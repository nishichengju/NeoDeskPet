export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory = 'System' | 'User' | 'API' | 'Manager' | 'Expert' | 'Synthesis' | 'Server';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: any;
}

class LoggerService {
  private logs: LogEntry[] = [];
  private maxLogs: number = 5000;
  private enableConsole: boolean = true;

  constructor() {
    this.info('System', 'Logger service initialized');
  }

  setConsoleOutput(enabled: boolean) {
    this.enableConsole = enabled;
  }

  private replacer(key: string, value: any) {
    if (key === 'apiKey') return '***REDACTED***';
    if (key === 'auth') return '***REDACTED***';
    if (key === 'data' && typeof value === 'string' && value.length > 100) {
      return value.substring(0, 100) + '...[truncated]';
    }
    return value;
  }

  add(level: LogLevel, category: LogCategory, message: string, data?: any) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data: data ? JSON.parse(JSON.stringify(data, this.replacer)) : undefined
    };

    this.logs.push(entry);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(this.logs.length - this.maxLogs);
    }

    if (this.enableConsole) {
      const timestamp = new Date().toLocaleTimeString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}] [${category}]`;

      switch (level) {
        case 'error':
          console.error(`${prefix} ${message}`, data || '');
          break;
        case 'warn':
          console.warn(`${prefix} ${message}`, data || '');
          break;
        case 'debug':
          console.debug(`${prefix} ${message}`, data || '');
          break;
        default:
          console.log(`${prefix} ${message}`, data || '');
      }
    }
  }

  info(category: LogCategory, message: string, data?: any) {
    this.add('info', category, message, data);
  }

  warn(category: LogCategory, message: string, data?: any) {
    this.add('warn', category, message, data);
  }

  error(category: LogCategory, message: string, data?: any) {
    this.add('error', category, message, data);
  }

  debug(category: LogCategory, message: string, data?: any) {
    this.add('debug', category, message, data);
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this.info('System', 'Logs cleared');
  }
}

export const logger = new LoggerService();
