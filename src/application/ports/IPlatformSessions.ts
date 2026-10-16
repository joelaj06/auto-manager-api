import type { AuthSession } from "../../domain/entities/AuthSession.js";

export type PlatformSessionState = Readonly<{
  session: AuthSession;
  lastSeenAt: Date;
  stepUpAt: Date | null;
}>;

/** Staff sessions (platform database), checked on every console request. */
export interface IPlatformSessions {
  find(id: string): Promise<PlatformSessionState | null>;
  lockById(id: string): Promise<AuthSession | null>;
  /** Inserts or updates (last seen = now on insert). */
  save(session: AuthSession, now: Date): Promise<void>;
  touch(id: string, now: Date): Promise<void>;
  markStepUp(id: string, now: Date): Promise<void>;
  revokeAllForUser(
    userId: string,
    reason: "user_disabled" | "admin_revoked" | "password_changed",
    now: Date,
  ): Promise<number>;
}
