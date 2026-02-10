/**
 * DeepThink Orchestrator - Core Multi-Agent Reasoning Engine
 * Pure logic extracted from useDeepThink.ts without React dependencies
 */

import { v4 as uuidv4 } from 'uuid';
import { getAI, getAIProvider, findCustomModel } from '../api.js';
import { getThinkingBudget } from '../config.js';
import {
  DeepThinkConfig,
  ModelOption,
  ExpertResult,
  ChatMessage,
  MessageAttachment,
  DeepThinkEvent,
  ThinkingLevel
} from '../types.js';

import { executeManagerAnalysis, executeManagerReview } from './deepThink/manager.js';
import { streamExpertResponse } from './deepThink/expert.js';
import { streamSynthesisResponse } from './deepThink/synthesis.js';
import { logger } from './logger.js';

export interface DeepThinkOptions {
  model?: ModelOption;
  planningLevel?: ThinkingLevel;
  expertLevel?: ThinkingLevel;
  synthesisLevel?: ThinkingLevel;
  enableRecursiveLoop?: boolean;
}

export interface DeepThinkResult {
  content: string;
  experts: ExpertResult[];
  thoughts: string;
  totalDuration: number;
}

/**
 * Run DeepThink process with streaming events
 */
export async function* runDeepThink(
  query: string,
  history: ChatMessage[],
  config: DeepThinkConfig,
  options?: DeepThinkOptions
): AsyncGenerator<DeepThinkEvent, DeepThinkResult, undefined> {
  // Use actual model from config, not the "deepthink" alias
  const requestModel = options?.model || config.model;
  const actualModel = (requestModel === 'deepthink') ? config.model : requestModel;
  const planningLevel = options?.planningLevel || config.planningLevel;
  const expertLevel = options?.expertLevel || config.expertLevel;
  const synthesisLevel = options?.synthesisLevel || config.synthesisLevel;
  const enableRecursiveLoop = options?.enableRecursiveLoop ?? config.enableRecursiveLoop;

  const abortController = new AbortController();
  const signal = abortController.signal;

  const startTime = Date.now();
  let experts: ExpertResult[] = [];
  let finalOutput = '';
  let synthesisThoughts = '';

  // Always use provider from config for custom setups
  const customModelConfig = findCustomModel(actualModel, config.customModels);
  const provider = config.provider || customModelConfig?.provider || getAIProvider(actualModel);

  logger.info('System', 'Starting DeepThink Process', {
    requestModel,
    actualModel,
    provider,
    baseUrl: config.baseUrl
  });

  yield { type: 'state', data: { state: 'analyzing' } };

  const ai = getAI({
    provider,
    apiKey: customModelConfig?.apiKey || config.apiKey,
    baseUrl: customModelConfig?.baseUrl || config.baseUrl
  });

  try {
    // Get attachments from the last user message
    const lastMessage = history[history.length - 1];
    const currentAttachments: MessageAttachment[] =
      lastMessage?.role === 'user' ? (lastMessage.attachments || []) : [];

    // Build context from recent history
    const recentHistory = history.slice(0, -1).slice(-5).map(msg =>
      `${msg.role === 'user' ? 'User' : 'Model'}: ${msg.content}`
    ).join('\n');

    // --- Phase 1: Planning & Initial Experts ---
    logger.debug('Manager', 'Phase 1: Planning started');

    const managerTask = executeManagerAnalysis(
      ai,
      actualModel,
      query,
      recentHistory,
      currentAttachments,
      getThinkingBudget(planningLevel, actualModel)
    );

    // Create primary responder
    const primaryExpert: ExpertResult = {
      id: 'expert-0',
      role: "Primary Responder",
      description: "Directly addresses the user's original query.",
      temperature: 1,
      prompt: query,
      status: 'pending',
      round: 1
    };

    experts = [primaryExpert];
    yield { type: 'expert', data: { experts: [...experts], action: 'init' } };

    // Start primary expert
    experts[0].status = 'thinking';
    experts[0].startTime = Date.now();
    yield { type: 'expert', data: { experts: [...experts], action: 'start', index: 0 } };

    let primaryContent = '';
    let primaryThoughts = '';

    const primaryTask = streamExpertResponse(
      ai, actualModel, primaryExpert, recentHistory, currentAttachments,
      getThinkingBudget(expertLevel, actualModel), signal,
      (textChunk, thoughtChunk) => {
        primaryContent += textChunk;
        primaryThoughts += thoughtChunk;
      }
    ).then(() => {
      experts[0].content = primaryContent;
      experts[0].thoughts = primaryThoughts;
      experts[0].status = 'completed';
      experts[0].endTime = Date.now();
    }).catch(err => {
      experts[0].status = 'error';
      experts[0].content = 'Failed to generate response.';
      experts[0].endTime = Date.now();
      logger.error('Expert', 'Primary expert failed', err);
    });

    // Wait for manager analysis
    const analysisJson = await managerTask;
    yield { type: 'manager', data: { analysis: analysisJson } };
    logger.info('Manager', 'Plan generated', analysisJson);

    // Create round 1 experts from manager analysis
    const round1Experts: ExpertResult[] = analysisJson.experts.map((exp, idx) => ({
      ...exp,
      id: `expert-r1-${idx + 1}`,
      status: 'pending' as const,
      round: 1
    }));

    experts = [...experts, ...round1Experts];
    yield { type: 'state', data: { state: 'experts_working' } };
    yield { type: 'expert', data: { experts: [...experts], action: 'append' } };

    // Run round 1 experts in parallel
    const round1Tasks = round1Experts.map((exp, idx) => {
      const globalIndex = idx + 1;
      experts[globalIndex].status = 'thinking';
      experts[globalIndex].startTime = Date.now();

      let content = '';
      let thoughts = '';

      return streamExpertResponse(
        ai, actualModel, exp, recentHistory, currentAttachments,
        getThinkingBudget(expertLevel, actualModel), signal,
        (textChunk, thoughtChunk) => {
          content += textChunk;
          thoughts += thoughtChunk;
        }
      ).then(() => {
        experts[globalIndex].content = content;
        experts[globalIndex].thoughts = thoughts;
        experts[globalIndex].status = 'completed';
        experts[globalIndex].endTime = Date.now();
      }).catch(err => {
        experts[globalIndex].status = 'error';
        experts[globalIndex].content = 'Failed to generate response.';
        experts[globalIndex].endTime = Date.now();
        logger.error('Expert', `Expert ${exp.role} failed`, err);
      });
    });

    await Promise.all([primaryTask, ...round1Tasks]);
    yield { type: 'expert', data: { experts: [...experts], action: 'complete' } };

    // --- Phase 2: Recursive Loop (Optional) ---
    let roundCounter = 1;
    const MAX_ROUNDS = config.maxRounds || 3;
    let loopActive = enableRecursiveLoop;

    while (loopActive && roundCounter < MAX_ROUNDS) {
      if (signal.aborted) break;

      logger.info('Manager', `Phase 2: Reviewing Round ${roundCounter}`);
      yield { type: 'state', data: { state: 'reviewing' } };

      const reviewResult = await executeManagerReview(
        ai, actualModel, query, experts,
        getThinkingBudget(planningLevel, actualModel)
      );

      logger.info('Manager', `Review Result: ${reviewResult.satisfied ? 'Satisfied' : 'Not Satisfied'}`, reviewResult);

      if (reviewResult.satisfied) {
        loopActive = false;
      } else {
        roundCounter++;
        const nextRoundExperts = (reviewResult.refined_experts || []).map((exp, idx) => ({
          ...exp,
          id: `expert-r${roundCounter}-${idx}`,
          status: 'pending' as const,
          round: roundCounter
        }));

        if (nextRoundExperts.length === 0) {
          logger.warn('Manager', 'Not satisfied but no new experts proposed. Breaking loop.');
          loopActive = false;
          break;
        }

        const startIndex = experts.length;
        experts = [...experts, ...nextRoundExperts];
        yield { type: 'state', data: { state: 'experts_working' } };
        yield { type: 'expert', data: { experts: [...experts], action: 'append' } };

        const nextRoundTasks = nextRoundExperts.map((exp, idx) => {
          const globalIndex = startIndex + idx;
          experts[globalIndex].status = 'thinking';
          experts[globalIndex].startTime = Date.now();

          let content = '';
          let thoughts = '';

          return streamExpertResponse(
            ai, actualModel, exp, recentHistory, currentAttachments,
            getThinkingBudget(expertLevel, actualModel), signal,
            (textChunk, thoughtChunk) => {
              content += textChunk;
              thoughts += thoughtChunk;
            }
          ).then(() => {
            experts[globalIndex].content = content;
            experts[globalIndex].thoughts = thoughts;
            experts[globalIndex].status = 'completed';
            experts[globalIndex].endTime = Date.now();
          }).catch(err => {
            experts[globalIndex].status = 'error';
            experts[globalIndex].content = 'Failed to generate response.';
            experts[globalIndex].endTime = Date.now();
          });
        });

        await Promise.all(nextRoundTasks);
        yield { type: 'expert', data: { experts: [...experts], action: 'complete' } };
      }
    }

    // --- Phase 3: Synthesis ---
    yield { type: 'state', data: { state: 'synthesizing' } };
    logger.info('Synthesis', 'Phase 3: Synthesis started');

    await streamSynthesisResponse(
      ai, actualModel, query, recentHistory, experts,
      currentAttachments,
      getThinkingBudget(synthesisLevel, actualModel), signal,
      (textChunk, thoughtChunk) => {
        finalOutput += textChunk;
        synthesisThoughts += thoughtChunk;

        // Stream synthesis content
        if (textChunk) {
          // This will be handled by the caller
        }
      }
    );

    yield { type: 'synthesis', data: { content: finalOutput, thoughts: synthesisThoughts } };
    yield { type: 'state', data: { state: 'completed' } };
    yield { type: 'done', data: {} };

    logger.info('Synthesis', 'Response generation completed');

    const totalDuration = Date.now() - startTime;

    return {
      content: finalOutput,
      experts,
      thoughts: synthesisThoughts,
      totalDuration
    };

  } catch (e: any) {
    logger.error('System', 'DeepThink Process Error', e);
    yield { type: 'error', data: { error: e.message || 'Unknown error' } };

    return {
      content: '',
      experts,
      thoughts: '',
      totalDuration: Date.now() - startTime
    };
  }
}

/**
 * Run DeepThink and get final result (non-streaming)
 */
export async function runDeepThinkSync(
  query: string,
  history: ChatMessage[],
  config: DeepThinkConfig,
  options?: DeepThinkOptions
): Promise<DeepThinkResult> {
  const generator = runDeepThink(query, history, config, options);

  let result: DeepThinkResult | undefined;

  for await (const event of generator) {
    // Process events (logging, etc.)
    if (event.type === 'done') {
      // Generator will return after this
    }
  }

  // Get the return value
  const finalResult = await generator.next();
  return finalResult.value as DeepThinkResult;
}
