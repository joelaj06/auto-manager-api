import { DomainError } from "../errors/DomainError.js";

export type CurrencyInfo = Readonly<{
  code: string;
  name: string;
  /** Narrow symbol for screens (₵); SMS and exports use the code (docs/20 §7). */
  symbol: string;
  /** Digits after the decimal point: 2 for GHS (pesewas), 0 for XOF and KRW. */
  minorUnits: number;
  locale: string;
}>;

/** ISO 4217 currencies for the market (docs/20 §4). GHS is the default. */
const currencies = {
  GHS: { code: "GHS", name: "Ghana Cedi", symbol: "₵", minorUnits: 2, locale: "en-GH" },
  USD: { code: "USD", name: "US Dollar", symbol: "$", minorUnits: 2, locale: "en-US" },
  EUR: { code: "EUR", name: "Euro", symbol: "€", minorUnits: 2, locale: "en-IE" },
  GBP: { code: "GBP", name: "Pound Sterling", symbol: "£", minorUnits: 2, locale: "en-GB" },
  NGN: { code: "NGN", name: "Nigerian Naira", symbol: "₦", minorUnits: 2, locale: "en-NG" },
  XOF: {
    code: "XOF",
    name: "West African CFA Franc",
    symbol: "CFA",
    minorUnits: 0,
    locale: "fr-SN",
  },
  KES: { code: "KES", name: "Kenyan Shilling", symbol: "KSh", minorUnits: 2, locale: "en-KE" },
  ZAR: { code: "ZAR", name: "South African Rand", symbol: "R", minorUnits: 2, locale: "en-ZA" },
  CAD: { code: "CAD", name: "Canadian Dollar", symbol: "CA$", minorUnits: 2, locale: "en-CA" },
  KRW: { code: "KRW", name: "South Korean Won", symbol: "₩", minorUnits: 0, locale: "ko-KR" },
  AED: { code: "AED", name: "UAE Dirham", symbol: "AED", minorUnits: 2, locale: "en-AE" },
} as const satisfies Record<string, CurrencyInfo>;

export type CurrencyCode = keyof typeof currencies;

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyInfo>> = Object.freeze(currencies);
export const CURRENCY_CODES = Object.freeze(Object.keys(currencies) as CurrencyCode[]);
export const DEFAULT_CURRENCY: CurrencyCode = "GHS";

export class UnknownCurrencyError extends DomainError {
  readonly code = "UNKNOWN_CURRENCY";
  constructor(code: string) {
    super(`Unknown currency "${code}"`);
  }
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.hasOwn(CURRENCIES, value);
}

export function currencyInfo(code: string): CurrencyInfo {
  if (!isCurrencyCode(code)) throw new UnknownCurrencyError(code);
  return CURRENCIES[code];
}

/** Suggested base currency for a country (signup, docs/20 §9); GHS otherwise. */
export function defaultCurrencyFor(country: string): CurrencyCode {
  const upper = country.toUpperCase();
  if (upper === "NG") return "NGN";
  if (["BJ", "BF", "CI", "GW", "ML", "NE", "SN", "TG"].includes(upper)) return "XOF";
  if (upper === "KE") return "KES";
  if (upper === "ZA") return "ZAR";
  return DEFAULT_CURRENCY;
}
