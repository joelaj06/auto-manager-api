import type { TaxCodeProps } from "./TaxCode.js";

/**
 * The tax codes a new business starts with, by country (decision 168). Ghana: the standard rate
 * as one code with its three levies on the same taxable value (VAT Act 2025, Act 1151, from
 * 1 January 2026), zero-rated and exempt. Elsewhere: zero-rated and exempt only; the business
 * adds its own rates. Every rate stays editable (new periods, end dates).
 */
export function standardTaxCodes(country: string, newId: () => string): TaxCodeProps[] {
  const both = ["sales", "purchases"] as const;
  const codes: TaxCodeProps[] = [
    {
      code: "ZERO_RATED",
      name: "Zero-rated supply",
      kind: "zero_rated",
      appliesTo: both,
      components: [],
      active: true,
    },
    {
      code: "EXEMPT",
      name: "Exempt supply",
      kind: "exempt",
      appliesTo: both,
      components: [],
      active: true,
    },
  ];
  if (country !== "GH") return codes;
  const component = (key: string, name: string, rate: string) => ({
    id: newId(),
    key,
    name,
    rate,
    base: "net" as const,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
  });
  return [
    {
      code: "VAT_STANDARD",
      name: "Standard rate (VAT + NHIL + GETFund)",
      kind: "standard",
      appliesTo: both,
      components: [
        component("vat", "VAT", "15"),
        component("nhil", "NHIL", "2.5"),
        component("getfund", "GETFund Levy", "2.5"),
      ],
      active: true,
    },
    ...codes,
  ];
}
