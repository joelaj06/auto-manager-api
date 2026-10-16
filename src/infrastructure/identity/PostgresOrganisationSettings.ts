import type {
  IOrganisationSettings,
  NumberingFormat,
  OrganisationChanges,
  OrganisationView,
} from "../../application/ports/IOrganisationSettings.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const COLUMNS: Readonly<Record<keyof OrganisationChanges, string>> = {
  name: "name",
  legalName: "legal_name",
  baseCurrency: "base_currency",
  timezone: "timezone",
  tin: "tin",
  registrationNumber: "registration_number",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
};

export class PostgresOrganisationSettings implements IOrganisationSettings {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<OrganisationView> {
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
    }>(
      `select name, legal_name, country, base_currency, timezone, tin, registration_number,
              contact_email::text as contact_email, contact_phone, settings->'numbering' as numbering
         from organisation`,
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
    };
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

  async setNumbering(numbering: Readonly<Record<string, NumberingFormat>>): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{numbering}', $1::jsonb), updated_at = now()",
        [JSON.stringify(numbering)],
      );
  }
}
