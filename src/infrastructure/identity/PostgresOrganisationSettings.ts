import type {
  IOrganisationSettings,
  NumberingFormat,
  OrganisationChanges,
  OrganisationRecord,
  CurrencySettings,
  TaxSettings,
} from "../../application/ports/IOrganisationSettings.js";
import { DEFAULT_TAX_SETTINGS } from "../../application/ports/IOrganisationSettings.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const COLUMNS: Readonly<Record<keyof OrganisationChanges, string>> = {
  name: "name",
  legalName: "legal_name",
  timezone: "timezone",
  tin: "tin",
  registrationNumber: "registration_number",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
};

export class PostgresOrganisationSettings implements IOrganisationSettings {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<OrganisationRecord> {
    const { rows } = await this.transactions.current().query<{
      name: string;
      legal_name: string | null;
      country: string;
      base_currency: string;
      timezone: string;
      tin: string | null;
      registration_number: string | null;
      contact_email: string | null;
      contact_phone: string | null;
      numbering: Record<string, NumberingFormat> | null;
      logo_file_id: string | null;
      logo_storage_key: string | null;
    }>(
      `select o.name, o.legal_name, o.country, o.base_currency, o.timezone, o.tin,
              o.registration_number, o.contact_email::text as contact_email, o.contact_phone,
              o.settings->'numbering' as numbering, o.logo_file_id, f.storage_key as logo_storage_key
         from organisation o
         left join files f on f.id = o.logo_file_id and f.status = 'ready'`,
    );
    const r = rows[0];
    if (r === undefined) throw new Error("Organisation is not set up");
    return {
      name: r.name,
      legalName: r.legal_name,
      country: r.country,
      baseCurrency: r.base_currency,
      timezone: r.timezone,
      tin: r.tin,
      registrationNumber: r.registration_number,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      numbering: r.numbering ?? {},
      logoFileId: r.logo_file_id,
      logoStorageKey: r.logo_storage_key,
    };
  }

  async setLogo(fileId: string | null): Promise<void> {
    await this.transactions
      .current()
      .query("update organisation set logo_file_id = $1, updated_at = now()", [fileId]);
  }

  async update(changes: OrganisationChanges): Promise<void> {
    const entries = (Object.keys(COLUMNS) as (keyof OrganisationChanges)[]).filter(
      (k) => changes[k] !== undefined,
    );
    if (entries.length === 0) return;
    const sets = entries.map((k, i) => `${COLUMNS[k]} = $${i + 1}`).join(", ");
    await this.transactions.current().query(
      `update organisation set ${sets}, updated_at = now()`,
      entries.map((k) => changes[k]),
    );
  }

  async currencySettings(): Promise<CurrencySettings> {
    const { rows } = await this.transactions.current().query<{
      base_currency: string;
      currency: { enabledCurrencies?: string[]; display?: { showCodeForForeign?: boolean } } | null;
      locked_at: Date | null;
    }>(
      `select base_currency, settings->'currency' as currency, base_currency_locked_at as locked_at
         from organisation`,
    );
    const r = rows[0]!;
    const enabled = r.currency?.enabledCurrencies ?? [];
    return {
      baseCurrency: r.base_currency,
      enabledCurrencies: enabled.includes(r.base_currency)
        ? enabled
        : [r.base_currency, ...enabled],
      display: { showCodeForForeign: r.currency?.display?.showCodeForForeign ?? true },
      baseCurrencyLockedAt: r.locked_at,
    };
  }

  async setCurrencySettings(
    settings: Readonly<{
      baseCurrency: string;
      enabledCurrencies: readonly string[];
      display: CurrencySettings["display"];
    }>,
  ): Promise<void> {
    await this.transactions.current().query(
      `update organisation
          set base_currency = $1,
              settings = jsonb_set(settings, '{currency}', $2::jsonb),
              updated_at = now()`,
      [
        settings.baseCurrency,
        JSON.stringify({
          enabledCurrencies: settings.enabledCurrencies,
          display: settings.display,
        }),
      ],
    );
  }

  async taxSettings(): Promise<TaxSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ tax: Partial<TaxSettings> | null }>(
        "select settings->'tax' as tax from organisation",
      );
    return { ...DEFAULT_TAX_SETTINGS, ...(rows[0]?.tax ?? {}) };
  }

  async setTaxSettings(settings: TaxSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{tax}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }

  async setNumbering(numbering: Readonly<Record<string, NumberingFormat>>): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{numbering}', $1::jsonb), updated_at = now()",
        [JSON.stringify(numbering)],
      );
  }
}
