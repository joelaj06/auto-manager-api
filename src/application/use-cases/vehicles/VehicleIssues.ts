import type { IVehicleIssueRepository } from "../../../domain/repositories/IVehicleIssueRepository.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import {
  VehicleIssue,
  VehicleIssueError,
  type IssueReport,
  type IssueStatus,
  type VehicleIssueProps,
} from "../../../domain/vehicles/VehicleIssue.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { VehicleIssueNotFoundError } from "../../errors/PartyErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { Notifier } from "../notifications/Notifier.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "./VehicleAccess.js";

export type VehicleIssueView = VehicleIssueProps & Readonly<{ photos?: readonly FileView[] }>;

export type IssueQuery = Readonly<{
  status?: readonly IssueStatus[];
  branchId?: string;
  vehicleId?: string;
  driverId?: string;
  limit: number;
  cursor?: string;
}>;

const LABELS: Readonly<Record<string, string>> = {
  breakdown: "Breakdown",
  accident: "Accident",
  damage: "Damage",
  tyre: "Tyre problem",
  warning_light: "Warning light",
  police: "Police stop",
  theft: "Theft",
  other: "Issue",
};

/**
 * Vehicle issues (docs/09 §4): reported by a driver from the app or by staff, numbered ISS-…,
 * with photos; the branch's fleet staff hear about it at once (rule `vehicle_issue_reported`),
 * acknowledge it and resolve it with what was done. Drivers see only their own reports.
 */
