import { AssignmentRuleError } from "../../../domain/assignments/VehicleAssignment.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  AssignmentSettings,
  IAssignmentSettingsStore,
} from "../../ports/IAssignmentRecords.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Assignment settings: the handover checklist, the remittance mode of new remittance
 * assignments (decision 8) and whether an expired licence blocks an assignment.
 */
export class AssignmentSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IAssignmentSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<AssignmentSettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(
    actor: Principal,
    changes: Partial<AssignmentSettings>,
  ): Promise<AssignmentSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: AssignmentSettings = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      const keys = after.handoverItems.map((i) => i.key);
      if (keys.length > 30 || keys.some((k) => !KEY.test(k)) || new Set(keys).size !== keys.length)
        throw new AssignmentRuleError(
          "Up to 30 checklist items with distinct keys (lowercase letters, digits and _)",
        );
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.assignments_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
