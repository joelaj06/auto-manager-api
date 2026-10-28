import { z } from "zod";
import type { FuelAnomalies } from "../../application/use-cases/incidents/FuelAnomalies.js";
import type { Incidents } from "../../application/use-cases/incidents/Incidents.js";
import type { TrafficOffences } from "../../application/use-cases/incidents/TrafficOffences.js";
import {
  CLAIM_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  OFFENCE_TYPES,
  SETTLEMENT_METHODS,
} from "../../domain/incidents/Incident.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const day = z.iso.date();
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "An amount like 120.00");
const reason = z.object({ reason: z.string().trim().min(3).max(1000) });
const flag = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();
const limit = z.coerce.number().int().min(1).max(200).default(50);

const incidentFields = {
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES).optional(),
  occurredAt: instant,
  location: text(300),
  description: z.string().trim().min(3).max(4000),
  injuries: z.boolean().optional(),
  policeReportNo: text(80),
  policeStation: text(120),
  thirdParties: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        phone: text(30),
        plateNumber: text(20),
        insurer: text(120),
        policyNo: text(80),
        notes: text(500),
      }),
    )
    .max(10)
    .optional(),
  driverId: uuid.nullable().optional(),
};

const offenceFields = {
  type: z.enum(OFFENCE_TYPES),
  offenceAt: instant,
  location: text(300),
  authority: z.string().trim().min(2).max(120),
  noticeRef: text(80),
  fine: amount,
  dueOn: day.nullable().optional(),
  driverId: uuid.nullable().optional(),
  driverPays: z.boolean().optional(),
  notes: text(2000),
};

export type IncidentRouteDependencies = Readonly<{
  incidents: Incidents;
  offences: TrafficOffences;
  anomalies: FuelAnomalies;
}>;

/**
 * Incidents and insurance claims, traffic offences and fuel anomalies (docs/06 §7–8).
 */
