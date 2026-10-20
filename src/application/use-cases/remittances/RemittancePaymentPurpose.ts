import type { IRemittanceRepository } from "../../../domain/repositories/IRemittanceRepository.js";
import type { IPaymentPurpose } from "../../ports/IFinanceRecords.js";
import type { IRemittanceRecords } from "../../ports/IRemittanceRecords.js";

/** On a receipt, a remittance payment reads "Remittance RMT-… for 2026-10-20" with what it settled. */
export class RemittancePaymentPurpose implements IPaymentPurpose {
  readonly sourceType = "remittance";

  constructor(
    private readonly deps: Readonly<{
      remittances: IRemittanceRepository;
      records: IRemittanceRecords;
    }>,
  ) {}

  async describe(sourceId: string, paymentId: string) {
    const remittance = await this.deps.remittances.findById(sourceId);
    if (remittance === null) return null;
    const r = remittance.snapshot();
    const settled = (await this.deps.records.payments(sourceId)).find(
      (p) => p.paymentId === paymentId && p.releasedAt === null,
    );
    const period =
      r.periodStart === r.periodEnd ? r.periodStart : `${r.periodStart} to ${r.periodEnd}`;
    return {
      description: `Remittance ${r.number ?? ""} for ${period}`.replace("  ", " "),
      settledMinor: settled?.settledMinor ?? 0,
    };
  }
}
