import { z } from "zod";
import {
  TELEMATICS_EVENT_KINDS,
  TELEMATICS_PROVIDERS,
} from "../../application/ports/ITelematics.js";
import type { TelematicsIngestion } from "../../application/use-cases/telematics/TelematicsIngestion.js";
import type { TelematicsSetup } from "../../application/use-cases/telematics/TelematicsSetup.js";
import type { TelematicsViews } from "../../application/use-cases/telematics/TelematicsViews.js";
import { GEOFENCE_ALERTS, MAX_POLYGON_POINTS } from "../../domain/telematics/Geo.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { parsePositions } from "../telematics/providerPayloads.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/v1/telematics";
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const day = z.iso.date();
const limit = z.coerce.number().int().min(1).max(500).default(100);
const flag = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();
const point = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const geofence = z.object({
  name: z.string().trim().min(2).max(80),
  shape: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("circle"), center: point, radiusM: z.number().int() }),
    z.object({
      kind: z.literal("polygon"),
      points: z
        .array(point)
        .min(3)
        .max(MAX_POLYGON_POINTS + 1),
    }),
  ]),
  branchId: uuid.nullable().default(null),
  alertOn: z.enum(GEOFENCE_ALERTS).default("exit"),
  active: z.boolean().default(true),
});

export type TelematicsRouteDependencies = Readonly<{
  ingestion: TelematicsIngestion;
  setup: TelematicsSetup;
  views: TelematicsViews;
}>;

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Telematics and GPS (docs/06 §9, decisions 504–509): the providers' ingestion address, setup of
 * connections, trackers, thresholds and geofences, and the live map, tracks, trips, events and
 * utilisation from ignition.
 */
