// Model and Provider Types
export type ModelOption = 'gemini-3-flash-preview' | 'gemini-3-pro-preview' | 'custom' | string;
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type ApiProvider = 'google' | 'openai' | 'deepseek' | 'anthropic' | 'xai' | 'mistral' | 'custom';

// Custom Model Configuration
export type CustomModel = {
  id: string;
  name: string;
  provider: ApiProvider;
  apiKey?: string;
  baseUrl?: string;
};

// Expert Configuration
export type ExpertConfig = {
  id: string;
  role: string;
  description: string;
  temperature: number;
  prompt: string;
};

// Expert Result with Status
export type ExpertResult = ExpertConfig & {
  status: 'pending' | 'thinking' | 'completed' | 'error';
  content?: string;
  thoughts?: string;
  thoughtProcess?: string;
  startTime?: number;
  endTime?: number;
  round?: number;
};

// Manager Analysis Result
export type AnalysisResult = {
  thought_process: string;
  experts: Omit<ExpertConfig, 'id'>[];
};

// Manager Review Result
export type ReviewResult = {
  satisfied: boolean;
  critique: string;
  next_round_strategy?: string;
  refined_experts?: Omit<ExpertConfig, 'id'>[];
};

// Application State
export type AppState = 'idle' | 'analyzing' | 'experts_working' | 'reviewing' | 'synthesizing' | 'completed';

// Message Attachment (for images)
export type MessageAttachment = {
  id: string;
  type: 'image';
  mimeType: string;
  data: string; // Base64 string
  url?: string;
};

// Chat Message
export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: MessageAttachment[];
};

// DeepThink Configuration
export interface DeepThinkConfig {
  // Model Settings
  model: ModelOption;
  provider: ApiProvider;
  apiKey: string;
  baseUrl?: string;

  // Thinking Levels
  planningLevel: ThinkingLevel;
  expertLevel: ThinkingLevel;
  synthesisLevel: ThinkingLevel;

  // Features
  enableRecursiveLoop: boolean;
  maxRounds: number;

  // Custom Models
  customModels?: CustomModel[];
}

// Server Configuration
export interface ServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  deepThink: DeepThinkConfig;
}

// API Request Body (OpenAI Compatible)
export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  // DeepThink specific options
  deepthink_options?: {
    planning_level?: ThinkingLevel;
    expert_level?: ThinkingLevel;
    synthesis_level?: ThinkingLevel;
    enable_recursive_loop?: boolean;
  };
}

// DeepThink Process Event (for SSE streaming)
export interface DeepThinkEvent {
  type: 'state' | 'manager' | 'expert' | 'synthesis' | 'done' | 'error';
  data: any;
}

// SSE Chunk (OpenAI Compatible)
export interface SSEChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }[];
}
