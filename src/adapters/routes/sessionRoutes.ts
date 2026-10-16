import { z } from "zod";
import { principalOf, tenantOf } from "../middleware/AccessGuard.js";
import { dataEnvelope, envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const me = dataEnvelope(
  z.object({
    userId: z.string(),
    sessionId: z.string(),
    tenant: z.object({ id: z.string(), slug: z.string(), status: z.string() }),
    branchIds: z.array(z.string()),
    permissions: z.array(z.object({ key: z.string(), scope: z.enum(["own", "branch", "all"]) })),
  }),
);

/** The signed-in user's own session: who they are, for which business, and what they may do. */
export function sessionRoutes(): ApiRoute[] {
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/me",
      summary: "Current user, business and permissions",
      tags: ["session"],
      access: access.signedIn(),
      responses: {
        200: { description: "The signed-in user", schema: me },
        401: { description: "Missing, invalid or expired access token" },
      },
      handler: (_input, _req, res) => {
        const principal = principalOf(res);
        const tenant = tenantOf(res);
        res.status(200).json(
          envelope({
            userId: principal.userId,
            sessionId: principal.sessionId,
            tenant: { id: tenant.id, slug: tenant.slug, status: tenant.status },
            branchIds: [...principal.branchIds],
            permissions: principal
              .grantedPermissions()
              .map(([key, grant]) => ({ key, scope: grant.scope })),
          }),
        );
      },
    }),
  ];
}
