import { pageHeaders } from "../presenters/pageHeaders.js";
import { pageParams } from "../validators/commonRequests.js";
import { z } from "zod";
import {
  SUMMARY_GROUPS,
  type ConsignmentInput,
  type DealerStock,
} from "../../application/use-cases/dealer/DealerStock.js";
import { MAX_BATCH_TRANSFER } from "../../domain/dealer/StockTransferBatch.js";
import { ENTRY_STATUSES, STOCK_SOURCES, STOCK_STATUSES } from "../../domain/dealer/StockUnit.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const params = z.object({ vehicleId: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A percentage, e.g. "12.5"');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v.split(",")))
    .pipe(z.array(z.enum(values)).optional());

const consignment = z
  .object({
    consignorId: uuid,
    terms: z.enum(["fixed", "commission"]),
    payout: amount.nullable().optional(),
    commissionRate: percent.nullable().optional(),
  })
  .nullable()
  .optional();

const terms = {
  holdingCostPerDay: amount.optional(),
  consignment,
  notes: text(2_000),
};

const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });

type ConsignmentBody = z.infer<typeof consignment>;

const toConsignment = (c: ConsignmentBody): ConsignmentInput | null | undefined =>
  c === undefined || c === null
    ? c
    : {
        consignorId: c.consignorId,
        terms: c.terms,
        payout: c.payout ?? null,
        commissionRate: c.commissionRate ?? null,
      };

export type DealerStockRouteDependencies = Readonly<{ stock: DealerStock }>;

/**
 * Dealer stock (docs/10 §2): the stock list and ageing, taking vehicles into stock, pricing,
 * listing, withdrawing and transferring them (decisions 429–436), the stock by make and model
 * with its value and margin and transfers of several vehicles at once (decisions 541–543).
 */
