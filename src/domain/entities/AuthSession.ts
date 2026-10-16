import { SessionNotActiveError } from "../errors/AuthErrors.js";

export type SessionRevocationReason =
  | "logout"
  | "refresh_token_reuse"
  | "password_changed"
  | "user_disabled"
  | "admin_revoked"
  /** Console sessions only: no request within the idle window. */
  | "idle_timeout";

export type AuthSessionProps = Readonly<{
  id: string;
  userId: string;
  refreshTokenHash: string;
  /** Hash of the token this session rotated away from last; presenting it again means theft. */
  previousRefreshTokenHash: string | null;
  createdAt: Date;
  lastRotatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: SessionRevocationReason | null;
  userAgent: string | null;
  ip: string | null;
}>;

/** Result of comparing a presented refresh token with the session. */
export type RefreshTokenMatch = "current" | "reused" | "unknown";

/**
 * A signed-in device. Holds the hash of its current refresh token, which is replaced on every
 * refresh (rotation). If a token that was already rotated away is presented again, someone else
 * has a copy: the whole session must be revoked.
 *
 * Hashes compared here are SHA-256 digests of 256-bit random secrets, so plain comparison leaks
 * nothing useful.
 */
export class AuthSession {
  private constructor(private props: AuthSessionProps) {}

  static start(params: {
    id: string;
    userId: string;
    refreshTokenHash: string;
    now: Date;
    ttlMs: number;
    userAgent?: string | null;
    ip?: string | null;
  }): AuthSession {
    return new AuthSession({
      id: params.id,
      userId: params.userId,
      refreshTokenHash: params.refreshTokenHash,
      previousRefreshTokenHash: null,
      createdAt: params.now,
      lastRotatedAt: params.now,
      expiresAt: new Date(params.now.getTime() + params.ttlMs),
      revokedAt: null,
      revocationReason: null,
      userAgent: params.userAgent ?? null,
      ip: params.ip ?? null,
    });
  }

  static restore(props: AuthSessionProps): AuthSession {
    return new AuthSession(props);
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get revocationReason(): SessionRevocationReason | null {
    return this.props.revocationReason;
  }

  isActive(now: Date): boolean {
    return this.props.revokedAt === null && now < this.props.expiresAt;
  }

  matchRefreshToken(hash: string): RefreshTokenMatch {
    if (hash === this.props.refreshTokenHash) return "current";
    if (hash === this.props.previousRefreshTokenHash) return "reused";
    return "unknown";
  }

  /** Replaces the refresh token. The session's absolute expiry does not move. */
  rotate(newRefreshTokenHash: string, now: Date): void {
    if (!this.isActive(now)) throw new SessionNotActiveError();
    this.props = {
      ...this.props,
      previousRefreshTokenHash: this.props.refreshTokenHash,
      refreshTokenHash: newRefreshTokenHash,
      lastRotatedAt: now,
    };
  }

  /** Idempotent: an already revoked session keeps its first reason. */
  revoke(reason: SessionRevocationReason, now: Date): void {
    if (this.props.revokedAt !== null) return;
    this.props = { ...this.props, revokedAt: now, revocationReason: reason };
  }

  snapshot(): AuthSessionProps {
    return this.props;
  }
}
