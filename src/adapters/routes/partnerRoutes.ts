import type { Request } from "express";
import { z } from "zod";
import type { TenantStatus } from "../../application/ports/ITenantDirectory.js";
import type { PartnerAdministration } from "../../application/use-cases/partners/PartnerAdministration.js";
import type { PartnerPortal } from "../../application/use-cases/partners/PartnerPortal.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { replyBody, signupBody } from "./applicationRoutes.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const STAFF_TAGS = ["console: partners"];
const PARTNER_TAGS = ["partner portal"];

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const reason = z.string().trim().min(5, "Give a reason of at least 5 characters").max(1_000);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const optionalText = (max: number) => z.string().trim().max(max).nullish();
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
const tenantFilter = z.object({
  status: z
    .string()
    .max(200)
    .transform((value) =>
      value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(TENANT_STATUSES as [TenantStatus, ...TenantStatus[]])))
    .optional(),
  q: z.string().trim().min(2).max(120).optional(),
  before: uuid.optional(),
  limit,
});
const applicationStatus = z.enum([
  "pending_verification",
  "pending_review",
  "needs_info",
  "approved",
  "rejected",
]);
const profileFields = {
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["individual", "company"]),
  contactName: z.string().trim().min(2).max(120),
  email: z.email().max(320),
  phone: z.string().trim().min(6).max(30),
  region: optionalText(120),
  address: optionalText(500),
  tin: optionalText(40),
};
const invitation = z.object({ email: z.email().max(320), name: z.string().trim().min(1).max(120) });

const context = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.get("user-agent")?.slice(0, 512) ?? null,
});
const nextBefore = (items: readonly { id: string }[], pageSize: number) =>
  items.length === pageSize ? (items.at(-1)?.id ?? null) : null;

export type PartnerRouteDependencies = Readonly<{
  administration: PartnerAdministration;
  portal: PartnerPortal;
}>;

/**
 * Reseller programme (docs/29 §8): staff manage partners under `/partners`; a reseller's own
 * console is under `/partner`, always scoped to the signed-in user's partner.
 */
