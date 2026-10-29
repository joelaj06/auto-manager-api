import { z } from "zod";
import type { DealerReports } from "../../application/use-cases/dealer/DealerReports.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();

const periodQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  branchId: uuid.optional(),
});

export type DealerReportRouteDependencies = Readonly<{ reports: DealerReports }>;

/**
 * Dealer reports (docs/10 §10): sales, stock, leads and cash at a glance, price reductions, and
 * cash collected on sales against what they owe. Periods are local dates, the last 30 days by
 * default.
 */
export function dealerReportRoutes(deps: DealerReportRouteDependencies): ApiRoute[] {
  const { reports } = deps;
  const view = access.permission("dashboards.dealer.view");

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/dealer",
      summary:
        "Units sold and delivered with revenue and days to sell, stock on hand, leads won and lost, cash collected, owed and held",
      tags: ["dashboards"],
      access: view,
      request: { query: periodQuery },
      responses: { 200: { description: "Overview" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.overview(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/dealer/price-reductions",
      summary: "Cuts in asking prices in the period, by make and vehicle",
      tags: ["dashboards"],
      access: view,
      request: { query: periodQuery },
      responses: { 200: { description: "Price reductions" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.priceReductions(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/dealer/collections",
      summary:
        "Cash collected on sales in the period by method and branch, what sold deals still owe and the deposits held",
      tags: ["dashboards"],
      access: view,
      request: { query: periodQuery },
      responses: { 200: { description: "Collections" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.collections(principalOf(res), query)));
      },
    }),
  ];
}
