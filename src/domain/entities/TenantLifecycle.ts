import { DomainError } from "../errors/DomainError.js";

export type TenantLifecycleStatus =
  | "provisioning"
  | "provisioning_failed"
  | "trialing"
  | "active"
  | "past_due"
  | "read_only"
  | "deactivated"
  | "archived";

export type DeactivationReason =
  "non_payment" | "trial_expired" | "requested_pause" | "abuse" | "legal" | "other";

/** Reasons staff may choose by hand; billing reasons are set by automation (P1-10). */
export const MANUAL_DEACTIVATION_REASONS: readonly DeactivationReason[] = [
  "requested_pause",
  "abuse",
  "legal",
  "other",
];

export type TenantLifecycleProps = Readonly<{
  id: string;
  slug: string;
  name: string;
  status: TenantLifecycleStatus;
  previousStatus: TenantLifecycleStatus | null;
  deactivationReason: DeactivationReason | null;
  statusMessage: string | null;
  autoRestoreLocked: boolean;
  statusChangedAt: Date | null;
}>;

export type StatusTransition = Readonly<{
  from: TenantLifecycleStatus;
  to: TenantLifecycleStatus;
  reasonCategory: DeactivationReason | null;
  message: string | null;
}>;

export class TenantStateError extends DomainError {
  readonly code = "TENANT_STATE";
  constructor(action: string, status: TenantLifecycleStatus) {
    super(`Cannot ${action} a tenant that is ${status.replaceAll("_", " ")}`);
  }
}

/** Statuses a tenant can be deactivated (or set read-only) from. */
const OPERATING: ReadonlySet<TenantLifecycleStatus> = new Set(["trialing", "active", "past_due"]);

/**
 * The manual part of the tenant status machine (docs/27 §3.3):
 *
 *   trialing | active | past_due | read_only → deactivated → (restore) previous status
 *   trialing | active | past_due → read_only → (clear) previous status
 *
 * There is no "suspended" state and no deletion (decisions 36, 39). A manual deactivation is
 * locked against automatic restore by billing.
 */
export class TenantLifecycle {
  private constructor(private props: TenantLifecycleProps) {}

  static restore(props: TenantLifecycleProps): TenantLifecycle {
    return new TenantLifecycle(props);
  }

  get id(): string {
    return this.props.id;
  }
  get status(): TenantLifecycleStatus {
    return this.props.status;
  }

  deactivate(
    reason: DeactivationReason,
    message: string | null,
    manual: boolean,
    now: Date,
  ): StatusTransition {
    const from = this.props.status;
    if (!OPERATING.has(from) && from !== "read_only")
      throw new TenantStateError("deactivate", from);
    this.props = {
      ...this.props,
      status: "deactivated",
      // Restoring a tenant that was read-only first returns it to where it was before that.
      previousStatus: from === "read_only" ? (this.props.previousStatus ?? "active") : from,
      deactivationReason: reason,
      statusMessage: message,
      autoRestoreLocked: manual,
      statusChangedAt: now,
    };
    return { from, to: "deactivated", reasonCategory: reason, message };
  }

  reactivate(now: Date): StatusTransition {
    const from = this.props.status;
    if (from !== "deactivated") throw new TenantStateError("restore", from);
    const to = this.props.previousStatus ?? "active";
    this.props = {
      ...this.props,
      status: to,
      previousStatus: null,
      deactivationReason: null,
      statusMessage: null,
      autoRestoreLocked: false,
      statusChangedAt: now,
    };
    return { from, to, reasonCategory: null, message: null };
  }

  setReadOnly(message: string | null, now: Date): StatusTransition {
    const from = this.props.status;
    if (!OPERATING.has(from)) throw new TenantStateError("set read-only", from);
    this.props = {
      ...this.props,
      status: "read_only",
      previousStatus: from,
      statusMessage: message,
      statusChangedAt: now,
    };
    return { from, to: "read_only", reasonCategory: null, message };
  }

  clearReadOnly(now: Date): StatusTransition {
    const from = this.props.status;
    if (from !== "read_only") throw new TenantStateError("clear read-only on", from);
    const to = this.props.previousStatus ?? "active";
    this.props = {
      ...this.props,
      status: to,
      previousStatus: null,
      statusMessage: null,
      statusChangedAt: now,
    };
    return { from, to, reasonCategory: null, message: null };
  }

  snapshot(): TenantLifecycleProps {
    return this.props;
  }
}
