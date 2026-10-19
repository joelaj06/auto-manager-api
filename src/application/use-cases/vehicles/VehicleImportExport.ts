import { DomainError } from "../../../domain/errors/DomainError.js";
import { Money } from "../../../domain/money/Money.js";
import type { CustomFieldDefinition } from "../../../domain/vehicles/CustomFields.js";
import {
  BODY_TYPES,
  DEPRECIATION_METHODS,
  DRIVES,
  FUEL_TYPES,
  OWNERSHIP_TYPES,
  TRANSMISSIONS,
  USAGES,
} from "../../../domain/vehicles/Vehicle.js";
import { InvalidVehicleError } from "../../../domain/vehicles/VehicleIdentifiers.js";
import { isVehicleStatus } from "../../../domain/vehicles/VehicleStatus.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { BranchView, IBranches } from "../../ports/IBranches.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IReferenceData } from "../../ports/IReferenceData.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  IVehicleGroups,
  IVehicleQueries,
  IVehicleSettingsStore,
  VehicleGroup,
  VehicleListFilter,
} from "../../ports/IVehicleRecords.js";
import { MakeModelMatcher } from "./MakeModelMatcher.js";
import type { VehicleAccess } from "./VehicleAccess.js";
import type {
  FinancialsInput,
  NewVehicleInput,
  PreparedVehicle,
  VehicleRegistry,
} from "./VehicleRegistry.js";

/** The register's CSV columns (import and export use the same, so an export can be re-imported). */
export const VEHICLE_CSV_COLUMNS = [
  "plate_number",
  "vin",
  "make",
  "model",
  "trim",
  "year",
  "colour",
  "body_type",
  "fuel_type",
  "transmission",
  "engine_cc",
  "seats",
  "doors",
  "drive",
  "mileage_unit",
  "usage",
  "ownership_type",
  "status",
  "branch_code",
  "odometer",
  "groups",
  "tags",
  "engine_number",
  "chassis_number",
  "notes",
] as const;

/** Only with `vehicles.financials.view`. */
export const VEHICLE_FINANCIAL_COLUMNS = [
  "acquisition_date",
  "acquisition_cost",
  "residual_value",
  "depreciation_method",
  "useful_life_months",
] as const;

/** Custom fields are columns named `custom.<key>`. */
export const CUSTOM_PREFIX = "custom.";
/** Several groups or tags in one cell. */
const LIST_SEPARATOR = ";";

export const MAX_IMPORT_ROWS = 1_000;
export const MAX_EXPORT_ROWS = 10_000;

export type ImportRowResult = Readonly<{
  /** Line in the file (the header is line 1). */
  line: number;
  ok: boolean;
  error: string | null;
  plateNumber: string | null;
  make: string | null;
  model: string | null;
}>;

export type ImportResult = Readonly<{
  /** Every row passed; with `commit`, all were created (all or nothing). */
  valid: boolean;
  committed: boolean;
  created: number;
  rows: readonly ImportRowResult[];
}>;

export type CsvTable = Readonly<{
  columns: readonly string[];
  rows: readonly Readonly<Record<string, string>>[];
  truncated: boolean;
}>;

/** Thrown inside the unit of work to roll a preview back (vehicle codes are given back). */
class Rollback extends Error {
  constructor(readonly result: ImportResult) {
    super("rollback");
  }
}

/**
 * CSV import and export of the register (docs/06 §12): a template, a preview that checks every
 * row exactly as registration would (duplicates within the file included), and a commit that
 * creates all rows or none. Export writes the same columns, scoped to the caller's branches.
 */
