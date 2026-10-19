import { z } from "zod";
import type { AssignmentSettingsService } from "../../application/use-cases/assignments/AssignmentSettingsService.js";
import type { VehicleAssignments } from "../../application/use-cases/assignments/VehicleAssignments.js";
import {
  ASSIGNMENT_TYPES,
  FUEL_LEVELS,
  REMITTANCE_MODES,
  TARGET_FREQUENCIES,
} from "../../domain/assignments/VehicleAssignment.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/v1/vehicles/:id/assignment";
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const odometer = z.number().int().min(0).max(5_000_000);
const reason = z.string().trim().min(3).max(500);
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');

const terms = z.object({
  mode: z.enum(REMITTANCE_MODES).optional(),
  target: amount.nullable().optional(),
  frequency: z.enum(TARGET_FREQUENCIES).nullable().optional(),
  daysOff: z.array(z.number().int().min(0).max(6)).max(6).optional(),
});

const checklist = z.object({
  items: z
    .array(
      z.object({
        key: z.string().max(40),
        ok: z.boolean(),
        note: z.string().trim().max(300).nullable().optional(),
      }),
    )
    .max(30),
  fuelLevel: z.enum(FUEL_LEVELS).nullable().optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
  driverAcknowledged: z.boolean().optional(),
});

export type AssignmentRouteDependencies = Readonly<{
  assignments: VehicleAssignments;
  settings: AssignmentSettingsService;
}>;

/**
 * Vehicle ↔ driver assignments (docs/06 §6): the current driver of a vehicle, start, end and
 * hand over with the checklist and odometer, remittance terms, the assignment board and "who
 * was driving at …"; assignment settings.
 */
export function assignmentRoutes(deps: AssignmentRouteDependencies): ApiRoute[] {
  const { assignments, settings } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/settings/assignments",
      summary: "Handover checklist, default remittance mode and licence rule",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/assignments",
      summary: "Change the assignment settings",
      tags: ["settings"],
      access: access.permission("settings.update"),
      request: {
        body: z.object({
          handoverItems: z
            .array(z.object({ key: z.string().max(40), label: z.string().trim().min(1).max(80) }))
            .max(30)
            .optional(),
          defaultRemittanceMode: z.enum(REMITTANCE_MODES).optional(),
          requireValidLicence: z.boolean().optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/assignments",
      summary: "Assignments in your branches (current board with open=true), newest first",
      tags: ["assignments"],
      access: access.permission("vehicles.view"),
      request: {
        query: z.object({
          open: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => (v === undefined ? undefined : v === "true")),
          branchId: uuid.optional(),
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Assignments; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { open, ...rest } = query;
        const page = await assignments.list(principalOf(res), {
          ...rest,
          ...(open === undefined ? {} : { open }),
        });
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "get",
      path: BASE,
      summary: "The vehicle's current driver assignment (null when none)",
      tags: ["assignments"],
      access: access.permission("vehicles.view"),
      request: { params: idParams },
      responses: { 200: { description: "Assignment or null" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await assignments.currentFor(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicles/:id/assignment-at",
      summary: "Who had the vehicle at an instant (traffic fines, accidents)",
      tags: ["assignments"],
      access: access.permission("vehicles.view"),
      request: { params: idParams, query: z.object({ at: z.iso.datetime({ offset: true }) }) },
      responses: { 200: { description: "Assignment or null" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await assignments.at(principalOf(res), params.id, new Date(query.at))));
      },
    }),
    defineRoute({
      method: "post",
      path: BASE,
      summary: "Assign an active driver to an available vehicle (handover checklist, odometer)",
      tags: ["assignments"],
      access: access.permission("vehicles.assign_driver"),
      request: {
        params: idParams,
        body: z.object({
          driverId: uuid,
          type: z.enum(ASSIGNMENT_TYPES).optional(),
          terms: terms.optional(),
          startedAt: z.iso.datetime({ offset: true }).optional(),
          odometer,
          checklist,
          notes: z.string().trim().max(2_000).nullable().optional(),
        }),
      },
      responses: {
        201: { description: "Assignment and compliance warnings" },
        409: { description: "The vehicle or driver already has an assignment" },
      },
      handler: async ({ params, body }, _req, res) => {
        const { startedAt, ...input } = body;
        res.status(201).json(
          envelope(
            await assignments.start(principalOf(res), params.id, {
              ...input,
              ...(startedAt === undefined ? {} : { startedAt: new Date(startedAt) }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/end`,
      summary: "Take the vehicle back (checklist, odometer, reason)",
      tags: ["assignments"],
      access: access.permission("vehicles.assign_driver"),
      request: {
        params: idParams,
        body: z.object({
          odometer,
          checklist,
          reason,
          endedAt: z.iso.datetime({ offset: true }).optional(),
          vehicleStatus: z.enum(["available", "in_maintenance"]).optional(),
        }),
      },
      responses: { 200: { description: "The ended assignment" } },
      handler: async ({ params, body }, _req, res) => {
        const { endedAt, ...input } = body;
        res.json(
          envelope(
            await assignments.end(principalOf(res), params.id, {
              ...input,
              ...(endedAt === undefined ? {} : { endedAt: new Date(endedAt) }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/handover`,
      summary: "Hand the vehicle to another driver in one step",
      tags: ["assignments"],
      access: access.permission("vehicles.assign_driver"),
      request: {
        params: idParams,
        body: z.object({
          toDriverId: uuid,
          odometer,
          checklist,
          reason,
          type: z.enum(ASSIGNMENT_TYPES).optional(),
          terms: terms.optional(),
          notes: z.string().trim().max(2_000).nullable().optional(),
        }),
      },
      responses: { 200: { description: "The new assignment and compliance warnings" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await assignments.handover(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/terms`,
      summary: "Change the remittance terms of the current assignment",
      tags: ["assignments"],
      access: access.permission("vehicles.assign_driver"),
      request: { params: idParams, body: terms },
      responses: { 200: { description: "Assignment" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await assignments.changeTerms(principalOf(res), params.id, body)));
      },
    }),
  ];
}
