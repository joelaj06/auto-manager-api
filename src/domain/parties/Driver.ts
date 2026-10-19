import { DomainError } from "../errors/DomainError.js";
import { PhoneNumber } from "../value-objects/PhoneNumber.js";
import {
  checkEmergencyContact,
  checkPayout,
  InvalidPartyError,
  normaliseTags,
  optionalDate,
  optionalEmail,
  optionalPhone,
  optionalText,
  parseGhanaCard,
  requiredText,
  type EmergencyContact,
  type LicenceClass,
  type PayoutDetails,
} from "./PartyDetails.js";

export const DRIVER_STATUSES = ["applicant", "active", "suspended", "terminated"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];
export const EMPLOYMENT_TYPES = ["remittance", "workpay", "salary", "chauffeur"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Fields a user edits directly. */
export type DriverDetails = Readonly<{
  firstName: string;
  lastName: string;
  otherNames: string | null;
  phone: string;
  altPhone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  gender: "female" | "male" | null;
  address: string | null;
  ghanaCardNumber: string | null;
  licenceNumber: string | null;
  licenceClass: LicenceClass | null;
  licenceIssuedOn: string | null;
  licenceExpiresOn: string | null;
  employmentType: EmploymentType;
  hiredOn: string | null;
  emergencyContact: EmergencyContact | null;
  payout: PayoutDetails | null;
  tags: readonly string[];
  notes: string | null;
}>;

export type DriverProps = DriverDetails &
  Readonly<{
    id: string;
    code: string;
    status: DriverStatus;
    statusReason: string | null;
    statusChangedAt: Date;
    terminatedOn: string | null;
    branchId: string;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    deletedReason: string | null;
  }>;

export type DriverStatusChange = Readonly<{
  from: DriverStatus | null;
  to: DriverStatus;
  reason: string | null;
}>;

/** What the business requires before a driver can start (driver settings). */
export type DriverOnboardingRules = Readonly<{
  requireGhanaCard: boolean;
  requireValidLicence: boolean;
  requiredGuarantors: number;
  /** Document types that must be on file (with a scan). */
  requiredDocuments: readonly string[];
}>;

export const DEFAULT_DRIVER_RULES: DriverOnboardingRules = Object.freeze({
  requireGhanaCard: true,
  requireValidLicence: true,
  requiredGuarantors: 1,
  requiredDocuments: [],
});

export type OnboardingItem = Readonly<{ key: string; label: string; done: boolean }>;

export class DriverStatusError extends DomainError {
  readonly code = "DRIVER_STATUS_TRANSITION";
  constructor(message: string) {
    super(message);
  }
}

const TRANSITIONS: Readonly<Record<DriverStatus, readonly DriverStatus[]>> = {
  applicant: ["active", "terminated"],
  active: ["suspended", "terminated"],
  suspended: ["active", "terminated"],
  terminated: ["applicant"],
};

/**
 * A driver (docs/09 §4): applicant → active → suspended ↔ active → terminated (rehiring starts
 * again as an applicant). Becoming active needs the onboarding checklist complete; suspending,
 * terminating, reinstating and rehiring need a reason.
 */
export class Driver {
  private constructor(private props: DriverProps) {}

  static register(
    params: Readonly<{
      id: string;
      code: string;
      branchId: string;
      details: DriverDetails;
      createdBy: string | null;
      now: Date;
    }>,
  ): { driver: Driver; change: DriverStatusChange } {
    const driver = new Driver({
      ...normalise(params.details),
      id: params.id,
      code: params.code,
      status: "applicant",
      statusReason: null,
      statusChangedAt: params.now,
      terminatedOn: null,
      branchId: params.branchId,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
      deletedAt: null,
      deletedReason: null,
    });
    return { driver, change: { from: null, to: "applicant", reason: "Registered" } };
  }

  static restore(props: DriverProps): Driver {
    return new Driver(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): DriverStatus {
    return this.props.status;
  }

  get branchId(): string {
    return this.props.branchId;
  }

  snapshot(): DriverProps {
    return this.props;
  }

  update(changes: Partial<DriverDetails>, now: Date): void {
    this.props = { ...this.props, ...normalise({ ...this.props, ...changes }), updatedAt: now };
  }

  moveToBranch(branchId: string, now: Date): void {
    this.props = { ...this.props, branchId, updatedAt: now };
  }

  /** The onboarding checklist (docs/09 §4) for the facts kept outside the driver row. */
  onboarding(
    facts: Readonly<{ guarantors: number; documentTypes: readonly string[] }>,
    rules: DriverOnboardingRules,
    today: string,
  ): OnboardingItem[] {
    const p = this.props;
    const items: OnboardingItem[] = [];
    if (rules.requireGhanaCard)
      items.push({
        key: "ghana_card",
        label: "Ghana Card number",
        done: p.ghanaCardNumber !== null,
      });
    if (rules.requireValidLicence)
      items.push({
        key: "licence",
        label: "Driving licence (number, class, not expired)",
        done:
          p.licenceNumber !== null &&
          p.licenceClass !== null &&
          p.licenceExpiresOn !== null &&
          p.licenceExpiresOn >= today,
      });
    if (rules.requiredGuarantors > 0)
      items.push({
        key: "guarantors",
        label: `${rules.requiredGuarantors} guarantor${rules.requiredGuarantors === 1 ? "" : "s"}`,
        done: facts.guarantors >= rules.requiredGuarantors,
      });
    for (const type of rules.requiredDocuments)
      items.push({
        key: `document:${type}`,
        label: `Document: ${type.replaceAll("_", " ")}`,
        done: facts.documentTypes.includes(type),
      });
    return items;
  }

  changeStatus(
    to: DriverStatus,
    params: Readonly<{
      reason: string | null;
      today: string;
      now: Date;
      /** The onboarding checklist, needed to become active. */
      checklist?: readonly OnboardingItem[];
    }>,
  ): DriverStatusChange {
    const from = this.props.status;
    if (!TRANSITIONS[from].includes(to))
      throw new DriverStatusError(`A driver who is ${from} cannot become ${to}`);
    const reason = params.reason?.trim() ?? null;
    if (to !== "active" || from === "suspended") {
      if (reason === null || reason.length < 3)
        throw new DriverStatusError("Give a reason for the change");
    }
    if (to === "active") {
      const missing = (params.checklist ?? []).filter((i) => !i.done).map((i) => i.label);
      if (missing.length > 0)
        throw new DriverStatusError(`Complete onboarding first: ${missing.join(", ")}`);
    }
    this.props = {
      ...this.props,
      status: to,
      statusReason: reason,
      statusChangedAt: params.now,
      hiredOn:
        to === "active" && from === "applicant"
          ? (this.props.hiredOn ?? params.today)
          : this.props.hiredOn,
      terminatedOn:
        to === "terminated" ? params.today : to === "applicant" ? null : this.props.terminatedOn,
      updatedAt: params.now,
    };
    return { from, to, reason };
  }

  /** Removes a mistaken entry (hidden, kept with the reason); only applicants and the terminated. */
  remove(reason: string, now: Date): void {
    if (this.props.status === "active" || this.props.status === "suspended")
      throw new DriverStatusError("Terminate the driver instead of removing them");
    if (reason.trim().length < 3) throw new DriverStatusError("Give a reason for removing them");
    this.props = { ...this.props, deletedAt: now, deletedReason: reason.trim(), updatedAt: now };
  }
}

function normalise(d: DriverDetails): DriverDetails {
  const licenceIssuedOn = optionalDate(d.licenceIssuedOn, "Licence issue date");
  const licenceExpiresOn = optionalDate(d.licenceExpiresOn, "Licence expiry");
  if (licenceIssuedOn !== null && licenceExpiresOn !== null && licenceExpiresOn <= licenceIssuedOn)
    throw new InvalidPartyError("The licence must expire after it was issued");
  return {
    ...d,
    firstName: requiredText(d.firstName, "First name", 80),
    lastName: requiredText(d.lastName, "Last name", 80),
    otherNames: optionalText(d.otherNames, "Other names", 80),
    phone: PhoneNumber.parse(d.phone).value,
    altPhone: optionalPhone(d.altPhone),
    email: optionalEmail(d.email),
    dateOfBirth: optionalDate(d.dateOfBirth, "Date of birth"),
    address: optionalText(d.address, "Address", 300),
    ghanaCardNumber: d.ghanaCardNumber === null ? null : parseGhanaCard(d.ghanaCardNumber),
    licenceNumber: optionalText(d.licenceNumber, "Licence number", 30)?.toUpperCase() ?? null,
    licenceIssuedOn,
    licenceExpiresOn,
    hiredOn: optionalDate(d.hiredOn, "Hire date"),
    emergencyContact: checkEmergencyContact(d.emergencyContact),
    payout: checkPayout(d.payout),
    tags: normaliseTags(d.tags),
    notes: optionalText(d.notes, "Notes", 4_000),
  };
}
