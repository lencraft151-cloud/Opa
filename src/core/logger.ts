export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

const COLORS: Record<string, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export interface Logger {
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

let currentLevel: LogLevel = 'info';
let useColor = process.stdout.isTTY === true;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setLogColor(enabled: boolean): void {
  useColor = enabled;
}

function format(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLORS[level] ?? ''}${tag}${RESET}` : tag;
  let line = `${ts} ${head} [${scope}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    line += ` ${safeStringify(meta)}`;
  }
  return line;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val as object)) return '[Circular]';
        seen.add(val as object);
      }
      if (val instanceof Error) return { name: val.name, message: val.message };
      return val;
    });
  } catch {
    return String(value);
  }
}

export function createLogger(scope = 'app'): Logger {
  const log = (level: Exclude<LogLevel, 'silent'>) => (message: string, meta?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
    const line = format(level, scope, message, meta);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };

  return {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('hub');
