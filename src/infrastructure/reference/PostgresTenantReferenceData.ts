import type {
  ExpenseCategory,
  FxRate,
  ITenantReferenceData,
} from "../../application/ports/IReferenceData.js";
import type {
  TaxAppliesTo,
  TaxCodeProps,
  TaxComponent,
  TaxKind,
} from "../../domain/tax/TaxCode.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TaxRow = {
  code: string;
  name: string;
  kind: TaxKind;
  applies_to: TaxAppliesTo[];
  components: TaxComponent[];
  active: boolean;
};
const toTax = (r: TaxRow): TaxCodeProps => ({
  code: r.code,
  name: r.name,
  kind: r.kind,
  appliesTo: r.applies_to,
  components: r.components,
  active: r.active,
});

type FxRow = {
  id: string;
  base: string;
  quote: string;
  rate: string;
  rate_date: string;
  source: FxRate["source"];
  entered_by: string | null;
  created_at: Date;
};
const FX_COLUMNS =
  "id, base, quote, rate::text as rate, rate_date::text as rate_date, source, entered_by, created_at";
/** numeric(20,10) comes back with trailing zeros: "15.4200000000" → "15.42". */
const trimRate = (rate: string) =>
  rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate;
const toFx = (r: FxRow): FxRate => ({
  id: r.id,
  base: r.base,
  quote: r.quote,
  rate: trimRate(r.rate),
  rateDate: r.rate_date,
  source: r.source,
  enteredBy: r.entered_by,
  createdAt: r.created_at,
});

type CategoryRow = {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  is_system: boolean;
  active: boolean;
  sort: number;
};
const toCategory = (r: CategoryRow): ExpenseCategory => ({
  id: r.id,
  parentId: r.parent_id,
  code: r.code,
  name: r.name,
  isSystem: r.is_system,
  active: r.active,
  sort: r.sort,
});
const CATEGORY_COLUMNS = "id, parent_id, code, name, is_system, active, sort";

/** Tax codes, FX rates and expense categories in the tenant database. */
export class PostgresTenantReferenceData implements ITenantReferenceData {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async taxCodes(): Promise<TaxCodeProps[]> {
    const { rows } = await this.tx.query<TaxRow>(
      "select code, name, kind, applies_to, components, active from tax_codes order by code",
    );
    return rows.map(toTax);
  }

  async taxCode(code: string): Promise<TaxCodeProps | null> {
    const { rows } = await this.tx.query<TaxRow>(
      "select code, name, kind, applies_to, components, active from tax_codes where code = $1",
      [code],
    );
    return rows[0] === undefined ? null : toTax(rows[0]);
  }

  async saveTaxCode(props: TaxCodeProps): Promise<void> {
    await this.tx.query(
      `insert into tax_codes (code, name, kind, applies_to, components, active)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (code) do update set
         name = excluded.name, kind = excluded.kind, applies_to = excluded.applies_to,
         components = excluded.components, active = excluded.active, updated_at = now()`,
      [
        props.code,
        props.name,
        props.kind,
        props.appliesTo,
        JSON.stringify(props.components),
        props.active,
      ],
    );
  }

  async fxRates(filter: Readonly<{ quote?: string; limit: number }>): Promise<FxRate[]> {
    const { rows } = await this.tx.query<FxRow>(
      `select ${FX_COLUMNS} from fx_rates
        where ($1::text is null or quote = $1)
        order by rate_date desc, quote
        limit $2`,
      [filter.quote ?? null, filter.limit],
    );
    return rows.map(toFx);
  }

  async latestFxRate(base: string, quote: string, date: string): Promise<FxRate | null> {
    const { rows } = await this.tx.query<FxRow>(
      `select ${FX_COLUMNS} from fx_rates
        where base = $1 and quote = $2 and rate_date <= $3
        order by rate_date desc limit 1`,
      [base, quote, date],
    );
    return rows[0] === undefined ? null : toFx(rows[0]);
  }

  async addFxRate(rate: Omit<FxRate, "createdAt">): Promise<void> {
    await this.tx.query(
      `insert into fx_rates (id, base, quote, rate, rate_date, source, entered_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [rate.id, rate.base, rate.quote, rate.rate, rate.rateDate, rate.source, rate.enteredBy],
    );
  }

  async fxRateExists(base: string, quote: string, date: string): Promise<boolean> {
    const { rows } = await this.tx.query<{ found: boolean }>(
      `select exists (select 1 from fx_rates
                       where base = $1 and quote = $2 and rate_date = $3) as found`,
      [base, quote, date],
    );
    return rows[0]?.found === true;
  }

  async removeFxRate(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.tx.query("delete from fx_rates where id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async expenseCategories(): Promise<ExpenseCategory[]> {
    const { rows } = await this.tx.query<CategoryRow>(
      `select ${CATEGORY_COLUMNS} from expense_categories order by sort, name`,
    );
    return rows.map(toCategory);
  }

  async expenseCategory(id: string): Promise<ExpenseCategory | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<CategoryRow>(
      `select ${CATEGORY_COLUMNS} from expense_categories where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toCategory(rows[0]);
  }

  async expenseCategoryCodeTaken(code: string): Promise<boolean> {
    const { rows } = await this.tx.query<{ taken: boolean }>(
      "select exists (select 1 from expense_categories where code = $1) as taken",
      [code],
    );
    return rows[0]?.taken === true;
  }

  async saveExpenseCategory(c: ExpenseCategory): Promise<void> {
    await this.tx.query(
      `insert into expense_categories (id, parent_id, code, name, is_system, active, sort)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set
         parent_id = excluded.parent_id, name = excluded.name, active = excluded.active,
         sort = excluded.sort, updated_at = now()`,
      [c.id, c.parentId, c.code, c.name, c.isSystem, c.active, c.sort],
    );
  }
}
