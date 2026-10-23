import type { Response } from "express";
import { z } from "zod";
import { MANUAL_DEACTIVATION_REASONS } from "../../domain/entities/TenantLifecycle.js";
import type {
  DeactivateTenantInput,
  TenantLifecycleService,
} from "../../application/use-cases/tenants/TenantLifecycleService.js";
import type { BranchReconciliation } from "../../application/use-cases/billing/BranchReconciliation.js";
import type {
  BranchActor,
  BranchLifecycle,
} from "../../application/use-cases/tenants/BranchLifecycle.js";
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
const newBranch = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/),
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).nullish(),
  phone: z.string().trim().max(30).nullish(),
  /** Beyond the subscription: agree to pay for one more branch (409 explains the price). */
  confirmBranchPurchase: z.boolean().default(false),
});
const branchChanges = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});
const branchAction = z.object({ reason, confirmBranchPurchase: z.boolean().default(false) });
const reassignment = z.object({
  targetBranchId: z.uuid(),
  /** Move the branch's members and branch roles too (default). */
  users: z.boolean().default(true),
  reason,
});
const ACTION_SUMMARY = {
  deactivate: "Deactivate",
  reactivate: "Reactivate",
  remove: "Remove (no records only)",
};
const isoDates = <T extends Record<string, unknown>>(value: T) =>
  JSON.parse(JSON.stringify(value)) as T;

