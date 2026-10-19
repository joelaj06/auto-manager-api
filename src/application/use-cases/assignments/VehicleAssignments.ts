import {
  buildChecklist,
  VehicleAssignment,
  AssignmentRuleError,
  type AssignmentType,
  type ChecklistAnswers,
  type RemittanceMode,
  type RemittanceTerms,
  type TargetFrequency,
} from "../../../domain/assignments/VehicleAssignment.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Driver } from "../../../domain/parties/Driver.js";
import type { IAssignmentRepository } from "../../../domain/repositories/IAssignmentRepository.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import {
  AssignmentConflictError,
  AssignmentNotFoundError,
  VehicleNotCompliantError,
} from "../../errors/AssignmentErrors.js";
import type {
  AssignmentListFilter,
  AssignmentRecord,
  AssignmentSettings,
  IAssignmentQueries,
  IAssignmentSettingsStore,
} from "../../ports/IAssignmentRecords.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { PageCursor } from "../../services/PageCursor.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { DriverAdministration } from "../parties/DriverAdministration.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { OdometerLog } from "../vehicles/OdometerLog.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import type { VehicleDocuments } from "../vehicles/VehicleDocuments.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";

/** Terms as sent by clients: the target as a decimal string in the base currency. */
export type TermsInput = Readonly<{
  mode?: RemittanceMode;
  target?: string | null;
  frequency?: TargetFrequency | null;
  daysOff?: readonly number[];
}>;

export type StartAssignmentInput = Readonly<{
  driverId: string;
  /** Default: from the driver's employment type. */
  type?: AssignmentType;
  terms?: TermsInput;
  /** Default: now; a late entry must not overlap earlier assignments. */
  startedAt?: Date;
  odometer: number;
  checklist: ChecklistAnswers;
  notes?: string | null;
}>;

export type EndAssignmentInput = Readonly<{
  odometer: number;
  checklist: ChecklistAnswers;
  reason: string;
  endedAt?: Date;
  /** Where the vehicle goes next (default available). */
  vehicleStatus?: "available" | "in_maintenance";
}>;

export type HandoverInput = Readonly<{
  toDriverId: string;
  odometer: number;
  checklist: ChecklistAnswers;
  reason: string;
  type?: AssignmentType;
  terms?: TermsInput;
  notes?: string | null;
}>;

export type AssignmentView = Omit<AssignmentRecord, "terms"> &
  Readonly<{
    terms: Readonly<{
      mode: RemittanceMode;
      target: MoneyJson | null;
      frequency: TargetFrequency | null;
      daysOff: readonly number[];
    }>;
    distance: number | null;
  }>;

export type StartResult = Readonly<{
  assignment: AssignmentView;
  /** Compliance problems the business only warns about (enforcement "warn"). */
  warnings: readonly string[];
}>;

export type AssignmentQuery = Omit<AssignmentListFilter, "branchIds" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/**
 * Vehicle ↔ driver assignments (docs/06 §6, decision 9): one driver per vehicle and one vehicle
 * per driver at a time, with remittance terms (decision 8), the handover checklist and the
 * odometer at both ends. Starting moves the vehicle to `assigned`, ending back to `available`
 * (or the workshop); a handover changes the driver in one step. The history answers "who was
 * driving on date X".
 */
