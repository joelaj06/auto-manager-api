import { InvalidVehicleError } from "../../../domain/vehicles/VehicleIdentifiers.js";
import type { IReferenceData, VehicleMake, VehicleModel } from "../../ports/IReferenceData.js";
import { VehicleMakeNotFoundError } from "../reference/VehicleCatalogue.js";

export type MakeModel = Readonly<{
  makeId: string | null;
  make: string;
  modelId: string | null;
  model: string;
}>;

/**
 * Links a vehicle's make and model to the platform catalogue (decision 147): by id, or by name
 * (any case) so "toyota corolla" typed or imported still counts as the catalogue's Toyota
 * Corolla. Unknown names stay free text. Caches the catalogue for one operation (an import).
 */
export class MakeModelMatcher {
  private makes: Promise<VehicleMake[]> | null = null;
  private readonly models = new Map<string, Promise<VehicleModel[]>>();

  constructor(private readonly reference: IReferenceData) {}

  async resolve(
    input: Readonly<{
      makeId?: string | null;
      make?: string | null;
      modelId?: string | null;
      model?: string | null;
    }>,
  ): Promise<MakeModel> {
    let makeId: string | null = null;
    let make = input.make?.trim() ?? "";
    if (input.makeId !== undefined && input.makeId !== null) {
      const found = (await this.allMakes()).find((m) => m.id === input.makeId);
      if (found === undefined) throw new VehicleMakeNotFoundError();
      makeId = found.id;
      make = found.name;
    } else if (make !== "") {
      const found = (await this.allMakes()).find(
        (m) => m.name.toLowerCase() === make.toLowerCase(),
      );
      if (found !== undefined) {
        makeId = found.id;
        make = found.name;
      }
    }

    let modelId: string | null = null;
    let model = input.model?.trim() ?? "";
    if (input.modelId !== undefined && input.modelId !== null) {
      const found =
        makeId === null
          ? undefined
          : (await this.modelsOf(makeId)).find((m) => m.id === input.modelId);
      if (found === undefined)
        throw new InvalidVehicleError("That model is not a model of the chosen make");
      modelId = found.id;
      model = found.name;
    } else if (makeId !== null && model !== "") {
      const found = (await this.modelsOf(makeId)).find(
        (m) => m.name.toLowerCase() === model.toLowerCase(),
      );
      if (found !== undefined) {
        modelId = found.id;
        model = found.name;
      }
    }
    return { makeId, make, modelId, model };
  }

  private allMakes(): Promise<VehicleMake[]> {
    this.makes ??= this.reference.vehicleMakes({ includeInactive: true });
    return this.makes;
  }

  private modelsOf(makeId: string): Promise<VehicleModel[]> {
    let models = this.models.get(makeId);
    if (models === undefined) {
      models = this.reference.vehicleModels(makeId, true);
      this.models.set(makeId, models);
    }
    return models;
  }
}
