import OpenAI from "openai";
import { ModelOption } from '../../types.js';
import { withRetry } from '../utils/retry.js';

export interface OpenAIStreamChunk {
  text: string;
  thought?: string;
}

export interface OpenAIConfig {
  model: ModelOption;
  systemInstruction?: string;
  content: string | Array<any>;
  temperature?: number;
  responseFormat?: 'text' | 'json_object';
  thinkingConfig?: {
    includeThoughts: boolean;
    thinkingBudget: number;
  };
}

const parseThinkingTokens = (text: string): { thought: string; text: string } => {
  const thinkPattern = /<thinking>([\s\S]*?)<\/thinking>/g;
  let thought = '';
  let cleanText = text;

  const matches = text.matchAll(thinkPattern);
  for (const match of matches) {
    thought += match[1];
  }

  cleanText = text.replace(thinkPattern, '');

  return { thought: thought.trim(), text: cleanText.trim() };
};

export const generateContent = async (
  ai: OpenAI,
  config: OpenAIConfig
): Promise<{ text: string; thought?: string }> => {
  const messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [];

  if (config.systemInstruction) {
    messages.push({
      role: 'system',
      content: config.systemInstruction
    });
  }

  messages.push({
    role: 'user',
    content: config.content as any
  });

  const requestOptions: any = {
    model: config.model,
    messages,
    temperature: config.temperature,
  };

  if (config.responseFormat === 'json_object') {
    requestOptions.response_format = { type: 'json_object' };
  }

  try {
    console.log('[OpenAI] Request options:', JSON.stringify({
      model: requestOptions.model,
      messagesCount: requestOptions.messages.length,
      temperature: requestOptions.temperature,
      response_format: requestOptions.response_format
    }));

    const response = await withRetry(() => ai.chat.completions.create(requestOptions));
    const content = response.choices[0]?.message?.content || '';

    console.log('[OpenAI] Response received, content length:', content.length);

    if (config.thinkingConfig?.includeThoughts) {
      const { thought, text } = parseThinkingTokens(content);
      return { text, thought };
    }

    return { text: content };
  } catch (error: any) {
    console.error('[OpenAI] generateContent error:', {
      message: error?.message,
      status: error?.status,
      code: error?.code,
      type: error?.type
    });
    throw error;
  }
};

export async function* generateContentStream(
  ai: OpenAI,
  config: OpenAIConfig
): AsyncGenerator<OpenAIStreamChunk, void, unknown> {
  const messages: Array<OpenAI.Chat.ChatCompletionMessageParam> = [];

  if (config.systemInstruction) {
    messages.push({
      role: 'system',
      content: config.systemInstruction
    });
  }

  messages.push({
    role: 'user',
    content: config.content as any
  });

  const requestOptions: any = {
    model: config.model,
    messages,
    temperature: config.temperature,
    stream: true,
  };

  console.log('[OpenAI Stream] Request:', JSON.stringify({
    model: requestOptions.model,
    messagesCount: requestOptions.messages.length,
    temperature: requestOptions.temperature
  }));

  let stream: any;
  try {
    stream = await withRetry(() => ai.chat.completions.create(requestOptions) as any);
  } catch (error: any) {
    console.error('[OpenAI Stream] Failed to create stream:', {
      message: error?.message,
      status: error?.status,
      code: error?.code
    });
    throw error;
  }

  let inThinking = false;
  let currentThought = '';

  for await (const chunk of (stream as any)) {
    const delta = chunk.choices[0]?.delta?.content || '';

    if (!delta) continue;

    if (config.thinkingConfig?.includeThoughts) {
      if (delta.includes('<thinking>')) {
        inThinking = true;
        continue;
      }

      if (inThinking) {
        if (delta.includes('</thinking>')) {
          inThinking = false;
          const parts = delta.split('</thinking>', 2);
          currentThought += parts[0];

          if (currentThought.trim()) {
            yield { text: '', thought: currentThought };
            currentThought = '';
          }

          if (parts[1]) {
            yield { text: parts[1], thought: '' };
          }
        } else {
          currentThought += delta;
          if (currentThought.length > 100) {
            yield { text: '', thought: currentThought };
            currentThought = '';
          }
        }
      } else {
        yield { text: delta, thought: '' };
      }
    } else {
      yield { text: delta, thought: '' };
    }
  }

  if (currentThought.trim()) {
    yield { text: '', thought: currentThought };
  }
}
