import { z } from "zod";
import type {
  DataProtectionRequests,
  RestoreDrills,
  StatusPage,
} from "../../application/use-cases/console/ComplianceOperations.js";
import type { LegalDocuments } from "../../application/use-cases/console/LegalDocuments.js";
import type { TenantDataExports } from "../../application/use-cases/console/TenantDataExports.js";
import { principalOf, staffOf, tenantOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const reason = z.string().trim().min(5).max(1_000);
const limit = z.coerce.number().int().min(1).max(200).default(50);
const legalKind = z.enum(["terms", "privacy", "dpa"]);
const incidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]);
const impact = z.enum(["minor", "major", "critical"]);

export type LegalOperationsRouteDependencies = Readonly<{
  legal: LegalDocuments;
  exports: TenantDataExports;
  requests: DataProtectionRequests;
  status: StatusPage;
  drills: RestoreDrills;
}>;

/**
 * Legal and operations (docs/26 §6–§7, docs/27 §3.1, §3.15): terms and privacy versions with
 * acceptances, the tenant's full data export, data-protection requests, the public status page
 * with incidents, and restore drills.
 */
export function legalOperationsRoutes(deps: LegalOperationsRouteDependencies): ApiRoute[] {
  const { legal, exports, requests, status, drills } = deps;
  return [
    // --- public ---
    defineRoute({
      method: "get",
      path: "/api/v1/public/legal/:kind",
      summary: "The terms of service, privacy policy or DPA in force",
      tags: ["public"],
      access: access.public(),
      request: { params: z.object({ kind: legalKind }) },
      responses: { 200: { description: "Document" }, 404: { description: "None published" } },
      handler: async ({ params }, _req, res) => {
        const d = await legal.current(params.kind);
        res.set("Cache-Control", "public, max-age=300").json(
          envelope({
            id: d.id,
            kind: d.kind,
            version: d.version,
            title: d.title,
            body: d.body,
            summary: d.summary,
            effectiveAt: d.effectiveAt,
          }),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/public/status",
      summary: "Service status: incidents, components and scheduled maintenance",
      tags: ["public"],
      access: access.public(),
      responses: { 200: { description: "Status" } },
      handler: async (_input, _req, res) => {
        res.set("Cache-Control", "public, max-age=30").json(envelope(await status.publicStatus()));
      },
    }),

    // --- the tenant ---
    defineRoute({
      method: "get",
      path: "/api/v1/legal",
      summary: "The terms and privacy policy in force and whether your business accepted them",
      tags: ["legal"],
      access: access.signedIn(),
      responses: { 200: { description: "Status" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await legal.tenantStatus(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/legal/accept",
      summary: "Accept the versions in force for your business",
      tags: ["legal"],
      access: { kind: "authenticated", permission: "legal.accept", allowWhenReadOnly: true },
      request: { body: z.object({ documentIds: z.array(uuid).min(1).max(3) }) },
      responses: { 200: { description: "Status" } },
      handler: async ({ body }, req, res) => {
        res.json(
          envelope(
            await legal.accept(tenantOf(res).id, principalOf(res).userId, body.documentIds, {
              ip: req.ip ?? null,
              userAgent: req.get("user-agent") ?? null,
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/data-exports",
      summary: "Export all your business's data (we email you when it is ready)",
      tags: ["data"],
      access: access.permission("data.export"),
      responses: { 202: { description: "Being prepared" } },
      handler: async (_input, _req, res) => {
        res
          .status(202)
          .json(envelope(await exports.request(tenantOf(res).id, principalOf(res).userId)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/data-exports",
      summary: "Your data exports (newest first)",
      tags: ["data"],
      access: access.permission("data.export"),
      responses: { 200: { description: "Exports" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await exports.list(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/data-exports/:id/download",
      summary: "A five-minute link to download an export",
      tags: ["data"],
      access: access.permission("data.export"),
      request: { params: idParams },
      responses: { 200: { description: "Link" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await exports.download(tenantOf(res).id, params.id, principalOf(res).userId)),
        );
      },
    }),

    // --- console: legal ---
    defineRoute({
      method: "get",
      path: `${BASE}/legal-documents`,
      summary: "Terms, privacy and DPA versions",
      tags: ["console: legal"],
      access: access.platform("platform.legal.view"),
      request: { query: z.object({ kind: legalKind.optional() }) },
      responses: { 200: { description: "Documents" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await legal.list(query.kind)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/legal-documents`,
      summary: "Draft a new version",
      tags: ["console: legal"],
      access: access.platform("platform.legal.manage"),
      request: {
        body: z.object({
          kind: legalKind,
          version: z
            .string()
            .trim()
            .regex(/^[0-9A-Za-z.-]{1,20}$/),
          title: z.string().trim().min(3).max(160),
          body: z.string().min(20).max(200_000),
          summary: z.string().trim().max(2_000).nullish(),
          requiresAcceptance: z.boolean().default(true),
        }),
      },
      responses: { 201: { description: "Draft" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await legal.draft(body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/legal-documents/:id`,
      summary: "A version, with which tenants accepted it",
      tags: ["console: legal"],
      access: access.platform("platform.legal.view"),
      request: { params: idParams },
      responses: { 200: { description: "Document and acceptances" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await legal.get(params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/legal-documents/:id`,
      summary: "Edit a draft",
      tags: ["console: legal"],
      access: access.platform("platform.legal.manage"),
      request: {
        params: idParams,
        body: z.object({
          title: z.string().trim().min(3).max(160).optional(),
          body: z.string().min(20).max(200_000).optional(),
          summary: z.string().trim().max(2_000).nullish(),
          requiresAcceptance: z.boolean().optional(),
        }),
      },
      responses: { 200: { description: "Draft" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await legal.update(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/legal-documents/:id/publish`,
      summary: "Publish a version (in force now, or from a date ahead)",
      tags: ["console: legal"],
      access: access.platform("platform.legal.manage"),
      request: { params: idParams, body: z.object({ effectiveAt: z.coerce.date().nullish() }) },
      responses: { 200: { description: "Published" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await legal.publish(params.id, body.effectiveAt ?? null, staffOf(res))));
      },
    }),

    // --- console: data exports ---
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/data-exports`,
      summary: "A tenant's data exports",
      tags: ["console: data"],
      access: access.platform("platform.data.exports.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Exports" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await exports.list(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/data-exports`,
      summary: "Export a tenant's data for its owner (the exit path)",
      tags: ["console: data"],
      access: access.platform("platform.data.exports.manage"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 202: { description: "Being prepared" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(202)
          .json(envelope(await exports.requestForTenant(params.id, body.reason, staffOf(res))));
      },
    }),

    // --- console: data-protection requests ---
    defineRoute({
      method: "get",
      path: `${BASE}/data-protection-requests`,
      summary: "Data-protection requests (open first, by deadline)",
      tags: ["console: compliance"],
      access: access.platform("platform.security.dsr.manage"),
      request: {
        query: z.object({
          status: z.enum(["open", "in_progress", "completed", "rejected"]).optional(),
          open: z.stringbool().optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Requests" } },
      handler: async ({ query }, _req, res) => {
        res.json(
          envelope(
            await requests.list({
              limit: query.limit,
              ...(query.status === undefined ? {} : { status: query.status }),
              ...(query.open === undefined ? {} : { openOnly: query.open }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/data-protection-requests`,
      summary: "Log a data-protection request (access, correction, erasure, objection)",
      tags: ["console: compliance"],
      access: access.platform("platform.security.dsr.manage"),
      request: {
        body: z.object({
          kind: z.enum(["access", "correction", "erasure", "objection"]),
          tenantId: uuid.nullish(),
          requesterName: z.string().trim().min(2).max(160),
          requesterContact: z.string().trim().min(5).max(200),
          subject: z.string().trim().min(3).max(1_000),
          receivedAt: z.coerce.date(),
          dueAt: z.coerce.date().optional(),
        }),
      },
      responses: { 201: { description: "Request" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await requests.open(body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/data-protection-requests/:id`,
      summary: "A data-protection request with its steps",
      tags: ["console: compliance"],
      access: access.platform("platform.security.dsr.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Request" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await requests.get(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/data-protection-requests/:id/steps`,
      summary: "Record a step (and optionally reassign)",
      tags: ["console: compliance"],
      access: access.platform("platform.security.dsr.manage"),
      request: {
        params: idParams,
        body: z.object({ note: z.string().trim().min(3).max(2_000), assignTo: uuid.nullish() }),
      },
      responses: { 200: { description: "Request" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await requests.step(
              params.id,
              {
                note: body.note,
                ...(body.assignTo === undefined ? {} : { assignTo: body.assignTo }),
              },
              staffOf(res),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/data-protection-requests/:id/close`,
      summary: "Close a request: completed or rejected, with the outcome",
      tags: ["console: compliance"],
      access: access.platform("platform.security.dsr.manage"),
      request: {
        params: idParams,
        body: z.object({
          status: z.enum(["completed", "rejected"]),
          outcome: z.string().trim().min(5).max(2_000),
        }),
      },
      responses: { 200: { description: "Request" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await requests.close(params.id, body, staffOf(res))));
      },
    }),

    // --- console: incidents ---
    defineRoute({
      method: "get",
      path: `${BASE}/incidents`,
      summary: "Incidents (open, and the last 90 days)",
      tags: ["console: operations"],
      access: access.platform("platform.health.view"),
      responses: { 200: { description: "Incidents" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await status.list()));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/incidents`,
      summary: "Open an incident on the status page",
      tags: ["console: operations"],
      access: access.platform("platform.support.incidents.manage"),
      request: {
        body: z.object({
          title: z.string().trim().min(3).max(160),
          impact,
          components: z.array(z.string()).max(5).default([]),
          message: z.string().trim().min(3).max(2_000),
        }),
      },
      responses: { 201: { description: "Incident" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await status.open(body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/incidents/:id/updates`,
      summary: "Post an update (status, message; resolved closes it)",
      tags: ["console: operations"],
      access: access.platform("platform.support.incidents.manage"),
      request: {
        params: idParams,
        body: z.object({
          status: incidentStatus,
          message: z.string().trim().min(3).max(2_000),
          impact: impact.optional(),
        }),
      },
      responses: { 200: { description: "Incident" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await status.update(params.id, body, staffOf(res))));
      },
    }),

    // --- console: restore drills ---
    defineRoute({
      method: "get",
      path: `${BASE}/restore-drills`,
      summary: "Restore drills: the next one scheduled and past results",
      tags: ["console: data"],
      access: access.platform("platform.data.backups.view"),
      request: { query: z.object({ limit }) },
      responses: { 200: { description: "Drills" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await drills.list(query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/restore-drills/:id/record`,
      summary: "Record a drill's result (schedules the next quarter's)",
      tags: ["console: data"],
      access: access.platform("platform.data.drills.manage"),
      request: {
        params: idParams,
        body: z.object({
          outcome: z.enum(["passed", "partial", "failed"]),
          performedAt: z.coerce.date(),
          rtoMinutes: z.number().int().min(0).nullish(),
          rpoMinutes: z.number().int().min(0).nullish(),
          notes: z.string().trim().max(4_000).nullish(),
        }),
      },
      responses: { 200: { description: "The drill and the next one" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await drills.record(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/restore-drills/:id/reschedule`,
      summary: "Move a scheduled drill",
      tags: ["console: data"],
      access: access.platform("platform.data.drills.manage"),
      request: { params: idParams, body: z.object({ dueOn: z.iso.date() }) },
      responses: { 200: { description: "Drill" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await drills.reschedule(params.id, body.dueOn, staffOf(res))));
      },
    }),
  ];
}
