import type { Request } from "express";
import { z } from "zod";
import type { RefreshAuthSession } from "../../application/use-cases/auth/RefreshAuthSession.js";
import type { RevokeAuthSession } from "../../application/use-cases/auth/RevokeAuthSession.js";
import { type OrganisationAdministration } from "../../application/use-cases/identity/OrganisationAdministration.js";
import type { RoleAdministration } from "../../application/use-cases/identity/RoleAdministration.js";
import type { SessionManagement } from "../../application/use-cases/identity/SessionManagement.js";
import type { TenantSignIn } from "../../application/use-cases/identity/TenantSignIn.js";
import type { UserAdministration } from "../../application/use-cases/identity/UserAdministration.js";
import type { AuthenticationResult } from "../../application/dto/AuthenticationResult.js";
import { principalOf, tenantOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const identifier = z.string().trim().min(3).max(320);
const password = z.string().min(1).max(200);
const newPassword = z.string().max(200);
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const reason = z.string().trim().min(5).max(1_000);
const scope = z.enum(["own", "branch", "all"]);
const grants = z
  .array(
    z.object({
      key: z.string().min(3).max(100),
      scope,
      limits: z.record(z.string(), z.number()).nullish(),
    }),
  )
  .max(300);
const assignments = z.array(z.object({ roleId: uuid, branchId: uuid.nullable() })).max(50);

const userAgentOf = (req: Request) => req.get("user-agent")?.slice(0, 512) ?? null;
const json = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
const tokens = (r: AuthenticationResult) =>
  envelope({
    sessionId: r.sessionId,
    accessToken: r.accessToken,
    accessTokenExpiresAt: r.accessTokenExpiresAt.toISOString(),
    refreshToken: r.refreshToken,
    refreshTokenExpiresAt: r.refreshTokenExpiresAt.toISOString(),
  });

export type IdentityRouteDependencies = Readonly<{
  signIn: TenantSignIn;
  refresh: RefreshAuthSession;
  revoke: RevokeAuthSession;
  sessions: SessionManagement;
  users: UserAdministration;
  roles: RoleAdministration;
  organisation: OrganisationAdministration;
}>;

/** Tenant sign-in, sessions, users, roles, organisation settings and branch management. */
export function identityRoutes(deps: IdentityRouteDependencies): ApiRoute[] {
  return [
    // --- sign-in (X-Tenant) ---
    defineRoute({
      method: "post",
      path: "/api/v1/auth/login",
      summary: "Sign in with email or phone and password",
      tags: ["auth"],
      access: access.tenant(),
      request: { body: z.object({ identifier, password }) },
      responses: { 200: { description: "Session tokens" } },
      handler: async ({ body }, req, res) => {
        res.json(tokens(await deps.signIn.login(body.identifier, body.password, userAgentOf(req))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/auth/refresh",
      summary: "Rotate the refresh token and get a new access token",
      tags: ["auth"],
      access: access.tenant(),
      request: { body: z.object({ refreshToken: z.string().min(20).max(500) }) },
      responses: { 200: { description: "Session tokens" } },
      handler: async ({ body }, _req, res) => {
        res.json(tokens(await deps.refresh.execute(body.refreshToken)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/auth/password-reset",
      summary: "Email a password reset code (always answers 202)",
      tags: ["auth"],
      access: access.tenant(),
      request: { body: z.object({ identifier }) },
      responses: { 202: { description: "If the account exists, a code was sent" } },
      handler: async ({ body }, _req, res) => {
        await deps.signIn.requestPasswordReset(body.identifier);
        res.status(202).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/auth/password-reset/confirm",
      summary: "Set a new password with the emailed code (signs out everywhere)",
      tags: ["auth"],
      access: access.tenant(),
      request: {
        body: z.object({ identifier, code: z.string().regex(/^\d{6}$/), newPassword }),
      },
      responses: { 204: { description: "Password changed; sign in again" } },
      handler: async ({ body }, _req, res) => {
        await deps.signIn.confirmPasswordReset(body.identifier, body.code, body.newPassword);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/auth/discover",
      summary: "Businesses you can sign in to with these credentials (mobile app)",
      tags: ["auth"],
      access: access.public(),
      request: { body: z.object({ identifier, password }) },
      responses: { 200: { description: "Matching businesses (slug and name)" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await deps.signIn.discover(body.identifier, body.password)));
      },
    }),

    // --- me ---
    defineRoute({
      method: "post",
      path: "/api/v1/auth/logout",
      summary: "End the current session",
      tags: ["auth"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      responses: { 204: { description: "Signed out" } },
      handler: async (_input, _req, res) => {
        const me = principalOf(res);
        await deps.revoke.execute({
          sessionId: me.sessionId,
          reason: "logout",
          actorId: me.userId,
        });
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/permissions",
      summary: "Your permissions with their scope and branches",
      tags: ["me"],
      access: access.signedIn(),
      responses: { 200: { description: "Permissions" } },
      handler: (_input, _req, res) => {
        const me = principalOf(res);
        res.json(
          envelope({
            branchIds: me.branchIds,
            permissions: me.grantedPermissions().map(([key, grant]) => ({ key, ...grant })),
          }),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/password",
      summary: "Change your password (signs out everywhere)",
      tags: ["me"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: { body: z.object({ currentPassword: password, newPassword }) },
      responses: { 204: { description: "Changed; sign in again" } },
      handler: async ({ body }, _req, res) => {
        await deps.signIn.changePassword(principalOf(res), body.currentPassword, body.newPassword);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/sessions",
      summary: "Where you are signed in",
      tags: ["me"],
      access: access.signedIn(),
      responses: { 200: { description: "Active sessions" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(json(await deps.sessions.mine(principalOf(res)))));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/me/sessions/:id",
      summary: "Sign out one of your sessions",
      tags: ["me"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: { params: idParams },
      responses: { 204: { description: "Signed out" } },
      handler: async ({ params }, _req, res) => {
        await deps.sessions.revokeMine(principalOf(res), params.id);
        res.status(204).end();
      },
    }),

    // --- users ---
    defineRoute({
      method: "get",
      path: "/api/v1/users",
      summary: "Users (within your branches unless you have all-branch access)",
      tags: ["users"],
      access: access.permission("users.list"),
      request: {
        query: z.object({
          status: z.enum(["invited", "active", "disabled"]).optional(),
          search: z.string().trim().max(100).optional(),
          before: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Users" } },
      handler: async ({ query }, _req, res) => {
        const users = await deps.users.list(principalOf(res), query);
        res.json(
          envelope(json(users), {
            nextBefore: users.length === query.limit ? (users.at(-1)?.id ?? null) : null,
          }),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/users/:id",
      summary: "A user with their branches and roles",
      tags: ["users"],
      access: access.permission("users.view"),
      request: { params: idParams },
      responses: { 200: { description: "User" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(json(await deps.users.get(principalOf(res), params.id))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/users/invitations",
      summary: "Invite a user (emailed link to set a password)",
      tags: ["users"],
      access: access.permission("users.invite"),
      request: {
        body: z.object({
          name: z.string().trim().min(1).max(120),
          email: z.email().max(320),
          phone: z.string().trim().max(30).nullish(),
          branchIds: z.array(uuid).min(1).max(50),
          roles: assignments.default([]),
        }),
      },
      responses: { 201: { description: "Invited" } },
      handler: async ({ body }, _req, res) => {
        const id = await deps.users.invite(principalOf(res), body, tenantOf(res).slug);
        res.status(201).json(envelope({ id }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/users/:id/invitation/resend",
      summary: "Send a new invitation link",
      tags: ["users"],
      access: access.permission("users.invite"),
      request: { params: idParams },
      responses: { 204: { description: "Sent" } },
      handler: async ({ params }, _req, res) => {
        await deps.users.resendInvitation(principalOf(res), params.id, tenantOf(res).slug);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/users/:id",
      summary: "Update a user's name, phone or branches",
      tags: ["users"],
      access: access.permission("users.update"),
      request: {
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          phone: z.string().trim().max(30).nullable().optional(),
          branchIds: z.array(uuid).min(1).max(50).optional(),
        }),
      },
      responses: { 204: { description: "Updated" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.users.update(principalOf(res), params.id, body);
        res.status(204).end();
      },
    }),
    ...(["disable", "enable"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `/api/v1/users/:id/${action}`,
        summary:
          action === "disable" ? "Disable a user (signs them out everywhere)" : "Re-enable a user",
        tags: ["users"],
        access: access.permission("users.disable"),
        request: { params: idParams, body: z.object({ reason }) },
        responses: { 204: { description: "Done" } },
        handler: async ({ params, body }, _req, res) => {
          await deps.users[action](principalOf(res), params.id, body.reason);
          res.status(204).end();
        },
      }),
    ),
    defineRoute({
      method: "put",
      path: "/api/v1/users/:id/roles",
      summary: "Replace a user's role assignments (per branch or for all their branches)",
      tags: ["users"],
      access: access.permission("roles.assign"),
      request: {
        params: idParams,
        body: z.object({ assignments, reason: z.string().trim().max(1_000).nullish() }),
      },
      responses: { 204: { description: "Updated" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.users.setRoles(
          principalOf(res),
          params.id,
          body.assignments,
          body.reason ?? null,
        );
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/users/:id/sessions/revoke",
      summary: "Sign a user out everywhere",
      tags: ["users"],
      access: access.permission("sessions.revoke"),
      request: { params: idParams },
      responses: { 200: { description: "Number of sessions ended" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope({ revoked: await deps.sessions.revokeAllFor(principalOf(res), params.id) }),
        );
      },
    }),

    // --- roles and permissions ---
    defineRoute({
      method: "get",
      path: "/api/v1/roles",
      summary: "Roles with their permissions and number of holders",
      tags: ["roles"],
      access: access.permission("roles.list"),
      responses: { 200: { description: "Roles" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.roles.list()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/roles/:id",
      summary: "A role",
      tags: ["roles"],
      access: access.permission("roles.view"),
      request: { params: idParams },
      responses: { 200: { description: "Role" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deps.roles.get(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/roles",
      summary: "Create a custom role (optionally cloned from another role)",
      tags: ["roles"],
      access: access.permission("roles.create"),
      request: {
        body: z.object({
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(500).default(""),
          grants: grants.default([]),
          basedOnRoleId: uuid.nullish(),
        }),
      },
      responses: { 201: { description: "Created" } },
      handler: async ({ body }, _req, res) => {
        const id = await deps.roles.create(principalOf(res), {
          ...body,
          grants: body.grants.map((g) => ({
            key: g.key,
            scope: g.scope,
            limits: g.limits ?? null,
          })),
        });
        res.status(201).json(envelope({ id }));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/roles/:id",
      summary: "Edit a custom role (holders are re-evaluated at once)",
      tags: ["roles"],
      access: access.permission("roles.update"),
      request: {
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(500).default(""),
          grants,
        }),
      },
      responses: { 204: { description: "Updated" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.roles.update(principalOf(res), params.id, {
          ...body,
          grants: body.grants.map((g) => ({
            key: g.key,
            scope: g.scope,
            limits: g.limits ?? null,
          })),
        });
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/roles/:id",
      summary: "Delete a custom role nobody holds",
      tags: ["roles"],
      access: access.permission("roles.delete"),
      request: { params: idParams },
      responses: { 204: { description: "Deleted" } },
      handler: async ({ params }, _req, res) => {
        await deps.roles.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/permissions",
      summary: "The permissions your business can grant",
      tags: ["roles"],
      access: access.permission("permissions.list"),
      responses: { 200: { description: "Permissions" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.roles.permissions()));
      },
    }),

    // --- organisation, numbering, branches ---
    defineRoute({
      method: "get",
      path: "/api/v1/organisation",
      summary: "Business profile and settings",
      tags: ["organisation"],
      access: access.permission("organisation.view"),
      responses: { 200: { description: "Organisation" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await deps.organisation.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/organisation",
      summary: "Update the business profile (base currency: /settings/currency)",
      tags: ["organisation"],
      access: access.permission("organisation.update"),
      request: {
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          legalName: z.string().trim().max(200).nullable().optional(),
          timezone: z.string().trim().min(3).max(64).optional(),
          tin: z.string().trim().max(40).nullable().optional(),
          registrationNumber: z.string().trim().max(60).nullable().optional(),
          contactEmail: z.email().max(320).nullable().optional(),
          contactPhone: z.string().trim().max(30).nullable().optional(),
        }),
      },
      responses: { 200: { description: "Updated organisation" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await deps.organisation.update(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/settings/numbering",
      summary: "Document numbering formats",
      tags: ["organisation"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Numbering formats by document type" } },
      handler: async (_input, _req, res) => {
        res.json(envelope((await deps.organisation.get()).numbering));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/settings/numbering",
      summary: "Set document numbering formats (e.g. invoice: INV-2026-000123)",
      tags: ["organisation"],
      access: access.permission("settings.numbering.manage"),
      request: {
        body: z.record(
          z.string().regex(/^[a-z][a-z_]{1,39}$/),
          z.object({
            prefix: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
            padding: z.number().int().min(1).max(12),
            yearly: z.boolean(),
          }),
        ),
      },
      responses: { 204: { description: "Saved" } },
      handler: async ({ body }, _req, res) => {
        await deps.organisation.setNumbering(principalOf(res), body);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/branches/:id",
      summary: "Edit a branch",
      tags: ["branches"],
      access: access.permission("branches.update"),
      request: {
        params: idParams,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          address: z.string().trim().max(500).nullable().optional(),
          phone: z.string().trim().max(30).nullable().optional(),
        }),
      },
      responses: { 204: { description: "Updated" } },
      handler: async ({ params, body }, _req, res) => {
        await deps.organisation.updateBranch(principalOf(res), params.id, body);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/branches/:id/make-default",
      summary: "Make a branch the default (head office)",
      tags: ["branches"],
      access: access.permission("branches.update"),
      request: { params: idParams },
      responses: { 204: { description: "Done" } },
      handler: async ({ params }, _req, res) => {
        await deps.organisation.makeDefault(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
  ];
}
