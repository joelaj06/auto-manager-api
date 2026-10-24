import type { IOnCallWebhook } from "../../application/ports/IOnCallWebhook.js";
import type { PlatformAlert } from "../../domain/repositories/IPlatformAlertRepository.js";

const ICON = { info: "ℹ️", warning: "⚠️", critical: "🚨" } as const;
const TIMEOUT_MS = 10_000;

/** A Slack-compatible incoming webhook: `{ "text": … }` plus the alert for other relays. */
export class HttpOnCallWebhook implements IOnCallWebhook {
  constructor(
    private readonly url: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.url !== null;
  }

  async post(alert: PlatformAlert, consoleUrl: string): Promise<void> {
    if (this.url === null) return;
    const text = `${ICON[alert.severity]} [${alert.severity}] ${alert.title} (${alert.source}${alert.occurrences > 1 ? `, ×${alert.occurrences}` : ""}) ${consoleUrl}/alerts/${alert.id}`;
    const res = await this.fetcher(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        alert: {
          id: alert.id,
          severity: alert.severity,
          source: alert.source,
          title: alert.title,
          tenantId: alert.tenantId,
          runbook: alert.runbook,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`On-call webhook answered ${res.status}`);
  }
}
