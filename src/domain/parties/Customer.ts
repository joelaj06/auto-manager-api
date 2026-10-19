import { DomainError } from "../errors/DomainError.js";
import {
  InvalidPartyError,
  normaliseTags,
  optionalDate,
  optionalEmail,
  optionalPhone,
  optionalText,
  parseGhanaCard,
  requiredText,
  type LicenceClass,
} from "./PartyDetails.js";

export const CUSTOMER_TYPES = ["individual", "corporate"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const RISK_STATUSES = ["ok", "watch", "blacklisted"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
export const CUSTOMER_SOURCES = [
  "walk_in",
  "referral",
  "website",
  "social",
  "phone",
  "corporate",
  "other",
] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

export type CustomerDetails = Readonly<{
  type: CustomerType;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  address: string | null;
  dateOfBirth: string | null;
  occupation: string | null;
  ghanaCardNumber: string | null;
  licenceNumber: string | null;
  licenceClass: LicenceClass | null;
  licenceExpiresOn: string | null;
  registrationNumber: string | null;
  tin: string | null;
  contactPerson: string | null;
  /** Corporate credit limit in minor units of the base currency. */
  creditLimitMinor: number | null;
  paymentTermsDays: number | null;
  source: CustomerSource | null;
  homeBranchId: string | null;
  tags: readonly string[];
  notes: string | null;
}>;

export type CustomerProps = CustomerDetails &
  Readonly<{
    id: string;
    code: string;
    name: string;
    riskStatus: RiskStatus;
    riskReason: string | null;
    riskChangedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    deletedReason: string | null;
  }>;

export class CustomerRiskError extends DomainError {
  readonly code = "CUSTOMER_RISK";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A customer (docs/05 §2.2, docs/07 KYC): an individual or a company, shared by every branch
 * (decision 157). A watch or blacklist status with its reason follows the customer everywhere;
 * rentals and sales refuse blacklisted customers.
 */
export class Customer {
  private constructor(private props: CustomerProps) {}

  static register(
    params: Readonly<{
      id: string;
      code: string;
      details: CustomerDetails;
      createdBy: string | null;
      now: Date;
    }>,
  ): Customer {
    const details = normalise(params.details);
    return new Customer({
      ...details,
      name: displayName(details),
      id: params.id,
      code: params.code,
      riskStatus: "ok",
      riskReason: null,
      riskChangedAt: null,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
      deletedAt: null,
      deletedReason: null,
    });
  }

  static restore(props: CustomerProps): Customer {
    return new Customer(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): CustomerProps {
    return this.props;
  }

  update(changes: Partial<CustomerDetails>, now: Date): void {
    const details = normalise({ ...this.props, ...changes });
    this.props = { ...this.props, ...details, name: displayName(details), updatedAt: now };
  }

  /** Puts the customer on watch, blacklists them or clears them; returns the previous status. */
  setRisk(status: RiskStatus, reason: string | null, now: Date): RiskStatus {
    const from = this.props.riskStatus;
    if (status === from) throw new CustomerRiskError(`The customer is already ${status}`);
    const text = reason?.trim() ?? "";
    if (text.length < 3) throw new CustomerRiskError("Give a reason");
    this.props = {
      ...this.props,
      riskStatus: status,
      riskReason: status === "ok" ? null : text,
      riskChangedAt: now,
      updatedAt: now,
    };
    return from;
  }

  /** Throws when the customer may not take part in a new rental or sale. */
  assertAllowed(): void {
    if (this.props.riskStatus === "blacklisted")
      throw new CustomerRiskError(
        `${this.props.name} is blacklisted: ${this.props.riskReason ?? "no reason recorded"}`,
      );
  }

  remove(reason: string, now: Date): void {
    if (reason.trim().length < 3) throw new CustomerRiskError("Give a reason for removing them");
    this.props = { ...this.props, deletedAt: now, deletedReason: reason.trim(), updatedAt: now };
  }
}

function displayName(d: CustomerDetails): string {
  return d.type === "corporate"
    ? d.companyName!
    : [d.firstName, d.lastName].filter((n) => n !== null).join(" ");
}

function normalise(d: CustomerDetails): CustomerDetails {
  const corporate = d.type === "corporate";
  const result: CustomerDetails = {
    ...d,
    firstName: corporate
      ? optionalText(d.firstName, "First name", 80)
      : requiredText(d.firstName, "First name", 80),
    lastName: corporate
      ? optionalText(d.lastName, "Last name", 80)
      : requiredText(d.lastName, "Last name", 80),
    companyName: corporate
      ? requiredText(d.companyName, "Company name", 160)
      : optionalText(d.companyName, "Company name", 160),
    phone: optionalPhone(d.phone),
    altPhone: optionalPhone(d.altPhone),
    email: optionalEmail(d.email),
    address: optionalText(d.address, "Address", 300),
    dateOfBirth: optionalDate(d.dateOfBirth, "Date of birth"),
    occupation: optionalText(d.occupation, "Occupation", 80),
    ghanaCardNumber: d.ghanaCardNumber === null ? null : parseGhanaCard(d.ghanaCardNumber),
    licenceNumber: optionalText(d.licenceNumber, "Licence number", 30)?.toUpperCase() ?? null,
    licenceExpiresOn: optionalDate(d.licenceExpiresOn, "Licence expiry"),
    registrationNumber: optionalText(d.registrationNumber, "Registration number", 40),
    tin: optionalText(d.tin, "TIN", 20)?.toUpperCase() ?? null,
    contactPerson: optionalText(d.contactPerson, "Contact person", 120),
    tags: normaliseTags(d.tags),
    notes: optionalText(d.notes, "Notes", 4_000),
  };
  if (result.phone === null && result.email === null)
    throw new InvalidPartyError("Enter a phone number or an email address");
  if (result.creditLimitMinor !== null && result.creditLimitMinor < 0)
    throw new InvalidPartyError("A credit limit cannot be negative");
  if (!corporate && (result.creditLimitMinor !== null || result.paymentTermsDays !== null))
    throw new InvalidPartyError("Credit limits and payment terms are for corporate customers");
  return result;
}