export function incidentRoutes(deps: IncidentRouteDependencies): ApiRoute[] {
  const { incidents, offences, anomalies } = deps;
  const view = access.permission("incidents.view");
  const manage = access.permission("incidents.manage");
  const post = <B extends z.ZodType>(
    path: string,
    summary: string,
    body: B,
    run: (actor: ReturnType<typeof principalOf>, id: string, body: z.infer<B>) => Promise<unknown>,
  ) =>
    defineRoute({
      method: "post",
      path,
      summary,
      tags: ["incidents"],
      access: manage,
      request: { params: idParams, body },
      responses: { 200: { description: "Updated" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await run(principalOf(res), params.id, input as z.infer<B>)));
      },
    });

  return [
    // --- incidents ---
    defineRoute({
      method: "get",
      path: "/api/v1/incidents",
      summary: "Incidents, newest first",
      tags: ["incidents"],
      access: view,
      request: {
        query: z.object({
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
          type: z.enum(INCIDENT_TYPES).optional(),
          status: z.enum(["open", "closed"]).optional(),
          before: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Incidents" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await incidents.list(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/incidents",
      summary:
        "Report an incident (the vehicle put in accident, stolen or impounded unless a module holds it)",
      tags: ["incidents"],
      access: manage,
      request: {
        body: z.object({
          vehicleId: uuid,
          ...incidentFields,
          issueId: uuid.nullable().optional(),
          damageId: uuid.nullable().optional(),
          moveVehicle: z.boolean().optional(),
        }),
      },
      responses: { 201: { description: "Incident" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await incidents.report(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/incidents/:id",
      summary: "An incident with its claims and what it cost (work orders, expenses, recoveries)",
      tags: ["incidents"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Incident" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await incidents.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/incidents/:id",
      summary: "Change an open incident",
      tags: ["incidents"],
      access: manage,
      request: { params: idParams, body: z.object(incidentFields).partial() },
      responses: { 200: { description: "Incident" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await incidents.change(principalOf(res), params.id, body)));
      },
    }),
    post(
      "/api/v1/incidents/:id/close",
      "Close with the outcome (a vehicle it moved goes back)",
      z.object({ outcome: z.string().trim().min(3).max(2000) }),
      (actor, id, body) => incidents.close(actor, id, body.outcome),
    ),
    post("/api/v1/incidents/:id/reopen", "Reopen a closed incident", z.object({}), (actor, id) =>
      incidents.reopen(actor, id),
    ),
    post(
      "/api/v1/incidents/:id/links",
      "Count a work order or an expense of the vehicle in the incident's cost",
      z
        .object({ workOrderId: uuid.optional(), expenseId: uuid.optional() })
        .refine((b) => b.workOrderId !== undefined || b.expenseId !== undefined, {
          message: "Name a work order or an expense",
        }),
      (actor, id, body) => incidents.link(actor, id, body),
    ),

    // --- insurance claims ---
    defineRoute({
      method: "get",
      path: "/api/v1/insurance-claims",
      summary: "Insurance claims, newest first",
      tags: ["incidents"],
      access: view,
      request: {
        query: z.object({
          status: z.enum(CLAIM_STATUSES).optional(),
          insurerId: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Claims" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await incidents.claims(principalOf(res), query)));
      },
    }),
    post(
      "/api/v1/incidents/:id/claims",
      "Claim on an insurer (a supplier) for the incident",
      z.object({
        insurerId: uuid,
        policyNo: text(80),
        claimNo: text(80),
        claimed: amount,
        excess: amount.optional(),
        submittedOn: day.optional(),
        notes: text(2000),
      }),
      (actor, id, body) => incidents.submitClaim(actor, id, body),
    ),
    post(
      "/api/v1/insurance-claims/:id/approve",
      "The insurer approved an amount",
      z.object({ approved: amount, claimNo: text(80) }),
      (actor, id, body) => incidents.decideClaim(actor, id, { action: "approve", ...body }),
    ),
    post(
      "/api/v1/insurance-claims/:id/reject",
      "The insurer rejected the claim",
      reason,
      (actor, id, body) =>
        incidents.decideClaim(actor, id, { action: "reject", reason: body.reason }),
    ),
    post("/api/v1/insurance-claims/:id/withdraw", "Withdraw the claim", reason, (actor, id, body) =>
      incidents.decideClaim(actor, id, { action: "withdraw", reason: body.reason }),
    ),
    post(
      "/api/v1/insurance-claims/:id/settle",
      "The insurer paid: the money received posted to insurance recoveries",
      z.object({
        amount,
        method: z.enum(SETTLEMENT_METHODS),
        receivedOn: day.optional(),
        reference: text(80),
      }),
      (actor, id, body) => incidents.decideClaim(actor, id, { action: "settle", ...body }),
    ),

    // --- traffic offences ---
    defineRoute({
      method: "get",
      path: "/api/v1/traffic-offences",
      summary: "Traffic offences, newest first (`outstanding=true`: unpaid or contested)",
      tags: ["incidents"],
      access: view,
      request: {
        query: z.object({
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
          status: z.enum(["unpaid", "contested", "paid", "waived"]).optional(),
          outstanding: flag,
          before: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Offences" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await offences.list(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/traffic-offences",
      summary: "Record a traffic offence (the driver who had the vehicle is told by SMS)",
      tags: ["incidents"],
      access: manage,
      request: { body: z.object({ vehicleId: uuid, ...offenceFields }) },
      responses: { 201: { description: "Offence" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await offences.record(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/traffic-offences/:id",
      summary: "A traffic offence",
      tags: ["incidents"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Offence" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await offences.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/traffic-offences/:id",
      summary: "Change an outstanding offence",
      tags: ["incidents"],
      access: manage,
      request: { params: idParams, body: z.object(offenceFields).partial() },
      responses: { 200: { description: "Offence" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await offences.change(principalOf(res), params.id, body)));
      },
    }),
    post(
      "/api/v1/traffic-offences/:id/pay",
      "Paid by the business (an expense, charged to the driver when they pay) or by the driver",
      z.object({
        by: z.enum(["business", "driver"]),
        paidOn: day.optional(),
        reference: text(80),
      }),
      (actor, id, body) => offences.pay(actor, id, body),
    ),
    post("/api/v1/traffic-offences/:id/contest", "Contest the fine", z.object({}), (actor, id) =>
      offences.contest(actor, id),
    ),
    post(
      "/api/v1/traffic-offences/:id/waive",
      "The fine was waived",
      z.object({ note: z.string().trim().min(3).max(1000) }),
      (actor, id, body) => offences.waive(actor, id, body.note),
    ),

    // --- fuel anomalies ---
    defineRoute({
      method: "get",
      path: "/api/v1/fuel-anomalies",
      summary: "Fuel fills that look wrong, newest first",
      tags: ["incidents"],
      access: view,
      request: {
        query: z.object({
          vehicleId: uuid.optional(),
          status: z.enum(["open", "confirmed", "dismissed"]).optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Anomalies" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await anomalies.list(principalOf(res), query)));
      },
    }),
    post(
      "/api/v1/fuel-anomalies/:id/review",
      "Confirmed or dismissed, with what was found",
      z.object({
        status: z.enum(["confirmed", "dismissed"]),
        note: z.string().trim().min(3).max(1000),
      }),
      (actor, id, body) => anomalies.review(actor, id, body),
    ),
  ];
}
