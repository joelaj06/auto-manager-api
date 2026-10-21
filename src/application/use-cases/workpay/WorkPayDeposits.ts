import type { IPaymentRepository } from "../../../domain/repositories/IFinanceRepositories.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPaymentPurpose, IPaymentReversalListener } from "../../ports/IFinanceRecords.js";
import type { IWorkPayAgreementRepository } from "../../ports/IWorkPayRecords.js";

/**
 * Deposits paid on Work & Pay agreements, as finance sees them: the receipt says what the money
 * was for, and a reversed deposit payment is taken off the agreement's deposit paid.
 */
export class WorkPayDeposits implements IPaymentPurpose, IPaymentReversalListener {
  readonly sourceType = "workpay_deposit";

  constructor(
    private readonly deps: Readonly<{
      agreements: IWorkPayAgreementRepository;
      payments: IPaymentRepository;
      clock: IClock;
    }>,
  ) {}

  async describe(sourceId: string, paymentId: string) {
    const agreement = await this.deps.agreements.findById(sourceId);
    const payment = await this.deps.payments.findById(paymentId);
    if (agreement === null || payment === null) return null;
    return {
      description: `Deposit, work and pay agreement ${agreement.snapshot().number}`,
      settledMinor: payment.snapshot().amountBaseMinor,
    };
  }

  async paymentReversed(sourceId: string, paymentId: string): Promise<void> {
    const agreement = await this.deps.agreements.lockById(sourceId);
    const payment = await this.deps.payments.findById(paymentId);
    if (agreement === null || payment === null) return;
    agreement.depositReturned(payment.snapshot().amountBaseMinor, this.deps.clock.now());
    await this.deps.agreements.save(agreement);
  }
}
