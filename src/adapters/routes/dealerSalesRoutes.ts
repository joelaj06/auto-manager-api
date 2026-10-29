import { z } from "zod";
import {
  LOGGED_ACTIVITIES,
  type DealerLeads,
} from "../../application/use-cases/dealer/DealerLeads.js";
import type { DealerQuotes } from "../../application/use-cases/dealer/DealerQuotes.js";
import type { TestDrives } from "../../application/use-cases/dealer/TestDrives.js";
import { LEAD_SOURCES, LEAD_STAGES } from "../../domain/dealer/Lead.js";
import { ADD_ON_KINDS, FINANCING, QUOTE_STATUSES } from "../../domain/dealer/Quote.js";
import { TEST_DRIVE_STATUSES } from "../../domain/dealer/TestDrive.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const idParams = z.object({ id: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const year = z.number().int().min(1950).max(2100).nullable().optional();
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v.split(",")))
    .pipe(z.array(z.enum(values)).optional());
const assignee = z.union([uuid, z.literal("round_robin"), z.null()]);

const leadBody = z.object({
  source: z.enum(LEAD_SOURCES),
  name: z.string().trim().min(1).max(160),
  phone: text(30),
  email: z.email().nullable().optional(),
  customerId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
  make: text(80),
  model: text(80),
  yearFrom: year,
  yearTo: year,
  budgetMax: amount.nullable().optional(),
  notifyMatches: z.boolean().optional(),
  notes: text(2_000),
});

const quoteBody = z.object({
  vehicleId: uuid,
  leadId: uuid.nullable().optional(),
  customerId: uuid.nullable().optional(),
  customerName: text(160),
  price: amount.optional(),
  discount: amount.optional(),
  addOns: z
    .array(z.object({ kind: z.enum(ADD_ON_KINDS), description: text(300), amount }))
    .max(20)
    .optional(),
  tradeIn: z
    .object({ description: z.string().trim().min(1).max(300), value: amount })
    .nullable()
    .optional(),
  financing: z.enum(FINANCING).optional(),
  deposit: amount.nullable().optional(),
  termMonths: z.number().int().min(1).max(120).nullable().optional(),
  financingNote: text(500),
  validUntil: date.optional(),
  notes: text(2_000),
});

export type DealerSalesRouteDependencies = Readonly<{
  leads: DealerLeads;
  drives: TestDrives;
  quotes: DealerQuotes;
}>;

/**
 * Dealer sales (docs/10 §4–6): leads with their activity, follow-ups, assignment and funnel; test
 * drives; quotes (decisions 437–444).
 */
