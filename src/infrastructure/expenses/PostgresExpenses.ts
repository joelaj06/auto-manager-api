import {
  DEFAULT_EXPENSE_SETTINGS,
  type Budget,
  type ExpenseListFilter,
  type ExpenseSettings,
  type FuelLog,
  type IApprovalRules,
  type IBudgets,
  type IExpenseQueries,
  type IExpenseSettingsStore,
  type IFuelLogs,
  type IRecurringExpenses,
  type RecurringExpense,
} from "../../application/ports/IExpenseRecords.js";
import { Expense, type ExpenseLine, type ExpenseProps } from "../../domain/expenses/Expense.js";
import type { ApprovalRule } from "../../domain/expenses/ExpenseRules.js";
import type { IExpenseRepository } from "../../domain/repositories/IExpenseRepository.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tx = ReturnType<PostgresTransactionContext["current"]>;
const num = (value: string | null) => (value === null ? null : Number(value));

// --- expenses ---

type ExpenseRow = {
  id: string;
  number: string | null;
  status: ExpenseProps["status"];
  category_id: string;
  description: string;
  branch_id: string;
  expense_date: string;
  payee_type: "supplier" | "driver" | null;
  payee_id: string | null;
  payee_name: string | null;
  driver_id: string | null;
  charge_to_driver: boolean;
  amount_minor: string;
  tax_code: string | null;
  tax_components: ExpenseProps["taxComponents"];
  net_minor: string;
  tax_minor: string;
  reference: string | null;
  notes: string | null;
  source_type: string | null;
  source_id: string | null;
  submitted_by: string | null;
  submitted_at: Date | null;
  approval_rule_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  rejection_reason: string | null;
  payment_id: string | null;
  paid_at: Date | null;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type LineRow = {
  expense_id: string;
  position: number;
  vehicle_id: string | null;
  amount_minor: string;
  net_minor: string;
  tax_minor: string;
};

const COLUMNS = `e.id, e.number, e.status, e.category_id, e.description, e.branch_id,
  e.expense_date::text as expense_date, e.payee_type, e.payee_id, e.payee_name, e.driver_id,
  e.charge_to_driver, e.amount_minor, e.tax_code, e.tax_components, e.net_minor, e.tax_minor,
  e.reference, e.notes, e.source_type, e.source_id, e.submitted_by, e.submitted_at,
  e.approval_rule_id, e.approved_by, e.approved_at, e.rejected_by, e.rejected_at,
  e.rejection_reason, e.payment_id, e.paid_at, e.void_reason, e.voided_by, e.voided_at,
  e.created_by, e.created_at, e.updated_at`;

const toExpense = (r: ExpenseRow, lines: ExpenseLine[]): ExpenseProps => ({
  id: r.id,
  number: r.number,
  status: r.status,
  categoryId: r.category_id,
  description: r.description,
  branchId: r.branch_id,
  expenseDate: r.expense_date,
  payee:
    r.payee_type === null || r.payee_id === null ? null : { type: r.payee_type, id: r.payee_id },
  payeeName: r.payee_name,
  driverId: r.driver_id,
  chargeToDriver: r.charge_to_driver,
  amountMinor: Number(r.amount_minor),
  taxCode: r.tax_code,
  taxComponents: r.tax_components,
  netMinor: Number(r.net_minor),
  taxMinor: Number(r.tax_minor),
  lines,
  reference: r.reference,
  notes: r.notes,
  sourceType: r.source_type,
  sourceId: r.source_id,
  submittedBy: r.submitted_by,
  submittedAt: r.submitted_at,
  approvalRuleId: r.approval_rule_id,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  rejectedBy: r.rejected_by,
  rejectedAt: r.rejected_at,
  rejectionReason: r.rejection_reason,
  paymentId: r.payment_id,
  paidAt: r.paid_at,
  voidReason: r.void_reason,
  voidedBy: r.voided_by,
  voidedAt: r.voided_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function withLines(tx: Tx, rows: ExpenseRow[]): Promise<ExpenseProps[]> {
  if (rows.length === 0) return [];
  const { rows: lines } = await tx.query<LineRow>(
    "select * from expense_lines where expense_id = any($1::uuid[]) order by expense_id, position",
    [rows.map((r) => r.id)],
  );
  return rows.map((r) =>
    toExpense(
      r,
      lines
        .filter((l) => l.expense_id === r.id)
        .map((l) => ({
          vehicleId: l.vehicle_id,
          amountMinor: Number(l.amount_minor),
          netMinor: Number(l.net_minor),
          taxMinor: Number(l.tax_minor),
        })),
    ),
  );
}

/** Expenses and their reads in the tenant database (tenant unit of work). */
export class PostgresExpenseRepository implements IExpenseRepository, IExpenseQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  findById(id: string): Promise<Expense | null> {
    return this.one(id, "");
  }

  lockById(id: string): Promise<Expense | null> {
    return this.one(id, "for update of e");
  }

  private async one(id: string, lock: string): Promise<Expense | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<ExpenseRow>(
      `select ${COLUMNS} from expenses e where e.id = $1 ${lock}`,
      [id],
    );
    const [props] = await withLines(this.tx, rows);
    return props === undefined ? null : Expense.restore(props);
  }

  async save(expense: Expense): Promise<void> {
    const p = expense.snapshot();
    await this.tx.query(
      `insert into expenses (id, number, status, category_id, description, branch_id,
         expense_date, payee_type, payee_id, payee_name, driver_id, charge_to_driver,
         amount_minor, tax_code, tax_components, net_minor, tax_minor, reference, notes,
         source_type, source_id, submitted_by, submitted_at, approval_rule_id, approved_by,
         approved_at, rejected_by, rejected_at, rejection_reason, payment_id, paid_at,
         void_reason, voided_by, voided_at, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35,
         $36, $37)
       on conflict (id) do update set number = excluded.number, status = excluded.status,
         category_id = excluded.category_id, description = excluded.description,
         branch_id = excluded.branch_id, expense_date = excluded.expense_date,
         payee_type = excluded.payee_type, payee_id = excluded.payee_id,
         payee_name = excluded.payee_name, driver_id = excluded.driver_id,
         charge_to_driver = excluded.charge_to_driver, amount_minor = excluded.amount_minor,
         tax_code = excluded.tax_code, tax_components = excluded.tax_components,
         net_minor = excluded.net_minor, tax_minor = excluded.tax_minor,
         reference = excluded.reference, notes = excluded.notes,
         submitted_by = excluded.submitted_by, submitted_at = excluded.submitted_at,
         approval_rule_id = excluded.approval_rule_id, approved_by = excluded.approved_by,
         approved_at = excluded.approved_at, rejected_by = excluded.rejected_by,
         rejected_at = excluded.rejected_at, rejection_reason = excluded.rejection_reason,
         payment_id = excluded.payment_id, paid_at = excluded.paid_at,
         void_reason = excluded.void_reason, voided_by = excluded.voided_by,
         voided_at = excluded.voided_at, updated_at = excluded.updated_at`,
      [
        p.id,
        p.number,
        p.status,
        p.categoryId,
        p.description,
        p.branchId,
        p.expenseDate,
        p.payee?.type ?? null,
        p.payee?.id ?? null,
        p.payeeName,
        p.driverId,
        p.chargeToDriver,
        p.amountMinor,
        p.taxCode,
        JSON.stringify(p.taxComponents),
        p.netMinor,
        p.taxMinor,
        p.reference,
        p.notes,
        p.sourceType,
        p.sourceId,
        p.submittedBy,
        p.submittedAt,
        p.approvalRuleId,
        p.approvedBy,
        p.approvedAt,
        p.rejectedBy,
        p.rejectedAt,
        p.rejectionReason,
        p.paymentId,
        p.paidAt,
        p.voidReason,
        p.voidedBy,
        p.voidedAt,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
      ],
    );
    await this.tx.query("delete from expense_lines where expense_id = $1", [p.id]);
    for (const [index, line] of p.lines.entries())
      await this.tx.query(
        `insert into expense_lines (expense_id, position, vehicle_id, amount_minor, net_minor, tax_minor)
         values ($1, $2, $3, $4, $5, $6)`,
        [p.id, index + 1, line.vehicleId, line.amountMinor, line.netMinor, line.taxMinor],
      );
  }

  async deleteDraft(id: string): Promise<void> {
    await this.tx.query("delete from expenses where id = $1 and status = 'draft'", [id]);
  }

  async list(filter: ExpenseListFilter): Promise<ExpenseProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["true"];
    if (filter.branchIds !== "all")
      where.push(`e.branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.createdBy !== undefined) where.push(`e.created_by = ${param(filter.createdBy)}`);
    if (filter.branchId !== undefined) where.push(`e.branch_id = ${param(filter.branchId)}`);
    if (filter.statuses !== undefined)
      where.push(`e.status = any(${param(filter.statuses)}::text[])`);
    if (filter.categoryId !== undefined) {
      const category = param(filter.categoryId);
      where.push(
        `(e.category_id = ${category} or e.category_id in (select id from expense_categories where parent_id = ${category}))`,
      );
    }
    if (filter.vehicleId !== undefined)
      where.push(
        `exists (select 1 from expense_lines l where l.expense_id = e.id and l.vehicle_id = ${param(filter.vehicleId)})`,
      );
    if (filter.driverId !== undefined) where.push(`e.driver_id = ${param(filter.driverId)}`);
    if (filter.payee !== undefined)
      where.push(
        `e.payee_type = ${param(filter.payee.type)} and e.payee_id = ${param(filter.payee.id)}`,
      );
    if (filter.from !== undefined) where.push(`e.expense_date >= ${param(filter.from)}`);
    if (filter.to !== undefined) where.push(`e.expense_date <= ${param(filter.to)}`);
    if (filter.after !== undefined)
      where.push(
        `(e.created_at, e.id) < (${param(filter.after.createdAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<ExpenseRow>(
      `select ${COLUMNS} from expenses e where ${where.join(" and ")}
        order by e.created_at desc, e.id desc limit ${param(filter.limit)}`,
      params,
    );
    return withLines(this.tx, rows);
  }

  async similar(
    expense: Readonly<{ id: string; categoryId: string; expenseDate: string; amountMinor: number }>,
  ): Promise<ExpenseProps[]> {
    const { rows } = await this.tx.query<ExpenseRow>(
      `select ${COLUMNS} from expenses e
        where e.id <> $1 and e.category_id = $2 and e.expense_date = $3 and e.amount_minor = $4
          and e.status <> 'void'
        order by e.created_at limit 5`,
      [expense.id, expense.categoryId, expense.expenseDate, expense.amountMinor],
    );
    return withLines(this.tx, rows);
  }

  async spent(
    filter: Readonly<{
      month: string;
      categoryId: string | null;
      branchId: string | null;
      vehicleId: string | null;
    }>,
  ): Promise<number> {
    const { rows } = await this.tx.query<{ spent: string }>(
      `select coalesce(sum(l.amount_minor), 0) as spent
         from expenses e join expense_lines l on l.expense_id = e.id
        where e.status in ('approved', 'paid')
          and to_char(e.expense_date, 'YYYY-MM') = $1
          and ($2::uuid is null or e.category_id = $2
               or e.category_id in (select id from expense_categories where parent_id = $2))
          and ($3::uuid is null or e.branch_id = $3)
          and ($4::uuid is null or l.vehicle_id = $4)`,
      [filter.month, filter.categoryId, filter.branchId, filter.vehicleId],
    );
    return Number(rows[0]?.spent ?? 0);
  }
}

// --- approval rules ---

type RuleRow = {
  id: string;
  name: string;
  priority: number;
  category_id: string | null;
  branch_id: string | null;
  min_amount_minor: string;
  max_amount_minor: string | null;
  action: ApprovalRule["action"];
  active: boolean;
};
const toRule = (r: RuleRow): ApprovalRule => ({
  id: r.id,
  name: r.name,
  priority: r.priority,
  categoryId: r.category_id,
  branchId: r.branch_id,
  minAmountMinor: Number(r.min_amount_minor),
  maxAmountMinor: num(r.max_amount_minor),
  action: r.action,
  active: r.active,
});

export class PostgresApprovalRules implements IApprovalRules {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(): Promise<ApprovalRule[]> {
    const { rows } = await this.tx.query<RuleRow>(
      "select * from expense_approval_rules order by priority, name",
    );
    return rows.map(toRule);
  }

  async get(id: string): Promise<ApprovalRule | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<RuleRow>(
      "select * from expense_approval_rules where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toRule(rows[0]);
  }

  async save(r: ApprovalRule): Promise<void> {
    await this.tx.query(
      `insert into expense_approval_rules (id, name, priority, category_id, branch_id,
         min_amount_minor, max_amount_minor, action, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update set name = excluded.name, priority = excluded.priority,
         category_id = excluded.category_id, branch_id = excluded.branch_id,
         min_amount_minor = excluded.min_amount_minor, max_amount_minor = excluded.max_amount_minor,
         action = excluded.action, active = excluded.active, updated_at = now()`,
      [
        r.id,
        r.name,
        r.priority,
        r.categoryId,
        r.branchId,
        r.minAmountMinor,
        r.maxAmountMinor,
        r.action,
        r.active,
      ],
    );
  }
}

// --- budgets ---

type BudgetRow = {
  id: string;
  name: string;
  category_id: string | null;
  branch_id: string | null;
  vehicle_id: string | null;
  monthly_amount_minor: string;
  active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};
const toBudget = (r: BudgetRow): Budget => ({
  id: r.id,
  name: r.name,
  categoryId: r.category_id,
  branchId: r.branch_id,
  vehicleId: r.vehicle_id,
  monthlyAmountMinor: Number(r.monthly_amount_minor),
  active: r.active,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class PostgresBudgets implements IBudgets {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(): Promise<Budget[]> {
    const { rows } = await this.tx.query<BudgetRow>("select * from budgets order by name");
    return rows.map(toBudget);
  }

  async get(id: string): Promise<Budget | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<BudgetRow>("select * from budgets where id = $1", [id]);
    return rows[0] === undefined ? null : toBudget(rows[0]);
  }

  async save(b: Budget): Promise<void> {
    await this.tx.query(
      `insert into budgets (id, name, category_id, branch_id, vehicle_id, monthly_amount_minor,
         active, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set name = excluded.name, category_id = excluded.category_id,
         branch_id = excluded.branch_id, vehicle_id = excluded.vehicle_id,
         monthly_amount_minor = excluded.monthly_amount_minor, active = excluded.active,
         updated_at = excluded.updated_at`,
      [
        b.id,
        b.name,
        b.categoryId,
        b.branchId,
        b.vehicleId,
        b.monthlyAmountMinor,
        b.active,
        b.createdBy,
        b.createdAt,
        b.updatedAt,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from budgets where id = $1", [id]);
  }
}

// --- recurring expenses ---

type RecurringRow = {
  id: string;
  name: string;
  category_id: string;
  branch_id: string;
  description: string;
  payee_type: "supplier" | "driver" | null;
  payee_id: string | null;
  payee_name: string | null;
  amount_minor: string;
  tax_code: string | null;
  vehicle_ids: string[];
  frequency: RecurringExpense["frequency"];
  next_run_on: string;
  end_on: string | null;
  auto_submit: boolean;
  active: boolean;
  last_run_on: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};
const RECURRING_COLUMNS = `id, name, category_id, branch_id, description, payee_type, payee_id,
  payee_name, amount_minor, tax_code, vehicle_ids, frequency, next_run_on::text as next_run_on,
  end_on::text as end_on, auto_submit, active, last_run_on::text as last_run_on, created_by,
  created_at, updated_at`;
const toRecurring = (r: RecurringRow): RecurringExpense => ({
  id: r.id,
  name: r.name,
  categoryId: r.category_id,
  branchId: r.branch_id,
  description: r.description,
  payee:
    r.payee_type === null || r.payee_id === null ? null : { type: r.payee_type, id: r.payee_id },
  payeeName: r.payee_name,
  amountMinor: Number(r.amount_minor),
  taxCode: r.tax_code,
  vehicleIds: r.vehicle_ids,
  frequency: r.frequency,
  nextRunOn: r.next_run_on,
  endOn: r.end_on,
  autoSubmit: r.auto_submit,
  active: r.active,
  lastRunOn: r.last_run_on,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class PostgresRecurringExpenses implements IRecurringExpenses {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async list(): Promise<RecurringExpense[]> {
    const { rows } = await this.tx.query<RecurringRow>(
      `select ${RECURRING_COLUMNS} from recurring_expenses order by name`,
    );
    return rows.map(toRecurring);
  }

  async get(id: string): Promise<RecurringExpense | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<RecurringRow>(
      `select ${RECURRING_COLUMNS} from recurring_expenses where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toRecurring(rows[0]);
  }

  async lockDue(date: string): Promise<RecurringExpense[]> {
    const { rows } = await this.tx.query<RecurringRow>(
      `select ${RECURRING_COLUMNS} from recurring_expenses
        where active and next_run_on <= $1 order by next_run_on for update skip locked`,
      [date],
    );
    return rows.map(toRecurring);
  }

  async save(r: RecurringExpense): Promise<void> {
    await this.tx.query(
      `insert into recurring_expenses (id, name, category_id, branch_id, description, payee_type,
         payee_id, payee_name, amount_minor, tax_code, vehicle_ids, frequency, next_run_on,
         end_on, auto_submit, active, last_run_on, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       on conflict (id) do update set name = excluded.name, category_id = excluded.category_id,
         branch_id = excluded.branch_id, description = excluded.description,
         payee_type = excluded.payee_type, payee_id = excluded.payee_id,
         payee_name = excluded.payee_name, amount_minor = excluded.amount_minor,
         tax_code = excluded.tax_code, vehicle_ids = excluded.vehicle_ids,
         frequency = excluded.frequency, next_run_on = excluded.next_run_on,
         end_on = excluded.end_on, auto_submit = excluded.auto_submit, active = excluded.active,
         last_run_on = excluded.last_run_on, updated_at = excluded.updated_at`,
      [
        r.id,
        r.name,
        r.categoryId,
        r.branchId,
        r.description,
        r.payee?.type ?? null,
        r.payee?.id ?? null,
        r.payeeName,
        r.amountMinor,
        r.taxCode,
        r.vehicleIds,
        r.frequency,
        r.nextRunOn,
        r.endOn,
        r.autoSubmit,
        r.active,
        r.lastRunOn,
        r.createdBy,
        r.createdAt,
        r.updatedAt,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from recurring_expenses where id = $1", [id]);
  }
}

// --- fuel logs ---

type FuelRow = {
  id: string;
  vehicle_id: string;
  driver_id: string | null;
  filled_at: Date;
  litres: string;
  amount_minor: string;
  odometer: number;
  full_tank: boolean;
  station: string | null;
  expense_id: string | null;
  notes: string | null;
  recorded_by: string | null;
  created_at: Date;
};

export class PostgresFuelLogs implements IFuelLogs {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async add(l: FuelLog): Promise<void> {
    await this.tx.query(
      `insert into fuel_logs (id, vehicle_id, driver_id, filled_at, litres, amount_minor, odometer,
         full_tank, station, expense_id, notes, recorded_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        l.id,
        l.vehicleId,
        l.driverId,
        l.filledAt,
        l.litres,
        l.amountMinor,
        l.odometer,
        l.fullTank,
        l.station,
        l.expenseId,
        l.notes,
        l.recordedBy,
        l.createdAt,
      ],
    );
  }

  async forVehicle(vehicleId: string, limit: number): Promise<FuelLog[]> {
    const { rows } = await this.tx.query<FuelRow>(
      "select * from fuel_logs where vehicle_id = $1 order by filled_at desc limit $2",
      [vehicleId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      driverId: r.driver_id,
      filledAt: r.filled_at,
      litres: Number(r.litres),
      amountMinor: Number(r.amount_minor),
      odometer: r.odometer,
      fullTank: r.full_tank,
      station: r.station,
      expenseId: r.expense_id,
      notes: r.notes,
      recordedBy: r.recorded_by,
      createdAt: r.created_at,
    }));
  }
}

/** Expense settings in `organisation.settings->'expenses'`, over the defaults. */
export class PostgresExpenseSettingsStore implements IExpenseSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<ExpenseSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ expenses: Partial<ExpenseSettings> | null }>(
        "select settings->'expenses' as expenses from organisation",
      );
    return { ...DEFAULT_EXPENSE_SETTINGS, ...(rows[0]?.expenses ?? {}) };
  }

  async set(settings: ExpenseSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{expenses}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}
