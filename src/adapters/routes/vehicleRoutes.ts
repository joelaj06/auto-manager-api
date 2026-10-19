import type { Response } from "express";
import { z } from "zod";
import type { OdometerLog } from "../../application/use-cases/vehicles/OdometerLog.js";
import type { VehicleDocuments } from "../../application/use-cases/vehicles/VehicleDocuments.js";
import type { VehicleGroupAdministration } from "../../application/use-cases/vehicles/VehicleGroupAdministration.js";
import type {
  CsvTable,
  VehicleImportExport,
} from "../../application/use-cases/vehicles/VehicleImportExport.js";
import type { VehicleOverview } from "../../application/use-cases/vehicles/VehicleOverview.js";
import type { VehiclePhotos } from "../../application/use-cases/vehicles/VehiclePhotos.js";
import type { VehicleRegistry } from "../../application/use-cases/vehicles/VehicleRegistry.js";
import type { VehicleSettingsService } from "../../application/use-cases/vehicles/VehicleSettingsService.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import {
  BODY_TYPES,
  DEPRECIATION_METHODS,
  DRIVES,
  FUEL_TYPES,
  OWNERSHIP_TYPES,
  TRANSMISSIONS,
  USAGES,
} from "../../domain/vehicles/Vehicle.js";
import { VEHICLE_DOCUMENT_TYPES } from "../../domain/vehicles/VehicleCompliance.js";
import {
  INITIAL_STATUSES,
  MODULE_STATUSES,
  manualNextStatuses,
  nextStatuses,
  VEHICLE_STATUSES,
} from "../../domain/vehicles/VehicleStatus.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { CsvFormatError, parseCsv, toCsv } from "../presenters/csv.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { RequestValidationError } from "../validators/RequestValidationError.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/v1/vehicles";
const uuid = z.uuid();
const date = z.iso.date();
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "85000.00"');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
const status = z.enum(VEHICLE_STATUSES);
const reason = z.string().trim().min(3).max(500);
const idParams = z.object({ id: uuid });
const documentParams = z.object({ id: uuid, documentId: uuid });
const documentFileParams = z.object({ id: uuid, documentId: uuid, fileId: uuid });
const photoParams = z.object({ id: uuid, fileId: uuid });
const upload = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(FILE_KINDS.vehicle_photo.maxBytes),
});
const UPLOAD_HELP =
  "Send the bytes with `upload.method` to `upload.url` with exactly `upload.headers`, then " +
  "call complete. The URL expires at `upload.expiresAt`.";

const financials = z.object({
  acquisitionDate: date.nullable().optional(),
  acquisitionCost: amount.nullable().optional(),
  residualValue: amount.nullable().optional(),
  depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
  usefulLifeMonths: int(1, 600),
});

const vehicleFields = {
  plateNumber: text(30),
  vin: text(30),
  engineNumber: text(40),
  chassisNumber: text(40),
  makeId: uuid.nullable().optional(),
  make: z.string().trim().min(1).max(80).optional(),
  modelId: uuid.nullable().optional(),
  model: z.string().trim().min(1).max(80).optional(),
  trim: text(80),
  year: int(1950, 2100),
  colour: text(40),
  bodyType: z.enum(BODY_TYPES).nullable().optional(),
  fuelType: z.enum(FUEL_TYPES).nullable().optional(),
  transmission: z.enum(TRANSMISSIONS).nullable().optional(),
  engineCc: int(1, 20_000),
  seats: int(1, 100),
  doors: int(0, 10),
  drive: z.enum(DRIVES).nullable().optional(),
  mileageUnit: z.enum(["km", "mi"]).optional(),
  usage: z.enum(USAGES).optional(),
  ownershipType: z.enum(OWNERSHIP_TYPES).optional(),
  ownershipNote: text(500),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  specs: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.string().max(100), z.number()]))
    .optional(),
  customFields: z
    .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .optional(),
  notes: text(4_000),
  groupIds: z.array(uuid).max(20).optional(),
  financials: financials.optional(),
};

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
    .pipe(z.array(status).optional()),
  branchId: uuid.optional(),
  usage: z.enum(USAGES).optional(),
  groupId: uuid.optional(),
  makeId: uuid.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  search: z.string().trim().min(1).max(60).optional(),
  includeOffFleet: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

