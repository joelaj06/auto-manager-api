import { z } from "zod";
import type { WorkOrders } from "../../application/use-cases/maintenance/WorkOrders.js";
import {
  LINE_KINDS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TYPES,
} from "../../domain/maintenance/WorkOrder.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "An amount like 120.00");
const odometer = z.number().int().min(0).max(5_000_000);

const lineBody = z
  .object({
    kind: z.enum(LINE_KINDS),
    description: z.string().trim().min(1).max(300),
    quantity: z.number().positive().max(100_000),
    /** Not for a catalogue part (its average cost at the branch). */
    unitCost: amount.optional(),
    partRef: text(80),
    partId: uuid.nullable().optional(),
  })
  .refine((l) => (l.partId ?? null) !== null || l.unitCost !== undefined, {
    message: "Give the unit cost (or a catalogue part)",
    path: ["unitCost"],
  });

const detailFields = {
  type: z.enum(WORK_ORDER_TYPES),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  title: z.string().trim().min(3).max(160),
  description: text(4000),
  serviceTaskIds: z.array(uuid).max(50).optional(),
  vendorId: uuid.nullable().optional(),
  assignedTo: uuid.nullable().optional(),
  warranty: z.boolean().optional(),
  expectedBackAt: instant.nullable().optional(),
  notes: text(4000),
};

const openBody = z.object({
  vehicleId: uuid,
  ...detailFields,
  issueId: uuid.nullable().optional(),
  damageId: uuid.nullable().optional(),
  offRoad: z.boolean().optional(),
  offRoadFrom: instant.optional(),
  odometer: odometer.nullable().optional(),
  lines: z.array(lineBody).max(100).optional(),
});

const changeBody = z.object(detailFields).partial();

const completeBody = z.object({
  odometer: odometer.nullable().optional(),
  allocations: z
    .array(
      z.object({
        payer: z.enum(["driver", "customer", "insurer"]),
        amount,
        driverId: uuid.nullable().optional(),
        insurerId: uuid.nullable().optional(),
        claimRef: text(80),
      }),
    )
    .max(3)
    .optional(),
  vendorInvoiceRef: text(80),
  vendorRating: z.number().int().min(1).max(5).nullable().optional(),
});

export type WorkOrderRouteDependencies = Readonly<{ orders: WorkOrders }>;

/**
 * Work orders (docs/12 §3, §5): open one on a vehicle (from an issue or a damage, for service
 * plan tasks), cost it in lines, take the vehicle off the road, move it along, complete it with
 * who pays, or cancel it; and a vendor's record.
 */
export function workOrderRoutes(deps: WorkOrderRouteDependencies): ApiRoute[] {
  const { orders } = deps;
  const manage = access.permission("maintenance.work_orders.manage");
  const view = access.permission("maintenance.view");
  const action = (
    path: string,
    summary: string,
    body: z.ZodType<Record<string, unknown>>,
    run: (actor: ReturnType<typeof principalOf>, id: string, body: never) => Promise<unknown>,
  ) =>
    defineRoute({
      method: "post",
      path: `/api/v1/work-orders/:id/${path}`,
      summary,
      tags: ["maintenance"],
      access: manage,
      request: { params: idParams, body },
      responses: { 200: { description: "Work order" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await run(principalOf(res), params.id, input as never)));
      },
    });

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/work-orders",
      summary: "Work orders, newest first (`open=true` for those not done)",
      tags: ["maintenance"],
      access: view,
      request: {
        query: z.object({
          status: z.enum(WORK_ORDER_STATUSES).optional(),
          type: z.enum(WORK_ORDER_TYPES).optional(),
          vehicleId: uuid.optional(),
          vendorId: uuid.optional(),
          branchId: uuid.optional(),
          open: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          before: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Work orders" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await orders.list(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/work-orders/:id",
      summary: "A work order with its lines, who pays and the downtime",
      tags: ["maintenance"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Work order" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await orders.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/work-orders",
      summary:
        "Open a work order on a vehicle (optionally off the road: rentals blocked, Work & Pay paused)",
      tags: ["maintenance"],
      access: manage,
      request: { body: openBody },
      responses: { 201: { description: "Work order" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await orders.open(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/work-orders/:id",
      summary: "Change an open work order (the expected return moves its block)",
      tags: ["maintenance"],
      access: manage,
      request: { params: idParams, body: changeBody },
      responses: { 200: { description: "Work order" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await orders.change(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/work-orders/:id/lines",
      summary: "Replace the labour, parts, sublet and other lines",
      tags: ["maintenance"],
      access: manage,
      request: { params: idParams, body: z.object({ lines: z.array(lineBody).max(100) }) },
      responses: { 200: { description: "Work order" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await orders.setLines(principalOf(res), params.id, body.lines)));
      },
    }),
    action("start", "Work has started", z.object({}), (actor, id) =>
      orders.move(actor, id, "in_progress"),
    ),
    action("awaiting-parts", "Waiting for parts", z.object({}), (actor, id) =>
      orders.move(actor, id, "awaiting_parts"),
    ),
    action(
      "off-road",
      "Take the vehicle off the road for the job",
      z.object({ from: instant.optional(), expectedBackAt: instant.nullable().optional() }),
      (actor, id, body: { from?: Date; expectedBackAt?: Date | null }) =>
        orders.offRoad(actor, id, body),
    ),
    action(
      "complete",
      "Complete: odometer, service tasks done, damage repaired, costs posted with who pays",
      completeBody,
      (actor, id, body: z.infer<typeof completeBody>) => orders.complete(actor, id, body),
    ),
    action(
      "cancel",
      "Cancel an open work order (the vehicle back on the road)",
      z.object({ reason: z.string().trim().min(3).max(500) }),
      (actor, id, body: { reason: string }) => orders.cancel(actor, id, body.reason),
    ),
    defineRoute({
      method: "get",
      path: "/api/v1/suppliers/:id/work-orders",
      summary: "A vendor's record: jobs, spend, turnaround, rating and recent work orders",
      tags: ["maintenance"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Vendor record" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await orders.vendor(principalOf(res), params.id)));
      },
    }),
  ];
}
