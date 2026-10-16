import { z } from "zod";
import type { TenantStatus } from "../../application/ports/ITenantDirectory.js";
import type { AuditLogExport } from "../../application/use-cases/console/AuditLogExport.js";
import type { ConsoleDashboard } from "../../application/use-cases/console/ConsoleDashboard.js";
import type { DataOperationsConsole } from "../../application/use-cases/console/DataOperationsConsole.js";
import type { SystemHealthSummary } from "../../application/use-cases/console/SystemHealthSummary.js";
import type { TenantAccounts } from "../../application/use-cases/console/TenantAccounts.js";
import type { TenantNotesAndTags } from "../../application/use-cases/console/TenantNotesAndTags.js";
import { MAX_NOTE_LENGTH } from "../../domain/entities/TenantNote.js";
import { MAX_TAGS_PER_TENANT } from "../../domain/value-objects/TenantTag.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { auditCsv } from "../presenters/auditCsv.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const TAGS = {
  dashboard: ["console: dashboard"],
  tenants: ["console: tenants"],
  data: ["console: data operations"],
  audit: ["console: audit"],
};

const TENANT_STATUSES: readonly TenantStatus[] = [
  "provisioning",
  "provisioning_failed",
  "trialing",
  "active",
  "past_due",
  "read_only",
  "deactivated",
  "archived",
];

const uuid = z.uuid();
const limit = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const tenantParams = z.object({ id: uuid });
const noteParams = z.object({ id: uuid, noteId: uuid });
const statusList = z
  .string()
  .max(200)
  .transform((value) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(TENANT_STATUSES as [TenantStatus, ...TenantStatus[]])));
