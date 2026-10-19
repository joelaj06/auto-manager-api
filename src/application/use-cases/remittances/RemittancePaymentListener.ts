import type { IRemittanceRepository } from "../../../domain/repositories/IRemittanceRepository.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPaymentReversalListener } from "../../ports/IFinanceRecords.js";
import type { IRemittanceRecords } from "../../ports/IRemittanceRecords.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { Remittances } from "./Remittances.js";

/**
 * A reversed remittance payment: its settlement is cancelled and the period owes it again (the
 * target stays due — reversing money never forgives it).
 */
export class RemittancePaymentListener implements IPaymentReversalListener {
  readonly sourceType = "remittance";

  constructor(
    private readonly deps: Readonly<{
      remittances: IRemittanceRepository;
      records: IRemittanceRecords;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      book: () => Remittances;
      clock: IClock;
    }>,
  ) {}

  async paymentReversed(remittanceId: string, paymentId: string): Promise<void> {
    const { deps } = this;
    const link = await deps.records.paymentFor(paymentId);
    const remittance = await deps.remittances.lockById(remittanceId);
    if (link === null || link.releasedAt !== null || remittance === null) return;
    const now = deps.clock.now();
    await deps.posting.reverse(
      { type: "remittance_payment", id: paymentId },
      await deps.calendar.today(),
      "Remittance payment reversed",
      null,
    );
    remittance.release(
      link.amountMinor,
      remittance.snapshot().mode === "variable" ? link.settledMinor : 0,
      now,
    );
    await deps.records.savePayment({ ...link, releasedAt: now });
    await deps.book().refresh(remittance);
  }
}
