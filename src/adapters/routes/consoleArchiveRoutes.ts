import { z } from "zod";
import type { ColdArchives } from "../../application/use-cases/console/ColdArchives.js";
import type { PersonalDataErasure } from "../../application/use-cases/console/PersonalDataErasure.js";
import { ERASURE_SUBJECTS } from "../../domain/console/ColdArchive.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const tenantParams = z.object({ id: z.uuid() });
const reason = z.string().trim().min(3).max(1_000);
const ticket = z.string().trim().max(120).nullish();
const subject = z.object({ subjectType: z.enum(ERASURE_SUBJECTS), subjectId: z.uuid() });

export type ConsoleArchiveRouteDependencies = Readonly<{
  archives: ColdArchives;
  erasure: PersonalDataErasure;
}>;

/**
 * Cold archive (docs/27 §3.3, docs/26 §8) and erasure by anonymisation (docs/27 §3.15): asking to
 * archive a tenant deactivated for a year and to bring it back (four-eyes; an operator restores
 * with the backup key), the archives with their checks and yearly restore tests, and erasing a
 * person's personal data in a tenant (a Super Admin approves) with the erasure ledger.
 */
export function consoleArchiveRoutes(deps: ConsoleArchiveRouteDependencies): ApiRoute[] {
  const { archives, erasure } = deps;
  return [
    defineRoute({
      method: "get",
      path: `${BASE}/archives`,
      summary: "Cold archives with their checks, yearly restore tests and restores",
      tags: ["console: data operations"],
      access: access.platform("platform.data.backups.view"),
      request: {
        query: z.object({
          status: z
            .enum(["queued", "archiving", "archived", "failed", "restoring", "restored"])
            .optional(),
          tenantId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: { 200: { description: "Archives" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await archives.list(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/archives/:id`,
      summary: "A cold archive: the dump, its checks, the files manifest and its restore tests",
      tags: ["console: data operations"],
      access: access.platform("platform.data.backups.view"),
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: { description: "Archive" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await archives.archive(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/cold-archive`,
      summary:
        "Asks to move a tenant deactivated for a year to cold archive (another staff member approves)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.archive_cold"),
      request: { params: tenantParams, body: z.object({ reason, ticket }) },
      responses: { 202: { description: "Waiting for approval" } },
      handler: async ({ params, body }, _req, res) => {
        const approvalId = await archives.requestArchive(staffOf(res), params.id, body);
        res.status(202).json(envelope({ approvalId }));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/cold-archive/restore`,
      summary:
        "Asks to bring a tenant back from cold archive (approved, then restored by an operator)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.restore_cold_archive"),
      request: { params: tenantParams, body: z.object({ reason, ticket }) },
      responses: { 202: { description: "Waiting for approval" } },
      handler: async ({ params, body }, _req, res) => {
        const approvalId = await archives.requestRestore(staffOf(res), params.id, body);
        res.status(202).json(envelope({ approvalId }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/erasures/preview`,
      summary: "The person to erase as they are now, with the related records that go too",
      tags: ["console: security"],
      access: access.platform("platform.security.dsr.anonymise"),
      request: { params: tenantParams, query: subject },
      responses: { 200: { description: "Preview" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(
          envelope(
            await erasure.preview(params.id, { type: query.subjectType, id: query.subjectId }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/erasures`,
      summary: "Asks to erase a person's personal data in a tenant (a Super Admin approves)",
      tags: ["console: security"],
      access: access.platform("platform.security.dsr.anonymise"),
      request: {
        params: tenantParams,
        body: subject.extend({ requestId: z.uuid().nullish(), reason, ticket }),
      },
      responses: { 202: { description: "Waiting for approval" } },
      handler: async ({ params, body }, _req, res) => {
        const approvalId = await erasure.request(staffOf(res), params.id, body);
        res.status(202).json(envelope({ approvalId }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/erasures`,
      summary: "The erasure ledger: who was erased where, when, and how often it was reapplied",
      tags: ["console: security"],
      access: access.platform("platform.security.dsr.manage"),
      request: {
        query: z.object({
          tenantId: z.uuid().optional(),
          requestId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: { 200: { description: "Erasures" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await erasure.list(query)));
      },
    }),
  ];
}
