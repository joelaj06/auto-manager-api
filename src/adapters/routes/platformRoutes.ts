import type { Request } from "express";
import { z } from "zod";
import { isPlatformPermissionKey } from "../../application/authorization/platformPermissionCatalog.js";
import type { AuthenticationResult } from "../../application/dto/AuthenticationResult.js";
import type { IPlatformAuditTrail } from "../../application/ports/IPlatformAuditTrail.js";
import type { ApprovalWorkflow } from "../../application/use-cases/platform/ApprovalWorkflow.js";
import type { StaffAdministration } from "../../application/use-cases/platform/StaffAdministration.js";
import type { StaffSessions } from "../../application/use-cases/platform/StaffSessions.js";
import type { StaffSignIn } from "../../application/use-cases/platform/StaffSignIn.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const TAGS = {
  auth: ["console: auth"],
  staff: ["console: staff"],
  approvals: ["console: approvals"],
  audit: ["console: audit"],
};

const uuid = z.uuid();
const reason = z.string().trim().min(5, "Give a reason of at least 5 characters").max(1_000);
const code = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");
const challengeToken = z.string().min(20).max(2_000);
const permissionKey = z.string().refine(isPlatformPermissionKey, "Unknown permission");
const roleInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  permissions: z.array(permissionKey).max(200),
});
const idParams = z.object({ id: uuid });

const userAgentOf = (req: Request) => req.get("user-agent")?.slice(0, 512) ?? null;

const tokens = (result: AuthenticationResult) =>
  envelope({
    sessionId: result.sessionId,
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
  });

export type PlatformRouteDependencies = Readonly<{
  signIn: StaffSignIn;
  sessions: StaffSessions;
  administration: StaffAdministration;
  approvals: ApprovalWorkflow;
  audit: IPlatformAuditTrail;
}>;

