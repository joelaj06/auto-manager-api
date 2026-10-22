import { DomainError } from "../errors/DomainError.js";
import { Money } from "../money/Money.js";
import { TaxCode, type TaxComponent } from "../tax/TaxCode.js";
import type { InvoiceParty, InvoiceTaxLine } from "./Invoice.js";

export class BillingSettingsError extends DomainError {
  readonly code = "BILLING_SETTINGS";
  constructor(message: string) {
    super(message);
  }
}

/** Autoforce as the seller on its invoices, and the VAT it charges (docs/25 §3). */
export type BillingSettings = Readonly<{
  sellerName: string;
  sellerAddress: string | null;
  sellerTin: string | null;
  sellerEmail: string | null;
  sellerPhone: string | null;
  /** Off until the accountant confirms the registration: invoices then carry no tax. */
  vatRegistered: boolean;
  vatNumber: string | null;
  /** The levies on the fee when registered (Ghana: VAT, NHIL, GETFund on the same value). */
  taxComponents: readonly TaxComponent[];
  /** How to pay outside the gateway (bank, MoMo merchant), printed on invoices. */
  paymentInstructions: string | null;
  invoiceDueDays: number;
}>;

const text = (value: string | null, max: number, name: string) => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > max) throw new BillingSettingsError(`${name} is at most ${max} characters`);
  return trimmed === "" ? null : trimmed;
};

/** Checked settings: a registered seller has a VAT number and rates in force. */
export function billingSettings(input: BillingSettings): BillingSettings {
  const sellerName = input.sellerName.trim();
  if (sellerName.length < 2 || sellerName.length > 160)
    throw new BillingSettingsError("The seller's name is 2 to 160 characters");
  if (
    !Number.isInteger(input.invoiceDueDays) ||
    input.invoiceDueDays < 0 ||
    input.invoiceDueDays > 60
  )
    throw new BillingSettingsError("Invoices are due 0 to 60 days after issue");
  // Validates the components like a tenant tax code (rates, keys, effective dates, overlaps).
  taxCodeOf(input.taxComponents);
  const settings: BillingSettings = {
    sellerName,
    sellerAddress: text(input.sellerAddress, 500, "The address"),
    sellerTin: text(input.sellerTin, 40, "The TIN"),
    sellerEmail: text(input.sellerEmail, 200, "The email"),
    sellerPhone: text(input.sellerPhone, 40, "The phone"),
    vatRegistered: input.vatRegistered,
    vatNumber: text(input.vatNumber, 40, "The VAT number"),
    taxComponents: input.taxComponents,
    paymentInstructions: text(input.paymentInstructions, 1_000, "Payment instructions"),
    invoiceDueDays: input.invoiceDueDays,
  };
  if (settings.vatRegistered && settings.vatNumber === null)
    throw new BillingSettingsError("A VAT-registered seller needs its VAT number");
  if (settings.vatRegistered && settings.taxComponents.length === 0)
    throw new BillingSettingsError("Enter the VAT rates before charging VAT");
  return settings;
}

function taxCodeOf(components: readonly TaxComponent[]): TaxCode {
  return TaxCode.create({
    code: "PLATFORM_VAT",
    name: "Tax on the subscription",
    kind: "standard",
    appliesTo: ["sales"],
    components,
    active: components.length > 0,
  });
}

/** The tax on an invoice's subtotal on `date`: none unless VAT-registered (prices exclude tax). */
export function billingTax(
  settings: BillingSettings,
  subtotalMinor: number,
  currency: string,
  date: string,
): InvoiceTaxLine[] {
  if (!settings.vatRegistered || subtotalMinor <= 0) return [];
  const line = taxCodeOf(settings.taxComponents).apply(
    Money.ofMinor(subtotalMinor, currency),
    date,
    false,
  );
  return line.components.map((c) => ({
    key: c.key,
    name: c.name,
    rate: c.rate,
    amountMinor: c.amount.amountMinor,
  }));
}

/** The seller as printed on an invoice. */
export const sellerParty = (s: BillingSettings): InvoiceParty => ({
  name: s.sellerName,
  address: s.sellerAddress,
  tin: s.sellerTin,
  vatNumber: s.vatRegistered ? s.vatNumber : null,
  email: s.sellerEmail,
  phone: s.sellerPhone,
});