export function dealerSalesRoutes(deps: DealerSalesRouteDependencies): ApiRoute[] {
  const { leads, drives, quotes } = deps;
  const tags = ["dealer"];
  const viewLeads = access.permission("dealer.leads.view");
  const updateLeads = access.permission("dealer.leads.update");
  const assignLeads = access.permission("dealer.leads.assign");
  const testDrives = access.permission("dealer.testdrives.manage");
  const manageQuotes = access.permission("dealer.quotes.manage");

  return [
    // --- leads ---
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/leads",
      summary: "Leads, newest first (own scope: those assigned to you)",
      tags,
      access: viewLeads,
      request: {
        query: z.object({
          branchId: uuid.optional(),
          assignedTo: uuid.optional(),
          unassigned: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => (v === undefined ? undefined : v === "true")),
          stage: list(LEAD_STAGES),
          source: list(LEAD_SOURCES),
          search: z.string().trim().min(1).max(100).optional(),
          beforeId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Leads" } },
      handler: async ({ query }, _req, res) => {
        const { stage, source, unassigned, ...rest } = query;
        res.json(
          envelope(
            await leads.list(principalOf(res), {
              ...rest,
              ...(unassigned === undefined ? {} : { unassigned }),
              ...(stage === undefined ? {} : { stages: stage }),
              ...(source === undefined ? {} : { sources: source }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/leads",
      summary: "Capture a lead; unassigned it goes to the next in the branch's rotation, or to you",
      tags,
      access: access.permission("dealer.leads.create"),
      request: {
        body: leadBody.extend({ branchId: uuid.optional(), assignTo: assignee.optional() }),
      },
      responses: { 201: { description: "Lead" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await leads.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/leads/funnel",
      summary: "Leads created in a period by stage, source and sales executive, with conversion",
      tags,
      access: viewLeads,
      request: { query: z.object({ from: date, to: date, branchId: uuid.optional() }) },
      responses: { 200: { description: "Funnel" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await leads.funnel(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/lead-rotation/:branchId",
      summary: "Who takes the branch's new leads in turn",
      tags,
      access: assignLeads,
      request: { params: z.object({ branchId: uuid }) },
      responses: { 200: { description: "User ids in turn order" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await leads.pool(principalOf(res), params.branchId)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/dealer/lead-rotation/:branchId",
      summary: "Set who takes the branch's new leads in turn (in this order)",
      tags,
      access: assignLeads,
      request: {
        params: z.object({ branchId: uuid }),
        body: z.object({ userIds: z.array(uuid).max(50) }),
      },
      responses: { 200: { description: "User ids in turn order" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await leads.setPool(principalOf(res), params.branchId, body.userIds)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/leads/:id",
      summary: "A lead with its activity log and follow-ups",
      tags,
      access: viewLeads,
      request: { params: idParams },
      responses: { 200: { description: "Lead" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await leads.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/dealer/leads/:id",
      summary: "Edit the lead's contact, interest and saved search",
      tags,
      access: updateLeads,
      request: { params: idParams, body: leadBody },
      responses: { 200: { description: "Lead" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await leads.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/leads/:id/stage",
      summary: "Move the lead along the pipeline (lost needs a reason)",
      tags,
      access: updateLeads,
      request: {
        params: idParams,
        body: z.object({ stage: z.enum(LEAD_STAGES), reason: text(500) }),
      },
      responses: { 200: { description: "Lead" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await leads.move(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/leads/:id/assign",
      summary: "Give the lead to someone, to the next in turn, or to nobody (null)",
      tags,
      access: assignLeads,
      request: { params: idParams, body: z.object({ assignTo: assignee }) },
      responses: { 200: { description: "Lead" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await leads.assign(principalOf(res), params.id, body.assignTo)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/leads/:id/activities",
      summary: "Log a call, message, visit or note (contact moves a new lead to contacted)",
      tags,
      access: updateLeads,
      request: {
        params: idParams,
        body: z.object({
          kind: z.enum(LOGGED_ACTIVITIES),
          note: text(2_000),
          occurredAt: instant.optional(),
        }),
      },
      responses: { 201: { description: "Lead" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await leads.logActivity(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/leads/:id/tasks",
      summary: "Add a follow-up, reminded on the day it is due",
      tags,
      access: updateLeads,
      request: {
        params: idParams,
        body: z.object({
          title: z.string().trim().min(1).max(300),
          dueOn: date,
          assignedTo: uuid.nullable().optional(),
        }),
      },
      responses: { 201: { description: "Lead" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await leads.addTask(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/leads/:id/tasks/:taskId/done",
      summary: "Mark a follow-up done",
      tags,
      access: updateLeads,
      request: { params: z.object({ id: uuid, taskId: uuid }) },
      responses: { 200: { description: "Lead" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await leads.completeTask(principalOf(res), params.id, params.taskId)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/leads/:id/matches",
      summary: "Listed stock that fits the lead's saved search",
      tags,
      access: viewLeads,
      request: { params: idParams },
      responses: { 200: { description: "Vehicles" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await leads.matches(principalOf(res), params.id)));
      },
    }),

    // --- test drives ---
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/test-drives",
      summary: "Test drives in your branches, newest first",
      tags,
      access: testDrives,
      request: {
        query: z.object({
          vehicleId: uuid.optional(),
          leadId: uuid.optional(),
          status: list(TEST_DRIVE_STATUSES),
          from: instant.optional(),
          until: instant.optional(),
          beforeId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Test drives" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        res.json(
          envelope(
            await drives.list(principalOf(res), {
              ...rest,
              ...(status === undefined ? {} : { statuses: status }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/test-drives",
      summary: "Book a test drive on a ready or listed stock vehicle (blocks the vehicle)",
      tags,
      access: testDrives,
      request: {
        body: z.object({
          vehicleId: uuid,
          leadId: uuid.nullable().optional(),
          startsAt: instant,
          endsAt: instant,
          driverName: z.string().trim().min(1).max(160).optional(),
          driverPhone: z.string().trim().min(5).max(30).optional(),
          licenceNumber: z.string().trim().min(3).max(40),
          licenceExpiresOn: date,
          accompaniedBy: uuid.optional(),
          notes: text(2_000),
        }),
      },
      responses: { 201: { description: "Test drive" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await drives.book(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/test-drives/:id",
      summary: "A test drive",
      tags,
      access: testDrives,
      request: { params: idParams },
      responses: { 200: { description: "Test drive" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await drives.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/test-drives/:id/start",
      summary: "The car goes out: the odometer read and the waiver issued for signature",
      tags,
      access: testDrives,
      request: { params: idParams, body: z.object({ odometer: z.number().int().min(0) }) },
      responses: { 200: { description: "Test drive" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await drives.start(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/test-drives/:id/return",
      summary: "The car is back: the odometer and the driver's feedback",
      tags,
      access: testDrives,
      request: {
        params: idParams,
        body: z.object({ odometer: z.number().int().min(0), feedback: text(2_000) }),
      },
      responses: { 200: { description: "Test drive" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await drives.finish(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/test-drives/:id/cancel",
      summary: "Cancel a booked drive, or record that the driver did not come",
      tags,
      access: testDrives,
      request: {
        params: idParams,
        body: z.object({ status: z.enum(["cancelled", "no_show"]), reason: text(500) }),
      },
      responses: { 200: { description: "Test drive" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await drives.cancel(principalOf(res), params.id, body)));
      },
    }),

    // --- quotes ---
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/quotes",
      summary: "Sales quotes in your branches, newest first",
      tags,
      access: manageQuotes,
      request: {
        query: z.object({
          leadId: uuid.optional(),
          vehicleId: uuid.optional(),
          customerId: uuid.optional(),
          status: list(QUOTE_STATUSES),
          beforeId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Quotes" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        res.json(
          envelope(
            await quotes.list(principalOf(res), {
              ...rest,
              ...(status === undefined ? {} : { statuses: status }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/quotes",
      summary: "Draft a quote for a stock vehicle (at its asking price unless another is given)",
      tags,
      access: manageQuotes,
      request: { body: quoteBody },
      responses: { 201: { description: "Quote" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await quotes.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/quotes/:id",
      summary: "A quote with its totals (its PDF is the document it was sent as)",
      tags,
      access: manageQuotes,
      request: { params: idParams },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/dealer/quotes/:id",
      summary: "Edit a draft quote",
      tags,
      access: manageQuotes,
      request: { params: idParams, body: quoteBody },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await quotes.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/quotes/:id/approve",
      summary: "Approve a price below the minimum (dealer.stock.price.manage)",
      tags,
      access: manageQuotes,
      request: { params: idParams },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.approve(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/quotes/:id/send",
      summary: "Issue the quotation PDF and log it on the lead",
      tags,
      access: manageQuotes,
      request: { params: idParams },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.send(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/quotes/:id/decision",
      summary: "Record the customer's acceptance or rejection, or withdraw the quote",
      tags,
      access: manageQuotes,
      request: {
        params: idParams,
        body: z.object({
          outcome: z.enum(["accepted", "rejected", "withdrawn"]),
          note: text(500),
        }),
      },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await quotes.decide(principalOf(res), params.id, body)));
      },
    }),
  ];
}