const documentFields = {
  title: text(120),
  number: text(60),
  provider: text(120),
  issuedOn: date.nullable().optional(),
  expiresOn: date.nullable().optional(),
  cost: amount.nullable().optional(),
  reminderDays: z.array(z.number().int().min(0).max(365)).max(5).optional(),
  notes: text(2_000),
};

const customField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().trim().min(1).max(60),
  type: z.enum(["text", "number", "date", "boolean", "select"]),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

export type VehicleRouteDependencies = Readonly<{
  registry: VehicleRegistry;
  documents: VehicleDocuments;
  odometer: OdometerLog;
  photos: VehiclePhotos;
  groups: VehicleGroupAdministration;
  importExport: VehicleImportExport;
  overview: VehicleOverview;
  settings: VehicleSettingsService;
}>;

function sendCsv(res: Response, name: string, table: CsvTable): void {
  const stamp = new Date().toISOString().slice(0, 10);
  res
    .status(200)
    .set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${stamp}.csv"`,
      "Cache-Control": "no-store",
      "X-Export-Truncated": String(table.truncated),
    })
    .send(toCsv(table.columns, table.rows));
}

function csvRows(csv: string): Record<string, string>[] {
  try {
    return parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvFormatError)
      throw new RequestValidationError([{ field: "body.csv", message: error.message }]);
    throw error;
  }
}

/**
 * Vehicles (docs/06): the register with branch scope, lifecycle status and history, documents and
 * compliance, odometer, photos, groups, CSV import/export, the 360° overview and vehicle
 * settings. Static paths come before `/:id` so they are not taken for an id.
 */
