import { DomainError } from "../../../domain/errors/DomainError.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IReferenceData, VehicleMake, VehicleModel } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";

export class VehicleMakeNotFoundError extends ApplicationError {
  readonly code = "VEHICLE_MAKE_NOT_FOUND";
  constructor() {
    super("Vehicle make not found");
  }
}

export class VehicleCatalogueRuleError extends DomainError {
  readonly code = "VEHICLE_CATALOGUE_RULE";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Vehicle makes and models (docs/27 §3.11): a platform list tenants pick from when registering
 * vehicles (free text stays possible for rare models); staff add entries.
 */
export class VehicleCatalogue {
  constructor(
    private readonly deps: Readonly<{
      reference: IReferenceData;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  makes(q?: string): Promise<VehicleMake[]> {
    return this.deps.reference.vehicleMakes({ ...(q === undefined ? {} : { q }) });
  }

  async models(makeId: string): Promise<VehicleModel[]> {
    if ((await this.deps.reference.vehicleMake(makeId)) === null)
      throw new VehicleMakeNotFoundError();
    return this.deps.reference.vehicleModels(makeId);
  }

  async addMake(name: string, actor: PlatformPrincipal): Promise<VehicleMake> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (await deps.reference.vehicleMakeNameTaken(name.trim()))
        throw new VehicleCatalogueRuleError(`${name.trim()} is already in the list`);
      const make = await deps.reference.addVehicleMake(name.trim());
      await recordStaffAction(deps, actor, {
        action: "reference.vehicle_make_added",
        entityType: "vehicle_make",
        entityId: make.id,
        after: make,
      });
      return make;
    });
  }

  async addModel(makeId: string, name: string, actor: PlatformPrincipal): Promise<VehicleModel> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if ((await deps.reference.vehicleMake(makeId)) === null) throw new VehicleMakeNotFoundError();
      if (await deps.reference.vehicleModelNameTaken(makeId, name.trim()))
        throw new VehicleCatalogueRuleError(`${name.trim()} is already in the list`);
      const model = await deps.reference.addVehicleModel(makeId, name.trim());
      await recordStaffAction(deps, actor, {
        action: "reference.vehicle_model_added",
        entityType: "vehicle_model",
        entityId: model.id,
        after: model,
      });
      return model;
    });
  }
}
