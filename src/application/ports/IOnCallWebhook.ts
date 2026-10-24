import type { PlatformAlert } from "../../domain/repositories/IPlatformAlertRepository.js";

/** Posts an alert to the on-call channel (Slack-compatible webhook). Throws when it fails. */
export interface IOnCallWebhook {
  readonly configured: boolean;
  post(alert: PlatformAlert, consoleUrl: string): Promise<void>;
}
