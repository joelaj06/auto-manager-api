import type { AgreementPosition, PenaltyRule } from "./WorkPayCollections.js";
import {
  WorkPayRuleError,
  type Pricing,
  type WorkPayFrequency,
  type WorkPayTerms,
} from "./WorkPayTerms.js";

/** The whole lifecycle (docs/08 §5); P3-3 covers draft → signing → active and cancelling. */
export const AGREEMENT_STATUSES = [
  "draft",
  "awaiting_signatures",
  "active",
  "in_arrears",
  "defaulted",
  "restructured",
  "completed",
  "terminated",
  "repossessed",
  "cancelled",
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/** A vehicle or driver can have only one agreement in these statuses. */
export const LIVE_STATUSES: readonly AgreementStatus[] = [
  "awaiting_signatures",
  "active",
  "in_arrears",
  "defaulted",
];

export type Responsibility = "driver" | "owner" | "shared";

export type Guarantor = Readonly<{
  name: string;
  phone: string;
  ghanaCardNumber: string | null;
  relationship: string | null;
  address: string | null;
  /** Asked to sign the agreement (by link). */
  signs: boolean;
}>;

/** Why a running agreement ended early (docs/08 §5). */
export const TERMINATION_REASONS = ["mutual", "death", "write_off", "other"] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** How the agreement was closed before completion, with the settlement figures. */
export type Closure = Readonly<{
  reason: TerminationReason | "repossession";
  on: string;
  notes: string | null;
  /** Instalments, late fees and charges still owed when it closed. */
  outstandingMinor: number;
  /** Agreed: what the driver still pays (to their ledger) … */
  owedMinor: number;
  /** … or what the business gives back. */
  refundMinor: number;
  by: string;
}>;

/** The schedule's frequency once a restructure changed it. */
export type ScheduleBasis = Readonly<{ frequency: WorkPayFrequency; daysOff: readonly number[] }>;

export type AgreementTerms = Omit<WorkPayTerms, "schedule" | "pricing"> &
  Readonly<{ pricingKind: Pricing["kind"]; pricingValue: string }>;

export type WorkPayAgreementProps = Readonly<{
  id: string;
  number: string;
  vehicleId: string;
  driverId: string;
  branchId: string;
  status: AgreementStatus;
  terms: AgreementTerms;
  graceDays: number;
  penalty: PenaltyRule;
  maintenance: Responsibility;
  insurance: Responsibility;
  depositPaidMinor: number;
  /** The day the oldest unpaid instalment fell overdue (null: up to date). */
  arrearsSince: string | null;
  completedAt: Date | null;
  /** Null: the signed terms' frequency and days off. */
  rescheduledBasis: ScheduleBasis | null;
  closure: Closure | null;
  guarantors: readonly Guarantor[];
  notes: string | null;
  documentId: string | null;
  assignmentId: string | null;
  startedOn: string | null;
  activatedBy: string | null;
  activatedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

const pricingValue = (p: Pricing) =>
  p.kind === "multiplier"
    ? p.multiplier
    : p.kind === "markup_percent"
      ? p.percent
      : String(p.totalMinor);

/** The terms as stored on the agreement (the schedule is generated from them at activation). */
export function agreementTerms(terms: WorkPayTerms): AgreementTerms {
  const { schedule: _schedule, pricing, ...rest } = terms;
  return { ...rest, pricingKind: pricing.kind, pricingValue: pricingValue(pricing) };
}

/** The pricing the terms were made from. */
export function pricingOf(terms: AgreementTerms): Pricing {
  return terms.pricingKind === "multiplier"
    ? { kind: "multiplier", multiplier: terms.pricingValue }
    : terms.pricingKind === "markup_percent"
      ? { kind: "markup_percent", percent: terms.pricingValue }
      : { kind: "total", totalMinor: Number(terms.pricingValue) };
}

const PHONE = /^\+[1-9]\d{7,14}$/;

/**
 * A Work & Pay agreement (docs/08): drafted with its terms and guarantors, sent for signature
 * (the terms then freeze — the signed document shows them), activated once signed and the
 * deposit is paid, when the schedule starts and the driver gets the vehicle.
 */
export class WorkPayAgreement {
  private constructor(private props: WorkPayAgreementProps) {}

  static draft(
    params: Readonly<{
      id: string;
      number: string;
      vehicleId: string;
      driverId: string;
      branchId: string;
      terms: WorkPayTerms;
      graceDays: number;
      penalty: PenaltyRule;
      maintenance: Responsibility;
      insurance: Responsibility;
      guarantors: readonly Guarantor[];
      notes: string | null;
      createdBy: string | null;
      now: Date;
    }>,
  ): WorkPayAgreement {
    WorkPayAgreement.check(params.graceDays, params.guarantors);
    WorkPayAgreement.checkPenalty(params.penalty);
    return new WorkPayAgreement({
      id: params.id,
      number: params.number,
      vehicleId: params.vehicleId,
      driverId: params.driverId,
      branchId: params.branchId,
      status: "draft",
      terms: agreementTerms(params.terms),
      graceDays: params.graceDays,
      penalty: params.penalty,
      maintenance: params.maintenance,
      insurance: params.insurance,
      depositPaidMinor: 0,
      arrearsSince: null,
      completedAt: null,
      rescheduledBasis: null,
      closure: null,
      guarantors: params.guarantors,
      notes: params.notes?.trim() || null,
      documentId: null,
      assignmentId: null,
      startedOn: null,
      activatedBy: null,
      activatedAt: null,
      cancelledAt: null,
      cancelReason: null,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: WorkPayAgreementProps): WorkPayAgreement {
    return new WorkPayAgreement(props);
  }

  private static check(graceDays: number, guarantors: readonly Guarantor[]): void {
    if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60)
      throw new WorkPayRuleError("Grace is 0 to 60 days");
    if (guarantors.length > 5) throw new WorkPayRuleError("At most 5 guarantors");
    for (const g of guarantors) {
      if (g.name.trim().length < 2) throw new WorkPayRuleError("A guarantor needs a name");
      if (!PHONE.test(g.phone)) throw new WorkPayRuleError(`${g.name}: give the phone as +233…`);
    }
  }

  static checkPenalty(rule: PenaltyRule): void {
    if (rule.kind === "none") return;
    if (rule.kind === "percent") {
      if (!/^\d{1,2}(\.\d{1,2})?$/.test(rule.percent) || Number(rule.percent) <= 0)
        throw new WorkPayRuleError("A late-payment percentage is above 0 and below 100");
      return;
    }
    if (!Number.isSafeInteger(rule.amountMinor) || rule.amountMinor <= 0)
      throw new WorkPayRuleError("A late-payment fee must be above zero");
    if (rule.kind === "daily" && rule.capMinor !== null && rule.capMinor < rule.amountMinor)
      throw new WorkPayRuleError("The cap must be at least one day's fee");
  }

  get id(): string {
    return this.props.id;
  }

  get status(): AgreementStatus {
    return this.props.status;
  }

  private assertDraft(): void {
    if (this.props.status !== "draft")
      throw new WorkPayRuleError(
        this.props.status === "awaiting_signatures"
          ? "The agreement is out for signature: withdraw it to change it"
          : "Only a draft agreement can be changed",
      );
  }

  revise(
    changes: Readonly<{
      terms?: WorkPayTerms;
      graceDays?: number;
      penalty?: PenaltyRule;
      maintenance?: Responsibility;
      insurance?: Responsibility;
      guarantors?: readonly Guarantor[];
      notes?: string | null;
    }>,
    now: Date,
  ): void {
    this.assertDraft();
    const graceDays = changes.graceDays ?? this.props.graceDays;
    const guarantors = changes.guarantors ?? this.props.guarantors;
    WorkPayAgreement.check(graceDays, guarantors);
    if (changes.penalty !== undefined) WorkPayAgreement.checkPenalty(changes.penalty);
    this.props = {
      ...this.props,
      ...(changes.terms === undefined ? {} : { terms: agreementTerms(changes.terms) }),
      graceDays,
      guarantors,
      penalty: changes.penalty ?? this.props.penalty,
      maintenance: changes.maintenance ?? this.props.maintenance,
      insurance: changes.insurance ?? this.props.insurance,
      notes: changes.notes === undefined ? this.props.notes : changes.notes?.trim() || null,
      updatedAt: now,
    };
  }

  /** The agreement document is out for signature: the terms freeze. */
  sentForSignature(documentId: string, now: Date): void {
    this.assertDraft();
    this.props = { ...this.props, status: "awaiting_signatures", documentId, updatedAt: now };
  }

  /** Back to draft (the document is voided) to change something. */
  withdraw(now: Date): string | null {
    if (this.props.status !== "awaiting_signatures")
      throw new WorkPayRuleError("Only an agreement out for signature can be withdrawn");
    const documentId = this.props.documentId;
    this.props = { ...this.props, status: "draft", documentId: null, updatedAt: now };
    return documentId;
  }

  depositReceived(amountMinor: number, now: Date): void {
    if (this.props.status !== "draft" && this.props.status !== "awaiting_signatures")
      throw new WorkPayRuleError("The deposit is paid before the agreement starts");
    if (this.props.depositPaidMinor + amountMinor > this.props.terms.depositMinor)
      throw new WorkPayRuleError("This is more than the deposit still to pay");
    this.props = {
      ...this.props,
      depositPaidMinor: this.props.depositPaidMinor + amountMinor,
      updatedAt: now,
    };
  }

  /** A deposit payment was reversed. */
  depositReturned(amountMinor: number, now: Date): void {
    this.props = {
      ...this.props,
      depositPaidMinor: Math.max(0, this.props.depositPaidMinor - amountMinor),
      updatedAt: now,
    };
  }

  get depositOutstandingMinor(): number {
    return this.props.terms.depositMinor - this.props.depositPaidMinor;
  }

  activate(
    params: Readonly<{
      assignmentId: string;
      today: string;
      userId: string;
      requireDeposit: boolean;
      now: Date;
    }>,
  ): void {
    if (this.props.status !== "awaiting_signatures")
      throw new WorkPayRuleError("Send the agreement for signature first");
    if (params.requireDeposit && this.depositOutstandingMinor > 0)
      throw new WorkPayRuleError("The deposit has not been paid in full");
    if (params.today > this.props.terms.firstDueOn)
      throw new WorkPayRuleError(
        "The first instalment date has passed: withdraw the agreement, change the dates and sign it again",
      );
    this.props = {
      ...this.props,
      status: "active",
      assignmentId: params.assignmentId,
      startedOn: params.today,
      activatedBy: params.userId,
      activatedAt: params.now,
      updatedAt: params.now,
    };
  }

  get isRunning(): boolean {
    return ["active", "in_arrears", "defaulted", "completed"].includes(this.props.status);
  }

  /** The frequency and days off instalments follow now. */
  get scheduleBasis(): ScheduleBasis {
    return (
      this.props.rescheduledBasis ?? {
        frequency: this.props.terms.frequency,
        daysOff: this.props.terms.daysOff,
      }
    );
  }

  /** Holidays and restructures change a running agreement that is not fully paid. */
  assertReschedulable(): void {
    if (!["active", "in_arrears", "defaulted"].includes(this.props.status))
      throw new WorkPayRuleError(
        "Only a running agreement that is not fully paid can be rescheduled",
      );
  }

  /** A restructure changed the instalments (and perhaps their frequency). */
  rescheduled(basis: ScheduleBasis | null, now: Date): void {
    this.assertReschedulable();
    this.props = {
      ...this.props,
      ...(basis === null ? {} : { rescheduledBasis: basis }),
      updatedAt: now,
    };
  }

  /**
   * Ends a running agreement early (docs/08 §5): terminated (mutual, death, accident write-off …)
   * from any running state, repossessed only once in arrears or defaulted.
   */
  close(kind: "terminated" | "repossessed", closure: Closure, now: Date): void {
    const allowed =
      kind === "repossessed" ? ["in_arrears", "defaulted"] : ["active", "in_arrears", "defaulted"];
    if (!allowed.includes(this.props.status))
      throw new WorkPayRuleError(
        kind === "repossessed"
          ? "A vehicle is repossessed only when the agreement is in arrears or defaulted"
          : "Only a running agreement that is not fully paid can be terminated",
      );
    if (closure.owedMinor > 0 && closure.refundMinor > 0)
      throw new WorkPayRuleError("Give either what the driver owes or what is refunded, not both");
    if (closure.owedMinor < 0 || closure.refundMinor < 0)
      throw new WorkPayRuleError("Settlement amounts cannot be negative");
    const notes = closure.notes?.trim() || null;
    if (closure.reason === "other" && (notes === null || notes.length < 3))
      throw new WorkPayRuleError("Say why the agreement is terminated");
    this.props = {
      ...this.props,
      status: kind,
      closure: { ...closure, notes },
      arrearsSince: null,
      updatedAt: now,
    };
  }

  /** Payments are taken while the agreement runs (and corrected after it completes). */
  assertCollecting(): void {
    if (!["active", "in_arrears", "defaulted"].includes(this.props.status))
      throw new WorkPayRuleError(
        this.props.status === "completed"
          ? "This agreement is fully paid"
          : "Payments are recorded once the agreement has started",
      );
  }

  /**
   * Follows the schedule (docs/08 §3, §5): active, in arrears, defaulted or completed, as the
   * instalments and penalties stand. Returns whether the status changed.
   */
  settle(position: AgreementPosition, now: Date): boolean {
    if (!this.isRunning) return false;
    const before = this.props.status;
    this.props = {
      ...this.props,
      status: position.status,
      arrearsSince: position.arrearsSince,
      completedAt: position.status === "completed" ? (this.props.completedAt ?? now) : null,
      updatedAt: now,
    };
    return before !== position.status;
  }

  cancel(reason: string, now: Date): string | null {
    if (this.props.status !== "draft" && this.props.status !== "awaiting_signatures")
      throw new WorkPayRuleError("Only an agreement that has not started can be cancelled");
    const why = reason.trim();
    if (why.length < 3) throw new WorkPayRuleError("Say why the agreement is cancelled");
    const documentId = this.props.documentId;
    this.props = {
      ...this.props,
      status: "cancelled",
      cancelledAt: now,
      cancelReason: why,
      updatedAt: now,
    };
    return documentId;
  }

  snapshot(): WorkPayAgreementProps {
    return this.props;
  }
}

export type { WorkPayFrequency };