export function telematicsRoutes(deps: TelematicsRouteDependencies): ApiRoute[] {
  const { ingestion, setup, views } = deps;
  return [
    // --- the provider ---
    defineRoute({
      method: "post",
      path: "/api/v1/webhooks/telematics/:tenant/:connectionId",
      summary:
        "A telematics provider pushes positions (Authorization: Bearer <the connection's token>)",
      tags: ["telematics"],
      access: access.public(),
      request: {
        params: z.object({ tenant: z.string().min(1).max(63), connectionId: z.string().max(64) }),
        body: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]),
      },
      responses: {
        200: { description: "Accepted, duplicates and rejected positions" },
        401: { description: "Wrong address or token" },
      },
      handler: async ({ params, body }, req, res) => {
        const header = req.header("authorization") ?? req.header("x-telematics-token") ?? "";
        const token = BEARER.exec(header)?.[1] ?? (header.trim() === "" ? null : header.trim());
        const result = await ingestion.receive(
          params.tenant,
          params.connectionId,
          token,
          (provider) => parsePositions(provider, body),
        );
        res.json(envelope(result));
      },
    }),

    // --- the business: live map, tracks, trips, events, utilisation ---
    defineRoute({
      method: "get",
      path: `${BASE}/live`,
      summary: "Every tracked vehicle's last position: moving, idling, parked or offline",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      responses: { 200: { description: "Vehicles" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await views.live(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicles/:id/track",
      summary: "A vehicle's positions over up to 7 days (thinned to 5,000 points)",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: { params: idParams, query: z.object({ from: instant, to: instant }) },
      responses: { 200: { description: "Positions" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await views.track(principalOf(res), params.id, query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/trips`,
      summary: "Trips, newest first (ignition on to off)",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: {
        query: z.object({
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
          from: instant,
          to: instant,
          limit,
        }),
      },
      responses: { 200: { description: "Trips" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await views.trips(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/events`,
      summary: "Geofence and over-speed events (open=true: not acknowledged)",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: {
        query: z.object({
          kind: z.enum(TELEMATICS_EVENT_KINDS).optional(),
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
          open: flag,
          from: instant.optional(),
          to: instant.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Events" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await views.events(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/events/:id/acknowledge`,
      summary: "Acknowledge an event (with a note of what was done)",
      tags: ["telematics"],
      access: access.permission("telematics.events.manage"),
      request: {
        params: idParams,
        body: z.object({ note: z.string().trim().max(500).nullish() }),
      },
      responses: { 200: { description: "Event" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await views.acknowledge(principalOf(res), params.id, body.note ?? null)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/utilisation`,
      summary:
        "Engine, moving and idle hours, distance, trips and utilisation per vehicle (default: the last 30 days)",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: {
        query: z.object({
          from: day.optional(),
          to: day.optional(),
          branchId: uuid.optional(),
          vehicleId: uuid.optional(),
        }),
      },
      responses: { 200: { description: "Utilisation" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await views.utilisation(principalOf(res), query)));
      },
    }),

    // --- trackers ---
    defineRoute({
      method: "get",
      path: `${BASE}/devices`,
      summary: "Trackers (unlinked=true: seen but not on a vehicle yet)",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: {
        query: z.object({
          connectionId: uuid.optional(),
          vehicleId: uuid.optional(),
          unlinked: flag,
          status: z.enum(["active", "retired"]).optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Trackers" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await setup.devices(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/devices/:id`,
      summary: "A tracker with its last position",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: { params: idParams },
      responses: { 200: { description: "Tracker" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await setup.device(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/devices`,
      summary: "Add a tracker before it first reports, on a vehicle or not",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: {
        body: z.object({
          connectionId: uuid,
          identifier: z.string().trim().min(1).max(64),
          label: z.string().trim().max(80).nullable().default(null),
          vehicleId: uuid.nullable().default(null),
        }),
      },
      responses: { 201: { description: "Tracker" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await setup.addDevice(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/devices/:id`,
      summary:
        "Link a tracker to a vehicle (or unlink it), label it, set its odometer or retire it",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: {
        params: idParams,
        body: z.object({
          label: z.string().trim().max(80).nullable().optional(),
          vehicleId: uuid.nullable().optional(),
          status: z.enum(["active", "retired"]).optional(),
          syncOdometer: z.boolean().optional(),
          odometerOffsetKm: z.number().optional(),
        }),
      },
      responses: { 200: { description: "Tracker" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await setup.updateDevice(principalOf(res), params.id, body)));
      },
    }),

    // --- connections ---
    defineRoute({
      method: "get",
      path: `${BASE}/connections`,
      summary: "Telematics provider connections",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      responses: { 200: { description: "Connections" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await setup.connections()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/connections/:id`,
      summary: "A connection with its ingestion address",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Connection" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await setup.connection(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/connections`,
      summary: "Connect a provider: the address and the token to give it (shown once)",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: {
        body: z.object({
          name: z.string().trim().min(2).max(80),
          provider: z.enum(TELEMATICS_PROVIDERS),
        }),
      },
      responses: { 201: { description: "Connection with its token" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await setup.createConnection(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/connections/:id`,
      summary: "Rename a connection, or disable it (its positions are refused) and enable it again",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: {
        params: idParams,
        body: z.object({
          name: z.string().trim().min(2).max(80).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        }),
      },
      responses: { 200: { description: "Connection" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await setup.updateConnection(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/connections/:id/rotate-token`,
      summary: "A new token for the connection; the old one stops working at once",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Connection with its new token" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await setup.rotateToken(principalOf(res), params.id)));
      },
    }),

    // --- settings and geofences ---
    defineRoute({
      method: "get",
      path: `${BASE}/settings`,
      summary: "Speed limit, retention of positions, working day and silence alert",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await setup.settings()));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/settings`,
      summary: "Set the speed limit, retention of positions, working day and silence alert",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: {
        body: z.object({
          positionRetentionDays: z.number().int().min(30).max(730),
          overspeedKmh: z.number().int().min(30).max(250),
          overspeedMinSeconds: z.number().int().min(0).max(600),
          workingHoursPerDay: z.number().min(1).max(24).multipleOf(0.5),
          silentAfterHours: z.number().int().min(1).max(720),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await setup.updateSettings(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/geofences`,
      summary: "Geofences",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      responses: { 200: { description: "Geofences" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await setup.geofences()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/geofences/:id`,
      summary: "A geofence",
      tags: ["telematics"],
      access: access.permission("telematics.view"),
      request: { params: idParams },
      responses: { 200: { description: "Geofence" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await setup.geofence(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/geofences`,
      summary: "Draw a geofence: a circle or a polygon, alerting on entry, exit or both",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: { body: geofence },
      responses: { 201: { description: "Geofence" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await setup.saveGeofence(principalOf(res), null, body)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/geofences/:id`,
      summary: "Change or switch off a geofence",
      tags: ["telematics"],
      access: access.permission("telematics.manage"),
      request: { params: idParams, body: geofence },
      responses: { 200: { description: "Geofence" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await setup.saveGeofence(principalOf(res), params.id, body)));
      },
    }),
  ];
}
