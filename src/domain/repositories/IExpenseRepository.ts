import type { Expense } from "../expenses/Expense.js";

/** Expenses of the current tenant (tenant unit of work). */
export interface IExpenseRepository {
  findById(id: string): Promise<Expense | null>;
  lockById(id: string): Promise<Expense | null>;
  /** The expenses one payment paid (a supplier payment may pay several), locked. */
  lockByPayment(paymentId: string): Promise<Expense[]>;
  /** Inserts or updates the expense with its lines. */
  save(expense: Expense): Promise<void>;
  deleteDraft(id: string): Promise<void>;
}
