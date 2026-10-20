import { createSign } from "node:crypto";
import type { IPushSender, PushMessage } from "../../../application/ports/INotifications.js";

export type FcmServiceAccount = Readonly<{
  project_id: string;
  client_email: string;
  private_key: string;
}>;

type Fetch = typeof fetch;

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 15_000;

/**
 * Firebase Cloud Messaging, HTTP v1 API, authenticated with a service account (a signed JWT
 * exchanged for an access token, cached until shortly before it expires). One request per
 * device; tokens FCM reports as unregistered are returned so they can be forgotten.
 */
export class FcmPushSender implements IPushSender {
  private accessToken: Readonly<{ value: string; expiresAt: number }> | null = null;

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(tokens: readonly string[], message: PushMessage) {
    const invalid: string[] = [];
    if (tokens.length === 0) return { invalid };
    const accessToken = await this.token();
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    let failure: Error | null = null;
    let delivered = 0;
    for (const token of tokens) {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: message.data,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        delivered += 1;
        continue;
      }
      const text = await response.text();
      // 404 UNREGISTERED / 400 INVALID_ARGUMENT on the token: the app was removed.
      if (response.status === 404 || /UNREGISTERED|registration token/i.test(text)) {
        invalid.push(token);
        continue;
      }
      failure = new Error(`FCM refused the push (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    // Retry only when no device got it (a retry would repeat it on the others).
    if (failure !== null && delivered === 0) throw failure;
    return { invalid };
  }

  private async token(): Promise<string> {
    const now = this.now();
    if (this.accessToken !== null && this.accessToken.expiresAt - 60_000 > now)
      return this.accessToken.value;
    const issuedAt = Math.floor(now / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: this.account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(this.account.private_key)
      .toString("base64url");
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(
        `FCM sign-in failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`,
      );
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return body.access_token;
  }
}