export type LifecycleRouteDependencies = Readonly<{
  lifecycle: TenantLifecycleService;
  branches: BranchLifecycle;
  reconciliation: BranchReconciliation;
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
  const staff = (res: Response) => ({ type: "platform_staff" as const, id: staffOf(res).userId });
  const user = (res: Response) => ({ type: "user" as const, id: principalOf(res).userId });
  const act = (
    action: "deactivate" | "reactivate" | "remove",
    branchId: string,
    body: z.infer<typeof branchAction>,
    actor: BranchActor,
  ) =>
    action === "reactivate"
      ? deps.branches.reactivate(branchId, body.reason, actor, body.confirmBranchPurchase)
      : deps.branches[action](branchId, body.reason, actor);

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

    // --- console: branches of a tenant (docs/27 §3.5) ---
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
    defineRoute({
      method: "get",
      path: `${CONSOLE}/:id/branches/price-impact`,
      summary: "What one more active branch would cost the tenant (before adding or reactivating)",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Price impact" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await asTenant(params.id, () => deps.branches.priceImpact())));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/branches`,
      summary: "Add a branch for a tenant (beyond its subscription: confirm the price impact)",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.manage"),
      request: { params: tenantParams, body: newBranch.extend({ reason }) },
      responses: { 201: { description: "Created" }, 409: { description: "Beyond the limit" } },
      handler: async ({ params, body }, _req, res) => {
        const { confirmBranchPurchase, ...input } = body;
        const id = await asTenant(params.id, () =>
          deps.branches.create(input, staff(res), confirmBranchPurchase),
        );
        res.status(201).json(envelope({ id }));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${CONSOLE}/:id/branches/:branchId`,
      summary: "Edit a tenant's branch",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.manage"),
      request: { params: branchParams, body: branchChanges.extend({ reason }) },
      responses: { 204: { description: "Updated" } },
      handler: async ({ params, body }, _req, res) => {
        const { reason: why, ...changes } = body;
        await asTenant(params.id, () =>
          deps.branches.update(params.branchId, changes, why, staff(res)),
        );
        done(res);
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/branches/:branchId/make-default`,
      summary: "Make a tenant's branch the default (head office)",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.manage"),
      request: { params: branchParams, body: z.object({ reason }) },
      responses: { 204: { description: "Done" } },
      handler: async ({ params, body }, _req, res) => {
        await asTenant(params.id, () =>
          deps.branches.makeDefault(params.branchId, body.reason, staff(res)),
        );
        done(res);
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/:id/branches/:branchId/deactivation-check`,
      summary: "What is still live in a tenant's branch and what blocks deactivating it",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.view"),
      request: { params: branchParams },
      responses: { 200: { description: "Inventory and blockers" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(
            isoDates(
              await asTenant(params.id, () => deps.branches.deactivationCheck(params.branchId)),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/branches/:branchId/reassign`,
      summary: "Move everything live in a tenant's branch to another branch (deactivation wizard)",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.manage"),
      request: { params: branchParams, body: reassignment },
      responses: { 200: { description: "What moved" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await asTenant(params.id, () =>
              deps.branches.reassign(params.branchId, body, staff(res)),
            ),
          ),
        );
      },
    }),
    ...(["deactivate", "reactivate", "remove"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `${CONSOLE}/:id/branches/:branchId/${action}`,
        summary: `${ACTION_SUMMARY[action]} a tenant's branch`,
        tags: ["console: tenants"],
        access: access.platform("platform.branches.manage"),
        request: { params: branchParams, body: branchAction },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await asTenant(params.id, () => act(action, params.branchId, body, staff(res)));
          done(res);
        },
      }),
    ),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/branches/reconcile`,
      summary: "Compare the billed branches with the tenant's active branches and fix drift",
      tags: ["console: tenants"],
      access: access.platform("platform.branches.manage"),
      request: { params: tenantParams },
      responses: { 200: { description: "Reconciliation" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deps.reconciliation.runFor(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/platform/v1/billing/branch-reconciliations",
      summary: "Branch reconciliations (filter: tenant, outcome such as over_limit or fixed)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: {
        query: z.object({
          tenantId: z.uuid().optional(),
          outcome: z.enum(["matched", "fixed", "over_limit", "failed"]).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
      },
      responses: { 200: { description: "Reconciliations" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await deps.reconciliation.list(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/platform/v1/billing/over-limit",
      summary: "Tenants with more active branches than they pay for",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      responses: { 200: { description: "Over-limit tenants" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.reconciliation.overLimit()));
      },
    }),

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
    defineRoute({
      method: "get",
      path: "/api/v1/branches/price-impact",
      summary: "What one more active branch would cost (shown before you confirm)",
      tags: ["branches"],
      access: access.permission("branches.create"),
      responses: { 200: { description: "Price impact" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.branches.priceImpact()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/branches",
      summary: "Create a branch",
      tags: ["branches"],
      access: access.permission("branches.create"),
      request: { body: newBranch },
      responses: {
        201: { description: "Created" },
        409: { description: "ENTITLEMENT_BRANCH_LIMIT: beyond the subscription" },
      },
      handler: async ({ body }, _req, res) => {
        const { confirmBranchPurchase, ...input } = body;
        const id = await deps.branches.create(input, user(res), confirmBranchPurchase);
        res.status(201).json(envelope({ id }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/branches/:id/deactivation-check",
      summary: "What is still live in a branch and what blocks deactivating it",
      tags: ["branches"],
      access: access.permission("branches.deactivate"),
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: { description: "Inventory and blockers" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(isoDates(await deps.branches.deactivationCheck(params.id))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/branches/:id/reassign",
      summary: "Move everything live in a branch to another branch, before deactivating it",
      tags: ["branches"],
      access: access.permission("branches.deactivate"),
      request: { params: z.object({ id: z.uuid() }), body: reassignment },
      responses: { 200: { description: "What moved" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deps.branches.reassign(params.id, body, user(res))));
      },
    }),
    ...(["deactivate", "reactivate", "remove"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `/api/v1/branches/:id/${action}`,
        summary: `${ACTION_SUMMARY[action]} a branch`,
        tags: ["branches"],
        access: access.permission("branches.deactivate"),
        request: { params: z.object({ id: z.uuid() }), body: branchAction },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await act(action, params.id, body, user(res));
          done(res);
        },
      }),
    ),
  ];
}
