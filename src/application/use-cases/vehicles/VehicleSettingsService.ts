import {
  validateCustomFieldDefinitions,
  type CustomFieldDefinition,
} from "../../../domain/vehicles/CustomFields.js";
import {
  checkReminderDays,
  type VehicleDocumentType,
} from "../../../domain/vehicles/VehicleCompliance.js";
import { InvalidVehicleError } from "../../../domain/vehicles/VehicleIdentifiers.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  IVehicleSettingsStore,
  VehicleComplianceSettings,
  VehicleSettings,
} from "../../ports/IVehicleRecords.js";
import { recordUserAction } from "../reference/userAudit.js";

export type VehicleSettingsChanges = Readonly<{
  compliance?: Partial<VehicleComplianceSettings>;
  reminderDays?: Readonly<Partial<Record<VehicleDocumentType, readonly number[]>>>;
  customFields?: readonly CustomFieldDefinition[];
}>;

/**
 * The business's vehicle settings: which documents a vehicle needs to operate, when a document
 * counts as expiring, whether modules block or only warn, default reminder days, and the custom
 * fields of its vehicles.
 */
export class VehicleSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IVehicleSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<VehicleSettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(actor: Principal, changes: VehicleSettingsChanges): Promise<VehicleSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: VehicleSettings = {
        compliance: { ...before.compliance, ...changes.compliance },
        reminderDays: Object.fromEntries(
          Object.entries({ ...before.reminderDays, ...changes.reminderDays }).map(([k, v]) => [
            k,
            checkReminderDays(v ?? []),
          ]),
        ),
        customFields: changes.customFields ?? before.customFields,
      };
      if (after.compliance.expiringWithinDays < 1 || after.compliance.expiringWithinDays > 180)
        throw new InvalidVehicleError("“Expiring” is 1 to 180 days before expiry");
      validateCustomFieldDefinitions(after.customFields);
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.vehicles_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
