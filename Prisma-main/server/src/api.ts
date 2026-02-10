import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { ApiProvider, CustomModel } from './types.js';
import { logger } from './services/logger.js';

type AIProviderConfig = {
  provider?: ApiProvider;
  apiKey?: string;
  baseUrl?: string;
};

// External API base URLs
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  custom: '',
};

export const findCustomModel = (modelName: string, customModels?: CustomModel[]): CustomModel | undefined => {
  return customModels?.find(m => m.name === modelName);
};

export const getAI = (config?: AIProviderConfig) => {
  const provider = config?.provider || 'google';
  const apiKey = config?.apiKey || process.env.API_KEY || process.env.GEMINI_API_KEY;

  if (provider === 'openai' || provider === 'deepseek' || provider === 'custom' || provider === 'anthropic' || provider === 'xai' || provider === 'mistral') {
    const options: any = {
      apiKey: apiKey,
    };

    if (config?.baseUrl) {
      options.baseURL = config.baseUrl;
    } else {
      const providerBaseUrl = PROVIDER_BASE_URLS[provider];
      if (providerBaseUrl) {
        options.baseURL = providerBaseUrl;
      }
    }

    logger.info('API', 'Initializing OpenAI Client', {
      provider,
      baseURL: options.baseURL,
      isCustom: provider === 'custom'
    });

    return new OpenAI(options);
  } else {
    const options: any = {
      apiKey: apiKey,
    };

    if (config?.baseUrl) {
      options.baseUrl = config.baseUrl;
    }

    logger.info('API', 'Initializing Google GenAI Client');
    return new GoogleGenAI(options);
  }
};

export const getAIProvider = (model: string): ApiProvider => {
  if (model.startsWith('gpt-') || model.startsWith('o1-')) {
    return 'openai';
  }
  if (model.startsWith('deepseek-')) {
    return 'deepseek';
  }
  if (model.startsWith('claude-')) {
    return 'anthropic';
  }
  if (model.startsWith('grok-')) {
    return 'xai';
  }
  if (model.startsWith('mistral-') || model.startsWith('mixtral-')) {
    return 'mistral';
  }
  if (model === 'custom') {
    return 'custom';
  }
  return 'google';
};
