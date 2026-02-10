import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { ServerConfig, ThinkingLevel, ApiProvider } from './types.js';

// Default configuration
const DEFAULT_CONFIG: ServerConfig = {
  port: 3000,
  host: '0.0.0.0',
  corsOrigins: ['*'],
  deepThink: {
    model: 'gemini-3-flash-preview',
    provider: 'google',
    apiKey: '',
    baseUrl: undefined,
    planningLevel: 'high',
    expertLevel: 'high',
    synthesisLevel: 'high',
    enableRecursiveLoop: false,
    maxRounds: 3,
    customModels: []
  }
};

// Thinking budget mapping
const THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 0,
  low: 2048,
  medium: 8192,
  high: 16384
};

export const getThinkingBudget = (level: ThinkingLevel, model: string): number => {
  const isGeminiPro = model === 'gemini-3-pro-preview';

  if (level === 'high') {
    return isGeminiPro ? 32768 : 16384;
  }

  return THINKING_BUDGETS[level] || 0;
};

// Load configuration from file or environment
export const loadConfig = (): ServerConfig => {
  let config = { ...DEFAULT_CONFIG };

  // Try to load from config.yaml
  const configPath = path.join(process.cwd(), 'config.yaml');
  if (fs.existsSync(configPath)) {
    try {
      const yamlContent = fs.readFileSync(configPath, 'utf-8');
      const yamlConfig = parseYaml(yamlContent);
      config = mergeConfig(config, yamlConfig);
      console.log('[Config] Loaded from config.yaml');
    } catch (e) {
      console.warn('[Config] Failed to parse config.yaml:', e);
    }
  }

  // Override with environment variables
  if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
  }
  if (process.env.HOST) {
    config.host = process.env.HOST;
  }
  if (process.env.CORS_ORIGINS) {
    config.corsOrigins = process.env.CORS_ORIGINS.split(',');
  }
  if (process.env.API_KEY || process.env.GEMINI_API_KEY) {
    config.deepThink.apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || '';
  }
  if (process.env.MODEL) {
    config.deepThink.model = process.env.MODEL;
  }
  if (process.env.PROVIDER) {
    config.deepThink.provider = process.env.PROVIDER as ApiProvider;
  }
  if (process.env.BASE_URL) {
    config.deepThink.baseUrl = process.env.BASE_URL;
  }
  if (process.env.PLANNING_LEVEL) {
    config.deepThink.planningLevel = process.env.PLANNING_LEVEL as ThinkingLevel;
  }
  if (process.env.EXPERT_LEVEL) {
    config.deepThink.expertLevel = process.env.EXPERT_LEVEL as ThinkingLevel;
  }
  if (process.env.SYNTHESIS_LEVEL) {
    config.deepThink.synthesisLevel = process.env.SYNTHESIS_LEVEL as ThinkingLevel;
  }
  if (process.env.ENABLE_RECURSIVE_LOOP === 'true') {
    config.deepThink.enableRecursiveLoop = true;
  }

  return config;
};

// Merge configurations
const mergeConfig = (base: ServerConfig, override: Partial<ServerConfig>): ServerConfig => {
  return {
    ...base,
    ...override,
    deepThink: {
      ...base.deepThink,
      ...(override.deepThink || {})
    }
  };
};

// Get AI provider from model name
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
