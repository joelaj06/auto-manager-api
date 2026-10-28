import {
  complianceLevel,
  costPerDistance,
  inServiceSeconds,
  meanDaysBetweenFailures,
  offRoadSeconds,
  percentOf,
  type ComplianceLevel,
} from "../../../domain/maintenance/MaintenanceMetrics.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  addDays,
  DateRange,
  ReportRangeError,
  series,
  type Bucket,
  type Granularity,
} from "../../../domain/reporting/DateRange.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  CompletedOrderRow,
  IMaintenanceReporting,
  Instants,
} from "../../ports/IMaintenanceReporting.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { BranchFilter } from "../../ports/IReporting.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import { localDateTime, localMidnight } from "../../services/TenantLocalTime.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { VehicleStatsBuilder } from "../reporting/VehicleStatsBuilder.js";

const REPORTS: PermissionKey = "dashboards.maintenance.view";
const DAY = 86_400;
/** Work order types counted as preventive and as failures (decision 405). */
const PREVENTIVE = new Set(["preventive"]);
const CORRECTIVE = new Set(["corrective", "accident"]);

export type MaintenanceQuery = Readonly<{
  from?: string;
  to?: string;
  branchId?: string;
  groupBy?: Granularity;
}>;

type Spend = Readonly<{ workOrders: number; cost: MoneyJson }>;

export type MaintenanceKpis = Readonly<{
  period: Readonly<{ from: string; to: string; groupBy: Granularity }>;
  vehicles: number;
  cost: Readonly<{
    /** All lines of the work orders completed in the period, whoever paid. */
    total: MoneyJson;
    /** Charged to drivers, renters and insurers. */
    recovered: MoneyJson;
    /** What the business bore. */
    business: MoneyJson;
    byKind: Readonly<{ labour: MoneyJson; part: MoneyJson; sublet: MoneyJson; other: MoneyJson }>;
    byType: readonly (Spend & Readonly<{ type: string }>)[];
    /** Total cost per vehicle per 30 days in service. */
    perVehicleMonth: MoneyJson | null;
    /** Total cost per km over the vehicles that read km (null without distance). */
    perKm: MoneyJson | null;
  }>;
  distanceKm: number;
  workOrders: Readonly<{ completed: number; open: number; offRoad: number }>;
  preventive: Readonly<{
    preventive: Spend;
    corrective: Spend;
    /** Preventive work orders among preventive and corrective ones, in percent. */
    preventivePercent: number | null;
  }>;
  downtime: Readonly<{
    days: number;
    /** Time in service not off the road, in percent. */
    availabilityPercent: number | null;
  }>;
  failures: Readonly<{ count: number; meanDaysBetween: number | null }>;
  services: Readonly<{ due: number; overdue: number }>;
  series: readonly (Bucket & Readonly<{ cost: MoneyJson; workOrders: number }>)[];
  byVehicle: readonly Readonly<{
    vehicleId: string;
    code: string;
    plateNumber: string | null;
    make: string;
    model: string;
    branchId: string;
    workOrders: number;
    cost: MoneyJson;
    distance: Readonly<{ value: number; unit: "km" | "mi" }>;
    costPerDistance: MoneyJson | null;
    downtimeDays: number;
    availabilityPercent: number | null;
    failures: number;
  }>[];
  byModel: readonly Readonly<{
    make: string;
    model: string;
    vehicles: number;
    workOrders: number;
    cost: MoneyJson;
    costPerKm: MoneyJson | null;
    failures: number;
    meanDaysBetweenFailures: number | null;
  }>[];
}>;

type DocumentLine = Readonly<{
  documentId: string;
  type: string;
  title: string | null;
  number: string | null;
  expiresOn: string;
  expired: boolean;
}>;