/** Console API (docs/27 §7): staff sign-in, staff administration, approvals and the audit log. */
export function platformRoutes(deps: PlatformRouteDependencies): ApiRoute[] {
  const { signIn, sessions, administration, approvals, audit } = deps;
  return [
    // --- sign-in (public, rate-limited separately) ---
    defineRoute({
      method: "post",
      path: `${BASE}/auth/login`,
      summary: "Staff sign-in, step 1: email and password",
      tags: TAGS.auth,
      access: access.public(),
      request: {
        body: z.object({ email: z.email().max(320), password: z.string().min(1).max(200) }),
      },
      responses: {
        200: { description: "Next step: `mfa` (enter code) or `enrol` (set up authenticator)" },
      },
      handler: async ({ body }, _req, res) => {
        const step = await signIn.login(body.email, body.password);
        res.json(envelope({ ...step, expiresAt: step.expiresAt.toISOString() }));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/mfa`,
      summary: "Staff sign-in, step 2: authenticator code",
      tags: TAGS.auth,
      access: access.public(),
      request: { body: z.object({ challengeToken, code }) },
      responses: { 200: { description: "Session tokens" } },
      handler: async ({ body }, req, res) => {
        res.json(
          tokens(await signIn.completeMfa(body.challengeToken, body.code, userAgentOf(req))),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/mfa/enrol`,
      summary: "Start authenticator enrolment (returns the secret for the QR code)",
      tags: TAGS.auth,
      access: access.public(),
      request: { body: z.object({ challengeToken }) },
      responses: { 200: { description: "TOTP secret and otpauth URI" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await signIn.beginTotpEnrolment(body.challengeToken)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/mfa/enrol/confirm`,
      summary: "Confirm authenticator enrolment with a first code",
      tags: TAGS.auth,
      access: access.public(),
      request: { body: z.object({ challengeToken, code }) },
      responses: { 200: { description: "Session tokens" } },
      handler: async ({ body }, req, res) => {
        res.json(
          tokens(
            await signIn.confirmTotpEnrolment(body.challengeToken, body.code, userAgentOf(req)),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/invitations/accept`,
      summary: "Accept a staff invitation and set the password",
      tags: TAGS.auth,
      access: access.public(),
      request: {
        body: z.object({ token: z.string().min(20).max(200), password: z.string().max(200) }),
      },
      responses: { 200: { description: "Next step: `enrol`" } },
      handler: async ({ body }, _req, res) => {
        const step = await signIn.acceptInvitation(body.token, body.password);
        res.json(envelope({ ...step, expiresAt: step.expiresAt.toISOString() }));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/refresh`,
      summary: "Rotate the refresh token and get a new access token",
      tags: TAGS.auth,
      access: access.public(),
      request: { body: z.object({ refreshToken: z.string().min(20).max(500) }) },
      responses: { 200: { description: "Session tokens" } },
      handler: async ({ body }, _req, res) => {
        res.json(tokens(await sessions.refresh(body.refreshToken)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/logout`,
      summary: "End the current session",
      tags: TAGS.auth,
      access: access.staff(),
      responses: { 204: { description: "Signed out" } },
      handler: async (_input, _req, res) => {
        await sessions.logout(staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/auth/step-up`,
      summary: "Re-authenticate (password + code) before sensitive actions",
      tags: TAGS.auth,
      access: access.staff(),
      request: { body: z.object({ password: z.string().min(1).max(200), code }) },
      responses: { 204: { description: "Sensitive actions allowed for the next minutes" } },
      handler: async ({ body }, _req, res) => {
        await signIn.stepUp(staffOf(res), body.password, body.code);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/me`,
      summary: "The signed-in staff member, roles and permissions",
      tags: TAGS.auth,
      access: access.staff(),
      responses: { 200: { description: "Current staff member" } },
      handler: (_input, _req, res) => {
        const staff = staffOf(res);
        res.json(
          envelope({
            id: staff.userId,
            email: staff.email,
            name: staff.name,
            systemRoles: [...staff.systemRoles].sort(),
            permissions: staff.permissionKeys,
            stepUpAt: staff.stepUpAt?.toISOString() ?? null,
          }),
        );
      },
    }),

    // --- staff administration ---
    defineRoute({
      method: "get",
      path: `${BASE}/staff`,
      summary: "Staff accounts",
      tags: TAGS.staff,
      access: access.platform("platform.staff.view"),
      responses: { 200: { description: "Staff with roles" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await administration.list()));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/staff/invitations`,
      summary: "Invite a staff member (email with a one-time link)",
      tags: TAGS.staff,
      access: access.platform("platform.staff.manage"),
      request: {
        body: z.object({
          email: z.email().max(320),
          name: z.string().trim().min(1).max(120),
          roleIds: z.array(uuid).min(1).max(20),
        }),
      },
      responses: { 201: { description: "Invitation sent" } },
      handler: async ({ body }, _req, res) => {
        const result = await administration.invite({ ...body, actor: staffOf(res) });
        res
          .status(201)
          .json(envelope({ userId: result.userId, expiresAt: result.expiresAt.toISOString() }));
      },
    }),
    ...(
      [
        ["disable", "Disable a staff account (ends all sessions)", "disable"],
        ["enable", "Re-enable a staff account", "enable"],
        ["reset-mfa", "Reset a staff member's authenticator (lost phone)", "resetMfa"],
      ] as const
    ).map(([action, summary, method]) =>
      defineRoute({
        method: "post",
        path: `${BASE}/staff/:id/${action}`,
        summary,
        tags: TAGS.staff,
        access: access.platform("platform.staff.manage"),
        request: { params: idParams, body: z.object({ reason }) },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await administration[method](params.id, staffOf(res), body.reason);
          res.status(204).end();
        },
      }),
    ),
    defineRoute({
      method: "put",
      path: `${BASE}/staff/:id/roles`,
      summary: "Replace a staff member's roles (granting Super Admin needs approval)",
      tags: TAGS.staff,
      access: access.platform("platform.staff.manage"),
      request: { params: idParams, body: z.object({ roleIds: z.array(uuid).max(20), reason }) },
      responses: {
        200: { description: "Applied" },
        202: { description: "Waiting for a second Super Admin's approval" },
      },
      handler: async ({ params, body }, _req, res) => {
        const result = await administration.setRoles(
          params.id,
          body.roleIds,
          staffOf(res),
          body.reason,
        );
        res.status(result.status === "applied" ? 200 : 202).json(envelope(result));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/roles`,
      summary: "Staff roles with their permissions",
      tags: TAGS.staff,
      access: access.platform("platform.staff.view"),
      responses: { 200: { description: "Roles" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await administration.listRoles()));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/roles`,
      summary: "Create a custom staff role",
      tags: TAGS.staff,
      access: access.platform("platform.roles.manage"),
      request: { body: roleInput },
      responses: { 201: { description: "Created" } },
      handler: async ({ body }, _req, res) => {
        const id = await administration.createRole(
          { ...body, permissions: body.permissions },
          staffOf(res),
        );
        res.status(201).json(envelope({ id }));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/roles/:id`,
      summary: "Edit a custom staff role (system roles are read-only)",
      tags: TAGS.staff,
      access: access.platform("platform.roles.manage"),
      request: { params: idParams, body: roleInput },
      responses: { 204: { description: "Updated" } },
      handler: async ({ params, body }, _req, res) => {
        await administration.updateRole(
          params.id,
          { ...body, permissions: body.permissions },
          staffOf(res),
        );
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/permissions`,
      summary: "The platform permission catalogue",
      tags: TAGS.staff,
      access: access.platform("platform.staff.view"),
      responses: { 200: { description: "Permissions" } },
      handler: (_input, _req, res) => {
        res.json(envelope(administration.listPermissions()));
      },
    }),

    // --- approvals (four-eyes) ---
    defineRoute({
      method: "get",
      path: `${BASE}/approvals`,
      summary: "Approval requests",
      tags: TAGS.approvals,
      access: access.staff(),
      request: {
        query: z.object({
          status: z.enum(["pending", "approved", "rejected", "expired", "failed"]).optional(),
        }),
      },
      responses: { 200: { description: "Requests, newest first" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await approvals.list(query.status ?? null)));
      },
    }),
    ...(["approve", "reject"] as const).map((decision) =>
      defineRoute({
        method: "post",
        path: `${BASE}/approvals/:id/${decision}`,
        summary: `${decision === "approve" ? "Approve (and execute)" : "Reject"} another staff member's request`,
        tags: TAGS.approvals,
        access: access.platform("platform.approvals.approve"),
        request: {
          params: idParams,
          body: z.object({ note: z.string().trim().max(1_000).optional() }),
        },
        responses: { 200: { description: "The decided request" } },
        handler: async ({ params, body }, _req, res) => {
          res.json(
            envelope(await approvals.decide(params.id, staffOf(res), decision, body.note ?? null)),
          );
        },
      }),
    ),

    // --- audit ---
    defineRoute({
      method: "get",
      path: `${BASE}/audit-logs`,
      summary: "Search the platform audit log (newest first)",
      tags: TAGS.audit,
      access: access.platform("platform.security.audit.view"),
      request: {
        query: z.object({
          actorId: uuid.optional(),
          action: z
            .string()
            .regex(/^[a-z][a-z0-9_.]*$/)
            .max(100)
            .optional(),
          targetTenantId: uuid.optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          before: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Audit entries" } },
      handler: async ({ query }, _req, res) => {
        const entries = await audit.search(query);
        res.json(
          envelope(entries, {
            nextBefore: entries.length === query.limit ? (entries.at(-1)?.id ?? null) : null,
          }),
        );
      },
    }),
  ];
}
