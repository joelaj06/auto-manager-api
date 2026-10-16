import { z } from "zod";
import type { AcceptUserInvitation } from "../../application/use-cases/auth/AcceptUserInvitation.js";
import type { ProvisioningConsole } from "../../application/use-cases/provisioning/ProvisioningConsole.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

export type ProvisioningRouteDependencies = Readonly<{
  console: ProvisioningConsole;
  acceptInvitation: AcceptUserInvitation;
}>;

/** Console: provisioning status and retry. Tenant: accept the owner's welcome link (first login). */
export function provisioningRoutes(deps: ProvisioningRouteDependencies): ApiRoute[] {
  const idParams = z.object({ id: z.uuid() });
  return [
    defineRoute({
      method: "get",
      path: "/api/platform/v1/tenants/:id/provisioning",
      summary: "Provisioning progress of a tenant",
      tags: ["console: tenants"],
      access: access.platform("platform.tenants.view"),
      request: { params: idParams },
      responses: { 200: { description: "Saga step, status, attempts, last error" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deps.console.status(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/platform/v1/tenants/:id/provisioning/retry",
      summary: "Retry failed provisioning (resumes from the failed step)",
      tags: ["console: tenants"],
      access: access.platform("platform.applications.approve"),
      request: { params: idParams },
      responses: { 202: { description: "Queued" } },
      handler: async ({ params }, _req, res) => {
        await deps.console.retry(params.id, staffOf(res));
        res.status(202).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/auth/invitations/accept",
      summary: "Set your password from an invitation link and sign in (X-Tenant required)",
      tags: ["auth"],
      access: access.tenant(),
      request: {
        body: z.object({
          token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
          password: z.string().max(200),
        }),
      },
      responses: { 200: { description: "Session tokens" } },
      handler: async ({ body }, req, res) => {
        const result = await deps.acceptInvitation.execute(
          body.token,
          body.password,
          req.get("user-agent")?.slice(0, 512) ?? null,
        );
        res.json(
          envelope({
            sessionId: result.sessionId,
            accessToken: result.accessToken,
            accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
            refreshToken: result.refreshToken,
            refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
          }),
        );
      },
    }),
  ];
}
