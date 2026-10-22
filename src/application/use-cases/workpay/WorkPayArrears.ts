import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWorkPayAgreementRepository } from "../../ports/IWorkPayRecords.js";
import type { WorkPayCollections } from "./WorkPayCollections.js";

/**
 * The daily arrears job (docs/08 §4–5): every running agreement gets its instalment statuses,
 * late fees and status for the day — one agreement per transaction, so one failing does not hold
 * the others back.
 */
export class WorkPayArrears implements ITenantDailyTask {
  readonly name = "workpay_arrears";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      agreements: IWorkPayAgreementRepository;
      collections: WorkPayCollections;
      logger: ILogger;
    }>,
  ) {}

  async run(localDate: string): Promise<void> {
    const { deps } = this;
    const ids = await deps.unitOfWork.run(() => deps.agreements.running());
    let failed = 0;
    for (const id of ids)
      try {
        await deps.collections.refresh(id, localDate);
      } catch (error) {
        failed += 1;
        deps.logger.error("workpay arrears refresh failed", { agreementId: id, error });
      }
    deps.logger.info("workpay arrears refreshed", { agreements: ids.length, failed });
  }
}
