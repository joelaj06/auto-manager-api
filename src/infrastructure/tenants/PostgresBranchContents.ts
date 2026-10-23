import type {
  BranchInventory,
  BranchMove,
  IBranchContents,
} from "../../application/ports/IBranchContents.js";
import { OFF_FLEET_STATUSES } from "../../domain/vehicles/VehicleStatus.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const OFF_FLEET = [...OFF_FLEET_STATUSES];
const OPEN_WORKPAY = [
  "draft",
  "awaiting_signatures",
  "active",
  "in_arrears",
  "defaulted",
  "restructured",
];
const OPEN_REMITTANCES = ["pending", "submitted", "partially_paid", "overdue"];
const OPEN_EXPENSES = ["draft", "submitted", "approved"];
const OPEN_INVOICES = ["draft", "issued", "partially_paid"];
const OPEN_ISSUES = ["open", "acknowledged"];
/** Belonging to a branch, not records of what happened there. */
const MEMBERSHIP_TABLES = new Set(["user_branches", "user_roles"]);

/** The live contents of a tenant's branches (tenant unit of work). */
export class PostgresBranchContents implements IBranchContents {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async inventory(branchId: string): Promise<BranchInventory> {
    const { rows } = await this.transactions.current().query<Record<keyof BranchInventory, number>>(
      `select
         (select count(*)::int from vehicles
           where branch_id = $1 and deleted_at is null and status <> all($2::text[])) as "vehicles",
         (select count(*)::int from drivers
           where branch_id = $1 and deleted_at is null and status <> 'terminated') as "drivers",
         (select count(*)::int from user_branches where branch_id = $1) as "users",
         (select count(*)::int from vehicle_assignments
           where branch_id = $1 and ended_at is null) as "openAssignments",
         (select count(*)::int from workpay_agreements
           where branch_id = $1 and status = any($3::text[])) as "workpayAgreements",
         (select count(*)::int from remittances
           where branch_id = $1 and status = any($4::text[])) as "remittances",
         (select count(*)::int from expenses
           where branch_id = $1 and status = any($5::text[])) as "expenses",
         (select count(*)::int from recurring_expenses
           where branch_id = $1 and active) as "recurringExpenses",
         (select count(*)::int from invoices
           where branch_id = $1 and status = any($6::text[])) as "invoices",
         (select count(*)::int from vehicle_issues
           where branch_id = $1 and status = any($7::text[])) as "vehicleIssues",
         (select count(*)::int from cash_sessions
           where branch_id = $1 and status = 'open') as "openCashSessions"`,
      [
        branchId,
        OFF_FLEET,
        OPEN_WORKPAY,
        OPEN_REMITTANCES,
        OPEN_EXPENSES,
        OPEN_INVOICES,
        OPEN_ISSUES,
      ],
    );
    return rows[0]!;
  }

  async moveLive(
    from: string,
    to: string,
    options: Readonly<{ users: boolean }>,
  ): Promise<BranchMove> {
    const tx = this.transactions.current();
    const move = async (sql: string, params: unknown[] = []) =>
      (await tx.query(sql, [from, to, ...params])).rowCount ?? 0;
    const vehicles = await move(
      `update vehicles set branch_id = $2, updated_at = now()
        where branch_id = $1 and deleted_at is null and status <> all($3::text[])`,
      [OFF_FLEET],
    );
    const openAssignments = await move(
      "update vehicle_assignments set branch_id = $2 where branch_id = $1 and ended_at is null",
    );
    const drivers = await move(
      `update drivers set branch_id = $2, updated_at = now()
        where branch_id = $1 and deleted_at is null and status <> 'terminated'`,
    );
    const workpayAgreements = await move(
      "update workpay_agreements set branch_id = $2 where branch_id = $1 and status = any($3::text[])",
      [OPEN_WORKPAY],
    );
    const remittances = await move(
      "update remittances set branch_id = $2 where branch_id = $1 and status = any($3::text[])",
      [OPEN_REMITTANCES],
    );
    const expenses = await move(
      "update expenses set branch_id = $2 where branch_id = $1 and status = any($3::text[])",
      [OPEN_EXPENSES],
    );
    const recurringExpenses = await move(
      "update recurring_expenses set branch_id = $2, updated_at = now() where branch_id = $1 and active",
    );
    const invoices = await move(
      "update invoices set branch_id = $2 where branch_id = $1 and status = any($3::text[])",
      [OPEN_INVOICES],
    );
    const vehicleIssues = await move(
      "update vehicle_issues set branch_id = $2 where branch_id = $1 and status = any($3::text[])",
      [OPEN_ISSUES],
    );
    const customers = await move(
      "update customers set home_branch_id = $2 where home_branch_id = $1",
    );
    let users = 0;
    let roleAssignments = 0;
    if (options.users) {
      users = await move(
        `insert into user_branches (user_id, branch_id)
         select user_id, $2 from user_branches where branch_id = $1
         on conflict do nothing`,
      );
      await tx.query("delete from user_branches where branch_id = $1", [from]);
      // Branch roles follow to the new branch (once: a duplicate is dropped).
      roleAssignments = await move(
        `update user_roles r set branch_id = $2
          where r.branch_id = $1
            and not exists (select 1 from user_roles d
                             where d.user_id = r.user_id and d.role_id = r.role_id
                               and d.branch_id = $2)`,
      );
      await tx.query("delete from user_roles where branch_id = $1", [from]);
    }
    return {
      vehicles,
      drivers,
      users,
      openAssignments,
      workpayAgreements,
      remittances,
      expenses,
      recurringExpenses,
      invoices,
      vehicleIssues,
      customers,
      roleAssignments,
    };
  }

  async tablesWithRecords(branchId: string): Promise<string[]> {
    const tx = this.transactions.current();
    // Every column with a foreign key to branches, wherever a module added one.
    const { rows: references } = await tx.query<{
      schema_name: string;
      table_name: string;
      column_name: string;
    }>(
      `select n.nspname as schema_name, cl.relname as table_name, a.attname as column_name
         from pg_constraint c
         join pg_class cl on cl.oid = c.conrelid
         join pg_namespace n on n.oid = cl.relnamespace
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.confrelid = 'branches'::regclass
        order by 2, 3`,
    );
    const found: string[] = [];
    for (const r of references) {
      if (MEMBERSHIP_TABLES.has(r.table_name)) continue;
      const { rows } = await tx.query<{ found: boolean }>(
        `select exists (select 1 from ${quote(r.schema_name)}.${quote(r.table_name)} where ${quote(r.column_name)} = $1) as found`,
        [branchId],
      );
      if (rows[0]?.found === true && !found.includes(r.table_name)) found.push(r.table_name);
    }
    return found;
  }

  async remove(branchId: string): Promise<void> {
    const tx = this.transactions.current();
    await tx.query("delete from user_roles where branch_id = $1", [branchId]);
    await tx.query("delete from user_branches where branch_id = $1", [branchId]);
    await tx.query("delete from branches where id = $1", [branchId]);
  }
}

/** A catalog identifier as a quoted SQL identifier. */
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