export function dealerStockRoutes(deps: DealerStockRouteDependencies): ApiRoute[] {
  const { stock } = deps;
  const tags = ["dealer"];

  const step = (
    path: string,
    summary: string,
    permission: Parameters<typeof access.permission>[0],
    run: (actor: ReturnType<typeof principalOf>, vehicleId: string) => Promise<unknown>,
  ) =>
    defineRoute({
      method: "post",
      path: `/api/v1/dealer/stock/:vehicleId/${path}`,
      summary,
      tags,
      access: access.permission(permission),
      request: { params },
      responses: { 200: { description: "Stock vehicle" } },
      handler: async ({ params: p }, _req, res) => {
        res.json(envelope(await run(principalOf(res), p.vehicleId)));
      },
    });

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock",
      summary: "Dealer stock in your branches, oldest stock first",
      tags,
      access: access.permission("dealer.stock.list"),
      request: {
        query: z.object({
          branchId: uuid.optional(),
          status: list(STOCK_STATUSES),
          source: list(STOCK_SOURCES),
          make: z.string().trim().min(1).max(80).optional(),
          model: z.string().trim().min(1).max(80).optional(),
          yearFrom: z.coerce.number().int().min(1950).max(2100).optional(),
          yearTo: z.coerce.number().int().min(1950).max(2100).optional(),
          priceFrom: amount.optional(),
          priceTo: amount.optional(),
          minDays: z.coerce.number().int().min(0).max(3650).optional(),
          consignorId: uuid.optional(),
          ...pageParams(100, 50),
        }),
      },
      responses: { 200: { description: "Stock" } },
      handler: async ({ query }, _req, res) => {
        const { status, source, ...rest } = query;
        const page = await stock.list(principalOf(res), {
          ...rest,
          ...(status === undefined ? {} : { statuses: status }),
          ...(source === undefined ? {} : { sources: source }),
        });
        res.set(pageHeaders(page)).json(envelope(page.items));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/ageing",
      summary:
        "Stock on the lot valued at asking price and cost: by days in stock (0–30, 31–60, 61–90, over 90), status, source, make and branch",
      tags,
      access: access.permission("dealer.stock.list"),
      request: { query: z.object({ branchId: uuid.optional() }) },
      responses: { 200: { description: "Ageing" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await stock.ageing(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/summary",
      summary:
        "Stock on the lot by make and model (or make, or make, model and year): units, asking value and, with dealer.stock.cost.view, cost, profit and margin",
      tags,
      access: access.permission("dealer.stock.list"),
      request: {
        query: z.object({
          branchId: uuid.optional(),
          groupBy: z.enum(SUMMARY_GROUPS).optional(),
          status: list(["incoming", "reconditioning", "ready", "listed", "reserved"] as const),
          make: z.string().trim().min(1).max(80).optional(),
          model: z.string().trim().min(1).max(80).optional(),
        }),
      },
      responses: { 200: { description: "Stock summary" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        res.json(
          envelope(
            await stock.summary(principalOf(res), {
              ...rest,
              ...(status === undefined ? {} : { statuses: status }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/stock/transfers",
      summary:
        "Transfer several stock vehicles to another branch under one reference: the vehicles named, or a number of a make and model, oldest stock first",
      tags,
      access: access.permission("dealer.stock.transfer"),
      request: {
        body: reasonBody
          .extend({
            branchId: uuid,
            transferredOn: date.optional(),
            vehicleIds: z.array(uuid).min(1).max(MAX_BATCH_TRANSFER).optional(),
            pick: z
              .object({
                fromBranchId: uuid,
                make: z.string().trim().min(1).max(80),
                model: z.string().trim().min(1).max(80),
                year: z.number().int().min(1950).max(2100).optional(),
                quantity: z.number().int().min(1).max(MAX_BATCH_TRANSFER),
              })
              .optional(),
          })
          .refine((b) => (b.vehicleIds === undefined) !== (b.pick === undefined), {
            message: "Send vehicleIds or pick, not both",
          }),
      },
      responses: { 201: { description: "The transfer with its vehicles" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await stock.transferMany(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/transfers",
      summary: "Transfers of several vehicles leaving or reaching your branches, newest first",
      tags,
      access: access.permission("dealer.stock.list"),
      request: {
        query: z.object({
          branchId: uuid.optional(),
          dateFrom: date.optional(),
          dateTo: date.optional(),
          ...pageParams(100, 50),
        }),
      },
      responses: { 200: { description: "Transfers" } },
      handler: async ({ query }, _req, res) => {
        const page = await stock.transferBatches(principalOf(res), query);
        res.set(pageHeaders(page)).json(envelope(page.items));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/transfers/:id",
      summary: "A transfer of several vehicles with the vehicles it sent",
      tags,
      access: access.permission("dealer.stock.view"),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "The transfer with its vehicles" } },
      handler: async ({ params: p }, _req, res) => {
        res.json(envelope(await stock.transferBatch(principalOf(res), p.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/stock",
      summary: "Take a vehicle into stock (or back into stock after it was withdrawn)",
      tags,
      access: access.permission("dealer.stock.create"),
      request: {
        body: z.object({
          vehicleId: uuid,
          source: z.enum(STOCK_SOURCES),
          status: z.enum(ENTRY_STATUSES).optional(),
          stockedOn: date.optional(),
          askingPrice: amount.nullable().optional(),
          minimumPrice: amount.nullable().optional(),
          ...terms,
        }),
      },
      responses: { 201: { description: "Stock vehicle" } },
      handler: async ({ body }, _req, res) => {
        const { consignment: c, ...rest } = body;
        const converted = toConsignment(c);
        res.status(201).json(
          envelope(
            await stock.add(principalOf(res), {
              ...rest,
              ...(converted === undefined ? {} : { consignment: converted }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/:vehicleId",
      summary: "A stock vehicle (cost, minimum price and margin with dealer.stock.cost.view)",
      tags,
      access: access.permission("dealer.stock.view"),
      request: { params },
      responses: { 200: { description: "Stock vehicle" } },
      handler: async ({ params: p }, _req, res) => {
        res.json(envelope(await stock.get(principalOf(res), p.vehicleId)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/dealer/stock/:vehicleId",
      summary: "Holding cost per day, consignment terms and notes",
      tags,
      access: access.permission("dealer.stock.update"),
      request: { params, body: z.object(terms) },
      responses: { 200: { description: "Stock vehicle" } },
      handler: async ({ params: p, body }, _req, res) => {
        const { consignment: c, ...rest } = body;
        const converted = toConsignment(c);
        res.json(
          envelope(
            await stock.setTerms(principalOf(res), p.vehicleId, {
              ...rest,
              ...(converted === undefined ? {} : { consignment: converted }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/dealer/stock/:vehicleId/pricing",
      summary: "Set the asking and minimum prices (logged in the price history)",
      tags,
      access: access.permission("dealer.stock.price.manage"),
      request: {
        params,
        body: z.object({
          askingPrice: amount.nullable(),
          minimumPrice: amount.nullable().optional(),
          reason: text(500),
        }),
      },
      responses: { 200: { description: "Stock vehicle" } },
      handler: async ({ params: p, body }, _req, res) => {
        res.json(envelope(await stock.price(principalOf(res), p.vehicleId, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/:vehicleId/price-history",
      summary: "Every price change (minimum prices with dealer.stock.cost.view)",
      tags,
      access: access.permission("dealer.stock.view"),
      request: { params },
      responses: { 200: { description: "Price changes" } },
      handler: async ({ params: p }, _req, res) => {
        res.json(envelope(await stock.priceHistory(principalOf(res), p.vehicleId)));
      },
    }),
    step(
      "ready",
      "Reconditioning is done: ready to price and list",
      "dealer.stock.update",
      (a, id) => stock.markReady(a, id),
    ),
    step("recondition", "Back into reconditioning", "dealer.stock.update", (a, id) =>
      stock.recondition(a, id),
    ),
    step(
      "list",
      "Put the vehicle on sale at its asking price",
      "dealer.stock.list_for_sale",
      (a, id) => stock.listForSale(a, id),
    ),
    step("unlist", "Take the vehicle off sale", "dealer.stock.list_for_sale", (a, id) =>
      stock.unlist(a, id),
    ),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/stock/:vehicleId/withdraw",
      summary: "Withdraw the vehicle from stock into another use",
      tags,
      access: access.permission("dealer.stock.withdraw"),
      request: {
        params,
        body: reasonBody.extend({
          usage: z.enum(["fleet", "rental", "workpay", "personal"]).optional(),
        }),
      },
      responses: { 200: { description: "Stock vehicle" } },
      handler: async ({ params: p, body }, _req, res) => {
        res.json(envelope(await stock.withdraw(principalOf(res), p.vehicleId, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/stock/:vehicleId/transfer",
      summary: "Transfer the vehicle to another branch with a transfer record",
      tags,
      access: access.permission("dealer.stock.transfer"),
      request: {
        params,
        body: reasonBody.extend({ branchId: uuid, transferredOn: date.optional() }),
      },
      responses: { 200: { description: "Stock vehicle" } },
      handler: async ({ params: p, body }, _req, res) => {
        res.json(envelope(await stock.transfer(principalOf(res), p.vehicleId, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/stock/:vehicleId/transfers",
      summary: "The vehicle's branch transfers while in stock",
      tags,
      access: access.permission("dealer.stock.view"),
      request: { params },
      responses: { 200: { description: "Transfers" } },
      handler: async ({ params: p }, _req, res) => {
        res.json(envelope(await stock.transfers(principalOf(res), p.vehicleId)));
      },
    }),
  ];
}
