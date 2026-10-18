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

export type OrganisationChanges = Partial<Omit<OrganisationView, "country" | "numbering" | "logo">>;

/** The organisation row of the current tenant (tenant unit of work). */
export interface IOrganisationSettings {
  get(): Promise<OrganisationRecord>;
  setLogo(fileId: string | null): Promise<void>;
  update(changes: OrganisationChanges): Promise<void>;
  setNumbering(numbering: Readonly<Record<string, NumberingFormat>>): Promise<void>;
}
