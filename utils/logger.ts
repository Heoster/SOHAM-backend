/**
 * Structured Logger
 * Replaces raw console.log/warn/error with structured JSON logs in production
 * and pretty-printed logs in development.
 *
 * Every log entry includes:
 *   - timestamp (ISO)
 *   - level (info | warn | error | debug)
 *   - message
 *   - requestId (if available)
 *   - any extra context fields
 */

const isProd = process.env.NODE_ENV === 'production';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  };

  if (isProd) {
    // Structured JSON — easy to ingest by Render / Datadog / CloudWatch
    const out = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(out + '\n');
    } else {
      process.stdout.write(out + '\n');
    }
  } else {
    // Pretty dev output
    const prefix = {
      debug: '🔍',
      info:  'ℹ️ ',
      warn:  '⚠️ ',
      error: '🚨',
    }[level];
    const extra = ctx && Object.keys(ctx).length > 0 ? ' ' + JSON.stringify(ctx) : '';
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`${prefix} [${entry.ts}] ${msg}${extra}`);
  }
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write('debug', msg, ctx),
  info:  (msg: string, ctx?: Record<string, unknown>) => write('info',  msg, ctx),
  warn:  (msg: string, ctx?: Record<string, unknown>) => write('warn',  msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write('error', msg, ctx),
};

export default logger;
