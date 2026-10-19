import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { FinanceSettings, IFinanceSettingsStore } from "../../ports/IFinanceRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";

/** Finance settings: whether cash needs an open cash session, default payment terms. */
export class FinanceSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IFinanceSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<FinanceSettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(actor: Principal, changes: Partial<FinanceSettings>): Promise<FinanceSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: FinanceSettings = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      if (
        !Number.isInteger(after.defaultDueDays) ||
        after.defaultDueDays < 0 ||
        after.defaultDueDays > 365
      )
        throw new FinanceRuleError("Payment terms are 0 to 365 days");
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.finance_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