export function vehicleRoutes(deps: VehicleRouteDependencies): ApiRoute[] {
  const { registry, documents, odometer, photos, groups, importExport, overview, settings } = deps;
  return [
    // --- lifecycle catalogue and settings ---
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-statuses",
      summary: "Vehicle statuses with their transitions (which ones users may set by hand)",
      tags: ["vehicles"],
      access: access.signedIn(),
      responses: { 200: { description: "Statuses" } },
      handler: (_input, _req, res) => {
        res.json(
          envelope(
            VEHICLE_STATUSES.map((s) => ({
              status: s,
              ownedByModule: MODULE_STATUSES.has(s),
              initial: INITIAL_STATUSES.includes(s),
              next: nextStatuses(s),
              manualNext: manualNextStatuses(s),
            })),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/settings/vehicles",
      summary: "Vehicle settings: required documents, reminders, custom fields",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Vehicle settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/vehicles",
      summary: "Change vehicle settings",
      tags: ["settings"],
      access: access.permission("settings.vehicles.manage"),
      request: {
        body: z.object({
          compliance: z
            .object({
              requiredDocuments: z.array(z.enum(VEHICLE_DOCUMENT_TYPES)).max(7).optional(),
              expiringWithinDays: z.number().int().min(1).max(180).optional(),
              enforcement: z.enum(["warn", "block"]).optional(),
            })
            .optional(),
          reminderDays: z
            .partialRecord(
              z.enum(VEHICLE_DOCUMENT_TYPES),
              z.array(z.number().int().min(0).max(365)).max(5),
            )
            .optional(),
          customFields: z.array(customField).max(30).optional(),
        }),
      },
      responses: { 200: { description: "Vehicle settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),

    // --- groups ---
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-groups",
      summary: "Vehicle groups with their vehicle counts",
      tags: ["vehicles"],
      access: access.permission("vehicles.list"),
      responses: { 200: { description: "Groups" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await groups.list()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-groups",
      summary: "Create a vehicle group",
      tags: ["vehicles"],
      access: access.permission("vehicles.groups.manage"),
      request: {
        body: z.object({ name: z.string().trim().min(1).max(80), description: text(500) }),
      },
      responses: { 201: { description: "Group" }, 409: { description: "Name taken" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await groups.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/vehicle-groups/:id",
      summary: "Rename a vehicle group",
      tags: ["vehicles"],
      access: access.permission("vehicles.groups.manage"),
      request: {
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(80).optional(),
          description: text(500),
        }),
      },
      responses: { 200: { description: "Group" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await groups.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/vehicle-groups/:id",
      summary: "Delete a vehicle group (its vehicles stay)",
      tags: ["vehicles"],
      access: access.permission("vehicles.groups.manage"),
      request: { params: idParams },
      responses: { 204: { description: "Deleted" } },
      handler: async ({ params }, _req, res) => {
        await groups.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-groups/:id/members",
      summary: "Add vehicles to and remove vehicles from a group",
      tags: ["vehicles"],
      access: access.permission("vehicles.groups.manage"),
      request: {
        params: idParams,
        body: z.object({
          add: z.array(uuid).max(200).optional(),
          remove: z.array(uuid).max(200).optional(),
        }),
      },
      responses: { 200: { description: "Group" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await groups.changeMembers(principalOf(res), params.id, body)));
      },
    }),

    // --- register (static paths first) ---
    defineRoute({
      method: "get",
      path: BASE,
      summary: "Vehicles in your branches (in the fleet unless includeOffFleet)",
      tags: ["vehicles"],
      access: access.permission("vehicles.list"),
      request: {
        query: listQuery.extend({
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Vehicles; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { status: statuses, ...rest } = query;
        const page = await registry.list(principalOf(res), {
          ...rest,
          ...(statuses === undefined ? {} : { statuses }),
        });
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: BASE,
      summary: "Register a vehicle",
      tags: ["vehicles"],
      access: access.permission("vehicles.create"),
      request: {
        body: z.object({
          ...vehicleFields,
          make: z.string().trim().min(1).max(80).optional(),
          model: z.string().trim().min(1).max(80).optional(),
          branchId: uuid.optional(),
          status: z.enum(INITIAL_STATUSES as [string, ...string[]]).optional(),
          odometer: z.number().int().min(0).max(5_000_000).nullable().optional(),
        }),
      },
      responses: { 201: { description: "Vehicle" }, 409: { description: "Plate or VIN taken" } },
      handler: async ({ body }, _req, res) => {
        const { status: initial, ...input } = body;
        const vehicle = await registry.create(principalOf(res), {
          ...input,
          ...(initial === undefined
            ? {}
            : { status: initial as (typeof INITIAL_STATUSES)[number] }),
        });
        res.status(201).json(envelope(vehicle));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/export`,
      summary: "Export the register as CSV (financial columns only with financials access)",
      tags: ["vehicles"],
      access: access.permission("vehicles.export"),
      request: { query: listQuery },
      responses: { 200: { description: "text/csv" } },
      handler: async ({ query }, _req, res) => {
        const { status: statuses, ...rest } = query;
        sendCsv(
          res,
          "vehicles",
          await importExport.export(principalOf(res), {
            ...rest,
            ...(statuses === undefined ? {} : { statuses }),
          }),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/import/template`,
      summary: "CSV template for the vehicle import (with your custom-field columns)",
      tags: ["vehicles"],
      access: access.permission("vehicles.import"),
      responses: { 200: { description: "text/csv" } },
      handler: async (_input, _req, res) => {
        sendCsv(res, "vehicle-import-template", await importExport.template(principalOf(res)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/import`,
      summary: "Check (and with commit: create) vehicles from CSV — all rows or none",
      tags: ["vehicles"],
      access: access.permission("vehicles.import"),
      request: {
        body: z.object({
          csv: z.string().min(1).max(1_000_000),
          commit: z.boolean().default(false),
        }),
      },
      responses: { 200: { description: "Per-row results; `committed` when created" } },
      handler: async ({ body }, _req, res) => {
        res.json(
          envelope(await importExport.import(principalOf(res), csvRows(body.csv), body.commit)),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/transfer`,
      summary: "Move vehicles to another branch (all or none)",
      tags: ["vehicles"],
      access: access.permission("vehicles.update"),
      request: {
        body: z.object({
          vehicleIds: z.array(uuid).min(1).max(100),
          branchId: uuid,
          reason,
        }),
      },
      responses: { 200: { description: "The moved vehicles" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await registry.transfer(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/compliance`,
      summary: "Compliance board: vehicles that cannot legally operate today first",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.view"),
      request: {
        query: z.object({
          level: z.enum(["red", "amber", "green"]).optional(),
          branchId: uuid.optional(),
        }),
      },
      responses: { 200: { description: "Summary and vehicles" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await documents.board(principalOf(res), query)));
      },
    }),

    // --- one vehicle ---
    defineRoute({
      method: "get",
      path: `${BASE}/:id`,
      summary: "A vehicle",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: { params: idParams },
      responses: { 200: { description: "Vehicle" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await registry.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/:id`,
      summary: "Edit a vehicle (status, branch and odometer have their own endpoints)",
      tags: ["vehicles"],
      access: access.permission("vehicles.update"),
      request: { params: idParams, body: z.object(vehicleFields) },
      responses: { 200: { description: "Vehicle" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await registry.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/:id`,
      summary: "Remove a mistaken entry (kept with the reason, hidden everywhere)",
      tags: ["vehicles"],
      access: access.permission("vehicles.delete"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params, body }, _req, res) => {
        await registry.remove(principalOf(res), params.id, body.reason);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/:id/overview`,
      summary: "Vehicle 360°: header, compliance, distance and the latest timeline",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: { params: idParams },
      responses: { 200: { description: "Overview" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await overview.overview(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/:id/timeline`,
      summary: "The vehicle's timeline (status changes, documents, odometer), newest first",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: {
        params: idParams,
        query: z.object({
          before: z.iso.datetime().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Entries; `meta.nextBefore` for the next page" } },
      handler: async ({ params, query }, _req, res) => {
        const page = await overview.timeline(principalOf(res), params.id, {
          limit: query.limit,
          ...(query.before === undefined ? {} : { before: new Date(query.before) }),
        });
        res.json(envelope(page.items, { nextBefore: page.nextBefore }));
      },
    }),

    // --- status ---
    defineRoute({
      method: "get",
      path: `${BASE}/:id/status-options`,
      summary: "Statuses you may move this vehicle to by hand",
      tags: ["vehicles"],
      access: access.permission("vehicles.change_status"),
      request: { params: idParams },
      responses: { 200: { description: "Statuses" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await registry.statusOptions(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/status`,
      summary: "Change the status by hand (not into or out of a module's state)",
      tags: ["vehicles"],
      access: access.permission("vehicles.change_status"),
      request: { params: idParams, body: z.object({ status, reason }) },
      responses: { 200: { description: "Vehicle" }, 422: { description: "Not allowed" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await registry.changeStatus(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/:id/status-history`,
      summary: "Every status change with its reason and cause",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: {
        params: idParams,
        query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
      },
      responses: { 200: { description: "History, newest first" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await registry.statusHistory(principalOf(res), params.id, query.limit)));
      },
    }),

    // --- odometer ---
    defineRoute({
      method: "get",
      path: `${BASE}/:id/odometer`,
      summary: "Odometer readings, newest first",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: {
        params: idParams,
        query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
      responses: { 200: { description: "Readings" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await odometer.list(principalOf(res), params.id, query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/odometer`,
      summary: "Record a reading (never lower than before, unless the odometer was replaced)",
      tags: ["vehicles"],
      access: access.permission("vehicles.odometer.record"),
      request: {
        params: idParams,
        body: z.object({
          value: z.number().int().min(0).max(5_000_000),
          readAt: z.iso.datetime().optional(),
          replacement: z.boolean().optional(),
          note: text(500),
        }),
      },
      responses: { 201: { description: "Reading" }, 422: { description: "Out of order" } },
      handler: async ({ params, body }, _req, res) => {
        const { readAt, ...rest } = body;
        const reading = await odometer.record(principalOf(res), params.id, {
          ...rest,
          ...(readAt === undefined ? {} : { readAt: new Date(readAt) }),
        });
        res.status(201).json(envelope(reading));
      },
    }),

    // --- documents ---
    defineRoute({
      method: "get",
      path: `${BASE}/:id/documents`,
      summary: "Documents with their scans, and the vehicle's compliance",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.view"),
      request: { params: idParams },
      responses: { 200: { description: "Compliance and documents" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await documents.list(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/documents`,
      summary: "Add a document (a renewal is a new document of the same type)",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.manage"),
      request: {
        params: idParams,
        body: z.object({ type: z.enum(VEHICLE_DOCUMENT_TYPES), ...documentFields }),
      },
      responses: { 201: { description: "Document" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await documents.add(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/:id/documents/:documentId`,
      summary: "Correct a document",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.manage"),
      request: { params: documentParams, body: z.object(documentFields) },
      responses: { 200: { description: "Document" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await documents.update(principalOf(res), params.id, params.documentId, body)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/:id/documents/:documentId`,
      summary: "Remove a document entered by mistake (with its scans)",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.manage"),
      request: { params: documentParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await documents.remove(principalOf(res), params.id, params.documentId);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/documents/:documentId/files`,
      summary: "Attach a scan or photo to a document",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.manage"),
      request: { params: documentParams, body: upload },
      responses: { 201: { description: UPLOAD_HELP } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(
            envelope(
              await documents.startFileUpload(principalOf(res), params.id, params.documentId, body),
            ),
          );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/documents/:documentId/files/:fileId/complete`,
      summary: "Confirm a document scan upload",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.manage"),
      request: { params: documentFileParams },
      responses: { 200: { description: "File" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(
            await documents.completeFileUpload(
              principalOf(res),
              params.id,
              params.documentId,
              params.fileId,
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/:id/documents/:documentId/files/:fileId`,
      summary: "Remove a scan from a document",
      tags: ["vehicles"],
      access: access.permission("vehicles.documents.manage"),
      request: { params: documentFileParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await documents.removeFile(principalOf(res), params.id, params.documentId, params.fileId);
        res.status(204).end();
      },
    }),

    // --- photos ---
    defineRoute({
      method: "get",
      path: `${BASE}/:id/photos`,
      summary: "Photos with short-lived links (one is primary)",
      tags: ["vehicles"],
      access: access.permission("vehicles.view"),
      request: { params: idParams },
      responses: { 200: { description: "Photos" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await photos.list(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/photos`,
      summary: "Start a photo upload",
      tags: ["vehicles"],
      access: access.permission("vehicles.photos.manage"),
      request: { params: idParams, body: upload },
      responses: { 201: { description: UPLOAD_HELP } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await photos.start(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/photos/:fileId/complete`,
      summary: "Confirm a photo upload (the first photo becomes primary)",
      tags: ["vehicles"],
      access: access.permission("vehicles.photos.manage"),
      request: { params: photoParams },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await photos.complete(principalOf(res), params.id, params.fileId)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/:id/primary-photo`,
      summary: "Choose the primary photo",
      tags: ["vehicles"],
      access: access.permission("vehicles.photos.manage"),
      request: { params: idParams, body: z.object({ fileId: uuid }) },
      responses: { 204: { description: "Set" } },
      handler: async ({ params, body }, _req, res) => {
        await photos.setPrimary(principalOf(res), params.id, body.fileId);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/:id/photos/:fileId`,
      summary: "Remove a photo",
      tags: ["vehicles"],
      access: access.permission("vehicles.photos.manage"),
      request: { params: photoParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await photos.remove(principalOf(res), params.id, params.fileId);
        res.status(204).end();
      },
    }),
  ];
}
