import { z } from "zod";
import type { HealthController } from "../controllers/HealthController.js";
import { dataEnvelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const readiness = dataEnvelope(
  z.object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.array(z.object({ name: z.string(), status: z.enum(["up", "down"]) })),
  }),
);

/** Health endpoints live outside /api so load balancers can probe them without rate limits. */
export function healthRoutes(controller: HealthController): ApiRoute[] {
  return [
    defineRoute({
      method: "get",
      path: "/health/live",
      summary: "Liveness probe",
      tags: ["health"],
      access: access.public(),
      responses: {
        200: {
          description: "The process is running",
          schema: dataEnvelope(z.object({ status: z.literal("ok") })),
        },
      },
      handler: (_input, _req, res) => controller.live(res),
    }),
    defineRoute({
      method: "get",
      path: "/health/ready",
      summary: "Readiness probe",
      tags: ["health"],
      access: access.public(),
      responses: {
        200: { description: "Ready to serve traffic", schema: readiness },
        503: { description: "A dependency is down", schema: readiness },
      },
      handler: (_input, _req, res) => controller.ready(res),
    }),
  ];
}
