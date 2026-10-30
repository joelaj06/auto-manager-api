import { z } from "zod";
import type { PlatformAnalytics } from "../../application/use-cases/console/PlatformAnalytics.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1/analytics";
const tags = ["console: analytics"];
const view = access.platform("platform.analytics.view");
/** A period of dates (UTC), the last 30 days by default. */
const period = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const minor = z.number().int().min(0).max(100_000_000);

export type ConsoleAnalyticsRouteDependencies = Readonly<{ analytics: PlatformAnalytics }>;

/**
 * Platform analytics (docs/27 §3.16): growth funnel, feature adoption, tenant health with the
 * onboarding checklist, cohorts, cost to serve and its rates, reseller performance and churn.
 */
export function consoleAnalyticsRoutes(deps: ConsoleAnalyticsRouteDependencies): ApiRoute[] {
  const { analytics } = deps;
  return [
    defineRoute({
      method: "get",
      path: `${BASE}/funnel`,
      summary:
        "Applications in a period through verified, approved, provisioned, first vehicle, first payment and paying",
      tags,
      access: view,
      request: { query: period },
      responses: { 200: { description: "Funnel" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await analytics.funnel(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/adoption`,
      summary: "Live tenants using each module over 30 days, and those expected to that do not",
      tags,
      access: view,
      responses: { 200: { description: "Adoption" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await analytics.adoption()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/health`,
      summary: "Health scores of live tenants, weakest first; at_risk, expansion_ready or new",
      tags,
      access: view,
      request: {
        query: z.object({
          flag: z.enum(["at_risk", "expansion_ready", "new"]).optional(),
          limit: z.coerce.number().int().min(1).max(1_000).default(200),
        }),
      },
      responses: { 200: { description: "Tenant health" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await analytics.health(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id`,
      summary: "A tenant's health score, its parts and its onboarding checklist",
      tags,
      access: view,
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: { description: "Tenant health" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await analytics.tenantHealth(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/cohorts`,
      summary: "Tenants by month provisioned: retention by activity, paying and MRR",
      tags,
      access: view,
      request: {
        query: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }),
      },
      responses: { 200: { description: "Cohorts" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await analytics.cohorts(query.months)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/cost-to-serve`,
      summary: "Each live tenant's monthly cost from its size, calls and jobs against its MRR",
      tags,
      access: view,
      responses: { 200: { description: "Cost to serve" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await analytics.costToServe()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/cost-rates`,
      summary: "What serving a tenant costs a month",
      tags,
      access: view,
      responses: { 200: { description: "Cost rates" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await analytics.rates()));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/cost-rates`,
      summary: "Set what serving a tenant costs a month (minor units)",
      tags,
      access: access.platform("platform.settings.manage"),
      request: {
        body: z.object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          tenantMonthMinor: minor,
          databaseGbMonthMinor: minor,
          storageGbMonthMinor: minor,
          apiCallsThousandMinor: minor,
          jobsThousandMinor: minor,
        }),
      },
      responses: { 200: { description: "Cost rates" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await analytics.setRates(staffOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/resellers`,
      summary: "Reseller performance: tenants, live, paying, churned, MRR, health and commission",
      tags,
      access: view,
      request: { query: period },
      responses: { 200: { description: "Resellers" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await analytics.resellers(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/churn`,
      summary: "Tenants deactivated in a period by reason, and those restored",
      tags,
      access: view,
      request: { query: period },
      responses: { 200: { description: "Churn" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await analytics.churn(query)));
      },
    }),
  ];
}
