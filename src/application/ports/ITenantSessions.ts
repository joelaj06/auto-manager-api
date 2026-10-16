export type SessionView = Readonly<{
  id: string;
  createdAt: Date;
  lastRotatedAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}>;

/** Session queries and bulk revocation for tenant users (tenant unit of work). */
export interface ITenantSessions {
  listActive(userId: string, now: Date): Promise<SessionView[]>;
  /** Revokes the user's sessions (optionally keeping one); returns how many. */
  revokeForUser(
    userId: string,
    reason: "logout" | "password_changed" | "user_disabled" | "admin_revoked",
    now: Date,
    exceptSessionId?: string,
  ): Promise<number>;
}
