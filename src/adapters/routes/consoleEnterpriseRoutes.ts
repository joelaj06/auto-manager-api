import { z } from "zod";
import type { CustomDomains } from "../../application/use-cases/console/CustomDomains.js";
import type { TenantDatabaseLogins } from "../../application/use-cases/console/TenantDatabaseLogins.js";
import type { TenantIntegrations } from "../../application/use-cases/console/TenantIntegrations.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const TENANT = "/api/platform/v1/tenants/:id";
const tags = ["console: enterprise"];
const viewTenant = access.platform("platform.tenants.view");
const manageDomains = access.platform("platform.tenants.domains.manage");
const manageIntegrations = access.platform("platform.tenants.integrations.manage");
const manageLogins = access.platform("platform.tenants.database_credentials.manage");
const tenantParams = z.object({ id: z.uuid() });
const domainParams = z.object({ id: z.uuid(), domainId: z.uuid() });
const reason = z.string().trim().min(3).max(1_000);

export type ConsoleEnterpriseRouteDependencies = Readonly<{
  domains: CustomDomains;
  integrations: TenantIntegrations;
  logins: TenantDatabaseLogins;
}>;

/**
 * Enterprise extras in the console (docs/27 §3, §5 item 14): custom domains, a tenant's keys and
 * webhooks, and its own database login. The public certificate check lives here too because it
 * belongs with the domains.
 */
export function consoleEnterpriseRoutes(deps: ConsoleEnterpriseRouteDependencies): ApiRoute[] {
  const { domains, integrations, logins } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/public/domains/allowed",
      summary: "For the proxy's on-demand certificates: 200 for a live custom domain, else 404",
      tags: ["public"],
      access: access.public(),
      request: { query: z.object({ domain: z.string().min(1).max(253) }) },
      responses: { 200: { description: "Allowed" }, 404: { description: "Not ours" } },
      handler: async ({ query }, _req, res) => {
        res.status((await domains.allowsCertificate(query.domain)) ? 200 : 404).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${TENANT}/domains`,
      summary: "A tenant's custom domains with the DNS records each needs",
      tags,
      access: viewTenant,
      request: { params: tenantParams },
      responses: { 200: { description: "Domains" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await domains.list(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${TENANT}/domains`,
      summary: "Adds a custom domain, pending until its DNS proves it (Enterprise)",
      tags,
      access: manageDomains,
      request: {
        params: tenantParams,
        body: z.object({ domain: z.string().trim().min(4).max(253) }),
      },
      responses: { 201: { description: "The domain and the records to create" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await domains.add(staffOf(res), params.id, body.domain)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${TENANT}/domains/:domainId/verify`,
      summary: "Checks a domain's DNS now; it goes live when the records are right",
      tags,
      access: manageDomains,
      request: { params: domainParams },
      responses: { 200: { description: "The domain, with what is wrong if it failed" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await domains.verify(staffOf(res), params.id, params.domainId)));
      },
    }),
    defineRoute({
      method: "delete",
      path: `${TENANT}/domains/:domainId`,
      summary: "Removes a custom domain",
      tags,
      access: manageDomains,
      request: { params: domainParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await domains.remove(staffOf(res), params.id, params.domainId);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${TENANT}/integrations`,
      summary: "A tenant's API keys and webhooks with their use",
      tags,
      access: viewTenant,
      request: { params: tenantParams },
      responses: { 200: { description: "Keys and webhooks, never a secret" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await integrations.overview(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${TENANT}/api-keys/:keyId/revoke`,
      summary: "Revokes a tenant's API key, e.g. when it has leaked",
      tags,
      access: manageIntegrations,
      request: {
        params: z.object({ id: z.uuid(), keyId: z.uuid() }),
        body: z.object({ reason }),
      },
      responses: { 204: { description: "Revoked" } },
      handler: async ({ params, body }, _req, res) => {
        await integrations.revokeKey(staffOf(res), params.id, params.keyId, body.reason);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${TENANT}/webhooks/:endpointId/disable`,
      summary: "Switches off a tenant's webhook address",
      tags,
      access: manageIntegrations,
      request: {
        params: z.object({ id: z.uuid(), endpointId: z.uuid() }),
        body: z.object({ reason }),
      },
      responses: { 204: { description: "Switched off" } },
      handler: async ({ params, body }, _req, res) => {
        await integrations.disableWebhook(staffOf(res), params.id, params.endpointId, body.reason);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${TENANT}/database-login`,
      summary: "Whether a tenant has its own database login, never its password",
      tags,
      access: viewTenant,
      request: { params: tenantParams },
      responses: { 200: { description: "The login's state" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await logins.status(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${TENANT}/database-login`,
      summary:
        "Asks to give a tenant its own database login, rotate it or take it back (four-eyes)",
      tags,
      access: manageLogins,
      request: {
        params: tenantParams,
        body: z.object({
          action: z.enum(["enable", "rotate", "disable"]),
          reason,
          ticket: z.string().trim().max(120).nullish(),
        }),
      },
      responses: { 202: { description: "The approval to give" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(202)
          .json(envelope({ approvalId: await logins.request(staffOf(res), params.id, body) }));
      },
    }),
  ];
}
