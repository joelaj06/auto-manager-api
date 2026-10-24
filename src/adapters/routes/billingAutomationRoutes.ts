import { z } from "zod";
import type { BillingAutomation } from "../../application/use-cases/billing/BillingAutomation.js";
import type { BillingExtensions } from "../../application/use-cases/billing/BillingExtensions.js";
import { principalOf, staffOf, tenantOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const CONSOLE = "/api/platform/v1";
const uuid = z.uuid();
const reason = z.string().trim().min(5).max(1_000);
const idParams = z.object({ id: uuid });
const limit = z.coerce.number().int().min(1).max(100).default(25);
const days = z.array(z.number().int()).max(10);
const extensionStatus = z.enum(["requested", "approved", "denied", "expired", "closed"]);

export type BillingAutomationRouteDependencies = Readonly<{
  automation: BillingAutomation;
  extensions: BillingExtensions;
}>;

/**
 * Billing automation (docs/25 §5): the tenant's banner, notices and extension requests (all
 * reachable in billing-only mode), and the console's dunning policy, runs, review queue of
 * pending deactivations, extension decisions and dispute holds.
 */
export function billingAutomationRoutes(deps: BillingAutomationRouteDependencies): ApiRoute[] {
  const { automation, extensions } = deps;
  return [
    // --- tenant: Billing tab ---
    defineRoute({
      method: "get",
      path: "/api/v1/billing/banner",
      summary: "The billing banner for every admin (null when nothing is due soon)",
      tags: ["billing"],
      access: access.signedIn(),
      responses: { 200: { description: "Banner or null" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await automation.banner(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/notices",
      summary: "Billing notices sent to your business (newest first)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { query: z.object({ limit }) },
      responses: { 200: { description: "Notices" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await automation.notices(tenantOf(res).id, query.limit)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/extensions",
      summary: "Your extension requests and their decisions",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Extensions" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await extensions.list({ tenantId: tenantOf(res).id, limit: 50 })));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/billing/extensions",
      summary: "Ask for more time to pay an invoice (at most 10 days after its due date)",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: {
        body: z.object({
          invoiceId: uuid,
          requestedUntil: z.iso.date(),
          note: z.string().trim().max(1_000).nullish(),
        }),
      },
      responses: { 201: { description: "Extension request" } },
      handler: async ({ body }, _req, res) => {
        const request = await extensions.request(tenantOf(res).id, body, principalOf(res).userId);
        res.status(201).json(envelope(request));
      },
    }),

    // --- console ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/dunning-policy`,
      summary: "The billing automation schedule and safeguards in force, with past versions",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      responses: { 200: { description: "Policy and versions" } },
      handler: async (_input, _req, res) => {
        res.json(
          envelope({ current: await automation.policy(), versions: await automation.policies(20) }),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/billing/dunning-policy`,
      summary: "Change the schedule and safeguards (a new version)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.prices.manage"),
      request: {
        body: z.object({
          invoiceLeadDays: z.number().int(),
          reminderDaysBefore: days,
          overdueReminderDays: days,
          graceDays: z.number().int(),
          readOnlyAfterDays: z.number().int().nullable(),
          skipSundays: z.boolean(),
          extension: z.object({
            maxDays: z.number().int(),
            maxPer90Days: z.number().int(),
            finalGraceDays: z.number().int(),
          }),
          dryRun: z.boolean(),
          circuitBreaker: z.object({ maxCount: z.number().int(), maxPercent: z.number().int() }),
          reviewBranchThreshold: z.number().int(),
          gatewayGuard: z.object({ maxFailedWebhooks24h: z.number().int() }),
          channels: z.array(z.enum(["email", "sms", "in_app", "push"])).min(1),
          /** Turning dry run off: confirms the dry-run review was read. */
          dryRunReviewed: z.boolean().optional(),
        }),
      },
      responses: { 200: { description: "The new version" } },
      handler: async ({ body }, _req, res) => {
        const { dryRunReviewed, ...policy } = body;
        res.json(envelope(await automation.setPolicy(policy, staffOf(res), { dryRunReviewed })));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/automation/dry-run-review`,
      summary: "What the automation would have done in dry run, and who paid afterwards",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(28) }) },
      responses: { 200: { description: "Review" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await automation.dryRunReview(query.days)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/automation/pending`,
      summary: "Tenants the automation will deactivate in the next 48 hours (large ones flagged)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      responses: { 200: { description: "Pending deactivations" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await automation.pending()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/automation/runs`,
      summary: "Runs of the billing automation: what it did, would have done, held back",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { query: z.object({ limit }) },
      responses: { 200: { description: "Runs" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await automation.runs(query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/automation/runs`,
      summary: "Run the billing automation now",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      responses: { 200: { description: "Run" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await automation.runNow(staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/extensions`,
      summary: "Extension requests (filter by status, e.g. requested)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: {
        query: z.object({ status: extensionStatus.optional(), tenantId: uuid.optional(), limit }),
      },
      responses: { 200: { description: "Extensions" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await extensions.list(query)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/billing/extensions/:id/approve`,
      summary: "Approve an extension (optionally to another date); restores a billing deactivation",
      tags: ["console: billing"],
      access: access.platform("platform.billing.extensions.grant"),
      request: {
        params: idParams,
        body: z.object({ until: z.iso.date().optional(), reason }),
      },
      responses: { 200: { description: "Extension" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await extensions.approve(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/billing/extensions/:id/deny`,
      summary: "Deny an extension request",
      tags: ["console: billing"],
      access: access.platform("platform.billing.extensions.grant"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Extension" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await extensions.deny(params.id, body.reason, staffOf(res))));
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/tenants/:id/billing/dispute-hold`,
      summary: "Hold (or release) automatic deactivation for a billing dispute or pending refund",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: idParams, body: z.object({ reason: reason.nullable() }) },
      responses: { 204: { description: "Saved" } },
      handler: async ({ params, body }, _req, res) => {
        await automation.setDisputeHold(params.id, body.reason, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/tenants/:id/billing/notices`,
      summary: "Billing notices sent to a tenant (timeline)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: idParams, query: z.object({ limit }) },
      responses: { 200: { description: "Notices" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await automation.notices(params.id, query.limit)));
      },
    }),
  ];
}
