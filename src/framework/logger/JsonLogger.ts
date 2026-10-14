import type { ILogger, LogContext } from "../../application/ports/ILogger.js";
import type { LogLevel } from "../../infrastructure/config/config.js";
import { sanitize } from "./redaction.js";

export type LogEntryLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = Readonly<{
  time: string;
  level: LogEntryLevel;
  msg: string;
  [field: string]: unknown;
}>;

export type LogSink = (entry: LogEntry) => void;

export type JsonLoggerOptions = Readonly<{
  level: LogLevel;
  sink?: LogSink;
  bindings?: LogContext;
  /** Extra fields for every entry, read at log time (e.g. the current request id). */
  contextProvider?: () => LogContext | undefined;
  now?: () => Date;
}>;

const SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

/** One JSON object per line on stdout — what container log collectors expect. */
export const jsonSink: LogSink = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

/**
 * Structured ILogger. Every field passes through `sanitize`, so secrets are redacted no matter
 * which layer logs them. Field precedence: entry context > bindings > request context.
 */
export class JsonLogger implements ILogger {
  private readonly threshold: number;

  constructor(private readonly options: JsonLoggerOptions) {
    this.threshold = SEVERITY[options.level];
  }

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  child(bindings: LogContext): ILogger {
    return new JsonLogger({
      ...this.options,
      bindings: { ...this.options.bindings, ...bindings },
    });
  }

  private write(level: LogEntryLevel, message: string, context?: LogContext): void {
    if (SEVERITY[level] < this.threshold) return;

    const fields = sanitize({
      ...this.options.contextProvider?.(),
      ...this.options.bindings,
      ...context,
    }) as Record<string, unknown>;

    const entry: LogEntry = {
      ...fields,
      time: (this.options.now?.() ?? new Date()).toISOString(),
      level,
      msg: message,
    };

    try {
      (this.options.sink ?? jsonSink)(entry);
    } catch {
      // A logging failure must never take the request (or the process) down.
    }
  }
}
