import type { Response } from "express";
import { z } from "zod";
import { MANUAL_DEACTIVATION_REASONS } from "../../domain/entities/TenantLifecycle.js";
import type {
  DeactivateTenantInput,
  TenantLifecycleService,
} from "../../application/use-cases/tenants/TenantLifecycleService.js";
import type { BranchLifecycle } from "../../application/use-cases/tenants/BranchLifecycle.js";
import type { TenantPublicConfig } from "../../application/use-cases/tenants/TenantPublicConfig.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { ITenantDirectory } from "../../application/ports/ITenantDirectory.js";
import { TenantNotFoundForStaffError } from "../../application/errors/TenantErrors.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { principalOf, staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const CONSOLE = "/api/platform/v1/tenants";
const reason = z.string().trim().min(5).max(1_000);
const message = z.string().trim().max(500).nullish();
const tenantParams = z.object({ id: z.uuid() });
const branchParams = z.object({ id: z.uuid(), branchId: z.uuid() });
const isoDates = <T extends Record<string, unknown>>(value: T) =>
  JSON.parse(JSON.stringify(value)) as T;

export type LifecycleRouteDependencies = Readonly<{
  lifecycle: TenantLifecycleService;
  branches: BranchLifecycle;
  publicConfig: TenantPublicConfig;
  tenantContext: ITenantContext;
  directory: ITenantDirectory;
}>;

/** Tenant lifecycle (console), branch lifecycle (console and tenant) and public tenant-config. */
export function lifecycleRoutes(deps: LifecycleRouteDependencies): ApiRoute[] {
  /** Console branch actions run in the tenant's context, like the tenant's own. */
  const asTenant = async <T>(tenantId: string, work: () => Promise<T>): Promise<T> => {
    if ((await deps.directory.findById(tenantId)) === null) throw new TenantNotFoundForStaffError();
    return deps.tenantContext.runAs(TenantId.from(tenantId), work);
  };
  const done = (res: Response) => res.status(204).end();

  return [
    // --- public ---
    defineRoute({
      method: "get",
      path: "/api/v1/public/tenant-config",
      summary:
        "What an app needs to connect to a business (name, status, currency, sign-in methods)",
      tags: ["public"],
      access: access.public(),
      request: { query: z.object({ slug: z.string().min(1).max(60) }) },
      responses: {
        200: { description: "Public tenant configuration" },
        404: { description: "Unknown business" },
      },
      handler: async ({ query }, _req, res) => {
        res
          .set("Cache-Control", "public, max-age=60")
          .json(envelope(await deps.publicConfig.get(query.slug)));
      },
    }),

    // --- console: tenant lifecycle ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/:id/status-history`,
      summary: "Tenant status history",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Transitions, newest first" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope((await deps.lifecycle.history(params.id)).map(isoDates)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/deactivate`,
      summary: "Deactivate a tenant (special cases; blocks every user immediately)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.deactivate"),
      request: {
        params: tenantParams,
        body: z.object({
          reasonCategory: z.enum(
            MANUAL_DEACTIVATION_REASONS as [
              DeactivateTenantInput["reasonCategory"],
              ...DeactivateTenantInput["reasonCategory"][],
            ],
          ),
          reason,
          message,
        }),
      },
      responses: { 204: { description: "Deactivated" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.lifecycle.deactivate(
          params.id,
          { ...body, message: body.message ?? null },
          staffOf(res),
        );
        done(res);
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/restore`,
      summary: "Restore a deactivated tenant to its previous status",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.restore"),
      request: { params: tenantParams, body: z.object({ reason }) },
      responses: { 204: { description: "Restored" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.lifecycle.restore(params.id, body.reason, staffOf(res));
        done(res);
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/read-only`,
      summary: "Make a tenant read-only (reads work, changes are refused)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.set_read_only"),
      request: { params: tenantParams, body: z.object({ reason, message }) },
      responses: { 204: { description: "Read-only" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.lifecycle.setReadOnly(
          params.id,
          body.reason,
          body.message ?? null,
          staffOf(res),
        );
        done(res);
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/read-only/clear`,
      summary: "End read-only mode",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.set_read_only"),
      request: { params: tenantParams, body: z.object({ reason }) },
      responses: { 204: { description: "Writable again" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.lifecycle.clearReadOnly(params.id, body.reason, staffOf(res));
        done(res);
      },
    }),

    // --- console: branches of a tenant ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/:id/branches`,
      summary: "Branches of a tenant",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Branches" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope((await asTenant(params.id, () => deps.branches.list())).map(isoDates)));
      },
    }),
    ...(["deactivate", "reactivate"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `${CONSOLE}/:id/branches/:branchId/${action}`,
        summary: `${action === "deactivate" ? "Deactivate" : "Reactivate"} a tenant's branch`,
        tags: ["console: tenants"],
        access: access.platform("platform.branches.manage"),
        request: { params: branchParams, body: z.object({ reason }) },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          const actor = { type: "platform_staff" as const, id: staffOf(res).userId };
          await asTenant(params.id, () =>
            deps.branches[action](params.branchId, body.reason, actor),
          );
          done(res);
        },
      }),
    ),

    // --- tenant: branches ---
    defineRoute({
      method: "get",
      path: "/api/v1/branches",
      summary: "Branches of your business",
      tags: ["branches"],
      access: access.permission("branches.list"),
      responses: { 200: { description: "Branches" } },
      handler: async (_input, _req, res) => {
        res.json(envelope((await deps.branches.list()).map(isoDates)));
      },
    }),
    ...(["deactivate", "reactivate"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `/api/v1/branches/:id/${action}`,
        summary: `${action === "deactivate" ? "Deactivate" : "Reactivate"} a branch`,
        tags: ["branches"],
        access: access.permission("branches.deactivate"),
        request: { params: z.object({ id: z.uuid() }), body: z.object({ reason }) },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await deps.branches[action](params.id, body.reason, {
            type: "user",
            id: principalOf(res).userId,
          });
          done(res);
        },
      }),
    ),
  ];
}
