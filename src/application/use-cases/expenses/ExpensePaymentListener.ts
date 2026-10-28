import type { IExpenseRepository } from "../../../domain/repositories/IExpenseRepository.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPaymentReversalListener } from "../../ports/IFinanceRecords.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";

/**
 * A reversed expense payment makes the expense approved and unpaid again, and undoes the
 * exchange difference of a foreign-currency payment.
 */
export class ExpensePaymentListener implements IPaymentReversalListener {
  readonly sourceType = "expense";

  constructor(
    private readonly deps: Readonly<{
      expenses: IExpenseRepository;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      clock: IClock;
    }>,
  ) {}

  async paymentReversed(expenseId: string, paymentId: string): Promise<void> {
    const expense = await this.deps.expenses.lockById(expenseId);
    if (expense?.snapshot().paymentId !== paymentId) return;
    if (expense.snapshot().fxDifferenceMinor !== 0)
      await this.deps.posting.reverse(
        { type: "payable_fx", id: paymentId },
        await this.deps.calendar.today(),
        `Payment of expense ${expense.snapshot().number ?? ""} reversed`,
        null,
      );
    expense.reopen(this.deps.clock.now());
    await this.deps.expenses.save(expense);
  }
}