export function partnerRoutes({ administration, portal }: PartnerRouteDependencies): ApiRoute[] {
  return [
    // --- staff: partner profiles ---
    defineRoute({
      method: "get",
      path: `${BASE}/partners`,
      summary: "Partners (newest first)",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.view"),
      request: {
        query: z.object({
          status: z.enum(["active", "paused", "terminated"]).optional(),
          q: z.string().trim().min(2).max(120).optional(),
          before: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Partners with user, tenant and application counts" } },
      handler: async ({ query }, _req, res) => {
        const partners = await administration.list(query);
        res.json(envelope(partners, { nextBefore: nextBefore(partners, query.limit) }));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partners`,
      summary: "Create a partner (default capabilities; referral code generated unless given)",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.manage"),
      request: {
        body: z.object({
          ...profileFields,
          region: profileFields.region.default(null),
          address: profileFields.address.default(null),
          tin: profileFields.tin.default(null),
          referralCode: z.string().trim().max(16).optional(),
        }),
      },
      responses: { 201: { description: "Created" }, 409: { description: "Email or code in use" } },
      handler: async ({ body }, _req, res) => {
        const id = await administration.create(
          {
            ...body,
            region: body.region ?? null,
            address: body.address ?? null,
            tin: body.tin ?? null,
          },
          staffOf(res),
        );
        res.status(201).json(envelope(await administration.get(id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id`,
      summary: "Partner profile, capabilities and console users",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.view"),
      request: { params: idParams },
      responses: { 200: { description: "Partner" }, 404: { description: "Unknown partner" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await administration.get(params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/partners/:id`,
      summary: "Edit a partner's profile, referral code or trusted flag",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.manage"),
      request: {
        params: idParams,
        body: z.object({
          name: profileFields.name.optional(),
          kind: profileFields.kind.optional(),
          contactName: profileFields.contactName.optional(),
          email: profileFields.email.optional(),
          phone: profileFields.phone.optional(),
          region: profileFields.region,
          address: profileFields.address,
          tin: profileFields.tin,
          trusted: z.boolean().optional(),
          referralCode: z.string().trim().max(16).optional(),
        }),
      },
      responses: { 200: { description: "Partner" } },
      handler: async ({ params, body }, _req, res) => {
        const changes = Object.fromEntries(
          Object.entries(body).filter(([, value]) => value !== undefined),
        ) as Parameters<PartnerAdministration["update"]>[1];
        await administration.update(params.id, changes, staffOf(res));
        res.json(envelope(await administration.get(params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/partners/:id/capabilities`,
      summary: "Set what the partner's users may see and do (docs/29 §7)",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.permissions.grant"),
      request: {
        params: idParams,
        body: z.object({ capabilities: z.array(z.string().max(80)).max(50), reason }),
      },
      responses: { 200: { description: "Partner" } },
      handler: async ({ params, body }, _req, res) => {
        await administration.setCapabilities(
          params.id,
          body.capabilities,
          staffOf(res),
          body.reason,
        );
        res.json(envelope(await administration.get(params.id)));
      },
    }),
    ...(["pause", "resume"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `${BASE}/partners/:id/${action}`,
        summary:
          action === "pause"
            ? "Pause a partner (no new clients; tenants and access stay)"
            : "Resume a paused partner",
        tags: STAFF_TAGS,
        access: access.platform("platform.partners.manage"),
        request: { params: idParams, body: z.object({ reason }) },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await administration[action](params.id, body.reason, staffOf(res));
          res.status(204).end();
        },
      }),
    ),
    defineRoute({
      method: "post",
      path: `${BASE}/partners/:id/terminate`,
      summary: "Terminate a partner (final; users disabled, attributed tenants keep the partner)",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.terminate"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 204: { description: "Terminated" } },
      handler: async ({ params, body }, _req, res) => {
        await administration.terminate(params.id, body.reason, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partners/:id/users/invitations`,
      summary: "Invite a console user for the partner (emailed link; MFA enrolment required)",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.manage"),
      request: { params: idParams, body: invitation },
      responses: { 201: { description: "Invited" } },
      handler: async ({ params, body }, _req, res) => {
        const result = await administration.inviteUser(params.id, body, staffOf(res));
        res.status(201).json(envelope({ userId: result.userId, expiresAt: result.expiresAt }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/tenants`,
      summary: "Tenants attributed to a partner",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.view"),
      request: { params: idParams, query: tenantFilter },
      responses: { 200: { description: "Tenants" } },
      handler: async ({ params, query }, _req, res) => {
        const tenants = await administration.tenants(params.id, query);
        res.json(
          envelope(tenants, {
            nextBefore: tenants.length === query.limit ? (tenants.at(-1)?.tenantId ?? null) : null,
          }),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/tenants/:id/partner`,
      summary: "Assign, change or remove the partner a tenant is attributed to",
      tags: STAFF_TAGS,
      access: access.platform("platform.partners.attribution.manage"),
      request: { params: idParams, body: z.object({ partnerId: uuid.nullable(), reason }) },
      responses: { 204: { description: "Done" } },
      handler: async ({ params, body }, _req, res) => {
        await administration.assignTenant(params.id, body.partnerId, body.reason, staffOf(res));
        res.status(204).end();
      },
    }),

    // --- partner portal (scoped to the signed-in user's partner) ---
    defineRoute({
      method: "get",
      path: `${BASE}/partner/dashboard`,
      summary: "Your tenants and applications at a glance",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.tenants.view"),
      responses: { 200: { description: "Counts" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await portal.dashboard(staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/profile`,
      summary: "Your partner profile, capabilities and referral link",
      tags: PARTNER_TAGS,
      access: access.partner(),
      responses: { 200: { description: "Profile" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await portal.profile(staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/tenants`,
      summary: "Businesses you brought on board",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.tenants.view"),
      request: { query: tenantFilter },
      responses: { 200: { description: "Tenants; owner contact and billing state if granted" } },
      handler: async ({ query }, _req, res) => {
        const tenants = await portal.tenants(staffOf(res), query);
        res.json(envelope(tenants, { nextBefore: nextBefore(tenants, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/tenants/:id`,
      summary: "One of your businesses, with its status history",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.tenants.view"),
      request: { params: idParams },
      responses: { 200: { description: "Tenant" }, 404: { description: "Not one of yours" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await portal.tenant(staffOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/applications`,
      summary: "Applications for your clients",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.tenants.view"),
      request: {
        query: z.object({ status: applicationStatus.optional(), before: uuid.optional(), limit }),
      },
      responses: { 200: { description: "Applications" } },
      handler: async ({ query }, _req, res) => {
        const items = await portal.applications(staffOf(res), query);
        res.json(envelope(items, { nextBefore: nextBefore(items, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/applications/:id`,
      summary: "One application with the messages exchanged",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.tenants.view"),
      request: { params: idParams },
      responses: { 200: { description: "Application" }, 404: { description: "Not one of yours" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await portal.application(staffOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partner/applications`,
      summary: "Sign up a new client (they verify their email and phone)",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.applications.create"),
      request: { body: signupBody.omit({ referralCode: true }) },
      responses: { 201: { description: "Created; the client receives the private link by email" } },
      handler: async ({ body }, req, res) => {
        const { acceptTerms: _accepted, ...input } = body;
        const result = await portal.createApplication(staffOf(res), input, context(req));
        res
          .status(201)
          .json(envelope({ applicationId: result.applicationId, status: result.status }));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partner/applications/:id/respond`,
      summary: "Answer an information request for your client",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.applications.respond"),
      request: { params: idParams, body: replyBody },
      responses: { 200: { description: "Application" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await portal.respond(staffOf(res), params.id, body.message, body.corrections)),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/users`,
      summary: "Your colleagues' console accounts",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.users.manage"),
      responses: { 200: { description: "Users" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await portal.users(staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partner/users/invitations`,
      summary: "Invite a colleague",
      tags: PARTNER_TAGS,
      access: access.partner("platform.partner.users.manage"),
      request: { body: invitation },
      responses: { 201: { description: "Invited" } },
      handler: async ({ body }, _req, res) => {
        const result = await portal.inviteUser(staffOf(res), body);
        res.status(201).json(envelope({ userId: result.userId, expiresAt: result.expiresAt }));
      },
    }),
    ...(["disable", "enable"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `${BASE}/partner/users/:id/${action}`,
        summary: `${action === "disable" ? "Disable" : "Enable"} a colleague's account`,
        tags: PARTNER_TAGS,
        access: access.partner("platform.partner.users.manage"),
        request: { params: idParams, body: z.object({ reason }) },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await portal.setUserEnabled(staffOf(res), params.id, action === "enable", body.reason);
          res.status(204).end();
        },
      }),
    ),
  ];
}
