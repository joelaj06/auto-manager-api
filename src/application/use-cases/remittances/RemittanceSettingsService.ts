import { RemittanceRuleError } from "../../../domain/remittances/Remittance.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type {
  IRemittanceSettingsStore,
  RemittanceSettings,
} from "../../ports/IRemittanceRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";

/** Remittance settings: grace days before a target is overdue, the board's shortfall alert. */
export class RemittanceSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IRemittanceSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<RemittanceSettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(
    actor: Principal,
    changes: Partial<RemittanceSettings>,
  ): Promise<RemittanceSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: RemittanceSettings = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      if (after.graceDays < 0 || after.graceDays > 30)
        throw new RemittanceRuleError("Grace is 0 to 30 days");
      if (after.shortfallAlertPeriods < 1 || after.shortfallAlertPeriods > 14)
        throw new RemittanceRuleError("The alert is 1 to 14 short periods");
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.remittances_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
