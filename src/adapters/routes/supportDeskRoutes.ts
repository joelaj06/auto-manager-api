import { z } from "zod";
import type { DemoTenants } from "../../application/use-cases/console/DemoTenants.js";
import type { OnboardingConcierge } from "../../application/use-cases/console/OnboardingConcierge.js";
import type { Requester, SupportDesk } from "../../application/use-cases/console/SupportDesk.js";
import { DEMO_MAX_DAYS, DEMO_PURPOSES } from "../../domain/console/DemoTenants.js";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "../../domain/console/SupportDesk.js";
import { ONBOARDING_STEPS } from "../../domain/console/TenantAnalytics.js";
import type { Response } from "express";
import { principalOf, staffOf, tenantOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const idParams = z.object({ id: z.uuid() });
const limit = z.coerce.number().int().min(1).max(500).default(100);
const priority = z.enum(TICKET_PRIORITIES);
const category = z.enum(TICKET_CATEGORIES);
const body = z.string().trim().min(1).max(10_000);
const note = z.string().trim().max(1_000).nullish();
const phone = z
  .string()
  .regex(/^\+[1-9][0-9]{7,14}$/, "Phone in international format, e.g. +233241234567");
const canned = z.object({
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(1).max(5_000),
  category: category.nullable().default(null),
  active: z.boolean().default(true),
});
const milestone = z.enum(ONBOARDING_STEPS.map((s) => s.key) as [string, ...string[]]);

export type SupportDeskRouteDependencies = Readonly<{
  desk: SupportDesk;
  demos: DemoTenants;
  concierge: OnboardingConcierge;
}>;

const requesterOf = (res: Response): Requester => {
  const principal = principalOf(res);
  return {
    tenantId: tenantOf(res).id,
    userId: principal.userId,
    seesAll: principal.grantFor("support.tickets.view_all") !== undefined,
  };
};

/**
 * The support desk (docs/27 §3.13), demo tenants (§5.2) and the onboarding concierge (§5.12):
 * tickets with replies, notes, escalation and SLA timers for staff and for the tenant's users in
 * the app, canned responses and SLA targets, demos with sample data that expire, and each new
 * tenant's task list for staff (decisions 500–503).
 */
export function supportDeskRoutes(deps: SupportDeskRouteDependencies): ApiRoute[] {
  const { desk, demos, concierge } = deps;
  return [
    // --- the tenant's users ---
    defineRoute({
      method: "get",
      path: "/api/v1/support/tickets",
      summary: "Your support tickets (every ticket of the business with support.tickets.view_all)",
      tags: ["support"],
      access: access.signedIn(),
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: { 200: { description: "Tickets" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await desk.myTickets(requesterOf(res), query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/support/tickets",
      summary: "Ask Autoforce support for help (we email you when we answer)",
      tags: ["support"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: {
        body: z.object({
          subject: z.string().trim().min(3).max(200),
          category,
          priority: z.enum(["low", "normal", "high"]).default("normal"),
          body,
        }),
      },
      responses: { 201: { description: "Ticket" } },
      handler: async ({ body: input }, _req, res) => {
        res
          .status(201)
          .json(
            envelope(
              await desk.raiseInApp({ ...requesterOf(res), tenantSlug: tenantOf(res).slug }, input),
            ),
          );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/support/tickets/:id",
      summary: "A support ticket with the conversation",
      tags: ["support"],
      access: access.signedIn(),
      request: { params: idParams },
      responses: { 200: { description: "Ticket" }, 404: { description: "Not yours" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await desk.mine(requesterOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/support/tickets/:id/messages",
      summary: "Reply on a support ticket (reopens it if it was resolved)",
      tags: ["support"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: { params: idParams, body: z.object({ body }) },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await desk.customerReply(requesterOf(res), params.id, input.body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/support/tickets/:id/rating",
      summary: "Rate how we handled a resolved ticket (1–5)",
      tags: ["support"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: {
        params: idParams,
        body: z.object({ score: z.number().int().min(1).max(5), comment: note }),
      },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(
          envelope(
            await desk.rate(requesterOf(res), params.id, {
              score: input.score,
              comment: input.comment ?? null,
            }),
          ),
        );
      },
    }),

    // --- console: tickets ---
    defineRoute({
      method: "get",
      path: `${BASE}/support/tickets`,
      summary: "Support tickets, active and most urgent first",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.view"),
      request: {
        query: z.object({
          status: z.enum([...TICKET_STATUSES, "active"]).optional(),
          priority: priority.optional(),
          category: category.optional(),
          tenantId: z.uuid().optional(),
          /** `me` for the signed-in staff member. */
          assigneeId: z.union([z.uuid(), z.literal("me")]).optional(),
          breached: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          q: z.string().trim().max(120).optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Tickets" } },
      handler: async ({ query }, _req, res) => {
        res.json(
          envelope(
            await desk.list({
              ...query,
              ...(query.assigneeId === "me" ? { assigneeId: staffOf(res).userId } : {}),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/support/summary`,
      summary: "Support at a glance: active, breached, and the period's SLA and satisfaction",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.view"),
      request: { query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) },
      responses: { 200: { description: "Summary" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await desk.summary(query.days)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support/tickets`,
      summary: "Log a ticket from a call, an email or a WhatsApp message",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.manage"),
      request: {
        body: z.object({
          tenantId: z.uuid().nullable().default(null),
          tenantUserId: z.uuid().nullable().default(null),
          requesterName: z.string().trim().min(1).max(120),
          requesterEmail: z.email().nullable().default(null),
          requesterPhone: phone.nullable().default(null),
          channel: z.enum(["email", "phone", "whatsapp", "console"]),
          subject: z.string().trim().min(3).max(200),
          category,
          priority: priority.default("normal"),
          body,
          acknowledge: z.boolean().default(true),
        }),
      },
      responses: { 201: { description: "Ticket" } },
      handler: async ({ body: input }, _req, res) => {
        res.status(201).json(envelope(await desk.log(staffOf(res), input)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/support/tickets/:id`,
      summary: "A ticket with its conversation and internal notes",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.view"),
      request: { params: idParams },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await desk.ticket(params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/support/tickets/:id`,
      summary: "Change a ticket's priority, category or assignee; link its tenant or request",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.manage"),
      request: {
        params: idParams,
        body: z.object({
          priority: priority.optional(),
          category: category.optional(),
          assigneeId: z.uuid().nullable().optional(),
          tenantId: z.uuid().nullable().optional(),
          dataProtectionRequestId: z.uuid().nullable().optional(),
        }),
      },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await desk.update(staffOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support/tickets/:id/messages`,
      summary:
        "Reply to the requester (emailed) or add an internal note; a canned response fills in",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.manage"),
      request: {
        params: idParams,
        body: z.object({
          body: z.string().trim().max(10_000).nullish(),
          cannedResponseId: z.uuid().nullish(),
          internal: z.boolean().default(false),
          status: z.enum(["open", "waiting_on_customer", "resolved"]).nullish(),
        }),
      },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await desk.reply(staffOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support/tickets/:id/escalate`,
      summary: "Escalate to engineering with the request id and the Sentry link",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.manage"),
      request: {
        params: idParams,
        body: z.object({
          requestId: z.string().trim().min(1).max(100).nullable().default(null),
          sentryUrl: z.string().trim().max(500).nullable().default(null),
          note: z.string().trim().min(3).max(2_000),
        }),
      },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await desk.escalate(staffOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support/tickets/:id/status`,
      summary: "Open a ticket again, resolve it (the requester is asked to rate it) or close it",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.manage"),
      request: {
        params: idParams,
        body: z.object({ status: z.enum(["open", "resolved", "closed"]), note }),
      },
      responses: { 200: { description: "Ticket" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(
          envelope(
            await desk.setStatus(staffOf(res), params.id, {
              status: input.status,
              note: input.note ?? null,
            }),
          ),
        );
      },
    }),

    // --- console: canned responses and SLA ---
    defineRoute({
      method: "get",
      path: `${BASE}/support/canned-responses`,
      summary: "Canned responses, most used first",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.view"),
      request: {
        query: z.object({
          active: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .default(true),
        }),
      },
      responses: { 200: { description: "Canned responses" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await desk.cannedResponses(query.active)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support/canned-responses`,
      summary:
        "Write a canned response ({{requesterName}}, {{ticketNumber}}, {{staffName}}, {{businessName}})",
      tags: ["console: support"],
      access: access.platform("platform.support.canned_responses.manage"),
      request: { body: canned },
      responses: { 201: { description: "Canned response" } },
      handler: async ({ body: input }, _req, res) => {
        res.status(201).json(envelope(await desk.createCanned(staffOf(res), input)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/support/canned-responses/:id`,
      summary: "Change or retire a canned response",
      tags: ["console: support"],
      access: access.platform("platform.support.canned_responses.manage"),
      request: { params: idParams, body: canned },
      responses: { 200: { description: "Canned response" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await desk.updateCanned(staffOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/support/sla`,
      summary: "The SLA targets per priority (minutes; in support hours unless around the clock)",
      tags: ["console: support"],
      access: access.platform("platform.support.tickets.view"),
      responses: { 200: { description: "Targets" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await desk.slaTargets()));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/support/sla/:priority`,
      summary: "Set a priority's targets (for tickets raised from now on)",
      tags: ["console: support"],
      access: access.platform("platform.support.settings.manage"),
      request: {
        params: z.object({ priority }),
        body: z.object({
          firstResponseMinutes: z.number().int(),
          resolutionMinutes: z.number().int(),
          businessHours: z.boolean(),
        }),
      },
      responses: { 200: { description: "Targets" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(
          envelope(await desk.setSlaTarget(staffOf(res), { ...input, priority: params.priority })),
        );
      },
    }),

    // --- console: demo tenants ---
    defineRoute({
      method: "get",
      path: `${BASE}/demo-tenants`,
      summary: "Demo and sandbox tenants with their sample data and end dates",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.demos.manage"),
      request: {
        query: z.object({
          live: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Demos" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await demos.list(query)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/demo-tenants`,
      summary: "Create a demo tenant with sample data; the contact gets the owner's sign-in",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.demos.manage"),
      request: {
        body: z.object({
          businessName: z.string().trim().min(2).max(120),
          businessType: z.enum(["fleet", "rental", "dealer", "mixed"]).default("mixed"),
          slug: z
            .string()
            .trim()
            .regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/)
            .nullish(),
          contactName: z.string().trim().min(2).max(120),
          contactEmail: z.email(),
          contactPhone: phone,
          purpose: z.enum(DEMO_PURPOSES).default("sales_demo"),
          prospect: z.string().trim().max(200).nullish(),
          days: z.number().int().min(1).max(DEMO_MAX_DAYS).optional(),
          sampleData: z.boolean().default(true),
        }),
      },
      responses: { 201: { description: "Demo (being provisioned)" } },
      handler: async ({ body: input }, _req, res) => {
        res.status(201).json(envelope(await demos.create(staffOf(res), input)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/demo-tenants/:id`,
      summary: "A demo tenant",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.demos.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Demo" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await demos.demo(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/demo-tenants/:id/extend`,
      summary: "Give a demo more days (an ended one is opened again until it is purged)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.demos.manage"),
      request: {
        params: idParams,
        body: z.object({ days: z.number().int().min(1).max(DEMO_MAX_DAYS) }),
      },
      responses: { 200: { description: "Demo" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await demos.extend(staffOf(res), params.id, input.days)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/demo-tenants/:id/end`,
      summary: "End a demo now (purged a week later)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.demos.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Demo" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await demos.end(staffOf(res), params.id)));
      },
    }),

    // --- console: onboarding concierge ---
    defineRoute({
      method: "get",
      path: `${BASE}/onboarding/templates`,
      summary: "The onboarding concierge's task templates",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      responses: { 200: { description: "Templates" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await concierge.templates()));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/onboarding/templates/:key`,
      summary: "Add or change a task template (applies to tenants provisioned from now on)",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.settings.manage"),
      request: {
        params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) }),
        body: z.object({
          title: z.string().trim().min(3).max(160),
          description: z.string().trim().max(1_000).nullable().default(null),
          dueAfterHours: z.number().int().min(1).max(2_160),
          completesWith: milestone.nullable().default(null),
          position: z.number().int().min(0).max(1_000).default(0),
          active: z.boolean().default(true),
        }),
      },
      responses: { 200: { description: "Templates" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(
          envelope(
            await concierge.saveTemplate(staffOf(res), params.key, {
              ...input,
              completesWith: input.completesWith as never,
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/onboarding/tasks`,
      summary: "Concierge tasks across tenants (open and overdue first)",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      request: {
        query: z.object({
          status: z.enum(["open", "done", "skipped"]).optional(),
          tenantId: z.uuid().optional(),
          assigneeId: z.union([z.uuid(), z.literal("me")]).optional(),
          overdue: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Tasks" } },
      handler: async ({ query }, _req, res) => {
        res.json(
          envelope(
            await concierge.list({
              ...(query.status === undefined ? {} : { status: query.status }),
              ...(query.tenantId === undefined ? {} : { tenantId: query.tenantId }),
              ...(query.assigneeId === undefined
                ? {}
                : {
                    assigneeId: query.assigneeId === "me" ? staffOf(res).userId : query.assigneeId,
                  }),
              ...(query.overdue === true ? { overdueAt: new Date() } : {}),
              limit: query.limit,
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/onboarding-tasks`,
      summary: "A tenant's concierge tasks",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Tasks" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await concierge.tenantTasks(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/onboarding-tasks`,
      summary: "Add a task of your own to a tenant's list",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      request: {
        params: idParams,
        body: z.object({
          title: z.string().trim().min(3).max(160),
          description: z.string().trim().max(1_000).nullable().default(null),
          dueAt: z.coerce.date(),
          assigneeId: z.uuid().nullable().default(null),
        }),
      },
      responses: { 201: { description: "Task" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.status(201).json(envelope(await concierge.addTask(staffOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/tenants/:id/onboarding-tasks/assignee`,
      summary: "Make a staff member the tenant's concierge: every open task goes to them",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      request: { params: idParams, body: z.object({ assigneeId: z.uuid().nullable() }) },
      responses: { 200: { description: "Tasks" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await concierge.assignTenant(staffOf(res), params.id, input.assigneeId)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/onboarding/tasks/:id/:action`,
      summary: "Complete, skip (with a note) or reopen a concierge task",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      request: {
        params: z.object({ id: z.uuid(), action: z.enum(["complete", "skip", "reopen"]) }),
        body: z.object({ note }),
      },
      responses: { 200: { description: "Task" } },
      handler: async ({ params, body: input }, _req, res) => {
        const staff = staffOf(res);
        res.json(
          envelope(
            params.action === "reopen"
              ? await concierge.reopen(staff, params.id)
              : await concierge.finish(
                  staff,
                  params.id,
                  params.action === "complete" ? "done" : "skipped",
                  input.note ?? null,
                ),
          ),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/onboarding/tasks/:id/assignee`,
      summary: "Give a concierge task to a staff member",
      tags: ["console: onboarding"],
      access: access.platform("platform.support.onboarding.manage"),
      request: { params: idParams, body: z.object({ assigneeId: z.uuid().nullable() }) },
      responses: { 200: { description: "Task" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await concierge.assign(staffOf(res), params.id, input.assigneeId)));
      },
    }),
  ];
}
