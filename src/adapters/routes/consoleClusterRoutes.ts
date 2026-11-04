import { z } from "zod";
import type { ClusterManagement } from "../../application/use-cases/console/ClusterManagement.js";
import { CLUSTER_STATUSES } from "../../domain/console/Clusters.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1/clusters";
const tags = ["console: clusters"];
const view = access.platform("platform.data.clusters.view");
const manage = access.platform("platform.data.clusters.manage");
const clusterId = z.string().trim().min(2).max(31);
const idParams = z.object({ id: clusterId });
const reason = z.string().trim().min(3).max(1_000);
const ticket = z.string().trim().max(120).nullish();

export type ConsoleClusterRouteDependencies = Readonly<{ clusters: ClusterManagement }>;

/**
 * Cluster management (docs/27 §3.14, docs/22 §2.2): capacity and a live look at each cluster,
 * adding, draining and retiring one, moving a tenant to another cluster (four-eyes), and the
 * orphan sweep's findings with dropping an orphan database (four-eyes, Super Admin).
 */
export function consoleClusterRoutes(deps: ConsoleClusterRouteDependencies): ApiRoute[] {
  const { clusters } = deps;
  return [
    defineRoute({
      method: "get",
      path: BASE,
      summary: "Clusters with their tenants, capacity, a live probe and the open sweep findings",
      tags,
      access: view,
      responses: { 200: { description: "Cluster overview" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await clusters.overview()));
      },
    }),
    defineRoute({
      method: "post",
      path: BASE,
      summary: "Adds a cluster whose server is ready (roles, template, rights); probed first",
      tags,
      access: manage,
      request: {
        body: z.object({
          id: clusterId,
          name: z.string().trim().min(1).max(120),
          host: z.string().trim().min(1).max(255),
          port: z.number().int().min(1).max(65_535),
          maxTenants: z.number().int().min(1).max(100_000).optional(),
          notes: z.string().trim().max(2_000).nullish(),
        }),
      },
      responses: { 201: { description: "Cluster added" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await clusters.add(staffOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/moves`,
      summary: "Moves of tenants between clusters, newest first",
      tags,
      access: view,
      request: {
        query: z.object({
          tenantId: z.uuid().optional(),
          clusterId: clusterId.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: { 200: { description: "Moves" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await clusters.moves(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/moves/:id`,
      summary: "A move with its steps, the copy's check report and the time offline",
      tags,
      access: view,
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: { description: "Move" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await clusters.move(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/findings`,
      summary: "What the orphan sweep found on each cluster, and whether it may be dropped yet",
      tags,
      access: view,
      request: {
        query: z.object({
          open: z
            .enum(["true", "false"])
            .default("true")
            .transform((v) => v === "true"),
          clusterId: clusterId.optional(),
        }),
      },
      responses: { 200: { description: "Findings" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await clusters.findings(query)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/sweep`,
      summary: "Sweeps every cluster for orphan, moved-away, stray and missing databases now",
      tags,
      access: manage,
      responses: { 200: { description: "Sweep result" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await clusters.sweep()));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/dedication`,
      summary:
        "Keeps a cluster for one Enterprise tenant, or opens it to all again (tenantId null)",
      tags,
      access: manage,
      request: {
        params: idParams,
        body: z.object({ tenantId: z.uuid().nullable(), reason }),
      },
      responses: { 200: { description: "The cluster" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await clusters.dedicate(staffOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/:id/databases/:name/drop`,
      summary:
        "Asks to drop an orphan database once it has waited long enough (Super Admin approves)",
      tags,
      access: manage,
      request: {
        params: z.object({ id: clusterId, name: z.string().trim().min(1).max(63) }),
        body: z.object({ reason, ticket }),
      },
      responses: { 202: { description: "Waiting for approval" } },
      handler: async ({ params, body }, _req, res) => {
        const approvalId = await clusters.requestDrop(staffOf(res), params.id, params.name, body);
        res.status(202).json(envelope({ approvalId }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/:id`,
      summary: "A cluster with its tenants, capacity and a live probe",
      tags,
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Cluster" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await clusters.cluster(params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/:id`,
      summary: "Renames a cluster, changes its capacity or notes, or drains, reopens or retires it",
      tags,
      access: manage,
      request: {
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          status: z.enum(CLUSTER_STATUSES).optional(),
          maxTenants: z.number().int().min(1).max(100_000).optional(),
          notes: z.string().trim().max(2_000).nullish(),
        }),
      },
      responses: { 200: { description: "Cluster" } },
      handler: async ({ params, body }, _req, res) => {
        const { notes, ...rest } = body;
        res.json(
          envelope(
            await clusters.update(staffOf(res), params.id, {
              ...rest,
              ...(notes === undefined ? {} : { notes }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/platform/v1/tenants/:id/cluster-move",
      summary:
        "Asks to move a tenant's database to another cluster; offline while it is copied (four-eyes)",
      tags,
      access: access.platform("platform.tenants.move_cluster"),
      request: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ clusterId, reason, ticket }),
      },
      responses: { 202: { description: "Waiting for approval" } },
      handler: async ({ params, body }, _req, res) => {
        const approvalId = await clusters.requestMove(staffOf(res), params.id, body);
        res.status(202).json(envelope({ approvalId }));
      },
    }),
  ];
}
