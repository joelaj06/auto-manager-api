import type { ExpenseProps } from "../../domain/expenses/Expense.js";

/**
 * Who bears an expense when the business has not said (a driver whose agreement makes them
 * responsible for it), and what follows when such an expense is approved or voided — e.g. the
 * cost added to their work and pay agreement.
 */
export interface IExpenseDriverCosts {
  /** The driver who bears an expense of this category on these vehicles, or null. */
  defaultBearer(
    expense: Readonly<{ categoryCode: string; vehicleIds: readonly string[] }>,
  ): Promise<string | null>;
  /** An expense charged to a driver was approved; `chargedMinor` went to their ledger. */
  approved(expense: ExpenseProps, chargedMinor: number, userId: string | null): Promise<void>;
  /** An approved expense was voided (its posting reversed). */
  voided(expense: ExpenseProps, userId: string | null): Promise<void>;
}