export class VehicleImportExport {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      registry: VehicleRegistry;
      queries: IVehicleQueries;
      groups: IVehicleGroups;
      branches: IBranches;
      settings: IVehicleSettingsStore;
      organisation: IOrganisationSettings;
      reference: IReferenceData;
      access: VehicleAccess;
    }>,
  ) {}

  async template(actor: Principal): Promise<CsvTable> {
    const columns = await this.columns(actor);
    const example: Record<string, string> = {
      plate_number: "GR 1234-21",
      make: "Toyota",
      model: "Corolla",
      year: "2018",
      colour: "Silver",
      body_type: "saloon",
      fuel_type: "petrol",
      transmission: "automatic",
      usage: "fleet",
      status: "available",
      odometer: "84500",
      tags: "uber;ac",
    };
    return { columns, rows: [example], truncated: false };
  }

  async import(
    actor: Principal,
    rows: readonly Readonly<Record<string, string>>[],
    commit: boolean,
  ): Promise<ImportResult> {
    const { deps } = this;
    if (rows.length === 0) throw new InvalidVehicleError("The file has no vehicles");
    if (rows.length > MAX_IMPORT_ROWS)
      throw new InvalidVehicleError(`Import at most ${MAX_IMPORT_ROWS} vehicles at a time`);
    try {
      return await deps.unitOfWork.run(async () => {
        // One transaction client: queries run one after another.
        const branches = await deps.branches.list();
        const groups = await deps.groups.list();
        const settings = await deps.settings.get();
        const matcher = new MakeModelMatcher(deps.reference);
        const seen = { plates: new Set<string>(), vins: new Set<string>() };
        const results: ImportRowResult[] = [];
        const prepared: PreparedVehicle[] = [];
        for (const [index, row] of rows.entries()) {
          const line = index + 2;
          try {
            const input = toInput(row, branches, groups, settings.customFields);
            const vehicle = await deps.registry.prepare(actor, input, { matcher, seen });
            prepared.push(vehicle);
            const s = vehicle.vehicle.snapshot();
            results.push({
              line,
              ok: true,
              error: null,
              plateNumber: s.plateNumber,
              make: s.make,
              model: s.model,
            });
          } catch (error) {
            if (!(error instanceof DomainError) && !(error instanceof ApplicationError))
              throw error;
            results.push({
              line,
              ok: false,
              error: error.message,
              plateNumber: row.plate_number ?? null,
              make: row.make ?? null,
              model: row.model ?? null,
            });
          }
        }
        const valid = results.every((r) => r.ok);
        if (!commit || !valid)
          throw new Rollback({ valid, committed: false, created: 0, rows: results });
        for (const vehicle of prepared) await deps.registry.persist(actor, vehicle, "import");
        return { valid, committed: true, created: prepared.length, rows: results };
      });
    } catch (error) {
      if (error instanceof Rollback) return error.result;
      throw error;
    }
  }

  async export(
    actor: Principal,
    filter: Omit<VehicleListFilter, "branchIds" | "limit" | "after">,
  ): Promise<CsvTable> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicles = await deps.queries.list({
        ...filter,
        branchIds: deps.access.branchesFor(actor, "vehicles.export"),
        limit: MAX_EXPORT_ROWS + 1,
      });
      const branches = await deps.branches.list();
      const groups = await deps.groups.list();
      const currency = await deps.organisation.currencySettings();
      const columns = await this.columns(actor);
      const branchCode = new Map(branches.map((b) => [b.id, b.code]));
      const groupName = new Map(groups.map((g) => [g.id, g.name]));
      const amount = (minor: number | null) =>
        minor === null ? "" : Money.ofMinor(minor, currency.baseCurrency).toDecimalString();
      const rows = vehicles.slice(0, MAX_EXPORT_ROWS).map((v) => {
        const row: Record<string, string> = {
          code: v.code,
          plate_number: v.plateNumber ?? "",
          vin: v.vin ?? "",
          make: v.make,
          model: v.model,
          trim: v.trim ?? "",
          year: v.year?.toString() ?? "",
          colour: v.colour ?? "",
          body_type: v.bodyType ?? "",
          fuel_type: v.fuelType ?? "",
          transmission: v.transmission ?? "",
          engine_cc: v.engineCc?.toString() ?? "",
          seats: v.seats?.toString() ?? "",
          doors: v.doors?.toString() ?? "",
          drive: v.drive ?? "",
          mileage_unit: v.mileageUnit,
          usage: v.usage,
          ownership_type: v.ownershipType,
          status: v.status,
          branch_code: branchCode.get(v.branchId) ?? "",
          odometer: v.currentOdometer?.toString() ?? "",
          groups: v.groupIds.map((g) => groupName.get(g) ?? "").join(LIST_SEPARATOR),
          tags: v.tags.join(LIST_SEPARATOR),
          engine_number: v.engineNumber ?? "",
          chassis_number: v.chassisNumber ?? "",
          notes: v.notes ?? "",
        };
        for (const [key, value] of Object.entries(v.customFields))
          row[`${CUSTOM_PREFIX}${key}`] = String(value);
        if (deps.access.canSeeFinancials(actor, v.branchId)) {
          row.acquisition_date = v.acquisitionDate ?? "";
          row.acquisition_cost = amount(v.acquisitionCostMinor);
          row.residual_value = amount(v.residualValueMinor);
          row.depreciation_method = v.depreciationMethod;
          row.useful_life_months = v.usefulLifeMonths?.toString() ?? "";
        }
        return row;
      });
      return { columns: ["code", ...columns], rows, truncated: vehicles.length > MAX_EXPORT_ROWS };
    });
  }

  private async columns(actor: Principal): Promise<string[]> {
    const { customFields } = await this.deps.unitOfWork.run(() => this.deps.settings.get());
    const financials = this.deps.access.branchesFor(actor, "vehicles.financials.view");
    return [
      ...VEHICLE_CSV_COLUMNS,
      ...customFields.map((f) => `${CUSTOM_PREFIX}${f.key}`),
      ...(financials === "all" || financials.length > 0 ? VEHICLE_FINANCIAL_COLUMNS : []),
    ];
  }
}

