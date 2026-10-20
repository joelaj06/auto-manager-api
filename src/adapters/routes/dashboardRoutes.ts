import { z } from "zod";
import type { Dashboards } from "../../application/use-cases/reporting/Dashboards.js";
import { GRANULARITIES } from "../../domain/reporting/DateRange.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
/**
 * A period on business dates in the tenant's calendar (default: this month to date), charted by
 * day, ISO week (Monday–Sunday) or month — one point per real bucket in the range.
 */
const period = {
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  groupBy: z.enum(GRANULARITIES).optional(),
};
const dashboardQuery = z.object({ ...period, branchId: uuid.optional() });

export type DashboardRouteDependencies = Readonly<{ dashboards: Dashboards }>;

/** Dashboards v1 (docs/14): overview, vehicle P&L, remittances and expenses. */
export function dashboardRoutes(deps: DashboardRouteDependencies): ApiRoute[] {
  const { dashboards } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/overview",
      summary: "Revenue by source, costs, net and cash collected, vs the previous period",
      tags: ["dashboards"],
      access: access.permission("dashboards.overview.view"),
      request: { query: dashboardQuery },
      responses: { 200: { description: "Overview" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await dashboards.overview(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/vehicles",
      summary: "Vehicle P&L: income, costs, depreciation, profit, cost per km and utilisation",
      tags: ["dashboards"],
      access: access.permission("dashboards.vehicles.view"),
      request: { query: dashboardQuery.extend({ groupId: uuid.optional() }) },
      responses: { 200: { description: "Vehicles, most profitable first" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await dashboards.vehicleProfits(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicles/:id/profit",
      summary: "A vehicle's P&L for a period with its trend",
      tags: ["dashboards"],
      access: access.permission("dashboards.vehicles.view"),
      request: { params: z.object({ id: uuid }), query: z.object(period) },
      responses: { 200: { description: "Vehicle P&L" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await dashboards.vehicleTrend(principalOf(res), params.id, query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/remittances",
      summary: "Remittances expected vs received (by period end), collection rate, drivers short",
      tags: ["dashboards"],
      access: access.permission("dashboards.remittances.view"),
      request: { query: dashboardQuery },
      responses: { 200: { description: "Remittance dashboard" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await dashboards.remittances(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/expenses",
      summary: "Approved spending by category and vehicle, pending approvals and budgets",
      tags: ["dashboards"],
      access: access.permission("dashboards.expenses.view"),
      request: { query: dashboardQuery },
      responses: { 200: { description: "Expense dashboard" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await dashboards.expenses(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dashboards/stats/rebuild",
      summary: "Bring the vehicle statistics up to date now",
      tags: ["dashboards"],
      access: access.permission("dashboards.stats.rebuild"),
      responses: { 200: { description: "Rows rebuilt" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await dashboards.rebuildStats()));
      },
    }),
  ];
}