export type ComplianceDashboard = Readonly<{
  date: string;
  /** Documents and licences expiring within this many days are flagged. */
  withinDays: number;
  summary: Readonly<{
    vehicles: Readonly<Record<ComplianceLevel, number>>;
    documentsExpired: number;
    documentsExpiring: number;
    licencesExpired: number;
    licencesExpiring: number;
    servicesOverdue: number;
    servicesDue: number;
    finesOverdue: number;
    openIncidents: number;
  }>;
  /** Vehicles needing attention (amber and red), red first. */
  vehicles: readonly Readonly<{
    vehicleId: string;
    code: string;
    plateNumber: string | null;
    name: string;
    branchId: string;
    status: string;
    level: ComplianceLevel;
    documents: readonly DocumentLine[];
    services: readonly Readonly<{
      taskName: string;
      status: "due" | "overdue";
      dueKm: number | null;
      dueOn: string | null;
    }>[];
    finesOverdue: number;
    openIncidents: number;
  }>[];
  drivers: readonly Readonly<{
    driverId: string;
    code: string;
    name: string;
    phone: string;
    branchId: string;
    licenceNumber: string | null;
    expiresOn: string;
    expired: boolean;
  }>[];
}>;

/**
 * Maintenance KPIs and the compliance dashboard (docs/12 §6, docs/14 §3): maintenance cost by
 * kind, type, vehicle and model with cost per km, downtime and availability, preventive against
 * corrective work, mean time between failures and the services due; and where every vehicle and
 * driver stands on documents, licences, services, fines and incidents (decisions 403–407).
 */
