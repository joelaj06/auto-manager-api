import type { CustomerProps, CustomerType, RiskStatus } from "../../domain/parties/Customer.js";
import type {
  DriverOnboardingRules,
  DriverProps,
  DriverStatus,
  EmploymentType,
} from "../../domain/parties/Driver.js";
import type { SupplierProps, SupplierType } from "../../domain/parties/Supplier.js";

/** Keyset cursor: created-at and id of the last record of the previous page. */
export type CreatedCursor = Readonly<{ createdAt: string; id: string }>;

export type DriverListFilter = Readonly<{
  /** Branches the caller may see; drivers of inactive branches never show. */
  branchIds: "all" | readonly string[];
  branchId?: string;
  statuses?: readonly DriverStatus[];
  employmentType?: EmploymentType;
  /** Name, code, phone (any format) or licence number. */
  search?: string;
  limit: number;
  after?: CreatedCursor;
}>;

export interface IDriverQueries {
  list(filter: DriverListFilter): Promise<DriverProps[]>;
  /** Drivers not terminated (nor removed) in a branch. */
  countInBranch(branchId: string): Promise<number>;
  /** Drivers (not terminated) whose licence expires on or before `until`, soonest first. */
  expiringLicences(branchIds: "all" | readonly string[], until: string): Promise<DriverProps[]>;
}

export type CustomerListFilter = Readonly<{
  type?: CustomerType;
  riskStatus?: RiskStatus;
  /** Name, code, phone (any format), email or Ghana Card number. */
  search?: string;
  limit: number;
  after?: CreatedCursor;
}>;

export interface ICustomerQueries {
  list(filter: CustomerListFilter): Promise<CustomerProps[]>;
}

export type SupplierListFilter = Readonly<{
  type?: SupplierType;
  includeInactive?: boolean;
  search?: string;
}>;

export interface ISupplierQueries {
  /** By name; a business has few enough suppliers to list them all. */
  list(filter: SupplierListFilter): Promise<SupplierProps[]>;
}

export type Guarantor = Readonly<{
  id: string;
  driverId: string;
  name: string;
  phone: string;
  relationship: string | null;
  address: string | null;
  occupation: string | null;
  ghanaCardNumber: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface IDriverGuarantors {
  list(driverId: string): Promise<Guarantor[]>;
  get(id: string): Promise<Guarantor | null>;
  save(guarantor: Guarantor): Promise<void>;
  remove(id: string): Promise<void>;
}

export const PARTY_TYPES = ["driver", "driver_guarantor", "customer"] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const PARTY_DOCUMENT_TYPES = [
  "ghana_card",
  "passport",
  "drivers_licence",
  "voters_id",
  "passport_photo",
  "proof_of_address",
  "police_report",
  "contract",
  "business_registration",
  "other",
] as const;
export type PartyDocumentType = (typeof PARTY_DOCUMENT_TYPES)[number];

export type PartyDocument = Readonly<{
  id: string;
  partyType: PartyType;
  partyId: string;
  type: PartyDocumentType;
  number: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface IPartyDocuments {
  list(partyType: PartyType, partyId: string): Promise<PartyDocument[]>;
  get(id: string): Promise<PartyDocument | null>;
  save(document: PartyDocument): Promise<void>;
  remove(id: string): Promise<void>;
}

export type PartyStatusEntry = Readonly<{
  id: string;
  from: string | null;
  to: string;
  reason: string | null;
  changedBy: string | null;
  changedAt: Date;
}>;

export interface IPartyStatusHistory {
  record(
    entry: Readonly<{
      partyType: "driver" | "customer";
      partyId: string;
      from: string | null;
      to: string;
      reason: string | null;
      changedBy: string | null;
      at: Date;
    }>,
  ): Promise<void>;
  list(partyType: "driver" | "customer", partyId: string): Promise<PartyStatusEntry[]>;
}

/** Driver onboarding rules in `organisation.settings->'drivers'` (tenant unit of work). */
export interface IDriverSettingsStore {
  get(): Promise<DriverOnboardingRules>;
  set(rules: DriverOnboardingRules): Promise<void>;
}
