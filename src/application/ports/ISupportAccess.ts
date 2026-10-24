import type { SupportActor } from "../authorization/Principal.js";

/** Who is behind a support-access token while its session is live (platform database). */
export interface ISupportAccess {
  /** Null when the session ended, expired, its console session signed out, or is not for this tenant. */
  live(sessionId: string, tenantId: string): Promise<SupportActor | null>;
  /** Appends a request to the session's trail (never fails the request). */
  record(
    sessionId: string,
    request: Readonly<{
      method: string;
      path: string;
      statusCode: number;
      requestId: string | null;
    }>,
  ): Promise<void>;
}
