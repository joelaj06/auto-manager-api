import { DomainError } from "../errors/DomainError.js";

export class IncidentRuleError extends DomainError {
  readonly code = "INCIDENT_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const INCIDENT_TYPES = [
  "accident",
  "theft",
  "impound",
  "vandalism",
  "fire",
  "flood",
  "other",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES = ["minor", "major", "total_loss"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** The vehicle status an incident type puts a vehicle in (decision 397). */
export const INCIDENT_STATUS: Readonly<
  Partial<Record<IncidentType, "accident" | "stolen" | "impounded">>
> = {
  accident: "accident",
  theft: "stolen",
  impound: "impounded",
};

export type ThirdParty = Readonly<{
  name: string;
  phone: string | null;
  plateNumber: string | null;
  insurer: string | null;
  policyNo: string | null;
  notes: string | null;
}>;

export type IncidentProps = Readonly<{
  id: string;
  number: string;
  vehicleId: string;
  branchId: string;
  driverId: string | null;
  type: IncidentType;
  severity: IncidentSeverity;
  status: "open" | "closed";
  occurredAt: Date;
  location: string | null;
  description: string;
  injuries: boolean;
  policeReportNo: string | null;
  policeStation: string | null;
  thirdParties: readonly ThirdParty[];
  issueId: string | null;
  damageId: string | null;
  vehicleStatus: string | null;
  statusBefore: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  outcome: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** What can change while it is open. */
export type IncidentDetails = Pick<
  IncidentProps,
  | "driverId"
  | "type"
  | "severity"
  | "occurredAt"
  | "location"
  | "description"
  | "injuries"
  | "policeReportNo"
  | "policeStation"
  | "thirdParties"
>;

const blank = (v: string | null | undefined) =>
  v === null || v === undefined || v.trim() === "" ? null : v.trim();

/**
 * An incident (docs/06 §8): an accident, a theft, an impound or other harm to a vehicle, with the
 * driver who had it, the police report and the others involved; open until closed with its
 * outcome (decisions 396–399).
 */
export class Incident {
  private constructor(private props: IncidentProps) {}

  static report(
    input: IncidentDetails &
      Readonly<{
        id: string;
        number: string;
        vehicleId: string;
        branchId: string;
        issueId: string | null;
        damageId: string | null;
        createdBy: string;
        now: Date;
      }>,
  ): Incident {
    return new Incident({
      id: input.id,
      number: input.number,
      vehicleId: input.vehicleId,
      branchId: input.branchId,
      ...details(input, input.now),
      status: "open",
      issueId: input.issueId,
      damageId: input.damageId,
      vehicleStatus: null,
      statusBefore: null,
      closedAt: null,
      closedBy: null,
      outcome: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: IncidentProps): Incident {
    return new Incident(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): IncidentProps {
    return this.props;
  }

  change(changes: Partial<IncidentDetails>, now: Date): void {
    this.assertOpen();
    this.props = { ...this.props, ...details({ ...this.props, ...changes }, now), updatedAt: now };
  }

  /** The vehicle went into `status` because of it, leaving `before`. */
  movedVehicle(status: string, before: string, now: Date): void {
    this.props = { ...this.props, vehicleStatus: status, statusBefore: before, updatedAt: now };
  }

  close(outcome: string, userId: string, now: Date): void {
    this.assertOpen();
    const text = outcome.trim();
    if (text.length < 3) throw new IncidentRuleError("Say how the incident ended");
    this.props = {
      ...this.props,
      status: "closed",
      outcome: text,
      closedAt: now,
      closedBy: userId,
      updatedAt: now,
    };
  }

  reopen(now: Date): void {
    if (this.props.status !== "closed") throw new IncidentRuleError("The incident is open");
    this.props = { ...this.props, status: "open", closedAt: null, closedBy: null, updatedAt: now };
  }

  private assertOpen(): void {
    if (this.props.status !== "open")
      throw new IncidentRuleError(`Incident ${this.props.number} is closed: reopen it first`);
  }
}

function details(input: IncidentDetails, now: Date): IncidentDetails {
  const description = input.description.trim();
  if (description.length < 3) throw new IncidentRuleError("Describe what happened");
  if (input.occurredAt.getTime() > now.getTime() + 5 * 60_000)
    throw new IncidentRuleError("An incident cannot happen in the future");
  if (input.thirdParties.length > 10) throw new IncidentRuleError("At most 10 others involved");
  return {
    driverId: input.driverId,
    type: input.type,
    severity: input.severity,
    occurredAt: input.occurredAt,
    location: blank(input.location),
    description,
    injuries: input.injuries,
    policeReportNo: blank(input.policeReportNo),
    policeStation: blank(input.policeStation),
    thirdParties: input.thirdParties.map((t) => {
      const name = t.name.trim();
      if (name.length === 0) throw new IncidentRuleError("Name each other party involved");
      return {
        name,
        phone: blank(t.phone),
        plateNumber: blank(t.plateNumber),
        insurer: blank(t.insurer),
        policyNo: blank(t.policyNo),
        notes: blank(t.notes),
      };
    }),
  };
}

// --- insurance claims ---

export const CLAIM_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "settled",
  "withdrawn",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const SETTLEMENT_METHODS = ["bank_transfer", "momo", "cheque"] as const;
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number];

export type ClaimProps = Readonly<{
  id: string;
  incidentId: string;
  insurerId: string;
  policyNo: string | null;
  claimNo: string | null;
  status: ClaimStatus;
  claimedMinor: number;
  excessMinor: number;
  approvedMinor: number | null;
  settledMinor: number | null;
  settledOn: string | null;
  settlementMethod: SettlementMethod | null;
  settlementReference: string | null;
  submittedOn: string;
  decidedAt: Date | null;
  reason: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

const positive = (minor: number, what: string) => {
  if (!Number.isInteger(minor) || minor <= 0)
    throw new IncidentRuleError(`The ${what} is more than nothing`);
  return minor;
};

/**
 * A claim on an insurer (decision 400): submitted → approved (the amount the insurer accepts,
 * less the excess) or rejected → settled when the money arrives; withdrawn before that.
 */
export class InsuranceClaim {
  private constructor(private props: ClaimProps) {}

  static submit(
    input: Pick<
      ClaimProps,
      | "id"
      | "incidentId"
      | "insurerId"
      | "policyNo"
      | "claimNo"
      | "claimedMinor"
      | "excessMinor"
      | "submittedOn"
      | "notes"
    > &
      Readonly<{ createdBy: string; now: Date }>,
  ): InsuranceClaim {
    positive(input.claimedMinor, "amount claimed");
    if (!Number.isInteger(input.excessMinor) || input.excessMinor < 0)
      throw new IncidentRuleError("The excess is 0 or more");
    if (input.excessMinor >= input.claimedMinor)
      throw new IncidentRuleError("The excess is less than the amount claimed");
    return new InsuranceClaim({
      id: input.id,
      incidentId: input.incidentId,
      insurerId: input.insurerId,
      policyNo: blank(input.policyNo),
      claimNo: blank(input.claimNo),
      status: "submitted",
      claimedMinor: input.claimedMinor,
      excessMinor: input.excessMinor,
      approvedMinor: null,
      settledMinor: null,
      settledOn: null,
      settlementMethod: null,
      settlementReference: null,
      submittedOn: input.submittedOn,
      decidedAt: null,
      reason: null,
      notes: blank(input.notes),
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: ClaimProps): InsuranceClaim {
    return new InsuranceClaim(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): ClaimProps {
    return this.props;
  }

  /** What the insurer is expected to pay: the approved amount, else the claim less the excess. */
  expectedMinor(): number {
    const p = this.props;
    return p.approvedMinor ?? p.claimedMinor - p.excessMinor;
  }

  approve(approvedMinor: number, claimNo: string | null, now: Date): void {
    this.expect("submitted", "approved");
    positive(approvedMinor, "amount approved");
    if (approvedMinor > this.props.claimedMinor)
      throw new IncidentRuleError("The insurer cannot approve more than was claimed");
    this.props = {
      ...this.props,
      status: "approved",
      approvedMinor,
      claimNo: blank(claimNo) ?? this.props.claimNo,
      decidedAt: now,
      updatedAt: now,
    };
  }

  reject(reason: string, now: Date): void {
    this.expect("submitted", "rejected");
    this.props = {
      ...this.props,
      status: "rejected",
      reason: why(reason),
      decidedAt: now,
      updatedAt: now,
    };
  }

  withdraw(reason: string, now: Date): void {
    if (this.props.status !== "submitted" && this.props.status !== "approved")
      throw new IncidentRuleError(`A claim ${this.props.status} cannot be withdrawn`);
    this.props = { ...this.props, status: "withdrawn", reason: why(reason), updatedAt: now };
  }

  settle(
    input: Readonly<{
      amountMinor: number;
      on: string;
      method: SettlementMethod;
      reference: string | null;
    }>,
    now: Date,
  ): void {
    if (this.props.status !== "submitted" && this.props.status !== "approved")
      throw new IncidentRuleError(`A claim ${this.props.status} cannot be settled`);
    positive(input.amountMinor, "amount received");
    if (input.amountMinor > this.props.claimedMinor)
      throw new IncidentRuleError("The insurer cannot pay more than was claimed");
    this.props = {
      ...this.props,
      status: "settled",
      approvedMinor: this.props.approvedMinor ?? input.amountMinor,
      settledMinor: input.amountMinor,
      settledOn: input.on,
      settlementMethod: input.method,
      settlementReference: blank(input.reference),
      decidedAt: this.props.decidedAt ?? now,
      updatedAt: now,
    };
  }

  private expect(from: ClaimStatus, to: ClaimStatus): void {
    if (this.props.status !== from)
      throw new IncidentRuleError(`A claim ${this.props.status} cannot be ${to}`);
  }
}

const why = (reason: string) => {
  const text = reason.trim();
  if (text.length < 3) throw new IncidentRuleError("Give the reason");
  return text;
};

// --- traffic offences ---

export const OFFENCE_TYPES = [
  "speeding",
  "red_light",
  "parking",
  "overloading",
  "no_documents",
  "dangerous_driving",
  "other",
] as const;
export type OffenceType = (typeof OFFENCE_TYPES)[number];
export type OffenceStatus = "unpaid" | "contested" | "paid" | "waived";

export type OffenceProps = Readonly<{
  id: string;
  vehicleId: string;
  branchId: string;
  driverId: string | null;
  type: OffenceType;
  offenceAt: Date;
  location: string | null;
  authority: string;
  noticeRef: string | null;
  fineMinor: number;
  dueOn: string | null;
  driverPays: boolean;
  status: OffenceStatus;
  paidOn: string | null;
  paidBy: "business" | "driver" | null;
  expenseId: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type OffenceDetails = Pick<
  OffenceProps,
  | "driverId"
  | "type"
  | "offenceAt"
  | "location"
  | "authority"
  | "noticeRef"
  | "fineMinor"
  | "dueOn"
  | "driverPays"
  | "notes"
>;

/**
 * A traffic offence and its fine (decision 401): unpaid until paid — by the business (an expense
 * to the authority, charged to the driver when the driver pays) or by the driver directly —
 * contested meanwhile, or waived.
 */
export class TrafficOffence {
  private constructor(private props: OffenceProps) {}

  static record(
    input: OffenceDetails &
      Readonly<{ id: string; vehicleId: string; branchId: string; createdBy: string; now: Date }>,
  ): TrafficOffence {
    return new TrafficOffence({
      id: input.id,
      vehicleId: input.vehicleId,
      branchId: input.branchId,
      ...offenceDetails(input, input.now),
      status: "unpaid",
      paidOn: null,
      paidBy: null,
      expenseId: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: OffenceProps): TrafficOffence {
    return new TrafficOffence(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): OffenceProps {
    return this.props;
  }

  change(changes: Partial<OffenceDetails>, now: Date): void {
    this.assertOutstanding();
    this.props = {
      ...this.props,
      ...offenceDetails({ ...this.props, ...changes }, now),
      updatedAt: now,
    };
  }

  contest(now: Date): void {
    if (this.props.status !== "unpaid")
      throw new IncidentRuleError("Only an unpaid fine is contested");
    this.props = { ...this.props, status: "contested", updatedAt: now };
  }

  /** Paid by the business (with its expense) or by the driver. */
  paid(by: "business" | "driver", on: string, expenseId: string | null, now: Date): void {
    this.assertOutstanding();
    if (this.props.fineMinor === 0) throw new IncidentRuleError("There is no fine to pay");
    if (by === "driver" && this.props.driverId === null)
      throw new IncidentRuleError("No driver is named on the offence");
    this.props = {
      ...this.props,
      status: "paid",
      paidOn: on,
      paidBy: by,
      expenseId,
      updatedAt: now,
    };
  }

  waive(note: string, now: Date): void {
    this.assertOutstanding();
    this.props = {
      ...this.props,
      status: "waived",
      notes: [this.props.notes, why(note)].filter((n) => n !== null).join("\n"),
      updatedAt: now,
    };
  }

  private assertOutstanding(): void {
    if (this.props.status === "paid" || this.props.status === "waived")
      throw new IncidentRuleError(`The fine is ${this.props.status}`);
  }
}

function offenceDetails(input: OffenceDetails, now: Date): OffenceDetails {
  const authority = input.authority.trim();
  if (authority.length < 2) throw new IncidentRuleError("Name the authority that issued it");
  if (input.offenceAt.getTime() > now.getTime() + 5 * 60_000)
    throw new IncidentRuleError("An offence cannot be in the future");
  if (!Number.isInteger(input.fineMinor) || input.fineMinor < 0)
    throw new IncidentRuleError("The fine is 0 or more");
  return {
    driverId: input.driverId,
    type: input.type,
    offenceAt: input.offenceAt,
    location: blank(input.location),
    authority,
    noticeRef: blank(input.noticeRef),
    fineMinor: input.fineMinor,
    dueOn: input.dueOn,
    driverPays: input.driverPays,
    notes: blank(input.notes),
  };
}
