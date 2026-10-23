import type { InvoiceLine } from "../billing/Invoice.js";
import { DomainError } from "../errors/DomainError.js";

export type CommissionType = "standard" | "enterprise";
export type PayoutMethod = "momo" | "bank" | "cash" | "cheque" | "other";

/** A reseller's deal (docs/29 §4.3): percentages as decimal strings ("10.00"). */
export type CommissionTermsInput = Readonly<{
  standardPercent: string | null;
  enterprisePercent: string | null;
  holdDays: number;
  minPayoutMinor: number;
  capPerTenantMinor: number | null;
}>;

export type CommissionTerms = CommissionTermsInput &
  Readonly<{
    id: string;
    partnerId: string;
    version: number;
    reason: string;
    createdBy: string;
    effectiveFrom: Date;
  }>;

export class CommissionRuleError extends DomainError {
  readonly code = "COMMISSION_RULE";
  constructor(message: string) {
    super(message);
  }
}

const PERCENT = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;

/** A percentage as basis points (10.5 % → 1050); null when absent. */
export function basisPoints(percent: string | null): number | null {
  if (percent === null) return null;
  if (!PERCENT.test(percent))
    throw new CommissionRuleError("Percentages are 0 to 100, two decimals");
  return Math.round(Number(percent) * 100);
}

export const percentOf = (bp: number) => (bp / 100).toFixed(2);

/** Checks terms staff save: real percentages above zero, sane hold, payout minimum and cap. */
export function commissionTerms(input: CommissionTermsInput): CommissionTermsInput {
  const norm = (p: string | null) => {
    const bp = basisPoints(p === null ? null : p.trim());
    if (bp === 0) throw new CommissionRuleError("Leave a type empty for no commission, not 0 %");
    return bp === null ? null : percentOf(bp);
  };
  if (!Number.isInteger(input.holdDays) || input.holdDays < 0 || input.holdDays > 180)
    throw new CommissionRuleError("The hold period is 0 to 180 days");
  if (!Number.isInteger(input.minPayoutMinor) || input.minPayoutMinor < 0)
    throw new CommissionRuleError("The minimum payout is a whole amount, zero or more");
  if (
    input.capPerTenantMinor !== null &&
    (!Number.isInteger(input.capPerTenantMinor) || input.capPerTenantMinor <= 0)
  )
    throw new CommissionRuleError("The cap per tenant is a whole amount above zero");
  return {
    standardPercent: norm(input.standardPercent),
    enterprisePercent: norm(input.enterprisePercent),
    holdDays: input.holdDays,
    minPayoutMinor: input.minPayoutMinor,
    capPerTenantMinor: input.capPerTenantMinor,
  };
}

/**
 * The commission base of a payment (decision 54): the licence share of what was collected,
 * excluding VAT. Licence lines are those flagged `countsAsLicence`; discounts reduce licence and
 * other lines pro rata; one-time setup and other costs never count. A payment covers the
 * invoice pro rata (partial payments earn pro rata).
 */
export function licenceBase(
  invoice: Readonly<{ lines: readonly InvoiceLine[]; totalMinor: number }>,
  paymentMinor: number,
): number {
  const positive = invoice.lines.filter((l) => l.amountMinor > 0);
  const licenceGross = positive
    .filter((l) => l.countsAsLicence)
    .reduce((sum, l) => sum + l.amountMinor, 0);
  const gross = positive.reduce((sum, l) => sum + l.amountMinor, 0);
  if (licenceGross === 0 || gross === 0 || invoice.totalMinor <= 0) return 0;
  const discounts = invoice.lines
    .filter((l) => l.amountMinor < 0)
    .reduce((sum, l) => sum + l.amountMinor, 0);
  const licenceNet = licenceGross + (discounts * licenceGross) / gross;
  return Math.max(0, Math.round((paymentMinor * licenceNet) / invoice.totalMinor));
}

/** `base` × `bp` basis points, rounded half up, never above what the cap leaves. */
export function commissionAmount(base: number, bp: number, capLeft: number | null): number {
  const amount = Math.round((base * bp) / 10_000);
  return capLeft === null ? amount : Math.max(0, Math.min(amount, capLeft));
}

/** What a refund takes back of the commission a payment earned (pro rata, never more). */
export function clawbackAmount(
  earnedMinor: number,
  alreadyClawedMinor: number,
  paymentMinor: number,
  refundMinor: number,
): number {
  const share = Math.round((earnedMinor * refundMinor) / paymentMinor);
  return Math.max(0, Math.min(share, earnedMinor - alreadyClawedMinor));
}

/** What each payout method must record (docs/29 §5.1). */
export function payoutRecord(
  method: PayoutMethod,
  input: Readonly<{
    reference: string | null;
    details: Readonly<Record<string, string>>;
    proofFileIds: readonly string[];
  }>,
): void {
  const need = (key: string, label: string) => {
    if ((input.details[key] ?? "").trim() === "")
      throw new CommissionRuleError(`A ${method} payout needs the ${label}`);
  };
  const reference = (input.reference ?? "").trim();
  if (method === "momo") {
    need("network", "MoMo network");
    need("number", "MoMo number");
    if (reference === "") throw new CommissionRuleError("A MoMo payout needs its transaction ID");
  }
  if (method === "bank") {
    need("bank", "bank");
    need("account", "account (masked)");
    if (reference === "") throw new CommissionRuleError("A bank payout needs its reference");
    if (input.proofFileIds.length === 0)
      throw new CommissionRuleError("A bank payout needs the deposit slip or transfer proof");
  }
  if ((method === "cheque" || method === "other") && reference === "")
    throw new CommissionRuleError("Record the cheque number or reference");
  if (method === "other") need("description", "description");
}
