import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { ILedger } from "../../ports/IFinanceRecords.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

/** Entries younger than this wait for the next night (their transaction may still be open). */
const SETTLE_SECONDS = 300;

/**
 * Rolls the ledger up by day, account and branch every night (decision 488), so the trial
 * balance and the tax report sum a row per day instead of every line ever posted. Lines posted
 * since are read live, so the figures are never behind.
 */
export class LedgerRollup implements ITenantDailyTask {
  readonly name = "ledger-rollup";

  constructor(
    private readonly deps: Readonly<{ unitOfWork: IUnitOfWork; ledger: ILedger; logger: ILogger }>,
  ) {}

  async run(): Promise<void> {
    const { deps } = this;
    const lines = await deps.unitOfWork.run(() => deps.ledger.rollUp(SETTLE_SECONDS));
    if (lines > 0) deps.logger.info("Ledger rolled up", { lines });
  }
}
