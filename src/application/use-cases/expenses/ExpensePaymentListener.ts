import type { IExpenseRepository } from "../../../domain/repositories/IExpenseRepository.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPaymentReversalListener } from "../../ports/IFinanceRecords.js";

/** A reversed expense payment makes the expense approved and unpaid again. */
export class ExpensePaymentListener implements IPaymentReversalListener {
  readonly sourceType = "expense";

  constructor(private readonly deps: Readonly<{ expenses: IExpenseRepository; clock: IClock }>) {}

  async paymentReversed(expenseId: string, paymentId: string): Promise<void> {
    const expense = await this.deps.expenses.lockById(expenseId);
    if (expense?.snapshot().paymentId !== paymentId) return;
    expense.reopen(this.deps.clock.now());
    await this.deps.expenses.save(expense);
  }
}
