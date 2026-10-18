export type NumberingFormat = Readonly<{
  /** Letters/digits shown before the number, e.g. "INV". */
  prefix: string;
  /** Minimum digits (zero-padded). */
  padding: number;
  /** Restart numbering every calendar year (INV-2026-000123). */
  yearly: boolean;
}>;

export type OrganisationView = Readonly<{
  name: string;
  legalName: string | null;
  country: string;
  baseCurrency: string;
  timezone: string;
  tin: string | null;
  registrationNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  numbering: Readonly<Record<string, NumberingFormat>>;
  /** The business logo (public file), if one is set. */
  logo: Readonly<{ fileId: string; url: string }> | null;
}>;

/** The stored organisation row: the logo as file id and storage key (turned into a URL above). */
export type OrganisationRecord = Omit<OrganisationView, "logo"> &
  Readonly<{ logoFileId: string | null; logoStorageKey: string | null }>;

/** Base currency changes go through the currency settings (lock rule, docs/20 §3). */
export type OrganisationChanges = Partial<
  Omit<OrganisationView, "country" | "numbering" | "logo" | "baseCurrency">
>;

export type CurrencySettings = Readonly<{
  baseCurrency: string;
  /** Currencies users may pick on documents; always includes the base currency. */
  enabledCurrencies: readonly string[];
  display: Readonly<{ showCodeForForeign: boolean }>;
  /** Set by the first financial transaction: the base currency cannot change after. */
  baseCurrencyLockedAt: Date | null;
}>;

export type TaxScheme = "not_registered" | "standard" | "flat_rate";

export type TaxSettings = Readonly<{
  scheme: TaxScheme;
  vatNumber: string | null;
  /** Prices are entered tax-inclusive (the tax is worked back). */
  pricesIncludeTax: boolean;
  defaultSalesTaxCode: string | null;
}>;

export const DEFAULT_TAX_SETTINGS: TaxSettings = Object.freeze({
  scheme: "not_registered",
  vatNumber: null,
  pricesIncludeTax: false,
  defaultSalesTaxCode: null,
});

/** The organisation row of the current tenant (tenant unit of work). */
export interface IOrganisationSettings {
  get(): Promise<OrganisationRecord>;
  setLogo(fileId: string | null): Promise<void>;
  update(changes: OrganisationChanges): Promise<void>;
  setNumbering(numbering: Readonly<Record<string, NumberingFormat>>): Promise<void>;
  currencySettings(): Promise<CurrencySettings>;
  setCurrencySettings(
    settings: Readonly<{
      baseCurrency: string;
      enabledCurrencies: readonly string[];
      display: CurrencySettings["display"];
    }>,
  ): Promise<void>;
  taxSettings(): Promise<TaxSettings>;
  setTaxSettings(settings: TaxSettings): Promise<void>;
}
