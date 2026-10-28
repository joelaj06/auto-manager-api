import { z } from "zod";
import type { MaintenanceReports } from "../../application/use-cases/maintenance/MaintenanceReports.js";
import { GRANULARITIES } from "../../domain/reporting/DateRange.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();

export type MaintenanceReportRouteDependencies = Readonly<{ reports: MaintenanceReports }>;

/**
 * Maintenance KPIs and the compliance dashboard (docs/12 §6, docs/14 §3). Periods are local
 * dates, the last 30 days by default.
 */
export function maintenanceReportRoutes(deps: MaintenanceReportRouteDependencies): ApiRoute[] {
  const { reports } = deps;
  const view = access.permission("dashboards.maintenance.view");

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/maintenance",
      summary:
        "Maintenance cost by kind, type, vehicle and model with cost per km, downtime and availability, preventive against corrective work, mean time between failures and services due",
      tags: ["dashboards"],
      access: view,
      request: {
        query: z.object({
          from: date.optional(),
          to: date.optional(),
          branchId: uuid.optional(),
          groupBy: z.enum(GRANULARITIES).optional(),
        }),
      },
      responses: { 200: { description: "Maintenance KPIs" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.kpis(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/compliance",
      summary:
        "Vehicles red, amber or green on documents, services and fines, and drivers' licences expired or expiring within `days` (default 30)",
      tags: ["dashboards"],
      access: view,
      request: {
        query: z.object({
          branchId: uuid.optional(),
          days: z.coerce.number().int().min(0).max(365).optional(),
        }),
      },
      responses: { 200: { description: "Compliance" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.compliance(principalOf(res), query)));
      },
    }),
  ];
}
