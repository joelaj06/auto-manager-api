import { DomainError } from "../errors/DomainError.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "failed";

export type ApprovalRequestProps = Readonly<{
  id: string;
  action: string;
  payload: Readonly<Record<string, unknown>>;
  summary: string;
  reason: string;
  ticket: string | null;
  targetTenantId: string | null;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  executedAt: Date | null;
  result: Readonly<Record<string, unknown>> | null;
  error: string | null;
}>;

export class ApprovalNotPendingError extends DomainError {
  readonly code = "APPROVAL_NOT_PENDING";
  constructor(readonly status: ApprovalStatus) {
    super(`This request is already ${status}`);
  }
}

export class SelfApprovalError extends DomainError {
  readonly code = "APPROVAL_SELF";
  constructor() {
    super("You cannot decide on your own request; another staff member must approve it");
  }
}

export class ApprovalReasonRequiredError extends DomainError {
  readonly code = "REASON_REQUIRED";
  constructor() {
    super("A reason of at least 5 characters is required");
  }
}

/**
 * A four-eyes request (docs/27 §8): one staff member asks, a different one decides. Requests
 * expire (default 24 h). Approval then runs the action; its outcome is recorded on the request.
 */
export class ApprovalRequest {
  private constructor(private props: ApprovalRequestProps) {}

  static open(params: {
    id: string;
    action: string;
    payload: Readonly<Record<string, unknown>>;
    summary: string;
    reason: string;
    ticket?: string | null;
    targetTenantId?: string | null;
    requestedBy: string;
    now: Date;
    ttlMs: number;
  }): ApprovalRequest {
    if (params.reason.trim().length < 5) throw new ApprovalReasonRequiredError();
    return new ApprovalRequest({
      id: params.id,
      action: params.action,
      payload: params.payload,
      summary: params.summary,
      reason: params.reason.trim(),
      ticket: params.ticket ?? null,
      targetTenantId: params.targetTenantId ?? null,
      requestedBy: params.requestedBy,
      requestedAt: params.now,
      expiresAt: new Date(params.now.getTime() + params.ttlMs),
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      executedAt: null,
      result: null,
      error: null,
    });
  }

  static restore(props: ApprovalRequestProps): ApprovalRequest {
    return new ApprovalRequest(props);
  }

  get id(): string {
    return this.props.id;
  }
  get action(): string {
    return this.props.action;
  }
  get payload(): Readonly<Record<string, unknown>> {
    return this.props.payload;
  }
  get requestedBy(): string {
    return this.props.requestedBy;
  }
  get status(): ApprovalStatus {
    return this.props.status;
  }

  /**
   * Checks that `deciderId` may decide now. An expired request is marked expired and the
   * error reports it (callers persist the change).
   */
  assertDecidable(deciderId: string, now: Date): void {
    if (this.props.status === "pending" && now >= this.props.expiresAt) {
      this.props = { ...this.props, status: "expired" };
    }
    if (this.props.status !== "pending") throw new ApprovalNotPendingError(this.props.status);
    if (deciderId === this.props.requestedBy) throw new SelfApprovalError();
  }

  reject(deciderId: string, note: string | null, now: Date): void {
    this.assertDecidable(deciderId, now);
    this.props = {
      ...this.props,
      status: "rejected",
      decidedBy: deciderId,
      decidedAt: now,
      decisionNote: note,
    };
  }

  /** Approval and execution happen together; `outcome` is what the action returned or threw. */
  approveAndRecord(
    deciderId: string,
    note: string | null,
    now: Date,
    outcome:
      | Readonly<{ ok: true; result: Readonly<Record<string, unknown>> }>
      | Readonly<{ ok: false; error: string }>,
  ): void {
    this.assertDecidable(deciderId, now);
    this.props = {
      ...this.props,
      status: outcome.ok ? "approved" : "failed",
      decidedBy: deciderId,
      decidedAt: now,
      decisionNote: note,
      executedAt: outcome.ok ? now : null,
      result: outcome.ok ? outcome.result : null,
      error: outcome.ok ? null : outcome.error,
    };
  }

  snapshot(): ApprovalRequestProps {
    return this.props;
  }
}