export class VehicleAssignments {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      assignments: IAssignmentRepository;
      queries: IAssignmentQueries;
      settings: IAssignmentSettingsStore;
      vehicles: VehicleAccess;
      registry: VehicleRegistry;
      odometer: OdometerLog;
      documents: VehicleDocuments;
      drivers: DriverAdministration;
      organisation: IOrganisationSettings;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async start(
    actor: Principal,
    vehicleId: string,
    input: StartAssignmentInput,
  ): Promise<StartResult> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicles.reach(actor, vehicleId, "vehicles.assign_driver", true);
      if (vehicle.status !== "available")
        throw new AssignmentRuleError(
          `Only an available vehicle can be assigned (this one is ${vehicle.status.replaceAll("_", " ")})`,
        );
      const warnings = await this.compliance(vehicleId);
      const settings = await deps.settings.get();
      const assignment = await this.open(actor, vehicle, input, settings, input.startedAt);
      await deps.odometer.recordFor(
        vehicle,
        { value: input.odometer, readAt: assignment.snapshot().startedAt },
        "assignment",
        assignment.id,
        actor.userId,
      );
      await deps.registry.moveByModule(vehicle, "assigned", {
        ref: { type: "assignment", id: assignment.id },
        reason: "Assigned to a driver",
        userId: actor.userId,
      });
      await this.audit(actor, "vehicle_assignment.started", assignment);
      return { assignment: await this.view(assignment.id), warnings };
    });
  }

  async end(
    actor: Principal,
    vehicleId: string,
    input: EndAssignmentInput,
  ): Promise<AssignmentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicles.reach(actor, vehicleId, "vehicles.assign_driver", true);
      const assignment = await this.current(vehicleId);
      const settings = await deps.settings.get();
      const endedAt = input.endedAt ?? deps.clock.now();
      assignment.end({
        endedAt,
        endOdometer: input.odometer,
        checklist: buildChecklist(settings.handoverItems, input.checklist),
        reason: input.reason,
        endedBy: actor.userId,
        now: deps.clock.now(),
      });
      await this.save(assignment);
      await deps.odometer.recordFor(
        vehicle,
        { value: input.odometer, readAt: endedAt },
        "assignment",
        assignment.id,
        actor.userId,
      );
      // A vehicle reported in an accident (or impounded …) while assigned stays where it is.
      if (vehicle.status === "assigned")
        await deps.registry.moveByModule(vehicle, input.vehicleStatus ?? "available", {
          ref: { type: "assignment", id: assignment.id },
          reason: input.reason,
          userId: actor.userId,
        });
      await this.audit(actor, "vehicle_assignment.ended", assignment);
      return this.view(assignment.id);
    });
  }

  /**
   * Changes the driver in one step: same instant, same odometer, one checklist; the terms carry
   * over unless new ones are given.
   */
  async handover(actor: Principal, vehicleId: string, input: HandoverInput): Promise<StartResult> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicles.reach(actor, vehicleId, "vehicles.assign_driver", true);
      const previous = await this.current(vehicleId);
      const settings = await deps.settings.get();
      const now = deps.clock.now();
      const checklist = buildChecklist(settings.handoverItems, input.checklist);
      previous.end({
        endedAt: now,
        endOdometer: input.odometer,
        checklist,
        reason: input.reason,
        endedBy: actor.userId,
        now,
      });
      await this.save(previous);
      const warnings = await this.compliance(vehicleId);
      const next = await this.open(
        actor,
        vehicle,
        { ...input, driverId: input.toDriverId },
        settings,
        now,
        previous.snapshot().terms,
      );
      await deps.odometer.recordFor(
        vehicle,
        { value: input.odometer, readAt: now },
        "assignment",
        next.id,
        actor.userId,
      );
      await this.audit(actor, "vehicle_assignment.ended", previous);
      await this.audit(actor, "vehicle_assignment.started", next);
      return { assignment: await this.view(next.id), warnings };
    });
  }

  /** New terms for the rest of an open assignment. */
  async changeTerms(
    actor: Principal,
    vehicleId: string,
    input: TermsInput,
  ): Promise<AssignmentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.vehicles.reach(actor, vehicleId, "vehicles.assign_driver", true);
      const assignment = await this.current(vehicleId);
      const before = assignment.snapshot().terms;
      assignment.changeTerms(
        await this.terms(input, assignment.snapshot().type, await deps.settings.get(), before),
        deps.clock.now(),
      );
      await this.save(assignment);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_assignment.terms_changed",
        entityType: "vehicle",
        entityId: vehicleId,
        before,
        after: assignment.snapshot().terms,
        metadata: { assignmentId: assignment.id },
      });
      return this.view(assignment.id);
    });
  }

  /** The vehicle's current assignment, if any. */
  async currentFor(actor: Principal, vehicleId: string): Promise<AssignmentView | null> {
    return this.deps.unitOfWork.run(async () => {
      await this.deps.vehicles.reach(actor, vehicleId, "vehicles.view");
      const record = await this.deps.queries.openForVehicle(vehicleId);
      return record === null ? null : this.present(record, await this.currency());
    });
  }

  /** Who had the vehicle at an instant (traffic fines, accidents). */
  async at(actor: Principal, vehicleId: string, instant: Date): Promise<AssignmentView | null> {
    return this.deps.unitOfWork.run(async () => {
      await this.deps.vehicles.reach(actor, vehicleId, "vehicles.view");
      const record = await this.deps.queries.at(vehicleId, instant);
      return record === null ? null : this.present(record, await this.currency());
    });
  }

  /** Assignments in the caller's branches (current board or history), newest first. */
  async list(actor: Principal, query: AssignmentQuery): Promise<Page<AssignmentView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      if (query.vehicleId !== undefined)
        await deps.vehicles.reach(actor, query.vehicleId, "vehicles.view");
      if (query.driverId !== undefined)
        await deps.drivers.reach(actor, query.driverId, "drivers.view");
      const rows = await deps.queries.list({
        ...query,
        branchIds: deps.vehicles.branchesFor(actor, "vehicles.view"),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { startedAt: String(after[0]), id: String(after[1]) } }),
      });
      const currency = await this.currency();
      const page = PageCursor.paginate(rows, query.limit, (a) => [a.startedAt.toISOString(), a.id]);
      return { ...page, items: page.items.map((a) => this.present(a, currency)) };
    });
  }

  /** Starts an assignment of a locked vehicle (shared by start and handover). */
  private async open(
    actor: Principal,
    vehicle: Vehicle,
    input: Omit<StartAssignmentInput, "startedAt">,
    settings: AssignmentSettings,
    startedAt: Date | undefined,
    /** Terms to keep when none are given (a handover carries the vehicle's terms over). */
    previous: RemittanceTerms | null = null,
  ): Promise<VehicleAssignment> {
    const { deps } = this;
    const now = deps.clock.now();
    const driver = await deps.drivers.reach(actor, input.driverId, "drivers.view", true);
    await this.assertDriverCanTake(driver, vehicle, settings);
    const type = input.type ?? driver.snapshot().employmentType;
    if (type === "workpay")
      throw new AssignmentRuleError("Work-and-pay vehicles are assigned through their agreement");
    const assignment = VehicleAssignment.start({
      id: deps.ids.next(),
      vehicleId: vehicle.id,
      driverId: driver.id,
      branchId: vehicle.branchId,
      type,
      terms: await this.terms(
        input.terms ?? {},
        type,
        settings,
        type === "remittance" ? previous : null,
      ),
      startedAt: startedAt ?? now,
      startOdometer: input.odometer,
      checklist: buildChecklist(settings.handoverItems, input.checklist),
      startedBy: actor.userId,
      notes: input.notes ?? null,
      now,
    });
    await this.save(assignment);
    return assignment;
  }

  private async assertDriverCanTake(
    driver: Driver,
    vehicle: Vehicle,
    settings: AssignmentSettings,
  ): Promise<void> {
    const d = driver.snapshot();
    const name = `${d.firstName} ${d.lastName}`;
    if (d.status !== "active")
      throw new AssignmentRuleError(`${name} is ${d.status}; only active drivers get vehicles`);
    if (d.branchId !== vehicle.branchId)
      throw new AssignmentRuleError(`${name} works in another branch; move them first`);
    if (
      settings.requireValidLicence &&
      (d.licenceExpiresOn === null || d.licenceExpiresOn < (await this.today()))
    )
      throw new AssignmentRuleError(`${name}'s driving licence has expired or is not recorded`);
    const current = await this.deps.queries.openForDriver(d.id);
    if (current !== null)
      throw new AssignmentConflictError(
        `${name} already has ${current.vehicle.plateNumber ?? current.vehicle.code}`,
      );
  }

  /** Compliance per vehicle settings: refuses (block) or returns warnings (warn). */
  private async compliance(vehicleId: string): Promise<string[]> {
    const check = await this.deps.documents.operability(vehicleId);
    if (check.canOperate) return [];
    const problems = check.items
      .filter((i) => i.required && (i.state === "missing" || i.state === "expired"))
      .map((i) => `${i.type.replaceAll("_", " ")} ${i.state}`);
    if (check.enforcement === "block") throw new VehicleNotCompliantError(problems);
    return problems.map((p) => `The vehicle cannot legally operate: ${p}`);
  }

  private async terms(
    input: TermsInput,
    type: AssignmentType,
    settings: AssignmentSettings,
    current: RemittanceTerms | null,
  ): Promise<RemittanceTerms> {
    const mode =
      input.mode ??
      current?.mode ??
      (type === "remittance" ? settings.defaultRemittanceMode : "none");
    const target =
      input.target === undefined
        ? (current?.targetMinor ?? null)
        : input.target === null
          ? null
          : Money.parse(input.target, await this.currency()).amountMinor;
    return {
      mode,
      targetMinor: target,
      frequency: input.frequency === undefined ? (current?.frequency ?? null) : input.frequency,
      daysOff: input.daysOff ?? current?.daysOff ?? [],
    };
  }

  private async current(vehicleId: string): Promise<VehicleAssignment> {
    const assignment = await this.deps.assignments.lockOpenForVehicle(vehicleId);
    if (assignment === null) throw new AssignmentNotFoundError("No driver has this vehicle");
    return assignment;
  }

  private async save(assignment: VehicleAssignment): Promise<void> {
    await this.deps.assignments.save(assignment);
  }

  private async view(id: string): Promise<AssignmentView> {
    const record = await this.deps.queries.get(id);
    if (record === null) throw new AssignmentNotFoundError();
    return this.present(record, await this.currency());
  }

  present(record: AssignmentRecord, currency: string): AssignmentView {
    const { terms, ...rest } = record;
    return {
      ...rest,
      terms: {
        mode: terms.mode,
        target:
          terms.targetMinor === null ? null : Money.ofMinor(terms.targetMinor, currency).toJSON(),
        frequency: terms.frequency,
        daysOff: terms.daysOff,
      },
      distance: record.endOdometer === null ? null : record.endOdometer - record.startOdometer,
    };
  }

  private async currency(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private async today(): Promise<string> {
    const { timezone } = await this.deps.organisation.get();
    return localDateTime(this.deps.clock.now(), timezone).date;
  }

  private async audit(actor: Principal, action: string, assignment: VehicleAssignment) {
    const s = assignment.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "vehicle",
      entityId: s.vehicleId,
      after: {
        assignmentId: s.id,
        driverId: s.driverId,
        type: s.type,
        terms: s.terms,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        endReason: s.endReason,
      },
    });
  }
}
