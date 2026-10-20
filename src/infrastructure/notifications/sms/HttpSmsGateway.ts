import { SmsProviderError } from "../../../application/errors/NotificationErrors.js";
import type {
  ISmsGateway,
  SmsProvider,
  SmsResult,
} from "../../../application/ports/INotifications.js";

export type Fetch = typeof fetch;
export type SmsAccountInput = Parameters<ISmsGateway["send"]>[0];

const TIMEOUT_MS = 15_000;

/** International format without the plus, as Ghanaian providers expect: 233241234567. */
export const msisdn = (e164: string) => e164.replace(/^\+/, "");

/**
 * Common HTTP handling of the tenant SMS providers: timeout, JSON parsing, and the split between
 * failures worth retrying (network, 5xx, rate limits) and permanent ones (credentials, sender ID,
 * balance — 4xx).
 */
export abstract class HttpSmsGateway implements ISmsGateway {
  abstract readonly provider: SmsProvider;

  constructor(protected readonly fetchImpl: Fetch = fetch) {}

  abstract send(account: SmsAccountInput, to: string, text: string): Promise<SmsResult>;

  protected async call(url: string, init: RequestInit): Promise<Readonly<Record<string, unknown>>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new SmsProviderError(
        `${this.provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    const raw = await response.text();
    let body: Record<string, unknown>;
    try {
      body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      body = { message: raw.slice(0, 200) };
    }
    if (!response.ok) {
      const retry = response.status >= 500 || response.status === 429;
      throw new SmsProviderError(
        `${this.provider} refused the message (HTTP ${response.status}): ${describe(body)}`,
        !retry,
      );
    }
    return body;
  }

  protected credential(account: SmsAccountInput, field: string): string {
    const value = account.credentials[field];
    if (value === undefined || value === "")
      throw new SmsProviderError(`${this.provider} credentials are missing ${field}`, true);
    return value;
  }
}

export function describe(body: Readonly<Record<string, unknown>>): string {
  const message = body.message ?? body.Message ?? body.error ?? body.status ?? "no details";
  return (typeof message === "string" ? message : JSON.stringify(message)).slice(0, 300);
}
