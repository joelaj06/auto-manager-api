import { randomUUID } from "node:crypto";
import type { ILogger } from "../../application/ports/ILogger.js";
import type { ISmsSender } from "../../application/ports/ISmsSender.js";

/**
 * Development stand-in until a platform SMS provider is chosen: writes the message to the log
 * instead of sending it, so verification codes can be read locally. In production it logs an
 * error at startup and refuses every message — codes are never faked or written to production
 * logs.
 */
export class LoggingSmsSender implements ISmsSender {
  constructor(
    private readonly logger: ILogger,
    private readonly isProduction: boolean,
  ) {
    if (isProduction) {
      logger.error("No SMS provider configured: signup phone verification will fail", {
        smsProvider: "log",
      });
    }
  }

  send(to: string, text: string): Promise<string> {
    if (this.isProduction) {
      return Promise.reject(new Error("SMS_PROVIDER=log cannot send messages in production"));
    }
    const id = `log-${randomUUID()}`;
    this.logger.warn("DEVELOPMENT SMS (not sent)", { smsTo: to, smsText: text, smsId: id });
    return Promise.resolve(id);
  }
}
