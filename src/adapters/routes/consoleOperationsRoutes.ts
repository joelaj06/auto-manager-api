import { z } from "zod";
import type { SubscriptionAdministration } from "../../application/use-cases/billing/SubscriptionAdministration.js";
import type { Communications } from "../../application/use-cases/console/Communications.js";
import type { FeatureFlags } from "../../application/use-cases/console/FeatureFlags.js";
import type { PlatformAlerts } from "../../application/use-cases/console/PlatformAlerts.js";
import type { SupportAccess } from "../../application/use-cases/console/SupportAccess.js";
import type { TenantUsageHistory } from "../../application/use-cases/console/TenantUsageHistory.js";
import type { TenantUserSupport } from "../../application/use-cases/console/TenantUserSupport.js";
import { principalOf, staffOf, tenantOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const reason = z.string().trim().min(5).max(1_000);
const limit = z.coerce.number().int().min(1).max(200).default(50);
const severity = z.enum(["info", "warning", "critical"]);
const flagKey = z.string().regex(/^[a-z][a-z0-9_.]{1,60}$/);
const licenceTypes = z.array(z.enum(["standard", "enterprise"])).max(2);
const routePrefixes = z.array(z.string().max(120)).max(10);

export type ConsoleOperationsRouteDependencies = Readonly<{
  alerts: PlatformAlerts;
  onCallWebhookConfigured: boolean;
  support: SupportAccess;
  users: TenantUserSupport;
  communications: Communications;
  flags: FeatureFlags;
  subscriptions: SubscriptionAdministration;
  usage: TenantUsageHistory;
}>;

/**
 * Console operations (docs/27 §3.1, §3.7–§3.9, §3.12, §8): the alerts centre, support access
 * with its trail, user support and owner recovery, announcements and maintenance windows,
 * feature flags and entitlement overrides, daily usage — and what tenants see of them.
 */
export function consoleOperationsRoutes(deps: ConsoleOperationsRouteDependencies): ApiRoute[] {
  const { alerts, support, users, communications, flags, subscriptions, usage } = deps;
  return [
    // --- alerts centre ---
    defineRoute({
      method: "get",
      path: `${BASE}/alerts`,
      summary: "Alerts, most severe and most recent first",
      tags: ["console: operations"],
      access: access.platform("platform.health.view"),
      request: {
        query: z.object({
          status: z.enum(["open", "acknowledged", "resolved"]).optional(),
          severity: severity.optional(),
          source: z.string().max(40).optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Alerts" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await alerts.list(query), { open: await alerts.openCounts() }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/alerts/on-call`,
      summary: "Where alerts go: on-call emails, the webhook, the minimum severity",
      tags: ["console: operations"],
      access: access.platform("platform.alerts.manage"),
      responses: { 200: { description: "On-call channels" } },
      handler: (_input, _req, res) => {
        res.json(envelope(alerts.onCallChannels(deps.onCallWebhookConfigured)));
        return Promise.resolve();
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/alerts/:id`,
      summary: "One alert",
      tags: ["console: operations"],
      access: access.platform("platform.health.view"),
      request: { params: idParams },
      responses: { 200: { description: "Alert" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await alerts.get(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/alerts/:id/acknowledge`,
      summary: "Acknowledge an alert (someone is on it)",
      tags: ["console: operations"],
      access: access.platform("platform.alerts.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Alert" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await alerts.acknowledge(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/alerts/:id/resolve`,
      summary: "Resolve an alert",
      tags: ["console: operations"],
      access: access.platform("platform.alerts.manage"),
      request: {
        params: idParams,
        body: z.object({ note: z.string().trim().max(1_000).nullish() }),
      },
      responses: { 200: { description: "Alert" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await alerts.resolve(params.id, staffOf(res), body.note ?? null)));
      },
    }),

    // --- support access ---
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/support-sessions`,
      summary: "Open a tenant in support mode (read-only; write mode waits for a second approver)",
      tags: ["console: support"],
      access: access.platform("platform.support.access_tenant"),
      request: {
        params: idParams,
        body: z.object({
          mode: z.enum(["read", "write"]).default("read"),
          reason,
          ticket: z.string().trim().max(120).nullish(),
          durationMinutes: z.number().int().optional(),
        }),
      },
      responses: {
        201: { description: "Session (take a token)" },
        202: { description: "Write mode: waiting for approval" },
      },
      handler: async ({ params, body }, _req, res) => {
        const session = await support.open(params.id, body, staffOf(res));
        res.status(session.status === "awaiting_approval" ? 202 : 201).json(envelope(session));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support-sessions/:id/token`,
      summary: "A tenant token for your support session (starts its clock)",
      tags: ["console: support"],
      access: access.platform("platform.support.access_tenant"),
      request: { params: idParams },
      responses: { 200: { description: "Token" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await support.token(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support-sessions/:id/extend`,
      summary: "More time for your session (two hours in all at most)",
      tags: ["console: support"],
      access: access.platform("platform.support.access_tenant"),
      request: { params: idParams, body: z.object({ minutes: z.number().int() }) },
      responses: { 200: { description: "Session" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await support.extend(params.id, body.minutes, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/support-sessions/:id/end`,
      summary: "End your support session",
      tags: ["console: support"],
      access: access.platform("platform.support.access_tenant"),
      request: { params: idParams },
      responses: { 200: { description: "Session" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await support.end(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/support-sessions`,
      summary: "Support sessions, by staff member or tenant",
      tags: ["console: support"],
      access: access.platform("platform.support.sessions.view"),
      request: {
        query: z.object({
          staffId: uuid.optional(),
          tenantId: uuid.optional(),
          status: z
            .enum(["awaiting_approval", "approved", "active", "ended", "rejected"])
            .optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Sessions" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await support.list(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/support-sessions/:id`,
      summary: "A support session with every request made in it",
      tags: ["console: support"],
      access: access.platform("platform.support.sessions.view"),
      request: { params: idParams },
      responses: { 200: { description: "Session and trail" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await support.get(params.id)));
      },
    }),

    // --- users & access support ---
    defineRoute({
      method: "get",
      path: `${BASE}/users/search`,
      summary: "Find a person across tenants by email or phone",
      tags: ["console: support"],
      access: access.platform("platform.users.search"),
      request: { query: z.object({ identifier: z.string().trim().min(5).max(200) }) },
      responses: { 200: { description: "Tenants and the user in each" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await users.search(query.identifier)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/users`,
      summary: "A tenant's users (status, lockout, last sign-in; no business data)",
      tags: ["console: support"],
      access: access.platform("platform.users.search"),
      request: { params: idParams },
      responses: { 200: { description: "Users" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await users.users(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/users/:userId/:action`,
      summary: "Help a user: reset-password (emails a code), unlock, force-logout, disable, enable",
      tags: ["console: support"],
      access: access.platform("platform.users.reset_access"),
      request: {
        params: z.object({
          id: uuid,
          userId: uuid,
          action: z
            .enum(["reset-password", "unlock", "force-logout", "disable", "enable"])
            .transform(
              (a) =>
                a.replace("-", "_") as
                  "reset_password" | "unlock" | "force_logout" | "disable" | "enable",
            ),
        }),
        body: z.object({ reason }),
      },
      responses: { 200: { description: "User" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await users.act(params.id, params.userId, params.action, body.reason, staffOf(res)),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/owner-recovery`,
      summary: "Owner recovery: a new sign-in email after identity checks (Super Admin approves)",
      tags: ["console: support"],
      access: access.platform("platform.users.recover_owner"),
      request: {
        params: idParams,
        body: z.object({
          newEmail: z.email(),
          identityChecks: z.string().trim().min(10).max(2_000),
          reason,
          ticket: z.string().trim().max(120).nullish(),
        }),
      },
      responses: { 202: { description: "Waiting for approval" } },
      handler: async ({ params, body }, _req, res) => {
        const approvalId = await users.requestOwnerRecovery(params.id, body, staffOf(res));
        res.status(202).json(envelope({ approvalId }));
      },
    }),

    // --- announcements and maintenance ---
    defineRoute({
      method: "post",
      path: `${BASE}/announcements`,
      summary: "Draft an announcement (banner, and optionally email to owners)",
      tags: ["console: communications"],
      access: access.platform("platform.support.announcements.manage"),
      request: {
        body: z.object({
          title: z.string().trim().max(120),
          body: z.string().trim().max(2_000),
          severity: severity.default("info"),
          audience: z
            .object({
              statuses: z.array(z.string().max(30)).max(10).optional(),
              licenceTypes: licenceTypes.optional(),
              tenantIds: z.array(uuid).max(1_000).optional(),
            })
            .default({}),
          email: z.boolean().default(false),
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
        }),
      },
      responses: { 201: { description: "Draft" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await communications.create(body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/announcements`,
      summary: "Announcements (newest first)",
      tags: ["console: communications"],
      access: access.platform("platform.support.announcements.manage"),
      request: {
        query: z.object({
          status: z.enum(["draft", "awaiting_approval", "published", "withdrawn"]).optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Announcements" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await communications.list(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/announcements/:id`,
      summary: "An announcement with its reach and reads",
      tags: ["console: communications"],
      access: access.platform("platform.support.announcements.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Announcement" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await communications.get(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/announcements/:id/publish`,
      summary: "Publish (emailing many tenants waits for a Super Admin's approval)",
      tags: ["console: communications"],
      access: access.platform("platform.support.announcements.manage"),
      request: { params: idParams },
      responses: {
        200: { description: "Published" },
        202: { description: "Waiting for approval" },
      },
      handler: async ({ params }, _req, res) => {
        const result = await communications.publish(params.id, staffOf(res));
        res.status(result.status === "awaiting_approval" ? 202 : 200).json(envelope(result));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/announcements/:id/withdraw`,
      summary: "Withdraw an announcement",
      tags: ["console: communications"],
      access: access.platform("platform.support.announcements.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Withdrawn" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await communications.withdraw(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/maintenance-windows`,
      summary: "Schedule maintenance (countdown banner; optionally read-only for every tenant)",
      tags: ["console: communications"],
      access: access.platform("platform.support.maintenance.manage"),
      request: {
        body: z.object({
          title: z.string().trim().max(120),
          message: z.string().trim().max(1_000),
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
          readOnly: z.boolean().default(false),
        }),
      },
      responses: { 201: { description: "Window" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await communications.schedule(body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/maintenance-windows`,
      summary: "Maintenance windows",
      tags: ["console: communications"],
      access: access.platform("platform.health.view"),
      request: { query: z.object({ limit }) },
      responses: { 200: { description: "Windows" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await communications.windows(query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/maintenance-windows/:id/cancel`,
      summary: "Cancel a maintenance window",
      tags: ["console: communications"],
      access: access.platform("platform.support.maintenance.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Cancelled" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await communications.cancel(params.id, staffOf(res))));
      },
    }),

    // --- feature flags and entitlement overrides ---
    defineRoute({
      method: "get",
      path: `${BASE}/flags`,
      summary: "Feature flags and kill switches",
      tags: ["console: flags"],
      access: access.platform("platform.health.view"),
      responses: { 200: { description: "Flags" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await flags.list()));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/flags`,
      summary: "Add a feature flag or kill switch",
      tags: ["console: flags"],
      access: access.platform("platform.flags.manage"),
      request: {
        body: z.object({
          key: flagKey,
          description: z.string().trim().max(300),
          kind: z.enum(["feature", "kill_switch"]),
          enabled: z.boolean(),
          rolloutPercent: z.number().int().optional(),
          licenceTypes: licenceTypes.optional(),
          routePrefixes: routePrefixes.optional(),
        }),
      },
      responses: { 201: { description: "Flag" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await flags.create(body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/flags/:key`,
      summary: "A flag with its per-tenant overrides",
      tags: ["console: flags"],
      access: access.platform("platform.health.view"),
      request: { params: z.object({ key: flagKey }) },
      responses: { 200: { description: "Flag" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await flags.get(params.key)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/flags/:key`,
      summary: "Change a flag (turning a kill switch off stops the feature for everyone)",
      tags: ["console: flags"],
      access: access.platform("platform.flags.manage"),
      request: {
        params: z.object({ key: flagKey }),
        body: z.object({
          description: z.string().trim().max(300).optional(),
          enabled: z.boolean().optional(),
          rolloutPercent: z.number().int().optional(),
          licenceTypes: licenceTypes.optional(),
          routePrefixes: routePrefixes.optional(),
          reason,
        }),
      },
      responses: { 200: { description: "Flag" } },
      handler: async ({ params, body }, _req, res) => {
        const { reason: why, ...changes } = body;
        res.json(envelope(await flags.update(params.key, changes, why, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/flags/:key/resolve`,
      summary: "Flag debugger: what a flag resolves to for a tenant, and why",
      tags: ["console: flags"],
      access: access.platform("platform.health.view"),
      request: { params: z.object({ key: flagKey }), query: z.object({ tenantId: uuid }) },
      responses: { 200: { description: "Resolution" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await flags.resolve(params.key, query.tenantId)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/tenants/:id/flags/:key`,
      summary: "Turn a feature on or off for one tenant (module toggle)",
      tags: ["console: flags"],
      access: access.platform("platform.flags.manage"),
      request: {
        params: z.object({ id: uuid, key: flagKey }),
        body: z.object({ enabled: z.boolean(), reason }),
      },
      responses: { 200: { description: "Override" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await flags.setOverride(params.key, params.id, body.enabled, body.reason, staffOf(res)),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/tenants/:id/flags/:key/clear`,
      summary: "Remove a tenant's override (the flag decides again)",
      tags: ["console: flags"],
      access: access.platform("platform.flags.manage"),
      request: { params: z.object({ id: uuid, key: flagKey }), body: z.object({ reason }) },
      responses: { 204: { description: "Cleared" } },
      handler: async ({ params, body }, _req, res) => {
        await flags.clearOverride(params.key, params.id, body.reason, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/tenants/:id/entitlements/branches`,
      summary: "Allow more active branches than billed (null removes the override)",
      tags: ["console: flags"],
      access: access.platform("platform.entitlements.override"),
      request: {
        params: idParams,
        body: z.object({ branches: z.number().int().nullable(), reason }),
      },
      responses: { 200: { description: "Subscription" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await subscriptions.setBranchLimitOverride(
              params.id,
              body.branches,
              body.reason,
              staffOf(res),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/tenants/:id/usage`,
      summary: "A tenant's daily usage (active users, API calls, records, size)",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.view"),
      request: {
        params: idParams,
        query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      },
      responses: { 200: { description: "Days" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await usage.history(params.id, query.days)));
      },
    }),

    // --- what tenants see ---
    defineRoute({
      method: "get",
      path: "/api/v1/announcements",
      summary: "Platform announcements and upcoming maintenance for your business",
      tags: ["platform"],
      access: access.signedIn(),
      responses: { 200: { description: "Announcements and maintenance" } },
      handler: async (_input, _req, res) => {
        res.json(
          envelope(await communications.forTenant(tenantOf(res).id, principalOf(res).userId)),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/announcements/:id/read",
      summary: "Mark an announcement read",
      tags: ["platform"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: { params: idParams },
      responses: { 204: { description: "Read" } },
      handler: async ({ params }, _req, res) => {
        await communications.markRead(params.id, tenantOf(res).id, principalOf(res).userId);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/features",
      summary: "Which features are on for your business",
      tags: ["platform"],
      access: access.signedIn(),
      responses: { 200: { description: "Flag key → on/off" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await flags.forTenant(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/settings/support-access",
      summary: "The support-access log: when Autoforce staff opened your business, and why",
      tags: ["settings"],
      access: access.permission("audit.view"),
      responses: { 200: { description: "Whether it is shown, and the sessions" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await support.tenantLog(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/settings/support-access",
      summary: "Show or hide the support-access log to your users (Autoforce keeps its trail)",
      tags: ["settings"],
      access: access.permission("settings.update"),
      request: { body: z.object({ visible: z.boolean() }) },
      responses: { 204: { description: "Saved" } },
      handler: async ({ body }, _req, res) => {
        await support.setTenantLogVisible(tenantOf(res).id, body.visible);
        res.status(204).end();
      },
    }),
  ];
}
