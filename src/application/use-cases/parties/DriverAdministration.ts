import {
  Driver,
  DriverStatusError,
  type DriverDetails,
  type DriverProps,
  type DriverStatus,
  type DriverStatusChange,
  type OnboardingItem,
} from "../../../domain/parties/Driver.js";
import { maskGhanaCard } from "../../../domain/parties/PartyDetails.js";
import type { IDriverRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { DriverNotFoundError, PartyExistsError } from "../../errors/PartyErrors.js";
import type { AssignmentRecord, IAssignmentQueries } from "../../ports/IAssignmentRecords.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  DriverListFilter,
  Guarantor,
  IDriverGuarantors,
  IDriverQueries,
  IDriverSettingsStore,
  IPartyDocuments,
  IPartyStatusHistory,
  PartyStatusEntry,
} from "../../ports/IPartyRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";

export type DriverView = Omit<DriverProps, "deletedAt" | "deletedReason">;

export type DriverDetailView = DriverView &
  Readonly<{
    onboarding: readonly OnboardingItem[];
    guarantors: readonly Guarantor[];
    /** The vehicle the driver has now (P2-4 assignments). */
    currentAssignment: Readonly<{
      id: string;
      vehicle: AssignmentRecord["vehicle"];
      startedAt: Date;
    }> | null;
  }>;

export type DriverInput = Partial<DriverDetails> & Readonly<{ branchId?: string }>;

export type DriverQuery = Omit<DriverListFilter, "branchIds" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/** A status change and the permission it needs (docs/28: suspend and terminate are separate). */
export const DRIVER_ACTIONS = {
  activate: { from: "applicant", to: "active", permission: "drivers.update", audit: "activated" },
  suspend: { from: null, to: "suspended", permission: "drivers.suspend", audit: "suspended" },
  reinstate: {
    from: "suspended",
    to: "active",
    permission: "drivers.suspend",
    audit: "reinstated",
  },
  terminate: { from: null, to: "terminated", permission: "drivers.terminate", audit: "terminated" },
  rehire: { from: "terminated", to: "applicant", permission: "drivers.update", audit: "rehired" },
} as const satisfies Record<
  string,
  { from: DriverStatus | null; to: DriverStatus; permission: PermissionKey; audit: string }
>;
export type DriverAction = keyof typeof DRIVER_ACTIONS;

const EMPTY: DriverDetails = Object.freeze({
  firstName: "",
  lastName: "",
  otherNames: null,
  phone: "",
  altPhone: null,
  email: null,
  dateOfBirth: null,
  gender: null,
  address: null,
  ghanaCardNumber: null,
  licenceNumber: null,
  licenceClass: null,
  licenceIssuedOn: null,
  licenceExpiresOn: null,
  employmentType: "remittance",
  hiredOn: null,
  emergencyContact: null,
  payout: null,
  tags: [],
  notes: null,
});

/**
 * Drivers (docs/09 §4): register within the caller's branches, edit, move between branches,
 * the onboarding checklist, status changes (activate only with onboarding complete; suspend,
 * reinstate, terminate, rehire with a reason) and removal of mistaken entries. Ghana Card
 * numbers are masked without `drivers.documents.view`.
 */