const auditFilter = {
  actorId: uuid.optional(),
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(100)
    .optional(),
  targetTenantId: uuid.optional(),
  entityType: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  entityId: z.string().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

/** The `before` cursor for keyset pages: the last id when the page is full. */
const nextBefore = (items: readonly { id: string }[], pageSize: number) =>
  items.length === pageSize ? (items.at(-1)?.id ?? null) : null;

export type ConsoleRouteDependencies = Readonly<{
  dashboard: ConsoleDashboard;
  tenants: TenantAccounts;
  notes: TenantNotesAndTags;
  dataOperations: DataOperationsConsole;
  health: SystemHealthSummary;
  auditExport: AuditLogExport;
}>;

/**
 * Console MVP (docs/27 §3.1, §3.4, §3.14): dashboard, tenant list and 360° profile, notes and
 * tags, backups and migrations, system health, audit export. Operational data only.
 */
export function consoleRoutes(deps: ConsoleRouteDependencies): ApiRoute[] {
  return [
    // --- dashboard & health ---
    defineRoute({
      method: "get",
      path: `${BASE}/dashboard`,
      summary: "Dashboard tiles: tenants by status, applications waiting, trials ending, failures",
      tags: TAGS.dashboard,
      access: access.platform("platform.dashboard.view"),
      responses: { 200: { description: "Dashboard counts" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.dashboard.get()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/health`,
      summary: "System health summary: database, jobs, email, backups, migrations",
      tags: TAGS.dashboard,
      access: access.platform("platform.health.view"),
      responses: { 200: { description: "Overall status and one check per component" } },
      handler: async (_input, _req, res) => {
        res.set("Cache-Control", "no-store").json(envelope(await deps.health.summary()));
      },
    }),

    // --- tenants ---
    defineRoute({
      method: "get",
      path: `${BASE}/tenants`,
      summary: "Tenant list (newest first): filter by status, tag, creation date, or search",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.view"),
      request: {
        query: z.object({
          status: statusList.optional(),
          q: z.string().trim().min(2).max(120).optional(),
          tag: z.string().trim().toLowerCase().max(30).optional(),
          createdFrom: z.coerce.date().optional(),
          createdTo: z.coerce.date().optional(),
          before: uuid.optional(),
          limit: limit(100, 25),
        }),
      },
      responses: { 200: { description: "Tenants; `meta.nextBefore` pages further" } },
      handler: async ({ query }, _req, res) => {
        const tenants = await deps.tenants.list(query);
        res.json(envelope(tenants, { nextBefore: nextBefore(tenants, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id`,
      summary: "Tenant 360° profile: status, owner, provisioning, schema, backups, usage, tags",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Profile" }, 404: { description: "Unknown tenant" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deps.tenants.profile(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/timeline`,
      summary: "Tenant timeline: application events and every audited console action",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.view"),
      request: {
        params: tenantParams,
        query: z.object({ before: z.coerce.date().optional(), limit: limit(200, 50) }),
      },
      responses: { 200: { description: "Entries, newest first; `meta.nextBefore` is a time" } },
      handler: async ({ params, query }, _req, res) => {
        const entries = await deps.tenants.timeline(params.id, query);
        res.json(
          envelope(entries, {
            nextBefore:
              entries.length === query.limit ? (entries.at(-1)?.at.toISOString() ?? null) : null,
          }),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/backups`,
      summary: "Backups of a tenant (newest first)",
      tags: TAGS.tenants,
      access: access.platform("platform.data.backups.view"),
      request: {
        params: tenantParams,
        query: z.object({ before: uuid.optional(), limit: limit(100, 25) }),
      },
      responses: { 200: { description: "Backups" } },
      handler: async ({ params, query }, _req, res) => {
        const backups = await deps.dataOperations.backups({ ...query, tenantId: params.id });
        res.json(envelope(backups, { nextBefore: nextBefore(backups, query.limit) }));
      },
    }),

    // --- notes & tags ---
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/notes`,
      summary: "Internal notes on a tenant (newest first; `pinned=true` for pinned only)",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.view"),
      request: {
        params: tenantParams,
        query: z.object({
          pinned: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          before: uuid.optional(),
          limit: limit(100, 25),
        }),
      },
      responses: { 200: { description: "Notes" } },
      handler: async ({ params, query }, _req, res) => {
        const notes = await deps.notes.notes(params.id, query);
        res.json(envelope(notes, { nextBefore: nextBefore(notes, query.limit) }));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/notes`,
      summary: "Add an internal note (never shown to the tenant)",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.notes"),
      request: {
        params: tenantParams,
        body: z.object({
          body: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
          pinned: z.boolean().default(false),
        }),
      },
      responses: { 201: { description: "The note" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await deps.notes.addNote(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/tenants/:id/notes/:noteId`,
      summary: "Edit a note (author only) or pin/unpin it",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.notes"),
      request: {
        params: noteParams,
        body: z
          .object({
            body: z.string().trim().min(1).max(MAX_NOTE_LENGTH).optional(),
            pinned: z.boolean().optional(),
          })
          .refine((b) => b.body !== undefined || b.pinned !== undefined, "Nothing to change"),
      },
      responses: { 200: { description: "The note" }, 403: { description: "Not the author" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deps.notes.editNote(params.id, params.noteId, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/tenants/:id/notes/:noteId`,
      summary: "Delete a note (author only; the audit log keeps its text)",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.notes"),
      request: { params: noteParams },
      responses: { 204: { description: "Deleted" } },
      handler: async ({ params }, _req, res) => {
        await deps.notes.deleteNote(params.id, params.noteId, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/tenants/:id/tags`,
      summary: "Replace a tenant's tags (e.g. vip, at-risk, partner-managed)",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.notes"),
      request: {
        params: tenantParams,
        body: z.object({ tags: z.array(z.string().max(60)).max(MAX_TAGS_PER_TENANT * 2) }),
      },
      responses: { 200: { description: "The tenant's tags, normalised" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deps.notes.setTags(params.id, body.tags, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tags`,
      summary: "Tags in use, with the number of tenants for each",
      tags: TAGS.tenants,
      access: access.platform("platform.tenants.view"),
      responses: { 200: { description: "Tags" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.notes.tagsInUse()));
      },
    }),

    // --- data operations ---
    defineRoute({
      method: "get",
      path: `${BASE}/backups`,
      summary: "Backup catalogue (newest first)",
      tags: TAGS.data,
      access: access.platform("platform.data.backups.view"),
      request: {
        query: z.object({
          kind: z.enum(["tenant", "platform"]).optional(),
          tenantId: uuid.optional(),
          status: z.enum(["running", "succeeded", "failed"]).optional(),
          before: uuid.optional(),
          limit: limit(100, 25),
        }),
      },
      responses: { 200: { description: "Backups" } },
      handler: async ({ query }, _req, res) => {
        const backups = await deps.dataOperations.backups(query);
        res.json(envelope(backups, { nextBefore: nextBefore(backups, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/backups/summary`,
      summary:
        "Backup status: last platform backup, last restore test, tenants without a recent backup",
      tags: TAGS.data,
      access: access.platform("platform.data.backups.view"),
      responses: { 200: { description: "Summary" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.dataOperations.backupOverview()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/migrations`,
      summary: "Schema migrations: platform version, tenants by version, failures",
      tags: TAGS.data,
      access: access.platform("platform.data.migrations.view"),
      responses: { 200: { description: "Migration status" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.dataOperations.migrations()));
      },
    }),

    // --- audit export ---
    defineRoute({
      method: "get",
      path: `${BASE}/audit-logs/export`,
      summary: "Export the platform audit log as CSV (at most 10,000 rows; the export is audited)",
      tags: TAGS.audit,
      access: access.platform("platform.security.audit.view"),
      request: { query: z.object(auditFilter) },
      responses: { 200: { description: "CSV file; `X-Export-Truncated: true` when cut off" } },
      handler: async ({ query }, _req, res) => {
        const result = await deps.auditExport.export(query, staffOf(res));
        const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "");
        res
          .status(200)
          .set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
            "Cache-Control": "no-store",
            "X-Export-Truncated": String(result.truncated),
          })
          .send(auditCsv(result.entries));
      },
    }),
  ];
}