function toInput(
  row: Readonly<Record<string, string>>,
  branches: readonly BranchView[],
  groups: readonly VehicleGroup[],
  customFields: readonly CustomFieldDefinition[],
): NewVehicleInput {
  const cell = (column: string): string | undefined => {
    const value = row[column]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const int = (column: string): number | undefined => {
    const value = cell(column)?.replaceAll(",", "");
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new InvalidVehicleError(`${column} must be a whole number`);
    return Number(value);
  };
  const choice = <T extends string>(column: string, allowed: readonly T[]): T | undefined => {
    const value = cell(column)?.toLowerCase();
    if (value === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(value))
      throw new InvalidVehicleError(`${column} must be one of ${allowed.join(", ")}`);
    return value as T;
  };
  const list = (column: string) =>
    (cell(column) ?? "")
      .split(LIST_SEPARATOR)
      .map((v) => v.trim())
      .filter((v) => v !== "");

  const branchCode = cell("branch_code");
  let branchId: string | undefined;
  if (branchCode !== undefined) {
    const branch = branches.find((b) => b.code.toLowerCase() === branchCode.toLowerCase());
    if (branch === undefined) throw new InvalidVehicleError(`Unknown branch code ${branchCode}`);
    branchId = branch.id;
  }
  const groupIds = list("groups").map((name) => {
    const group = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (group === undefined) throw new InvalidVehicleError(`Unknown vehicle group "${name}"`);
    return group.id;
  });
  const status = cell("status")?.toLowerCase();
  if (status !== undefined && !isVehicleStatus(status))
    throw new InvalidVehicleError(`Unknown status ${status}`);

  const custom: Record<string, unknown> = {};
  for (const definition of customFields) {
    const value = cell(`${CUSTOM_PREFIX}${definition.key}`);
    if (value === undefined) continue;
    custom[definition.key] = customValue(definition, value);
  }

  const hasFinancials = VEHICLE_FINANCIAL_COLUMNS.some((c) => cell(c) !== undefined);
  const financials: FinancialsInput | undefined = hasFinancials
    ? {
        acquisitionDate: cell("acquisition_date") ?? null,
        acquisitionCost: cell("acquisition_cost")?.replaceAll(",", "") ?? null,
        residualValue: cell("residual_value")?.replaceAll(",", "") ?? null,
        depreciationMethod: choice("depreciation_method", DEPRECIATION_METHODS) ?? "none",
        usefulLifeMonths: int("useful_life_months") ?? null,
      }
    : undefined;

  const input: Record<string, unknown> = {
    plateNumber: cell("plate_number") ?? null,
    vin: cell("vin") ?? null,
    make: cell("make") ?? "",
    model: cell("model") ?? "",
    trim: cell("trim") ?? null,
    year: int("year") ?? null,
    colour: cell("colour") ?? null,
    bodyType: choice("body_type", BODY_TYPES) ?? null,
    fuelType: choice("fuel_type", FUEL_TYPES) ?? null,
    transmission: choice("transmission", TRANSMISSIONS) ?? null,
    engineCc: int("engine_cc") ?? null,
    seats: int("seats") ?? null,
    doors: int("doors") ?? null,
    drive: choice("drive", DRIVES) ?? null,
    mileageUnit: choice("mileage_unit", ["km", "mi"] as const) ?? "km",
    usage: choice("usage", USAGES) ?? "fleet",
    ownershipType: choice("ownership_type", OWNERSHIP_TYPES) ?? "owned",
    engineNumber: cell("engine_number") ?? null,
    chassisNumber: cell("chassis_number") ?? null,
    notes: cell("notes") ?? null,
    tags: list("tags"),
    groupIds,
    customFields: custom,
    odometer: int("odometer") ?? null,
    ...(branchId === undefined ? {} : { branchId }),
    ...(status === undefined ? {} : { status }),
    ...(financials === undefined ? {} : { financials }),
  };
  return input;
}

function customValue(definition: CustomFieldDefinition, value: string): unknown {
  switch (definition.type) {
    case "number": {
      const number = Number(value.replaceAll(",", ""));
      if (!Number.isFinite(number))
        throw new InvalidVehicleError(`${definition.label} must be a number`);
      return number;
    }
    case "boolean": {
      const lower = value.toLowerCase();
      if (["yes", "true", "1", "y"].includes(lower)) return true;
      if (["no", "false", "0", "n"].includes(lower)) return false;
      throw new InvalidVehicleError(`${definition.label} must be yes or no`);
    }
    default:
      return value;
  }
}
