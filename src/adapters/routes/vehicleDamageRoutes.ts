import { z } from "zod";
import type { VehicleDamages } from "../../application/use-cases/rentals/VehicleDamages.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import {
  DAMAGE_AREAS,
  DAMAGE_LIABILITIES,
  DAMAGE_SEVERITIES,
  DAMAGE_STATUSES,
} from "../../domain/rentals/VehicleDamage.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Send amounts as text, e.g. "250.00"');
const ref = z.string().trim().max(60).nullable().optional();
const notes = z.string().trim().max(2000).nullable().optional();

export type VehicleDamageRouteDependencies = Readonly<{ damages: VehicleDamages }>;

/** The damage register (docs/07 §6): the damage map of each vehicle, settling, repairs. */
export function vehicleDamageRoutes(deps: VehicleDamageRouteDependencies): ApiRoute[] {
  const { damages } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-damages",
      summary:
        "Damages of the caller's branches (a vehicle's damage map with vehicleId), newest first",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: {
        query: z.object({
          vehicleId: uuid.optional(),
          bookingId: uuid.optional(),
          status: z.enum(DAMAGE_STATUSES).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
      responses: { 200: { description: "Damages" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await damages.list(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-damages",
      summary: "Record a damage noticed outside a rental",
      tags: ["vehicles"],
      access: access.permission("vehicles.damages.manage"),
      request: {
        body: z.object({
          vehicleId: uuid,
          area: z.enum(DAMAGE_AREAS),
          severity: z.enum(DAMAGE_SEVERITIES),
          description: z.string().trim().min(3).max(1000),
          estimate: amount.nullable().optional(),
          notes,
        }),
      },
      responses: { 201: { description: "Damage" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await damages.record(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-damages/:id",
      summary: "A damage with its photos",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: { params: idParams },
      responses: { 200: { description: "Damage" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await damages.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/vehicle-damages/:id",
      summary:
        "Settle a damage: estimate, final cost, who pays (the renter's booking charges follow), work order and claim",
      tags: ["vehicles"],
      access: access.permission("vehicles.damages.manage"),
      request: {
        params: idParams,
        body: z.object({
          severity: z.enum(DAMAGE_SEVERITIES).optional(),
          description: z.string().trim().min(3).max(1000).optional(),
          liability: z.enum(DAMAGE_LIABILITIES).optional(),
          estimate: amount.nullable().optional(),
          finalCost: amount.nullable().optional(),
          workOrderRef: ref,
          claimRef: ref,
          notes,
        }),
      },
      responses: { 200: { description: "Damage" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await damages.settle(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-damages/:id/repaired",
      summary: "Mark a damage repaired (off the damage map), with its final cost",
      tags: ["vehicles"],
      access: access.permission("vehicles.damages.manage"),
      request: {
        params: idParams,
        body: z.object({ finalCost: amount.nullable().optional(), workOrderRef: ref }),
      },
      responses: { 200: { description: "Damage" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await damages.repaired(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-damages/:id/photos",
      summary: "Add a photo to a damage (then confirm it)",
      tags: ["vehicles"],
      access: access.permission("vehicles.damages.manage"),
      request: {
        params: idParams,
        body: z.object({
          filename: z.string().trim().min(1).max(200),
          contentType: z.string().max(100),
          sizeBytes: z.number().int().min(1).max(FILE_KINDS.rental_photo.maxBytes),
        }),
      },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await damages.startPhoto(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-damages/:id/photos/:fileId/complete",
      summary: "Confirm a damage photo upload",
      tags: ["vehicles"],
      access: access.permission("vehicles.damages.manage"),
      request: { params: z.object({ id: uuid, fileId: uuid }) },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await damages.completePhoto(principalOf(res), params.id, params.fileId)));
      },
    }),
  ];
}
