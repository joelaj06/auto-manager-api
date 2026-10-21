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
  maintenance: Responsibility;
  insurance: Responsibility;
  depositPaidMinor: number;
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
      maintenance: Responsibility;
      insurance: Responsibility;
      guarantors: readonly Guarantor[];
      notes: string | null;
      createdBy: string | null;
      now: Date;
    }>,
  ): WorkPayAgreement {
    WorkPayAgreement.check(params.graceDays, params.guarantors);
    return new WorkPayAgreement({
      id: params.id,
      number: params.number,
      vehicleId: params.vehicleId,
      driverId: params.driverId,
      branchId: params.branchId,
      status: "draft",
      terms: agreementTerms(params.terms),
      graceDays: params.graceDays,
      maintenance: params.maintenance,
      insurance: params.insurance,
      depositPaidMinor: 0,
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
    this.props = {
      ...this.props,
      ...(changes.terms === undefined ? {} : { terms: agreementTerms(changes.terms) }),
      graceDays,
      guarantors,
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
