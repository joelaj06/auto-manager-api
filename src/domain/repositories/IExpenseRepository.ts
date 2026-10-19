import type { Expense } from "../expenses/Expense.js";

/** Expenses of the current tenant (tenant unit of work). */
export interface IExpenseRepository {
  findById(id: string): Promise<Expense | null>;
  lockById(id: string): Promise<Expense | null>;
  /** Inserts or updates the expense with its lines. */
  save(expense: Expense): Promise<void>;
  deleteDraft(id: string): Promise<void>;
}
