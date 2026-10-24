import type { SupportMode, SupportSession, SupportStatus } from "../console/SupportSession.js";

/** What authenticating a support token needs: who is behind it, while it is live. */
export type LiveSupportSession = Readonly<{
  id: string;
  tenantId: string;
  staffId: string;
  staffName: string;
  mode: SupportMode;
  expiresAt: Date;
}>;

export type SupportRequestRecord = Readonly<{
  method: string;
  path: string;
  statusCode: number;
  requestId: string | null;
  at: Date;
}>;

export type SupportSessionRow = ReturnType<SupportSession["snapshot"]> &
  Readonly<{ staffName: string; tenantName: string }>;

/** Support-access sessions and their request trail (platform database). */
export interface ISupportSessionRepository {
  save(session: SupportSession): Promise<void>;
  find(id: string, lock?: boolean): Promise<SupportSession | null>;
  /** Active, not expired, and its console session not signed out. */
  live(id: string, now: Date): Promise<LiveSupportSession | null>;
  list(
    filter: Readonly<{
      staffId?: string;
      tenantId?: string;
      status?: SupportStatus;
      from?: Date;
      limit: number;
    }>,
  ): Promise<SupportSessionRow[]>;
  /** Appends to the trail and counts the request. */
  recordRequest(sessionId: string, request: SupportRequestRecord): Promise<void>;
  requests(sessionId: string, limit: number): Promise<SupportRequestRecord[]>;
  /** Sessions a staff member opened since `since` (unusual patterns). */
  openedBy(staffId: string, since: Date): Promise<number>;
  /** Whether the tenant shows its users the support-access log. */
  logVisible(tenantId: string): Promise<boolean>;
  setLogVisible(tenantId: string, visible: boolean): Promise<void>;
}
