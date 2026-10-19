import { DomainError } from "../../../domain/errors/DomainError.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { ILedger } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ExpenseCategory, ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "./userAudit.js";

export class ExpenseCategoryNotFoundError extends ApplicationError {
  readonly code = "EXPENSE_CATEGORY_NOT_FOUND";
  constructor() {
    super("Expense category not found");
  }
}

export class ExpenseCategoryRuleError extends DomainError {
  readonly code = "EXPENSE_CATEGORY_RULE";
  constructor(message: string) {
    super(message);
  }
}

export type ExpenseCategoryNode = ExpenseCategory & Readonly<{ children: ExpenseCategoryNode[] }>;

const CODE = /^[a-z][a-z_]{1,39}$/;
/** Categories nest two levels deep (category → subcategory), docs/12. */
const MAX_DEPTH = 2;

/**
 * Expense categories (docs/12): seeded defaults plus the business's own, as a shallow tree.
 * Categories are renamed, moved or deactivated — never deleted (expenses keep pointing at them).
 */
export class ExpenseCategoryAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reference: ITenantReferenceData;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      ledger: ILedger;
    }>,
  ) {}

  async tree(includeInactive = false): Promise<ExpenseCategoryNode[]> {
    const all = await this.deps.unitOfWork.run(() => this.deps.reference.expenseCategories());
    const visible = all.filter((c) => includeInactive || c.active);
    const build = (parentId: string | null): ExpenseCategoryNode[] =>
      visible.filter((c) => c.parentId === parentId).map((c) => ({ ...c, children: build(c.id) }));
    return build(null);
  }

  async create(
    actor: Principal,
    input: Readonly<{ code: string; name: string; parentId?: string | null }>,
  ): Promise<ExpenseCategory> {
    const { deps } = this;
    const code = input.code.trim().toLowerCase();
    if (!CODE.test(code))
      throw new ExpenseCategoryRuleError("Codes use lowercase letters and _ (e.g. car_wash)");
    return deps.unitOfWork.run(async () => {
      if (await deps.reference.expenseCategoryCodeTaken(code))
        throw new ExpenseCategoryRuleError(`The code ${code} is already used`);
      const parentId = input.parentId ?? null;
      if (parentId !== null) await this.assertParent(parentId, null);
      const category: ExpenseCategory = {
        id: deps.ids.next(),
        parentId,
        code,
        name: input.name.trim(),
        isSystem: false,
        active: true,
        sort: 1_000,
        ledgerAccountId: null,
      };
      await deps.reference.saveExpenseCategory(category);
      await recordUserAction(deps, actor.userId, {
        action: "expense_category.created",
        entityType: "expense_category",
        entityId: category.id,
        after: category,
      });
      return category;
    });
  }

  async update(
    actor: Principal,
    id: string,
    changes: Readonly<{
      name?: string;
      parentId?: string | null;
      active?: boolean;
      sort?: number;
      /** An expense account; null: vehicle or other expenses. */
      ledgerAccountId?: string | null;
    }>,
  ): Promise<ExpenseCategory> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.reference.expenseCategory(id);
      if (before === null) throw new ExpenseCategoryNotFoundError();
      if (changes.parentId !== undefined && changes.parentId !== null)
        await this.assertParent(changes.parentId, id);
      const after: ExpenseCategory = {
        ...before,
        name: changes.name?.trim() ?? before.name,
        parentId: changes.parentId === undefined ? before.parentId : changes.parentId,
        active: changes.active ?? before.active,
        sort: changes.sort ?? before.sort,
        ledgerAccountId:
          changes.ledgerAccountId === undefined ? before.ledgerAccountId : changes.ledgerAccountId,
      };
      if (changes.ledgerAccountId !== undefined && changes.ledgerAccountId !== null) {
        const account = (await deps.ledger.accounts()).find(
          (a) => a.id === changes.ledgerAccountId,
        );
        if (account?.type !== "expense")
          throw new ExpenseCategoryRuleError("Post expenses to an expense account");
      }
      await deps.reference.saveExpenseCategory(after);
      await recordUserAction(deps, actor.userId, {
        action: "expense_category.updated",
        entityType: "expense_category",
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  /** The parent must exist, be top-level (two levels at most) and not be the category itself. */
  private async assertParent(parentId: string, childId: string | null): Promise<void> {
    const parent = await this.deps.reference.expenseCategory(parentId);
    if (parent === null) throw new ExpenseCategoryNotFoundError();
    if (parent.id === childId)
      throw new ExpenseCategoryRuleError("A category cannot contain itself");
    if (parent.parentId !== null)
      throw new ExpenseCategoryRuleError(`Categories nest at most ${MAX_DEPTH} levels deep`);
    if (childId !== null) {
      const all = await this.deps.reference.expenseCategories();
      if (all.some((c) => c.parentId === childId))
        throw new ExpenseCategoryRuleError("A category with subcategories stays at the top level");
    }
  }
}