export class DriverAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      drivers: IDriverRepository;
      queries: IDriverQueries;
      guarantors: IDriverGuarantors;
      documents: IPartyDocuments;
      history: IPartyStatusHistory;
      settings: IDriverSettingsStore;
      assignments: IAssignmentQueries;
      organisation: IOrganisationSettings;
      scope: BranchScope;
      numbering: DocumentNumbering;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, query: DriverQuery): Promise<Page<DriverView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.queries.list({
        ...query,
        branchIds: deps.scope.branchesFor(actor, "drivers.list"),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { createdAt: String(after[0]), id: String(after[1]) } }),
      });
      const page = PageCursor.paginate(rows, query.limit, (d) => [d.createdAt.toISOString(), d.id]);
      return { ...page, items: page.items.map((d) => this.view(actor, d)) };
    });
  }

  async get(actor: Principal, id: string): Promise<DriverDetailView> {
    return this.deps.unitOfWork.run(async () => {
      const driver = await this.reach(actor, id, "drivers.view");
      return this.detail(actor, driver);
    });
  }

  async create(actor: Principal, input: DriverInput): Promise<DriverDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const branchId =
        input.branchId ?? (await deps.scope.defaultBranch(actor, "drivers.create", "driver"));
      await deps.scope.branch(actor, "drivers.create", branchId);
      const { branchId: _branch, ...details } = input;
      const { driver, change } = Driver.register({
        id: deps.ids.next(),
        code: await deps.numbering.next("driver", now),
        branchId,
        details: { ...EMPTY, ...details },
        createdBy: actor.userId,
        now,
      });
      await this.assertUnique(driver);
      await deps.drivers.save(driver);
      await this.recordChange(actor, driver.id, change, now);
      await recordUserAction(deps, actor.userId, {
        action: "driver.created",
        entityType: "driver",
        entityId: driver.id,
        after: masked(driver.snapshot()),
      });
      return this.detail(actor, driver);
    });
  }

  async update(actor: Principal, id: string, input: DriverInput): Promise<DriverDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = await this.reach(actor, id, "drivers.update", true);
      const before = driver.snapshot();
      const now = deps.clock.now();
      const { branchId, ...details } = input;
      driver.update(details, now);
      if (branchId !== undefined && branchId !== before.branchId) {
        await this.assertNoVehicle(driver, "moved to another branch");
        await deps.scope.branch(actor, "drivers.update", branchId);
        driver.moveToBranch(branchId, now);
      }
      await this.assertUnique(driver);
      await deps.drivers.save(driver);
      await recordUserAction(deps, actor.userId, {
        action: "driver.updated",
        entityType: "driver",
        entityId: id,
        before: masked(before),
        after: masked(driver.snapshot()),
      });
      return this.detail(actor, driver);
    });
  }

  async onboarding(actor: Principal, id: string): Promise<OnboardingItem[]> {
    return this.deps.unitOfWork.run(async () =>
      this.checklist(await this.reach(actor, id, "drivers.view")),
    );
  }

  async changeStatus(
    actor: Principal,
    id: string,
    action: DriverAction,
    reason: string | null,
  ): Promise<DriverDetailView> {
    const { deps } = this;
    const { from, to, permission, audit } = DRIVER_ACTIONS[action];
    return deps.unitOfWork.run(async () => {
      const driver = await this.reach(actor, id, permission, true);
      const now = deps.clock.now();
      // Activating an applicant and reinstating a suspended driver need different permissions.
      if (from !== null && driver.status !== from)
        throw new DriverStatusError(`Only a driver who is ${from} can be ${audit}`);
      if (to === "suspended" || to === "terminated") await this.assertNoVehicle(driver, audit);
      const change = driver.changeStatus(to, {
        reason,
        today: await this.today(),
        now,
        ...(action === "activate" ? { checklist: await this.checklist(driver) } : {}),
      });
      await deps.drivers.save(driver);
      await this.recordChange(actor, id, change, now);
      await recordUserAction(deps, actor.userId, {
        action: `driver.${audit}`,
        entityType: "driver",
        entityId: id,
        before: { status: change.from },
        after: { status: change.to },
        metadata: { reason: change.reason },
      });
      return this.detail(actor, driver);
    });
  }

  async statusHistory(actor: Principal, id: string): Promise<PartyStatusEntry[]> {
    return this.deps.unitOfWork.run(async () => {
      await this.reach(actor, id, "drivers.view");
      return this.deps.history.list("driver", id);
    });
  }

  async remove(actor: Principal, id: string, reason: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const driver = await this.reach(actor, id, "drivers.delete", true);
      driver.remove(reason, deps.clock.now());
      await deps.drivers.save(driver);
      await recordUserAction(deps, actor.userId, {
        action: "driver.removed",
        entityType: "driver",
        entityId: id,
        before: { code: driver.snapshot().code, phone: driver.snapshot().phone },
        metadata: { reason },
      });
    });
  }

  /** Drivers whose licence expires within `days` (expired ones included), soonest first. */
  async expiringLicences(actor: Principal, days: number): Promise<DriverView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const until = new Date(`${await this.today()}T00:00:00Z`);
      until.setUTCDate(until.getUTCDate() + days);
      const drivers = await deps.queries.expiringLicences(
        deps.scope.branchesFor(actor, "drivers.list"),
        until.toISOString().slice(0, 10),
      );
      return drivers.map((d) => this.view(actor, d));
    });
  }

  /** The driver within the caller's branches for `permission` (call inside a unit of work). */
  async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Driver> {
    const { deps } = this;
    const driver = lock ? await deps.drivers.lockById(id) : await deps.drivers.findById(id);
    if (driver === null) throw new DriverNotFoundError();
    await deps.scope.assertReaches(
      actor,
      permission,
      driver.branchId,
      () => new DriverNotFoundError(),
    );
    return driver;
  }

  view(actor: Principal, props: DriverProps): DriverView {
    const { deletedAt: _d, deletedReason: _r, ...view } = props;
    const sensitive = this.deps.scope.can(actor, "drivers.documents.view", props.branchId);
    return sensitive || view.ghanaCardNumber === null
      ? view
      : { ...view, ghanaCardNumber: maskGhanaCard(view.ghanaCardNumber) };
  }

  private async detail(actor: Principal, driver: Driver): Promise<DriverDetailView> {
    const sensitive = this.deps.scope.can(actor, "drivers.documents.view", driver.branchId);
    const guarantors = (await this.deps.guarantors.list(driver.id)).map((g) =>
      sensitive || g.ghanaCardNumber === null
        ? g
        : { ...g, ghanaCardNumber: maskGhanaCard(g.ghanaCardNumber) },
    );
    const current = await this.deps.assignments.openForDriver(driver.id);
    return {
      ...this.view(actor, driver.snapshot()),
      onboarding: await this.checklist(driver),
      guarantors,
      currentAssignment:
        current === null
          ? null
          : { id: current.id, vehicle: current.vehicle, startedAt: current.startedAt },
    };
  }

  /** A driver who has a vehicle keeps their status and branch until the assignment ends. */
  private async assertNoVehicle(driver: Driver, change: string): Promise<void> {
    const current = await this.deps.assignments.openForDriver(driver.id);
    if (current !== null)
      throw new DriverStatusError(
        `The driver has ${current.vehicle.plateNumber ?? current.vehicle.code}; end the assignment before they are ${change}`,
      );
  }

  private async checklist(driver: Driver): Promise<OnboardingItem[]> {
    const { deps } = this;
    const guarantors = await deps.guarantors.list(driver.id);
    const documents = await deps.documents.list("driver", driver.id);
    return driver.onboarding(
      { guarantors: guarantors.length, documentTypes: documents.map((d) => d.type) },
      await deps.settings.get(),
      await this.today(),
    );
  }

  private async today(): Promise<string> {
    const { timezone } = await this.deps.organisation.get();
    return localDateTime(this.deps.clock.now(), timezone).date;
  }

  private async recordChange(
    actor: Principal,
    driverId: string,
    change: DriverStatusChange,
    at: Date,
  ): Promise<void> {
    await this.deps.history.record({
      partyType: "driver",
      partyId: driverId,
      from: change.from,
      to: change.to,
      reason: change.reason,
      changedBy: actor.userId,
      at,
    });
  }

  private async assertUnique(driver: Driver): Promise<void> {
    const { deps } = this;
    const p = driver.snapshot();
    if (await deps.drivers.phoneTaken(p.phone, p.id))
      throw new PartyExistsError(`Another driver already has the phone number ${p.phone}`);
    if (p.ghanaCardNumber !== null && (await deps.drivers.ghanaCardTaken(p.ghanaCardNumber, p.id)))
      throw new PartyExistsError("Another driver already has this Ghana Card number");
    if (p.licenceNumber !== null && (await deps.drivers.licenceTaken(p.licenceNumber, p.id)))
      throw new PartyExistsError(`Another driver already has the licence ${p.licenceNumber}`);
  }
}

/** Audit entries never carry full Ghana Card numbers. */
function masked(p: DriverProps): DriverProps {
  return p.ghanaCardNumber === null
    ? p
    : { ...p, ghanaCardNumber: maskGhanaCard(p.ghanaCardNumber) };
}