export class VehicleIssues {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      issues: IVehicleIssueRepository;
      vehicles: VehicleAccess;
      photos: OwnedDocuments;
      scope: BranchScope;
      numbering: DocumentNumbering;
      notifier: Notifier;
      notificationSettings: INotificationSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  /** Staff log an issue they were told about. */
  async report(
    actor: Principal,
    vehicleId: string,
    input: IssueReport & Readonly<{ driverId?: string | null }>,
  ): Promise<VehicleIssueView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicles.reach(actor, vehicleId, "vehicles.issues.manage");
      return this.reported(actor.userId, vehicle, input.driverId ?? null, input);
    });
  }

  /** A driver reports an issue with the vehicle they drive (driver app). */
  async reportAsDriver(
    userId: string,
    driverId: string,
    vehicle: Vehicle,
    input: IssueReport,
  ): Promise<VehicleIssueView> {
    return this.deps.unitOfWork.run(() => this.reported(userId, vehicle, driverId, input));
  }

  async list(actor: Principal, query: IssueQuery): Promise<Page<VehicleIssueView>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.scope.branch(actor, "vehicles.issues.view", query.branchId);
      return this.page(query, deps.scope.branchesFor(actor, "vehicles.issues.view"));
    });
  }

  async get(actor: Principal, id: string): Promise<VehicleIssueView> {
    return this.deps.unitOfWork.run(async () =>
      this.detail(await this.reach(actor, id, "vehicles.issues.view")),
    );
  }

  async acknowledge(actor: Principal, id: string): Promise<VehicleIssueView> {
    return this.change(actor, id, "vehicle.issue_acknowledged", (issue, now) =>
      issue.acknowledge(actor.userId, now),
    );
  }

  async resolve(actor: Principal, id: string, resolution: string): Promise<VehicleIssueView> {
    return this.change(actor, id, "vehicle.issue_resolved", (issue, now) =>
      issue.resolve(actor.userId, resolution, now),
    );
  }

  async reopen(actor: Principal, id: string): Promise<VehicleIssueView> {
    return this.change(actor, id, "vehicle.issue_reopened", (issue, now) => issue.reopen(now));
  }

  async startPhoto(
    actor: Principal,
    id: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.reach(actor, id, "vehicles.issues.manage"));
    return deps.photos.start(id, input, actor.userId);
  }

  async completePhoto(actor: Principal, id: string, fileId: string): Promise<FileView> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.reach(actor, id, "vehicles.issues.manage"));
    return deps.photos.complete(id, fileId);
  }

  // --- the driver's own reports ---

  async listOwn(driverId: string, query: Omit<IssueQuery, "driverId" | "branchId">) {
    return this.deps.unitOfWork.run(() => this.page({ ...query, driverId }, "all"));
  }

  async getOwn(driverId: string, id: string): Promise<VehicleIssueView> {
    return this.deps.unitOfWork.run(async () => this.detail(await this.own(driverId, id)));
  }

  async startOwnPhoto(
    userId: string,
    driverId: string,
    id: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      if ((await this.own(driverId, id)).snapshot().status === "resolved")
        throw new VehicleIssueError("This issue is resolved");
    });
    return deps.photos.start(id, input, userId);
  }

  async completeOwnPhoto(driverId: string, id: string, fileId: string): Promise<FileView> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.own(driverId, id));
    return deps.photos.complete(id, fileId);
  }

  private async reported(
    userId: string,
    vehicle: Vehicle,
    driverId: string | null,
    input: IssueReport,
  ): Promise<VehicleIssueView> {
    const { deps } = this;
    const now = deps.clock.now();
    const v = vehicle.snapshot();
    const issue = VehicleIssue.report({
      ...input,
      id: deps.ids.next(),
      number: await deps.numbering.next("vehicle_issue", now),
      vehicleId: vehicle.id,
      branchId: v.branchId,
      driverId,
      reportedBy: userId,
      now,
    });
    await deps.issues.save(issue);
    const p = issue.snapshot();
    const name = v.plateNumber ?? v.code;
    await deps.notifier.staff(await deps.notificationSettings.get(), {
      rule: "vehicle_issue_reported",
      permission: "vehicles.issues.manage",
      branchId: p.branchId,
      dedupeKey: `vehicle_issue:${p.id}`,
      title: `${name}: ${LABELS[p.type]} reported${p.canDrive ? "" : " — cannot drive"}`,
      body: `${p.number}: ${p.description.slice(0, 300)}${p.location === null ? "" : ` (at ${p.location})`}`,
      severity: p.severity === "high" ? "critical" : p.severity === "medium" ? "warning" : "info",
      data: { vehicleId: p.vehicleId, issueId: p.id },
    });
    await this.audit(userId, "vehicle.issue_reported", issue);
    return this.detail(issue);
  }

  private async change(
    actor: Principal,
    id: string,
    action: string,
    apply: (issue: VehicleIssue, now: Date) => void,
  ): Promise<VehicleIssueView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const issue = await this.reach(actor, id, "vehicles.issues.manage", true);
      apply(issue, deps.clock.now());
      await deps.issues.save(issue);
      await this.audit(actor.userId, action, issue);
      return this.detail(issue);
    });
  }

  private async page(
    query: IssueQuery,
    branchIds: "all" | readonly string[],
  ): Promise<Page<VehicleIssueView>> {
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 1).values;
    const rows = await this.deps.issues.list({
      branchIds,
      ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
      ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
      ...(query.driverId === undefined ? {} : { driverId: query.driverId }),
      ...(query.status === undefined ? {} : { statuses: query.status }),
      limit: query.limit + 1,
      ...(after === undefined ? {} : { afterId: String(after[0]) }),
    });
    const page = PageCursor.paginate(rows, query.limit, (r) => [r.id]);
    return { ...page, items: page.items.map((i) => i.snapshot()) };
  }

  private async detail(issue: VehicleIssue): Promise<VehicleIssueView> {
    return { ...issue.snapshot(), photos: await this.deps.photos.list(issue.id) };
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<VehicleIssue> {
    const issue = lock ? await this.deps.issues.lockById(id) : await this.deps.issues.findById(id);
    if (issue === null) throw new VehicleIssueNotFoundError();
    await this.deps.scope.assertReaches(
      actor,
      permission,
      issue.snapshot().branchId,
      () => new VehicleIssueNotFoundError(),
    );
    return issue;
  }

  private async own(driverId: string, id: string): Promise<VehicleIssue> {
    const issue = await this.deps.issues.findById(id);
    if (issue === null || issue.snapshot().driverId !== driverId)
      throw new VehicleIssueNotFoundError();
    return issue;
  }

  private async audit(userId: string, action: string, issue: VehicleIssue) {
    const p = issue.snapshot();
    await recordUserAction(this.deps, userId, {
      action,
      entityType: "vehicle",
      entityId: p.vehicleId,
      after: { issueId: p.id, number: p.number, type: p.type, status: p.status },
    });
  }
}
