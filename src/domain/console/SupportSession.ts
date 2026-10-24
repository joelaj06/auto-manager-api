import { DomainError } from "../errors/DomainError.js";

export type SupportMode = "read" | "write";
export type SupportStatus = "awaiting_approval" | "approved" | "active" | "ended" | "rejected";
export type SupportEndReason = "ended" | "expired" | "signed_out" | "revoked";

export type SupportSessionProps = Readonly<{
  id: string;
  staffId: string;
  staffSessionId: string;
  tenantId: string;
  mode: SupportMode;
  reason: string;
  ticket: string | null;
  status: SupportStatus;
  approvalId: string | null;
  approvedBy: string | null;
  durationMinutes: number;
  requestedAt: Date;
  startedAt: Date | null;
  expiresAt: Date | null;
  endedAt: Date | null;
  endReason: SupportEndReason | null;
  requestCount: number;
}>;

export class SupportSessionError extends DomainError {
  readonly code = "SUPPORT_SESSION";
  constructor(message: string) {
    super(message);
  }
}

/** Default time box, and the most a session may last in all (docs/27 §3.8). */
export const DEFAULT_SUPPORT_MINUTES = 30;
export const MAX_SUPPORT_MINUTES = 120;
const MINUTE_MS = 60_000;

/**
 * Support access to one tenant (docs/27 §3.8, decision 34): no tenant consent; a reason (and an
 * optional ticket) first; read-only by default; write mode waits for a second staff member's
 * approval. The clock starts when the first token is taken; a session lasts its time box
 * (default 30 min, extendable to 2 h in all) and ends early when staff end it or sign out.
 */
export class SupportSession {
  private constructor(private props: SupportSessionProps) {}

  static request(params: {
    id: string;
    staffId: string;
    staffSessionId: string;
    tenantId: string;
    mode: SupportMode;
    reason: string;
    ticket: string | null;
    durationMinutes?: number;
    now: Date;
  }): SupportSession {
    const reason = params.reason.trim();
    if (reason.length < 5) throw new SupportSessionError("Say why you need access (a reason)");
    const duration = params.durationMinutes ?? DEFAULT_SUPPORT_MINUTES;
    if (!Number.isInteger(duration) || duration < 5 || duration > MAX_SUPPORT_MINUTES)
      throw new SupportSessionError(`A session lasts 5 to ${MAX_SUPPORT_MINUTES} minutes`);
    return new SupportSession({
      id: params.id,
      staffId: params.staffId,
      staffSessionId: params.staffSessionId,
      tenantId: params.tenantId,
      mode: params.mode,
      reason,
      ticket: params.ticket?.trim() || null,
      status: params.mode === "write" ? "awaiting_approval" : "approved",
      approvalId: null,
      approvedBy: null,
      durationMinutes: duration,
      requestedAt: params.now,
      startedAt: null,
      expiresAt: null,
      endedAt: null,
      endReason: null,
      requestCount: 0,
    });
  }

  static restore(props: SupportSessionProps): SupportSession {
    return new SupportSession(props);
  }

  get id(): string {
    return this.props.id;
  }
  get mode(): SupportMode {
    return this.props.mode;
  }

  awaitApproval(approvalId: string): void {
    this.props = { ...this.props, approvalId };
  }

  /** The second staff member approved write mode (never the requester). */
  approve(approverId: string): void {
    if (this.props.status !== "awaiting_approval")
      throw new SupportSessionError("This session is not waiting for approval");
    if (approverId === this.props.staffId)
      throw new SupportSessionError("Another staff member must approve write access");
    this.props = { ...this.props, status: "approved", approvedBy: approverId };
  }

  /** Starts the clock on the first token; later tokens within the time box reuse it. */
  start(now: Date): void {
    this.closeIfExpired(now);
    if (this.props.status === "active") return;
    if (this.props.status !== "approved")
      throw new SupportSessionError(
        this.props.status === "awaiting_approval"
          ? "Write access is waiting for a second staff member's approval"
          : "This session is over; open a new one",
      );
    this.props = {
      ...this.props,
      status: "active",
      startedAt: now,
      expiresAt: new Date(now.getTime() + this.props.durationMinutes * MINUTE_MS),
    };
  }

  /** More time, up to two hours from the start in all. */
  extend(minutes: number, now: Date): void {
    this.closeIfExpired(now);
    if (
      this.props.status !== "active" ||
      this.props.startedAt === null ||
      this.props.expiresAt === null
    )
      throw new SupportSessionError("Only an active session can be extended");
    if (!Number.isInteger(minutes) || minutes < 5)
      throw new SupportSessionError("Extend by at least 5 minutes");
    const latest = this.props.startedAt.getTime() + MAX_SUPPORT_MINUTES * MINUTE_MS;
    const wanted = this.props.expiresAt.getTime() + minutes * MINUTE_MS;
    if (wanted > latest)
      throw new SupportSessionError(
        `A session lasts at most ${MAX_SUPPORT_MINUTES} minutes in all`,
      );
    this.props = {
      ...this.props,
      expiresAt: new Date(wanted),
      durationMinutes: this.props.durationMinutes + minutes,
    };
  }

  end(reason: SupportEndReason, now: Date): void {
    if (this.props.status === "ended" || this.props.status === "rejected") return;
    this.props = {
      ...this.props,
      status: "ended",
      endedAt: now,
      endReason: reason,
    };
  }

  /** Write access was refused (or its approval expired). */
  reject(): void {
    if (this.props.status !== "awaiting_approval") return;
    this.props = { ...this.props, status: "rejected" };
  }

  isLive(now: Date): boolean {
    return (
      this.props.status === "active" && this.props.expiresAt !== null && now < this.props.expiresAt
    );
  }

  snapshot(): SupportSessionProps {
    return this.props;
  }

  private closeIfExpired(now: Date): void {
    if (
      this.props.status === "active" &&
      this.props.expiresAt !== null &&
      now >= this.props.expiresAt
    )
      this.end("expired", now);
  }
}
