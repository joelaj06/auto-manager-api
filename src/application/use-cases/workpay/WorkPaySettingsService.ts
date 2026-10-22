import { WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import { WorkPayRuleError } from "../../../domain/workpay/WorkPayTerms.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWorkPaySettingsStore, WorkPaySettings } from "../../ports/IWorkPayRecords.js";
import { recordUserAction } from "../reference/userAudit.js";

/** Work & Pay defaults: frequency, grace, rounding, first due date, deposit rule, responsibilities. */
export class WorkPaySettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IWorkPaySettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<WorkPaySettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(actor: Principal, changes: Partial<WorkPaySettings>): Promise<WorkPaySettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: WorkPaySettings = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      if (
        !Number.isInteger(after.defaultGraceDays) ||
        after.defaultGraceDays < 0 ||
        after.defaultGraceDays > 60
      )
        throw new WorkPayRuleError("Grace is 0 to 60 days");
      if (![1, 10, 50, 100, 500, 1_000].includes(after.roundToMinor))
        throw new WorkPayRuleError("Round instalments to 1, 10, 50, 100, 500 or 1000 minor units");
      if (
        !Number.isInteger(after.firstDueAfterDays) ||
        after.firstDueAfterDays < 0 ||
        after.firstDueAfterDays > 90
      )
        throw new WorkPayRuleError("The first instalment is 0 to 90 days after the start");
      WorkPayAgreement.checkPenalty(after.defaultPenalty);
      if (
        !Number.isInteger(after.defaultAfterOverdue) ||
        after.defaultAfterOverdue < 1 ||
        after.defaultAfterOverdue > 100
      )
        throw new WorkPayRuleError("Default after 1 to 100 overdue instalments");
      if (
        !Number.isInteger(after.defaultAfterDays) ||
        after.defaultAfterDays < 1 ||
        after.defaultAfterDays > 365
      )
        throw new WorkPayRuleError("Default after 1 to 365 days in arrears");
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.workpay_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
