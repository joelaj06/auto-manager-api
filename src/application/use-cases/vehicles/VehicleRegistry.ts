import { Money } from "../../../domain/money/Money.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { validateCustomFields } from "../../../domain/vehicles/CustomFields.js";
import {
  checkOdometerReading,
  type OdometerSource,
} from "../../../domain/vehicles/OdometerReading.js";
import {
  NO_FINANCIALS,
  Vehicle,
  type StatusChange,
  type VehicleDetails,
  type VehicleFinancials,
} from "../../../domain/vehicles/Vehicle.js";
import { InvalidVehicleError } from "../../../domain/vehicles/VehicleIdentifiers.js";
import type { VehicleStatus } from "../../../domain/vehicles/VehicleStatus.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import type { Page } from "../../dto/Page.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  IOdometerReadings,
  IVehicleGroups,
  IVehicleQueries,
  IVehicleSettingsStore,
  StatusHistoryEntry,
  VehicleListFilter,
} from "../../ports/IVehicleRecords.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import { MakeModelMatcher } from "./MakeModelMatcher.js";
import { VehicleExistsError, type VehicleAccess } from "./VehicleAccess.js";
import { vehicleView, type VehicleView, type ViewOptions } from "./VehicleView.js";

/** Financial fields as sent by clients: amounts as decimal strings in the base currency. */
export type FinancialsInput = Readonly<{
  acquisitionDate?: string | null;
  acquisitionCost?: string | null;
  residualValue?: string | null;
  depreciationMethod?: VehicleFinancials["depreciationMethod"];
  usefulLifeMonths?: number | null;
}>;

export type VehicleChanges = Partial<
  Omit<VehicleDetails, "customFields" | "makeId" | "modelId" | "make" | "model">
> &
  Readonly<{
    makeId?: string | null;
    make?: string;
    modelId?: string | null;
    model?: string;
    /** Merged into the current values; null clears a field. */
    customFields?: Readonly<Record<string, unknown>>;
    groupIds?: readonly string[];
    financials?: FinancialsInput;
  }>;

export type NewVehicleInput = VehicleChanges &
  Readonly<{
    branchId?: string;
    status?: VehicleStatus;
    /** The odometer at registration (first reading). */
    odometer?: number | null;
  }>;

export type VehicleQuery = Omit<VehicleListFilter, "branchIds" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/** A new vehicle checked and ready to save (shared with the CSV import). */
export type PreparedVehicle = Readonly<{
  vehicle: Vehicle;
  change: StatusChange;
  odometer: number | null;
}>;

export type PrepareOptions = Readonly<{
  matcher?: MakeModelMatcher;
  /** Plates and VINs already used by earlier rows of the same import. */
  seen?: Readonly<{ plates: Set<string>; vins: Set<string> }>;
}>;

const EMPTY_DETAILS: VehicleDetails = Object.freeze({
  plateNumber: null,
  vin: null,
  engineNumber: null,
  chassisNumber: null,
  makeId: null,
  make: "",
  modelId: null,
  model: "",
  trim: null,
  year: null,
  colour: null,
  bodyType: null,
  fuelType: null,
  transmission: null,
  engineCc: null,
  seats: null,
  doors: null,
  drive: null,
  mileageUnit: "km",
  usage: "fleet",
  ownershipType: "owned",
  ownershipNote: null,
  tags: [],
  specs: {},
  customFields: {},
  notes: null,
});

export const MAX_TRANSFER = 100;

/**
 * The vehicle register (docs/06 §2–3, §12): list and view within the caller's branches, register,
 * edit, move between branches, change status by hand (only between states no module owns) and
 * remove mistaken entries. Financial fields are shown and edited only with
 * `vehicles.financials.view`.
 */
