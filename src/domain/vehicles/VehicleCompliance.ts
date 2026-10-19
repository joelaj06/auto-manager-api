import { InvalidVehicleError } from "./VehicleIdentifiers.js";

export const VEHICLE_DOCUMENT_TYPES = [
  "registration",
  "roadworthy",
  "insurance",
  "income_tax_sticker",
  "permit",
  "customs",
  "other",
] as const;

export type VehicleDocumentType = (typeof VEHICLE_DOCUMENT_TYPES)[number];

/** Reminder days before expiry when the business sets none (docs/06 §4). */
export const DEFAULT_REMINDER_DAYS: Readonly<Record<VehicleDocumentType, readonly number[]>> = {
  registration: [],
  roadworthy: [30, 14, 3],
  insurance: [30, 14, 3],
  income_tax_sticker: [14, 3],
  permit: [30],
  customs: [],
  other: [],
};

export type DocumentState = "valid" | "expiring" | "expired" | "missing";
/** Red: cannot legally operate; amber: something expires soon; green: all in order. */
export type ComplianceLevel = "green" | "amber" | "red";

export type ComplianceDocument = Readonly<{
  id: string;
  type: VehicleDocumentType;
  issuedOn: string | null;
  expiresOn: string | null;
}>;

export type ComplianceRules = Readonly<{
  requiredDocuments: readonly VehicleDocumentType[];
  expiringWithinDays: number;
}>;

export type ComplianceItem = Readonly<{
  type: VehicleDocumentType;
  required: boolean;
  state: DocumentState;
  documentId: string | null;
  expiresOn: string | null;
  /** Days until expiry (negative: days since); null without an expiry date. */
  daysLeft: number | null;
}>;

export type ComplianceStatus = Readonly<{
  level: ComplianceLevel;
  canOperate: boolean;
  items: readonly ComplianceItem[];
}>;

const DAY_MS = 86_400_000;
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * A vehicle's compliance on a date (docs/06 §4). Per document type the most recent document
 * counts (a renewal replaces the old one): no expiry date means it does not expire. Required
 * types that are missing or expired make the vehicle red (it cannot legally operate); anything
 * expiring within the window, or an optional document that expired, makes it amber. "Other"
 * documents are kept but never judged.
 */
export function evaluateCompliance(
  documents: readonly ComplianceDocument[],
  rules: ComplianceRules,
  today: string,
): ComplianceStatus {
  const required = new Set(rules.requiredDocuments);
  const types = VEHICLE_DOCUMENT_TYPES.filter(
    (type) => type !== "other" && (required.has(type) || documents.some((d) => d.type === type)),
  );
  const items = types.map((type): ComplianceItem => {
    const latest = current(documents.filter((d) => d.type === type));
    const isRequired = required.has(type);
    if (latest === null)
      return {
        type,
        required: isRequired,
        state: "missing",
        documentId: null,
        expiresOn: null,
        daysLeft: null,
      };
    const daysLeft = latest.expiresOn === null ? null : days(today, latest.expiresOn);
    const state: DocumentState =
      daysLeft === null
        ? "valid"
        : daysLeft < 0
          ? "expired"
          : daysLeft <= rules.expiringWithinDays
            ? "expiring"
            : "valid";
    return {
      type,
      required: isRequired,
      state,
      documentId: latest.id,
      expiresOn: latest.expiresOn,
      daysLeft,
    };
  });
  const red = items.some((i) => i.required && (i.state === "missing" || i.state === "expired"));
  const amber = items.some((i) => i.state === "expiring" || (!i.required && i.state === "expired"));
  return { level: red ? "red" : amber ? "amber" : "green", canOperate: !red, items };
}

/** The document in force: the one expiring last (no expiry wins), then the latest issued. */
function current(documents: readonly ComplianceDocument[]): ComplianceDocument | null {
  const sorted = [...documents].sort((a, b) => {
    if (a.expiresOn !== b.expiresOn) {
      if (a.expiresOn === null) return -1;
      if (b.expiresOn === null) return 1;
      return b.expiresOn.localeCompare(a.expiresOn);
    }
    return (b.issuedOn ?? "").localeCompare(a.issuedOn ?? "");
  });
  return sorted[0] ?? null;
}

export function checkReminderDays(values: readonly number[]): number[] {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.length > 5 || unique.some((d) => !Number.isInteger(d) || d < 0 || d > 365))
    throw new InvalidVehicleError("Up to 5 reminder days, each from 0 to 365");
  return unique;
}
