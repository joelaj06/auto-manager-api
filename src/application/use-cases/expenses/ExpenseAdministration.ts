import { ExpenseRuleError } from "../../../domain/expenses/Expense.js";
import {
  budgetLevel,
  checkRule,
  type ApprovalRule,
  type BudgetLevel,
} from "../../../domain/expenses/ExpenseRules.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  Budget,
  ExpenseSettings,
  IApprovalRules,
  IBudgets,
  IExpenseQueries,
  IExpenseSettingsStore,
} from "../../ports/IExpenseRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import { recordUserAction } from "../reference/userAudit.js";

export class ExpenseSetupNotFoundError extends ApplicationError {
  readonly code = "EXPENSE_SETUP_NOT_FOUND";
  constructor(what: string) {
    super(`${what} not found`);
  }
}

export type ApprovalRuleInput = Readonly<{
  name: string;
  priority?: number;
  categoryId?: string | null;
  branchId?: string | null;
  minAmount?: string;
  maxAmount?: string | null;
  action: ApprovalRule["action"];
  active?: boolean;
}>;

export type BudgetInput = Readonly<{
  name: string;
  categoryId?: string | null;
  branchId?: string | null;
  vehicleId?: string | null;
  monthlyAmount: string;
  active?: boolean;
}>;

export type BudgetStatus = Readonly<{
  budget: Omit<Budget, "monthlyAmountMinor"> & Readonly<{ monthlyAmount: MoneyJson }>;
  month: string;
  spent: MoneyJson;
  remaining: MoneyJson;
  percent: number;
  /** ok, warning (80% spent) or exceeded (100%). */
  level: BudgetLevel;
}>;

/**
 * Expense set-up (docs/12 §8): approval rules by amount, category and branch; monthly budgets
 * with spending against them (80% warns, 100% exceeded); expense settings.
 */
export class ExpenseAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      rules: IApprovalRules;
      budgets: IBudgets;
      queries: IExpenseQueries;
      settings: IExpenseSettingsStore;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  // --- approval rules ---

  rules(): Promise<ApprovalRule[]> {
    return this.deps.unitOfWork.run(() => this.deps.rules.list());
  }

  async saveRule(
    actor: Principal,
    id: string | null,
    input: ApprovalRuleInput,
  ): Promise<ApprovalRule> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await deps.rules.get(id);
      if (id !== null && before === null) throw new ExpenseSetupNotFoundError("Approval rule");
      const base = await deps.posting.baseCurrency();
      const rule = checkRule({
        id: id ?? deps.ids.next(),
        name: input.name,
        priority: input.priority ?? before?.priority ?? 100,
        categoryId: input.categoryId ?? null,
        branchId: input.branchId ?? null,
        minAmountMinor:
          input.minAmount === undefined ? 0 : Money.parse(input.minAmount, base).amountMinor,
        maxAmountMinor:
          input.maxAmount === undefined || input.maxAmount === null
            ? null
            : Money.parse(input.maxAmount, base).amountMinor,
        action: input.action,
        active: input.active ?? true,
      });
      await deps.rules.save(rule);
      await recordUserAction(deps, actor.userId, {
        action: id === null ? "expense_rule.created" : "expense_rule.updated",
        entityType: "expense_rule",
        entityId: rule.id,
        before,
        after: rule,
      });
      return rule;
    });
  }

  async removeRule(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const rule = await deps.rules.get(id);
      if (rule === null) throw new ExpenseSetupNotFoundError("Approval rule");
      // Expenses keep pointing at the rule that approved them: a rule is retired, not deleted.
      await deps.rules.save({ ...rule, active: false });
      await recordUserAction(deps, actor.userId, {
        action: "expense_rule.removed",
        entityType: "expense_rule",
        entityId: id,
        before: rule,
      });
    });
  }

  // --- budgets ---

  async budgets(month: string | null): Promise<BudgetStatus[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const period = month ?? (await deps.calendar.today()).slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ExpenseRuleError("A month is YYYY-MM");
      const base = await deps.posting.baseCurrency();
      const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
      const statuses: BudgetStatus[] = [];
      for (const budget of await deps.budgets.list()) {
        if (!budget.active) continue;
        const spent = await deps.queries.spent({
          month: period,
          categoryId: budget.categoryId,
          branchId: budget.branchId,
          vehicleId: budget.vehicleId,
        });
        const { monthlyAmountMinor, ...rest } = budget;
        statuses.push({
          budget: { ...rest, monthlyAmount: m(monthlyAmountMinor) },
          month: period,
          spent: m(spent),
          remaining: m(monthlyAmountMinor - spent),
          percent: Math.round((spent / monthlyAmountMinor) * 1_000) / 10,
          level: budgetLevel(spent, monthlyAmountMinor),
        });
      }
      return statuses;
    });
  }

  async saveBudget(actor: Principal, id: string | null, input: BudgetInput): Promise<Budget> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await deps.budgets.get(id);
      if (id !== null && before === null) throw new ExpenseSetupNotFoundError("Budget");
      const name = input.name.trim();
      if (name === "" || name.length > 120) throw new ExpenseRuleError("A budget needs a name");
      const amount = Money.parse(
        input.monthlyAmount,
        await deps.posting.baseCurrency(),
      ).amountMinor;
      if (amount <= 0) throw new ExpenseRuleError("A budget is above zero");
      const now = deps.clock.now();
      const budget: Budget = {
        id: id ?? deps.ids.next(),
        name,
        categoryId: input.categoryId ?? null,
        branchId: input.branchId ?? null,
        vehicleId: input.vehicleId ?? null,
        monthlyAmountMinor: amount,
        active: input.active ?? true,
        createdBy: before?.createdBy ?? actor.userId,
        createdAt: before?.createdAt ?? now,
        updatedAt: now,
      };
      await deps.budgets.save(budget);
      await recordUserAction(deps, actor.userId, {
        action: id === null ? "budget.created" : "budget.updated",
        entityType: "budget",
        entityId: budget.id,
        before,
        after: budget,
      });
      return budget;
    });
  }

  async removeBudget(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const budget = await deps.budgets.get(id);
      if (budget === null) throw new ExpenseSetupNotFoundError("Budget");
      await deps.budgets.remove(id);
      await recordUserAction(deps, actor.userId, {
        action: "budget.removed",
        entityType: "budget",
        entityId: id,
        before: budget,
      });
    });
  }

  // --- settings ---

  settings(): Promise<ExpenseSettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async updateSettings(
    actor: Principal,
    changes: Readonly<{
      receiptRequiredAbove?: string | null;
      fuelCategoryCode?: string;
      maintenanceCategoryCode?: string;
    }>,
  ): Promise<ExpenseSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: ExpenseSettings = {
        receiptRequiredAboveMinor:
          changes.receiptRequiredAbove === undefined
            ? before.receiptRequiredAboveMinor
            : changes.receiptRequiredAbove === null
              ? null
              : Money.parse(changes.receiptRequiredAbove, await deps.posting.baseCurrency())
                  .amountMinor,
        fuelCategoryCode: changes.fuelCategoryCode ?? before.fuelCategoryCode,
        maintenanceCategoryCode: changes.maintenanceCategoryCode ?? before.maintenanceCategoryCode,
      };
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.expenses_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