export class MaintenanceReports {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reporting: IMaintenanceReporting;
      stats: VehicleStatsBuilder;
      organisation: IOrganisationSettings;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      scope: BranchScope;
      clock: { now(): Date };
    }>,
  ) {}

  kpis(actor: Principal, query: MaintenanceQuery): Promise<MaintenanceKpis> {
    const { deps } = this;
    return this.within(actor, query, async ({ filter, m, timezone }) => {
      const range = DateRange.of(query.from, query.to, await deps.calendar.today());
      const groupBy = query.groupBy ?? range.defaultGranularity();
      const period: Instants = {
        from: localMidnight(range.from, timezone),
        to: localMidnight(addDays(range.to, 1), timezone),
      };
      const now = deps.clock.now();
      await deps.stats.refresh();
      const { reporting } = deps;
      const orders = await reporting.completedOrders(period, filter);
      const fleet = await reporting.fleet(period, { from: range.from, to: range.to }, filter);
      const spells = await reporting.offRoadSpells(period, filter);
      const failures = await reporting.failures(period, filter);
      const open = await reporting.openWorkOrders(filter);
      const due = await reporting.serviceDue(filter);

      const cost = (o: CompletedOrderRow) =>
        o.labourMinor + o.partMinor + o.subletMinor + o.otherMinor;
      const total = sum(orders, cost);
      const recovered = sum(orders, (o) => o.recoveredMinor);
      const ordersOf = group(orders, (o) => o.vehicleId);
      const vehicles = fleet.map((v) => {
        const own = ordersOf.get(v.vehicleId) ?? [];
        const inService = inServiceSeconds(v, period.from, period.to, now);
        const off = Math.min(
          inService,
          offRoadSeconds(spells.get(v.vehicleId) ?? [], period.from, period.to, now),
        );
        return { v, own, spent: sum(own, cost), inService, off };
      });
      const inService = sum(vehicles, (x) => x.inService);
      const off = sum(vehicles, (x) => x.off);
      const km = vehicles.filter((x) => x.v.mileageUnit === "km");
      const distanceKm = sum(km, (x) => x.v.distance);
      const kmCost = sum(km, (x) => x.spent);
      const failureCount = sum([...failures.values()], (f) => f);
      const spend = (types: ReadonlySet<string>): Spend => {
        const chosen = orders.filter((o) => types.has(o.type));
        return { workOrders: chosen.length, cost: m(sum(chosen, cost)) };
      };
      const preventive = orders.filter((o) => PREVENTIVE.has(o.type)).length;
      const corrective = orders.filter((o) => CORRECTIVE.has(o.type)).length;
      const local = (o: CompletedOrderRow) => localDateTime(o.completedAt, timezone).date;
      const points = series(
        range,
        groupBy,
        orders.map((o) => ({ date: local(o), cost: cost(o), workOrders: 1 })),
        ["cost", "workOrders"],
      );
      const perMinor = (minor: number | null) => (minor === null ? null : m(minor));
      return {
        period: { from: range.from, to: range.to, groupBy },
        vehicles: fleet.length,
        cost: {
          total: m(total),
          recovered: m(recovered),
          business: m(total - recovered),
          byKind: {
            labour: m(sum(orders, (o) => o.labourMinor)),
            part: m(sum(orders, (o) => o.partMinor)),
            sublet: m(sum(orders, (o) => o.subletMinor)),
            other: m(sum(orders, (o) => o.otherMinor)),
          },
          byType: [...group(orders, (o) => o.type).entries()]
            .map(([type, rows]) => ({ type, workOrders: rows.length, cost: m(sum(rows, cost)) }))
            .sort((a, b) => b.cost.amountMinor - a.cost.amountMinor),
          perVehicleMonth: inService > 0 ? m(Math.round((total * 30 * DAY) / inService)) : null,
          perKm: perMinor(costPerDistance(kmCost, distanceKm)),
        },
        distanceKm,
        workOrders: { completed: orders.length, open: open.open, offRoad: open.offRoad },
        preventive: {
          preventive: spend(PREVENTIVE),
          corrective: spend(CORRECTIVE),
          preventivePercent: percentOf(preventive, preventive + corrective),
        },
        downtime: {
          days: round1(off / DAY),
          availabilityPercent: percentOf(inService - off, inService),
        },
        failures: {
          count: failureCount,
          meanDaysBetween: meanDaysBetweenFailures(inService, failureCount),
        },
        services: {
          due: due.filter((d) => d.status === "due").length,
          overdue: due.filter((d) => d.status === "overdue").length,
        },
        series: points.map((p) => ({
          key: p.key,
          from: p.from,
          to: p.to,
          cost: m(p.cost),
          workOrders: p.workOrders,
        })),
        byVehicle: vehicles
          .map(({ v, own, spent, inService: seconds, off: down }) => ({
            vehicleId: v.vehicleId,
            code: v.code,
            plateNumber: v.plateNumber,
            make: v.make,
            model: v.model,
            branchId: v.branchId,
            workOrders: own.length,
            cost: m(spent),
            distance: { value: v.distance, unit: v.mileageUnit },
            costPerDistance: perMinor(costPerDistance(spent, v.distance)),
            downtimeDays: round1(down / DAY),
            availabilityPercent: percentOf(seconds - down, seconds),
            failures: failures.get(v.vehicleId) ?? 0,
          }))
          .sort((a, b) => b.cost.amountMinor - a.cost.amountMinor || a.code.localeCompare(b.code)),
        byModel: [...group(vehicles, (x) => `${x.v.make}\u0000${x.v.model}`).values()]
          .map((rows) => {
            const kmRows = rows.filter((x) => x.v.mileageUnit === "km");
            const broke = sum(rows, (x) => failures.get(x.v.vehicleId) ?? 0);
            return {
              make: rows[0]!.v.make,
              model: rows[0]!.v.model,
              vehicles: rows.length,
              workOrders: sum(rows, (x) => x.own.length),
              cost: m(sum(rows, (x) => x.spent)),
              costPerKm: perMinor(
                costPerDistance(
                  sum(kmRows, (x) => x.spent),
                  sum(kmRows, (x) => x.v.distance),
                ),
              ),
              failures: broke,
              meanDaysBetweenFailures: meanDaysBetweenFailures(
                sum(rows, (x) => x.inService),
                broke,
              ),
            };
          })
          .sort((a, b) => b.cost.amountMinor - a.cost.amountMinor),
      };
    });
  }

  compliance(
    actor: Principal,
    query: Readonly<{ branchId?: string; days?: number }>,
  ): Promise<ComplianceDashboard> {
    const { deps } = this;
    return this.within(actor, query, async ({ filter }) => {
      const today = await deps.calendar.today();
      const withinDays = query.days ?? 30;
      const until = addDays(today, withinDays);
      const { reporting } = deps;
      const documents = group(await reporting.documentsExpiring(until, filter), (d) => d.vehicleId);
      const services = group(await reporting.serviceDue(filter), (s) => s.vehicleId);
      const licences = await reporting.licencesExpiring(until, filter);
      const rows = (await reporting.complianceVehicles(today, filter)).map((v) => {
        const docs = (documents.get(v.vehicleId) ?? []).map((d) => ({
          documentId: d.documentId,
          type: d.type,
          title: d.title,
          number: d.number,
          expiresOn: d.expiresOn,
          expired: d.expiresOn < today,
        }));
        const due = (services.get(v.vehicleId) ?? []).map((s) => ({
          taskName: s.taskName,
          status: s.status,
          dueKm: s.dueKm,
          dueOn: s.dueOn,
        }));
        const level = complianceLevel({
          documentsExpired: docs.filter((d) => d.expired).length,
          documentsExpiring: docs.filter((d) => !d.expired).length,
          servicesOverdue: due.filter((s) => s.status === "overdue").length,
          servicesDue: due.filter((s) => s.status === "due").length,
          finesOverdue: v.finesOverdue,
        });
        return {
          vehicleId: v.vehicleId,
          code: v.code,
          plateNumber: v.plateNumber,
          name: `${v.make} ${v.model}`,
          branchId: v.branchId,
          status: v.status,
          level,
          documents: docs,
          services: due,
          finesOverdue: v.finesOverdue,
          openIncidents: v.openIncidents,
        };
      });
      const count = (level: ComplianceLevel) => rows.filter((r) => r.level === level).length;
      const docs = rows.flatMap((r) => r.documents);
      const due = rows.flatMap((r) => r.services);
      const drivers = licences.map((l) => ({ ...l, expired: l.expiresOn < today }));
      return {
        date: today,
        withinDays,
        summary: {
          vehicles: { red: count("red"), amber: count("amber"), green: count("green") },
          documentsExpired: docs.filter((d) => d.expired).length,
          documentsExpiring: docs.filter((d) => !d.expired).length,
          licencesExpired: drivers.filter((d) => d.expired).length,
          licencesExpiring: drivers.filter((d) => !d.expired).length,
          servicesOverdue: due.filter((s) => s.status === "overdue").length,
          servicesDue: due.filter((s) => s.status === "due").length,
          finesOverdue: sum(rows, (r) => r.finesOverdue),
          openIncidents: sum(rows, (r) => r.openIncidents),
        },
        vehicles: rows
          .filter((r) => r.level !== "green")
          .sort((a, b) => rank(a.level) - rank(b.level) || a.code.localeCompare(b.code)),
        drivers,
      };
    });
  }

  private within<T>(
    actor: Principal,
    query: Readonly<{ branchId?: string }>,
    body: (
      ctx: Readonly<{ filter: BranchFilter; timezone: string; m: (minor: number) => MoneyJson }>,
    ) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined) await deps.scope.branch(actor, REPORTS, query.branchId);
      const branchIds = deps.scope.branchesFor(actor, REPORTS);
      if (branchIds !== "all" && branchIds.length === 0)
        throw new ReportRangeError("You have no branch to report on");
      const { timezone } = await deps.organisation.get();
      const base = await deps.posting.baseCurrency();
      return body({
        filter: { branchIds, branchId: query.branchId ?? null },
        timezone,
        m: (minor) => Money.ofMinor(minor, base).toJSON(),
      });
    });
  }
}

const rank = (level: ComplianceLevel) => (level === "red" ? 0 : level === "amber" ? 1 : 2);
const round1 = (value: number) => Math.round(value * 10) / 10;

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function group<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}