export class VehicleRegistry {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      vehicles: IVehicleRepository;
      queries: IVehicleQueries;
      groups: IVehicleGroups;
      odometer: IOdometerReadings;
      settings: IVehicleSettingsStore;
      organisation: IOrganisationSettings;
      reference: IReferenceData;
      numbering: DocumentNumbering;
      access: VehicleAccess;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, query: VehicleQuery): Promise<Page<VehicleView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.queries.list({
        ...query,
        branchIds: deps.access.branchesFor(actor, "vehicles.list"),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { createdAt: String(after[0]), id: String(after[1]) } }),
      });
      const options = await this.viewContext();
      const page = PageCursor.paginate(rows, query.limit, (v) => [v.createdAt.toISOString(), v.id]);
      return {
        ...page,
        items: page.items.map((v) =>
          vehicleView(v, {
            ...options,
            financials: deps.access.canSeeFinancials(actor, v.branchId),
          }),
        ),
      };
    });
  }

  async get(actor: Principal, id: string): Promise<VehicleView> {
    return this.deps.unitOfWork.run(async () => {
      const vehicle = await this.deps.access.reach(actor, id, "vehicles.view");
      return this.view(actor, vehicle);
    });
  }

  async create(actor: Principal, input: NewVehicleInput): Promise<VehicleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const prepared = await this.prepare(actor, input);
      await this.persist(actor, prepared, "manual");
      return this.view(actor, prepared.vehicle);
    });
  }

  /**
   * Checks a new vehicle without saving it (also used row by row by the import). Call inside a
   * unit of work: the vehicle code is drawn from the counter (rolled back if not saved).
   */
  async prepare(
    actor: Principal,
    input: NewVehicleInput,
    options: PrepareOptions = {},
  ): Promise<PreparedVehicle> {
    const { deps } = this;
    const now = deps.clock.now();
    const branchId = input.branchId ?? (await deps.access.defaultBranch(actor, "vehicles.create"));
    await deps.access.branch(actor, "vehicles.create", branchId);
    const financials =
      input.financials === undefined
        ? NO_FINANCIALS
        : await this.financials(actor, branchId, NO_FINANCIALS, input.financials);
    const settings = await deps.settings.get();
    const makeModel = await (options.matcher ?? new MakeModelMatcher(deps.reference)).resolve(
      input,
    );
    const groupIds = await this.checkGroups(input.groupIds ?? []);
    const { vehicle, change } = Vehicle.register({
      id: deps.ids.next(),
      code: await deps.numbering.next("vehicle", now),
      branchId,
      status: input.status ?? "available",
      details: {
        ...EMPTY_DETAILS,
        ...pickDetails(input),
        ...makeModel,
        customFields: validateCustomFields(settings.customFields, input.customFields ?? {}),
      },
      financials,
      groupIds,
      createdBy: actor.userId,
      now,
      currentYear: now.getUTCFullYear(),
    });
    await this.assertUnique(vehicle, options.seen);
    const odometer = input.odometer ?? null;
    if (odometer !== null)
      checkOdometerReading(
        { value: odometer, readAt: now, replacement: false, note: null },
        { before: null, after: null },
        now,
      );
    return { vehicle, change, odometer };
  }

  /** Saves a prepared vehicle with its first status entry and odometer reading. */
  async persist(
    actor: Principal,
    prepared: PreparedVehicle,
    source: OdometerSource,
  ): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const { vehicle, change, odometer } = prepared;
    if (odometer !== null) vehicle.applyOdometer(odometer, now, now);
    await deps.vehicles.save(vehicle);
    await deps.vehicles.recordStatusChange(vehicle.id, change, actor.userId, now);
    if (odometer !== null)
      await deps.odometer.add({
        id: deps.ids.next(),
        vehicleId: vehicle.id,
        value: odometer,
        readAt: now,
        source,
        refId: null,
        replacement: false,
        note: null,
        recordedBy: actor.userId,
        createdAt: now,
      });
    const { acquisitionCostMinor: _c, residualValueMinor: _r, ...after } = vehicle.snapshot();
    await recordUserAction(deps, actor.userId, {
      action: "vehicle.created",
      entityType: "vehicle",
      entityId: vehicle.id,
      after: { ...after, source },
    });
  }

  async update(actor: Principal, id: string, changes: VehicleChanges): Promise<VehicleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, id, "vehicles.update", true);
      const before = vehicle.snapshot();
      const now = deps.clock.now();
      const { customFields, groupIds, financials } = changes;
      const touchesMake =
        changes.make !== undefined ||
        changes.makeId !== undefined ||
        changes.model !== undefined ||
        changes.modelId !== undefined;
      const makeModel = touchesMake
        ? await new MakeModelMatcher(deps.reference).resolve({
            makeId:
              changes.makeId === undefined && changes.make === undefined
                ? before.makeId
                : changes.makeId,
            make: changes.make ?? before.make,
            modelId:
              changes.modelId === undefined && changes.model === undefined
                ? before.modelId
                : changes.modelId,
            model: changes.model ?? before.model,
          })
        : {};
      const custom =
        customFields === undefined
          ? {}
          : {
              customFields: validateCustomFields((await deps.settings.get()).customFields, {
                ...before.customFields,
                ...customFields,
              }),
            };
      vehicle.updateDetails(
        { ...pickDetails(changes), ...makeModel, ...custom },
        now,
        now.getUTCFullYear(),
      );
      if (financials !== undefined)
        vehicle.updateFinancials(
          await this.financials(actor, vehicle.branchId, before, financials),
          now,
        );
      if (groupIds !== undefined) vehicle.setGroups(await this.checkGroups(groupIds), now);
      await this.assertUnique(vehicle);
      await deps.vehicles.save(vehicle);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle.updated",
        entityType: "vehicle",
        entityId: id,
        before: changed(before, vehicle.snapshot()).before,
        after: changed(before, vehicle.snapshot()).after,
      });
      return this.view(actor, vehicle);
    });
  }

  /** Moves vehicles to another branch (bulk, docs/06 §12). All or nothing. */
  async transfer(
    actor: Principal,
    input: Readonly<{ vehicleIds: readonly string[]; branchId: string; reason: string }>,
  ): Promise<VehicleView[]> {
    const { deps } = this;
    const ids = [...new Set(input.vehicleIds)];
    if (ids.length === 0 || ids.length > MAX_TRANSFER)
      throw new InvalidVehicleError(`Transfer 1 to ${MAX_TRANSFER} vehicles at a time`);
    return deps.unitOfWork.run(async () => {
      await deps.access.branch(actor, "vehicles.update", input.branchId);
      const now = deps.clock.now();
      const moved: Vehicle[] = [];
      for (const id of ids) {
        const vehicle = await deps.access.reach(actor, id, "vehicles.update", true);
        const from = vehicle.branchId;
        if (from === input.branchId) continue;
        vehicle.moveToBranch(input.branchId, now);
        await deps.vehicles.save(vehicle);
        await recordUserAction(deps, actor.userId, {
          action: "vehicle.transferred",
          entityType: "vehicle",
          entityId: id,
          before: { branchId: from },
          after: { branchId: input.branchId },
          metadata: { reason: input.reason },
        });
        moved.push(vehicle);
      }
      const views: VehicleView[] = [];
      for (const vehicle of moved) views.push(await this.view(actor, vehicle));
      return views;
    });
  }

  /** States the caller may move the vehicle to by hand. */
  async statusOptions(actor: Principal, id: string): Promise<VehicleStatus[]> {
    return this.deps.unitOfWork.run(async () =>
      (await this.deps.access.reach(actor, id, "vehicles.change_status")).nextStatuses(true),
    );
  }

  async changeStatus(
    actor: Principal,
    id: string,
    input: Readonly<{ status: VehicleStatus; reason: string }>,
  ): Promise<VehicleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, id, "vehicles.change_status", true);
      const now = deps.clock.now();
      const change = vehicle.changeStatus(input.status, {
        manual: true,
        reason: input.reason,
        now,
      });
      await deps.vehicles.save(vehicle);
      await deps.vehicles.recordStatusChange(id, change, actor.userId, now);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle.status_changed",
        entityType: "vehicle",
        entityId: id,
        before: { status: change.from },
        after: { status: change.to },
        metadata: { reason: change.reason },
      });
      return this.view(actor, vehicle);
    });
  }

  /**
   * A module moves a vehicle (locked in the caller's unit of work) into or out of one of its
   * states, with a reference to the record that causes it (an assignment, a rental …).
   */
  async moveByModule(
    vehicle: Vehicle,
    to: VehicleStatus,
    params: Readonly<{
      ref: Readonly<{ type: string; id: string }>;
      reason: string;
      userId: string;
    }>,
  ): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const change = vehicle.changeStatus(to, {
      manual: false,
      reason: params.reason,
      ref: params.ref,
      now,
    });
    await deps.vehicles.save(vehicle);
    await deps.vehicles.recordStatusChange(vehicle.id, change, params.userId, now);
  }

  async statusHistory(actor: Principal, id: string, limit: number): Promise<StatusHistoryEntry[]> {
    return this.deps.unitOfWork.run(async () => {
      await this.deps.access.reach(actor, id, "vehicles.view");
      return this.deps.queries.statusHistory(id, limit);
    });
  }

  async remove(actor: Principal, id: string, reason: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, id, "vehicles.delete", true);
      vehicle.remove(reason, deps.clock.now());
      await deps.vehicles.save(vehicle);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle.removed",
        entityType: "vehicle",
        entityId: id,
        before: { code: vehicle.snapshot().code, plateNumber: vehicle.snapshot().plateNumber },
        metadata: { reason },
      });
    });
  }

  /** Currency and "today" (tenant timezone) for views. */
  async viewContext(): Promise<Omit<ViewOptions, "financials">> {
    const { deps } = this;
    const organisation = await deps.organisation.get();
    const currency = await deps.organisation.currencySettings();
    return {
      currency: currency.baseCurrency,
      today: localDateTime(deps.clock.now(), organisation.timezone).date,
    };
  }

  async view(actor: Principal, vehicle: Vehicle): Promise<VehicleView> {
    return vehicleView(vehicle.snapshot(), {
      ...(await this.viewContext()),
      financials: this.deps.access.canSeeFinancials(actor, vehicle.branchId),
    });
  }

  private async financials(
    actor: Principal,
    branchId: string,
    current: VehicleFinancials,
    input: FinancialsInput,
  ): Promise<VehicleFinancials> {
    if (!this.deps.access.canSeeFinancials(actor, branchId))
      throw new PermissionDeniedError("vehicles.financials.view");
    const { baseCurrency } = await this.deps.organisation.currencySettings();
    const minor = (value: string | null | undefined, fallback: number | null) =>
      value === undefined
        ? fallback
        : value === null
          ? null
          : Money.parse(value, baseCurrency).amountMinor;
    const cost = minor(input.acquisitionCost, current.acquisitionCostMinor);
    const residual = minor(input.residualValue, current.residualValueMinor);
    if ((cost ?? 0) < 0 || (residual ?? 0) < 0)
      throw new InvalidVehicleError("Amounts cannot be negative");
    return {
      acquisitionDate:
        input.acquisitionDate === undefined ? current.acquisitionDate : input.acquisitionDate,
      acquisitionCostMinor: cost,
      residualValueMinor: residual,
      depreciationMethod: input.depreciationMethod ?? current.depreciationMethod,
      usefulLifeMonths:
        input.usefulLifeMonths === undefined ? current.usefulLifeMonths : input.usefulLifeMonths,
    };
  }

  private async checkGroups(groupIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(groupIds)];
    if (unique.length === 0) return [];
    const existing = await this.deps.groups.existing(unique);
    if (existing.length !== unique.length)
      throw new InvalidVehicleError("One of the groups does not exist");
    return unique;
  }

  private async assertUnique(
    vehicle: Vehicle,
    seen?: Readonly<{ plates: Set<string>; vins: Set<string> }>,
  ): Promise<void> {
    const { plateKey, plateNumber, vin } = vehicle.snapshot();
    if (plateKey !== null && plateNumber !== null) {
      if (
        seen?.plates.has(plateKey) === true ||
        (await this.deps.vehicles.plateTaken(plateKey, vehicle.id))
      )
        throw new VehicleExistsError("plate number", plateNumber);
      seen?.plates.add(plateKey);
    }
    if (vin !== null) {
      if (seen?.vins.has(vin) === true || (await this.deps.vehicles.vinTaken(vin, vehicle.id)))
        throw new VehicleExistsError("VIN", vin);
      seen?.vins.add(vin);
    }
  }
}

const DETAIL_KEYS = Object.keys(EMPTY_DETAILS).filter(
  (k) => !["customFields", "makeId", "make", "modelId", "model"].includes(k),
) as (keyof VehicleDetails)[];

/** The descriptive fields present in the input (make, model and custom fields go separately). */
function pickDetails(input: VehicleChanges): Partial<VehicleDetails> {
  return Object.fromEntries(
    DETAIL_KEYS.filter((k) => (input as Record<string, unknown>)[k] !== undefined).map((k) => [
      k,
      (input as Record<string, unknown>)[k],
    ]),
  );
}

/** Only the fields that changed, for the audit entry. */
function changed(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const result = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const key of Object.keys(after)) {
    if (key === "updatedAt") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      result.before[key] = before[key];
      result.after[key] = after[key];
    }
  }
  return result;
}
