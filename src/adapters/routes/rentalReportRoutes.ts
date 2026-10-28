import { z } from "zod";
import type { RentalReports } from "../../application/use-cases/rentals/RentalReports.js";
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

export type RentalReportRouteDependencies = Readonly<{ reports: RentalReports }>;

/**
 * Rental reports and the operations board (docs/07 §11): utilisation, revenue with the average
 * daily rate and revenue per available vehicle, balances and deposits held, damage recovery,
 * and the day's pickups and returns. Periods are local dates, the last 30 days by default.
 */
export function rentalReportRoutes(deps: RentalReportRouteDependencies): ApiRoute[] {
  const { reports } = deps;
  const view = access.permission("dashboards.rentals.view");

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/rentals/utilisation",
      summary: "Hours on rent against hours the fleet could be rented, by class and vehicle",
      tags: ["dashboards"],
      access: view,
      request: { query: periodQuery },
      responses: { 200: { description: "Utilisation" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.utilisation(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/rentals/revenue",
      summary:
        "Rental revenue by class, branch and customer type, with the average daily rate and revenue per available vehicle",
      tags: ["dashboards"],
      access: view,
      request: { query: periodQuery },
      responses: { 200: { description: "Revenue" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.revenue(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/rentals/balances",
      summary: "What rentals still owe, and the security deposits held",
      tags: ["dashboards"],
      access: view,
      request: { query: z.object({ branchId: uuid.optional() }) },
      responses: { 200: { description: "Balances and deposits" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.balances(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/rentals/damages",
      summary: "Damage costs against what the renters were charged, by liability",
      tags: ["dashboards"],
      access: view,
      request: { query: periodQuery },
      responses: { 200: { description: "Damages" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.damages(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/rental-board",
      summary: "The day's pickups and returns, overdue rentals and reservations lapsing",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: z.object({ date: date.optional(), branchId: uuid.optional() }) },
      responses: { 200: { description: "Board" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.board(principalOf(res), query)));
      },
    }),
  ];
}
