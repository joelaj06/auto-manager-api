import { z } from "zod";
import type { PartsInventory } from "../../application/use-cases/maintenance/PartsInventory.js";
import { PART_UNITS } from "../../domain/maintenance/Part.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const stockParams = z.object({ id: uuid, branchId: uuid });
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const amount = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "An amount like 120.00");
const quantity = z.number().positive().max(1_000_000);

const partFields = {
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(2).max(160),
  unit: z.enum(PART_UNITS).optional(),
  category: text(60),
  compatible: z
    .array(z.object({ make: z.string().trim().min(1).max(60), model: text(60) }))
    .max(50)
    .optional(),
  notes: text(2000),
  active: z.boolean().optional(),
};

export type PartRouteDependencies = Readonly<{ parts: PartsInventory }>;

/**
 * Parts inventory (docs/12 §4): the catalogue, stock per branch with reorder levels, and the
 * moves — opening stock, purchases, counts, transfers (issues come from completed work orders).
 */
export function partRoutes(deps: PartRouteDependencies): ApiRoute[] {
  const { parts } = deps;
  const view = access.permission("maintenance.view");
  const manage = access.permission("parts.manage");
  const atBranch = <B extends z.ZodType>(
    path: string,
    summary: string,
    body: B,
    run: (
      actor: ReturnType<typeof principalOf>,
      where: { partId: string; branchId: string },
      body: z.infer<B>,
    ) => Promise<unknown>,
    status: 200 | 201 = 201,
  ) =>
    defineRoute({
      method: "post",
      path: `/api/v1/parts/:id/stock/:branchId/${path}`,
      summary,
      tags: ["maintenance"],
      access: manage,
      request: { params: stockParams, body },
      responses: { [status]: { description: "Stock" } },
      handler: async ({ params, body: input }, _req, res) => {
        const where = { partId: params.id, branchId: params.branchId };
        res.status(status).json(envelope(await run(principalOf(res), where, input as z.infer<B>)));
      },
    });

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/parts",
      summary: "The parts catalogue (`vehicleId`: the parts that fit it)",
      tags: ["maintenance"],
      access: view,
      request: {
        query: z.object({
          search: z.string().trim().min(1).max(60).optional(),
          category: z.string().trim().min(1).max(60).optional(),
          vehicleId: uuid.optional(),
          includeInactive: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: { 200: { description: "Parts" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await parts.list(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/parts",
      summary: "Add a part to the catalogue",
      tags: ["maintenance"],
      access: manage,
      request: { body: z.object(partFields) },
      responses: { 201: { description: "Part" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await parts.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/parts/:id",
      summary: "A part with its stock at each branch",
      tags: ["maintenance"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Part" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await parts.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/parts/:id",
      summary: "Change a part (inactive: no longer stocked)",
      tags: ["maintenance"],
      access: manage,
      request: { params: idParams, body: z.object(partFields).partial() },
      responses: { 200: { description: "Part" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await parts.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/part-stock",
      summary: "Stock by part and branch with its value (`low=true`: at or below reorder level)",
      tags: ["maintenance"],
      access: view,
      request: {
        query: z.object({
          branchId: uuid.optional(),
          low: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .optional(),
        }),
      },
      responses: { 200: { description: "Stock" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await parts.stock(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/parts/:id/stock/:branchId",
      summary: "The reorder level and quantity and the bin of a part at a branch",
      tags: ["maintenance"],
      access: manage,
      request: {
        params: stockParams,
        body: z.object({
          reorderLevel: z.number().min(0).max(1_000_000).nullable(),
          reorderQty: quantity.nullable(),
          location: text(60),
        }),
      },
      responses: { 200: { description: "Stock" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await parts.setStock(
              principalOf(res),
              { partId: params.id, branchId: params.branchId },
              body,
            ),
          ),
        );
      },
    }),
    atBranch(
      "opening",
      "Opening stock already on the shelf (against equity)",
      z.object({ quantity, unitCost: amount }),
      (actor, where, body) => parts.opening(actor, where, body),
    ),
    atBranch(
      "receipts",
      "Bought for stock: in at its cost, an expense to the supplier posted to the inventory",
      z.object({
        quantity,
        unitCost: amount,
        supplierId: uuid,
        reference: text(80),
        taxCode: z.string().trim().min(1).max(20).nullable().optional(),
      }),
      (actor, where, body) => parts.receive(actor, where, body),
    ),
    atBranch(
      "counts",
      "A stock count: the stock set to what is on the shelf (the difference to stock adjustments)",
      z.object({
        counted: z.number().min(0).max(1_000_000),
        reason: z.string().trim().min(3).max(500),
        unitCost: amount.optional(),
      }),
      (actor, where, body) => parts.count(actor, where, body),
    ),
    defineRoute({
      method: "post",
      path: "/api/v1/parts/:id/transfers",
      summary: "Move stock from one branch to another at the sending branch's average cost",
      tags: ["maintenance"],
      access: manage,
      request: {
        params: idParams,
        body: z.object({
          fromBranchId: uuid,
          toBranchId: uuid,
          quantity,
          reason: text(500),
        }),
      },
      responses: { 201: { description: "Both branches' stock" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await parts.transfer(principalOf(res), { partId: params.id, ...body })));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/part-moves",
      summary: "Stock moves, newest first",
      tags: ["maintenance"],
      access: view,
      request: {
        query: z.object({
          partId: uuid.optional(),
          branchId: uuid.optional(),
          workOrderId: uuid.optional(),
          before: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Moves" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await parts.moves(principalOf(res), query)));
      },
    }),
  ];
}
