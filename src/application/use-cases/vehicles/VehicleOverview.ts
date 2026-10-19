import type { ComplianceStatus } from "../../../domain/vehicles/VehicleCompliance.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAssignmentQueries } from "../../ports/IAssignmentRecords.js";
import type { IBranches } from "../../ports/IBranches.js";
import type { IClock } from "../../ports/IClock.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IVehicleQueries, TimelineEntry } from "../../ports/IVehicleRecords.js";
import type { FileView } from "../files/FileService.js";
import type { VehicleAccess } from "./VehicleAccess.js";
import type { VehicleDocuments } from "./VehicleDocuments.js";
import type { VehiclePhotos } from "./VehiclePhotos.js";
import type { VehicleRegistry } from "./VehicleRegistry.js";
import type { VehicleView } from "./VehicleView.js";

export type TimelinePage = Readonly<{ items: TimelineEntry[]; nextBefore: Date | null }>;

export type VehicleOverviewView = Readonly<{
  vehicle: VehicleView;
  branch: Readonly<{ id: string; code: string; name: string }> | null;
  primaryPhoto: FileView | null;
  /** The driver who has the vehicle now (assignment). */
  currentDriver: Readonly<{
    assignmentId: string;
    driverId: string;
    code: string;
    name: string;
    phone: string;
    since: Date;
  }> | null;
  /** Filled by rentals (Phase 5). */
  currentRenter: null;
  /** Null without `vehicles.documents.view`. */
  compliance: ComplianceStatus | null;
  /** Distance over the last 30 days from the odometer readings. */
  distanceLast30Days: number | null;
  /** Revenue, costs, profit, utilisation: from the daily vehicle stats (P2-8). */
  kpis: null;
  timeline: TimelinePage;
}>;

const DAY_MS = 86_400_000;
const FIRST_PAGE = 20;

/**
 * The vehicle 360° page (docs/06 §10), skeleton: header, compliance badges, recent distance and
 * a merged timeline of status changes, documents and odometer readings, and the current driver.
 * KPIs and the current renter are added by the modules that produce them.
 */
export class VehicleOverview {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      access: VehicleAccess;
      registry: VehicleRegistry;
      documents: VehicleDocuments;
      photos: VehiclePhotos;
      queries: IVehicleQueries;
      assignments: IAssignmentQueries;
      branches: IBranches;
      clock: IClock;
    }>,
  ) {}

  async overview(actor: Principal, id: string): Promise<VehicleOverviewView> {
    const { deps } = this;
    const result = await deps.unitOfWork.run(async () => {
      const vehicle = await deps.access.reach(actor, id, "vehicles.view");
      const now = deps.clock.now();
      const branch = (await deps.branches.list()).find((b) => b.id === vehicle.branchId);
      const assignment = await deps.assignments.openForVehicle(id);
      return {
        currentDriver:
          assignment === null
            ? null
            : {
                assignmentId: assignment.id,
                driverId: assignment.driver.id,
                code: assignment.driver.code,
                name: assignment.driver.name,
                phone: assignment.driver.phone,
                since: assignment.startedAt,
              },
        vehicle: await deps.registry.view(actor, vehicle),
        branch:
          branch === undefined ? null : { id: branch.id, code: branch.code, name: branch.name },
        compliance: deps.access.can(actor, "vehicles.documents.view", vehicle.branchId)
          ? await deps.documents.compliance(id)
          : null,
        distanceLast30Days: await deps.queries.distanceBetween(
          id,
          new Date(now.getTime() - 30 * DAY_MS),
          now,
        ),
        timeline: await this.page(id, null, FIRST_PAGE),
      };
    });
    return {
      ...result,
      primaryPhoto: await deps.photos.primary(id, result.vehicle.primaryPhotoFileId),
      currentRenter: null,
      kpis: null,
    };
  }

  async timeline(
    actor: Principal,
    id: string,
    query: Readonly<{ before?: Date; limit: number }>,
  ): Promise<TimelinePage> {
    return this.deps.unitOfWork.run(async () => {
      await this.deps.access.reach(actor, id, "vehicles.view");
      return this.page(id, query.before ?? null, query.limit);
    });
  }

  private async page(id: string, before: Date | null, limit: number): Promise<TimelinePage> {
    const rows = await this.deps.queries.timeline(id, before, limit + 1);
    const items = rows.slice(0, limit);
    return { items, nextBefore: rows.length > limit ? (items.at(-1)?.at ?? null) : null };
  }
}
