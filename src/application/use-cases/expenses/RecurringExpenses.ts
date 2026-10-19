import { ExpenseRuleError, type PayeeType } from "../../../domain/expenses/Expense.js";
import { nextRun, type RecurringFrequency } from "../../../domain/expenses/ExpenseRules.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IRecurringExpenses, RecurringExpense } from "../../ports/IExpenseRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { recordUserAction } from "../reference/userAudit.js";
import { ExpenseSetupNotFoundError } from "./ExpenseAdministration.js";
import type { Expenses } from "./Expenses.js";

export type RecurringInput = Readonly<{
  name: string;
  categoryId: string;
  branchId: string;
  description: string;
  payeeType?: PayeeType | null;
  payeeId?: string | null;
  payeeName?: string | null;
  amount: string;
  taxCode?: string | null;
  vehicleIds?: readonly string[];
  frequency: RecurringFrequency;
  startOn: string;
  endOn?: string | null;
  autoSubmit?: boolean;
  active?: boolean;
}>;

export type RecurringView = Omit<RecurringExpense, "amountMinor"> & Readonly<{ amount: MoneyJson }>;

/** Runs at most this many missed periods per day (a schedule left off for months catches up slowly). */
const MAX_CATCH_UP = 12;

/**
 * Recurring expenses (docs/12 §8: rent, insurance instalments, tracker subscriptions): each due
 * run creates an expense (a draft, or submitted when set to) on its date; the daily tenant job
 * runs them, catching up missed periods.
 */
export class RecurringExpenses implements ITenantDailyTask {
  readonly name = "recurring_expenses";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      recurring: IRecurringExpenses;
      expenses: Expenses;
      scope: BranchScope;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async list(): Promise<RecurringView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const base = await deps.expenses.baseCurrency();
      return (await deps.recurring.list()).map((r) => view(r, base));
    });
  }

  async save(actor: Principal, id: string | null, input: RecurringInput): Promise<RecurringView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await deps.recurring.get(id);
      if (id !== null && before === null) throw new ExpenseSetupNotFoundError("Recurring expense");
      await deps.scope.branch(actor, "expenses.recurring.manage", input.branchId);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startOn))
        throw new ExpenseRuleError("Dates are YYYY-MM-DD");
      if (input.endOn !== undefined && input.endOn !== null && input.endOn < input.startOn)
        throw new ExpenseRuleError("It cannot end before it starts");
      const name = input.name.trim();
      if (name === "" || name.length > 120) throw new ExpenseRuleError("Give it a name");
      const base = await deps.expenses.baseCurrency();
      const now = deps.clock.now();
      const recurring: RecurringExpense = {
        id: id ?? deps.ids.next(),
        name,
        categoryId: input.categoryId,
        branchId: input.branchId,
        description: input.description.trim(),
        payee:
          input.payeeType !== undefined &&
          input.payeeType !== null &&
          input.payeeId !== undefined &&
          input.payeeId !== null
            ? { type: input.payeeType, id: input.payeeId }
            : null,
        payeeName: input.payeeName ?? null,
        amountMinor: Money.parse(input.amount, base).amountMinor,
        taxCode: input.taxCode ?? null,
        vehicleIds: input.vehicleIds ?? [],
        frequency: input.frequency,
        nextRunOn:
          before !== null && before.nextRunOn > input.startOn ? before.nextRunOn : input.startOn,
        endOn: input.endOn ?? null,
        autoSubmit: input.autoSubmit ?? false,
        active: input.active ?? true,
        lastRunOn: before?.lastRunOn ?? null,
        createdBy: before?.createdBy ?? actor.userId,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      };
      await deps.recurring.save(recurring);
      await recordUserAction(deps, actor.userId, {
        action: id === null ? "recurring_expense.created" : "recurring_expense.updated",
        entityType: "recurring_expense",
        entityId: recurring.id,
        before,
        after: recurring,
      });
      return view(recurring, base);
    });
  }

  async remove(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const recurring = await deps.recurring.get(id);
      if (recurring === null) throw new ExpenseSetupNotFoundError("Recurring expense");
      await deps.recurring.remove(id);
      await recordUserAction(deps, actor.userId, {
        action: "recurring_expense.removed",
        entityType: "recurring_expense",
        entityId: id,
        before: recurring,
      });
    });
  }

  /** Creates the expenses due on or before `localDate` (daily tenant job). */
  async run(localDate: string): Promise<void> {
    const { deps } = this;
    let created = 0;
    await deps.unitOfWork.run(async () => {
      for (const recurring of await deps.recurring.lockDue(localDate)) {
        let current = recurring;
        const anchorDay = Number(recurring.nextRunOn.slice(8, 10));
        for (
          let i = 0;
          i < MAX_CATCH_UP && current.active && current.nextRunOn <= localDate;
          i += 1
        ) {
          if (current.endOn !== null && current.nextRunOn > current.endOn) {
            current = { ...current, active: false };
            break;
          }
          await this.createExpense(current);
          created += 1;
          current = {
            ...current,
            lastRunOn: current.nextRunOn,
            nextRunOn: nextRun(current.nextRunOn, current.frequency, anchorDay),
          };
        }
        await deps.recurring.save({ ...current, updatedAt: deps.clock.now() });
      }
    });
    if (created > 0) deps.logger.info("Recurring expenses created", { count: created, localDate });
  }

  private async createExpense(r: RecurringExpense): Promise<void> {
    const { deps } = this;
    const base = await deps.expenses.baseCurrency();
    const expense = await deps.expenses.draftFor(
      r.createdBy,
      {
        categoryId: r.categoryId,
        description: r.description,
        expenseDate: r.nextRunOn,
        ...(r.payee === null
          ? { payeeName: r.payeeName }
          : { payeeType: r.payee.type, payeeId: r.payee.id }),
        amount: Money.ofMinor(r.amountMinor, base).toDecimalString(),
        taxCode: r.taxCode,
        vehicleIds: r.vehicleIds,
      },
      r.branchId,
      { type: "recurring_expense", id: r.id },
    );
    if (r.autoSubmit) await deps.expenses.submitLoaded(expense, null, { skipReceiptRule: true });
  }
}

function view(r: RecurringExpense, currency: string): RecurringView {
  const { amountMinor, ...rest } = r;
  return { ...rest, amount: Money.ofMinor(amountMinor, currency).toJSON() };
}
