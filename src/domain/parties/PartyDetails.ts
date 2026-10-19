import { DomainError } from "../errors/DomainError.js";
import { PhoneNumber } from "../value-objects/PhoneNumber.js";

export class InvalidPartyError extends DomainError {
  readonly code = "INVALID_PARTY";
  constructor(message: string) {
    super(message);
  }
}

/** Ghana DVLA licence classes (A motorbikes … F articulated/agricultural). */
export const LICENCE_CLASSES = ["A", "B", "C", "D", "E", "F"] as const;
export type LicenceClass = (typeof LICENCE_CLASSES)[number];

export const MOMO_NETWORKS = ["mtn", "telecel", "at"] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];

/** Where a party is paid (record only: the business pays outside the system, decision 16). */
export type PayoutDetails = Readonly<{
  momoNumber: string | null;
  momoNetwork: MomoNetwork | null;
  momoName: string | null;
  bankName: string | null;
  bankBranch: string | null;
  accountName: string | null;
  accountNumber: string | null;
}>;

export type EmergencyContact = Readonly<{
  name: string;
  phone: string;
  relationship: string | null;
}>;

/**
 * A Ghana Card (national ID) number, `GHA-123456789-1`. Accepts any case, spaces and missing
 * hyphens ("gha 123456789 1").
 */
export function parseGhanaCard(input: string): string {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  const match = /^GHA(\d{9})(\d)$/.exec(compact);
  if (match === null) throw new InvalidPartyError("A Ghana Card number looks like GHA-123456789-1");
  return `GHA-${match[1]}-${match[2]}`;
}

/** GHA-•••••6789-1, for people without access to identity documents. */
export function maskGhanaCard(value: string): string {
  return `GHA-•••••${value.slice(9, 13)}-${value.slice(-1)}`;
}

/** Trimmed text or null; refuses text over `max` characters. */
export function optionalText(
  value: string | null | undefined,
  label: string,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) throw new InvalidPartyError(`${label} is too long (max ${max})`);
  return trimmed;
}

export function requiredText(value: string | null | undefined, label: string, max: number): string {
  const text = optionalText(value, label, max);
  if (text === null) throw new InvalidPartyError(`${label} is required`);
  return text;
}

export function optionalPhone(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.trim() === ""
    ? null
    : PhoneNumber.parse(value).value;
}

export function optionalEmail(value: string | null | undefined): string | null {
  const email = optionalText(value, "Email", 254)?.toLowerCase() ?? null;
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new InvalidPartyError("Enter a valid email address");
  return email;
}

export function optionalDate(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new InvalidPartyError(`${label} is a date (YYYY-MM-DD)`);
  return value;
}

export function normaliseTags(tags: readonly string[]): string[] {
  const result = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
  if (result.length > 20 || result.some((t) => t.length > 40))
    throw new InvalidPartyError("At most 20 tags of up to 40 characters");
  return result;
}

export function checkPayout(payout: PayoutDetails | null): PayoutDetails | null {
  if (payout === null) return null;
  const result: PayoutDetails = {
    momoNumber: optionalPhone(payout.momoNumber),
    momoNetwork: payout.momoNetwork,
    momoName: optionalText(payout.momoName, "MoMo name", 120),
    bankName: optionalText(payout.bankName, "Bank", 120),
    bankBranch: optionalText(payout.bankBranch, "Bank branch", 120),
    accountName: optionalText(payout.accountName, "Account name", 120),
    accountNumber: optionalText(payout.accountNumber, "Account number", 34),
  };
  if ((result.momoNumber === null) !== (result.momoNetwork === null))
    throw new InvalidPartyError("A mobile money number needs its network, and the other way round");
  if ((result.bankName === null) !== (result.accountNumber === null))
    throw new InvalidPartyError("Bank details need the bank and the account number");
  if (result.accountNumber !== null && !/^[0-9A-Z -]{4,34}$/i.test(result.accountNumber))
    throw new InvalidPartyError("An account number has digits and letters only");
  return Object.values(result).every((v) => v === null) ? null : result;
}

export function checkEmergencyContact(contact: EmergencyContact | null): EmergencyContact | null {
  if (contact === null) return null;
  return {
    name: requiredText(contact.name, "Emergency contact name", 120),
    phone: PhoneNumber.parse(contact.phone).value,
    relationship: optionalText(contact.relationship, "Relationship", 60),
  };
}
