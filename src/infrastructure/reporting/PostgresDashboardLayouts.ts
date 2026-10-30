import type { IDashboardLayouts, StoredLayout } from "../../application/ports/IDashboardLayouts.js";
import type { DashboardRole } from "../../domain/reporting/DashboardLayout.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = { role: DashboardRole; widgets: string[]; updated_by: string | null; updated_at: Date };

const toLayout = (r: Row): StoredLayout => ({
  role: r.role,
  widgets: r.widgets,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export class PostgresDashboardLayouts implements IDashboardLayouts {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(): Promise<StoredLayout[]> {
    const { rows } = await this.tx.query<Row>(
      `select role, widgets, updated_by, updated_at from dashboard_layouts order by role`,
    );
    return rows.map(toLayout);
  }

  async get(role: DashboardRole): Promise<StoredLayout | null> {
    const { rows } = await this.tx.query<Row>(
      `select role, widgets, updated_by, updated_at from dashboard_layouts where role = $1`,
      [role],
    );
    return rows[0] === undefined ? null : toLayout(rows[0]);
  }

  async save(layout: StoredLayout): Promise<void> {
    await this.tx.query(
      `insert into dashboard_layouts (role, widgets, updated_by, updated_at)
       values ($1, $2, $3, $4)
       on conflict (role) do update
         set widgets = excluded.widgets, updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
      [layout.role, layout.widgets, layout.updatedBy, layout.updatedAt],
    );
  }

  async remove(role: DashboardRole): Promise<void> {
    await this.tx.query(`delete from dashboard_layouts where role = $1`, [role]);
  }
}
