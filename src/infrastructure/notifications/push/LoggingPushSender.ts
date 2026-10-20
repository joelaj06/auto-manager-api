import type { ILogger } from "../../../application/ports/ILogger.js";
import type { IPushSender, PushMessage } from "../../../application/ports/INotifications.js";

/** Local stand-in for FCM: logs the push instead of sending it (PUSH_PROVIDER=log). */
export class LoggingPushSender implements IPushSender {
  constructor(private readonly logger: ILogger) {}

  send(tokens: readonly string[], message: PushMessage): Promise<Readonly<{ invalid: string[] }>> {
    this.logger.info("DEVELOPMENT PUSH (not sent)", {
      devices: tokens.length,
      pushTitle: message.title,
      pushBody: message.body,
    });
    return Promise.resolve({ invalid: [] });
  }
}
