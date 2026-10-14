export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Structured logger. Context objects are serialised as fields; sensitive keys (passwords,
 * tokens, OTPs, …) are redacted by the implementation. Never log request bodies wholesale.
 */
export interface ILogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** A logger that adds `bindings` to every entry. */
  child(bindings: LogContext): ILogger;
}
