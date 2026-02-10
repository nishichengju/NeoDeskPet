/**
 * DeepThink API Server
 * OpenAI-compatible API with multi-agent reasoning capabilities
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

import { loadConfig } from './config.js';
import { runDeepThink } from './services/orchestrator.js';
import { ChatCompletionRequest, SSEChunk, ChatMessage, ThinkingLevel } from './types.js';
import { logger } from './services/logger.js';

const config = loadConfig();
const app = express();

// Middleware
app.use(cors({
  origin: config.corsOrigins,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// Get current configuration
app.get('/v1/config', (req: Request, res: Response) => {
  res.json({
    model: config.deepThink.model,
    provider: config.deepThink.provider,
    planningLevel: config.deepThink.planningLevel,
    expertLevel: config.deepThink.expertLevel,
    synthesisLevel: config.deepThink.synthesisLevel,
    enableRecursiveLoop: config.deepThink.enableRecursiveLoop,
    maxRounds: config.deepThink.maxRounds
  });
});

// Update configuration (runtime)
app.post('/v1/config', (req: Request, res: Response) => {
  const updates = req.body;

  if (updates.planningLevel) config.deepThink.planningLevel = updates.planningLevel;
  if (updates.expertLevel) config.deepThink.expertLevel = updates.expertLevel;
  if (updates.synthesisLevel) config.deepThink.synthesisLevel = updates.synthesisLevel;
  if (updates.enableRecursiveLoop !== undefined) config.deepThink.enableRecursiveLoop = updates.enableRecursiveLoop;
  if (updates.model) config.deepThink.model = updates.model;
  if (updates.apiKey) config.deepThink.apiKey = updates.apiKey;
  if (updates.baseUrl) config.deepThink.baseUrl = updates.baseUrl;

  logger.info('Server', 'Configuration updated', updates);
  res.json({ success: true, config: config.deepThink });
});

// List models (OpenAI compatible)
app.get('/v1/models', (req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: [
      { id: 'deepthink', object: 'model', created: Date.now(), owned_by: 'prisma' },
      { id: 'gemini-3-flash-preview', object: 'model', created: Date.now(), owned_by: 'google' },
      { id: 'gemini-3-pro-preview', object: 'model', created: Date.now(), owned_by: 'google' }
    ]
  });
});

// Chat completions endpoint (OpenAI compatible)
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  try {
    const body: ChatCompletionRequest = req.body;
    const { messages, stream = false, model, deepthink_options } = body;

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: { message: 'Messages array is required' } });
    }

    // Extract query from the last user message
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMessage) {
      return res.status(400).json({ error: { message: 'No user message found' } });
    }

    const query = lastUserMessage.content;

    // Convert messages to internal format
    const history: ChatMessage[] = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : m.role,
      content: m.content,
      attachments: m.attachments
    }));

    // Merge request options with config
    const options = {
      model: model || config.deepThink.model,
      planningLevel: deepthink_options?.planning_level || config.deepThink.planningLevel,
      expertLevel: deepthink_options?.expert_level || config.deepThink.expertLevel,
      synthesisLevel: deepthink_options?.synthesis_level || config.deepThink.synthesisLevel,
      enableRecursiveLoop: deepthink_options?.enable_recursive_loop ?? config.deepThink.enableRecursiveLoop
    };

    logger.info('Server', 'Chat completion request', { query: query.substring(0, 100), stream, model: options.model });

    if (stream) {
      // SSE Streaming Response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const requestId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);

      // Send initial role
      const initialChunk: SSEChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: options.model,
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

      let fullContent = '';

      try {
        const generator = runDeepThink(query, history, config.deepThink, options);

        for await (const event of generator) {
          if (event.type === 'synthesis' && event.data.content) {
            // Stream the synthesis content
            const content = event.data.content;
            if (content && content !== fullContent) {
              const delta = content.slice(fullContent.length);
              fullContent = content;

              const chunk: SSEChunk = {
                id: requestId,
                object: 'chat.completion.chunk',
                created,
                model: options.model,
                choices: [{
                  index: 0,
                  delta: { content: delta },
                  finish_reason: null
                }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          } else if (event.type === 'state') {
            // Optionally send state updates as comments
            res.write(`: state=${event.data.state}\n\n`);
          } else if (event.type === 'error') {
            const errorChunk = {
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model: options.model,
              choices: [{
                index: 0,
                delta: { content: `\n\nError: ${event.data.error}` },
                finish_reason: 'error'
              }]
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          }
        }

        // Send final chunk
        const finalChunk: SSEChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model: options.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');

      } catch (error: any) {
        logger.error('Server', 'Streaming error', error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      }

      res.end();

    } else {
      // Non-streaming response
      let finalContent = '';
      let experts: any[] = [];

      const generator = runDeepThink(query, history, config.deepThink, options);

      for await (const event of generator) {
        if (event.type === 'synthesis') {
          finalContent = event.data.content;
        }
        if (event.type === 'expert') {
          experts = event.data.experts;
        }
      }

      const response = {
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: options.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: finalContent
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        },
        // Extended fields for DeepThink
        deepthink: {
          experts: experts.map(e => ({
            role: e.role,
            round: e.round,
            status: e.status
          }))
        }
      };

      res.json(response);
    }

  } catch (error: any) {
    logger.error('Server', 'Request error', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error'
      }
    });
  }
});

// Extended endpoint: Get detailed DeepThink result with all experts
app.post('/v1/deepthink', async (req: Request, res: Response) => {
  try {
    const { query, history = [], options = {} } = req.body;

    if (!query) {
      return res.status(400).json({ error: { message: 'Query is required' } });
    }

    const mergedOptions = {
      model: options.model || config.deepThink.model,
      planningLevel: options.planning_level || config.deepThink.planningLevel,
      expertLevel: options.expert_level || config.deepThink.expertLevel,
      synthesisLevel: options.synthesis_level || config.deepThink.synthesisLevel,
      enableRecursiveLoop: options.enable_recursive_loop ?? config.deepThink.enableRecursiveLoop
    };

    logger.info('Server', 'DeepThink request', { query: query.substring(0, 100) });

    // Prepare history
    const chatHistory: ChatMessage[] = history.length > 0 ? history : [
      { role: 'user', content: query }
    ];

    let finalResult: any = null;
    const events: any[] = [];

    const generator = runDeepThink(query, chatHistory, config.deepThink, mergedOptions);

    for await (const event of generator) {
      events.push(event);
      if (event.type === 'synthesis') {
        finalResult = {
          content: event.data.content,
          thoughts: event.data.thoughts
        };
      }
    }

    // Get experts from events
    const expertEvent = events.filter(e => e.type === 'expert').pop();
    const experts = expertEvent?.data?.experts || [];

    res.json({
      success: true,
      content: finalResult?.content || '',
      thoughts: finalResult?.thoughts || '',
      experts: experts.map((e: any) => ({
        id: e.id,
        role: e.role,
        description: e.description,
        round: e.round,
        status: e.status,
        content: e.content,
        thoughts: e.thoughts
      })),
      events: events.map(e => ({ type: e.type, state: e.data?.state }))
    });

  } catch (error: any) {
    logger.error('Server', 'DeepThink request error', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error'
      }
    });
  }
});

// Start server
app.listen(config.port, config.host, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🔮 DeepThink API Server                                    ║
║                                                              ║
║   Server running at: http://${config.host}:${config.port}                   ║
║                                                              ║
║   Endpoints:                                                 ║
║   • POST /v1/chat/completions  (OpenAI compatible)           ║
║   • POST /v1/deepthink         (Extended API)                ║
║   • GET  /v1/config            (View config)                 ║
║   • POST /v1/config            (Update config)               ║
║   • GET  /v1/models            (List models)                 ║
║   • GET  /health               (Health check)                ║
║                                                              ║
║   Model: ${config.deepThink.model.padEnd(43)}║
║   Provider: ${config.deepThink.provider.padEnd(40)}║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);

  logger.info('Server', 'Server started', { port: config.port, host: config.host });
});

export default app;
