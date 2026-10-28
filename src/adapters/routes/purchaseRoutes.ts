import { z } from "zod";
import type { Purchases } from "../../application/use-cases/purchases/Purchases.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { CURRENCY_CODES, type CurrencyCode } from "../../domain/money/Currency.js";
import { ALLOCATIONS, COST_KINDS } from "../../domain/purchases/LandedCost.js";
import {
  IMPORT_STAGES,
  PURCHASE_STATUSES,
  PURCHASE_TYPES,
} from "../../domain/purchases/Purchase.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const lineParams = z.object({ id: uuid, lineId: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const rate = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/, 'An exchange rate, e.g. "15.42"');
const currency = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v.split(",")))
    .pipe(z.array(z.enum(values)).optional());

const lineDetails = {
  vin: z.string().trim().max(17).nullable().optional(),
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  colour: text(40),
  description: text(300),
};

const purchaseBody = z.object({
  type: z.enum(PURCHASE_TYPES),
  supplierId: uuid,
  branchId: uuid.optional(),
  currency: currency.optional(),
  reference: text(100),
  expectedOn: date.nullable().optional(),
  notes: text(2_000),
  lines: z.array(z.object({ ...lineDetails, price: amount })).max(50),
});

export type PurchaseRouteDependencies = Readonly<{ purchases: Purchases }>;

/**
 * Vehicle purchases (docs/11 §3–6, §9): drafts, ordering, cost components and landed cost, the
 * import timeline and documents, and receiving vehicles into the fleet (decisions 421–428).
 */
export function purchaseRoutes(deps: PurchaseRouteDependencies): ApiRoute[] {
  const { purchases } = deps;
  const view = access.permission("purchases.view");
  const create = access.permission("purchases.create");

  const toLine = (l: z.infer<typeof purchaseBody>["lines"][number]) => ({
    vin: l.vin ?? null,
    make: l.make,
    model: l.model,
    year: l.year ?? null,
    colour: l.colour ?? null,
    description: l.description ?? null,
    price: l.price,
  });

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/purchases",
      summary: "Vehicle purchases in your branches, newest first",
      tags: ["purchases"],
      access: view,
      request: {
        query: z.object({
          branchId: uuid.optional(),
          supplierId: uuid.optional(),
          status: list(PURCHASE_STATUSES),
          type: list(PURCHASE_TYPES),
          beforeId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Purchases" } },
      handler: async ({ query }, _req, res) => {
        const { status, type, ...rest } = query;
        res.json(
          envelope(
            await purchases.list(principalOf(res), {
              ...rest,
              ...(status === undefined ? {} : { statuses: status }),
              ...(type === undefined ? {} : { types: type }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases",
      summary: "Draft a purchase from a seller with one line per vehicle",
      tags: ["purchases"],
      access: create,
      request: { body: purchaseBody },
      responses: { 201: { description: "Purchase" } },
      handler: async ({ body }, _req, res) => {
        res
          .status(201)
          .json(
            envelope(
              await purchases.create(principalOf(res), { ...body, lines: body.lines.map(toLine) }),
            ),
          );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/purchases/:id",
      summary: "A purchase with its vehicles, costs, landed cost per vehicle and timeline",
      tags: ["purchases"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await purchases.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/purchases/:id/landed-cost",
      summary: "The landed cost per vehicle: price, own costs, share of shared costs, pending",
      tags: ["purchases"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Landed cost" } },
      handler: async ({ params }, _req, res) => {
        const p = await purchases.get(principalOf(res), params.id);
        res.json(
          envelope({
            purchaseId: p.id,
            totals: p.totals,
            lines: p.lines.map((l) => ({
              lineId: l.id,
              vehicleId: l.vehicleId,
              vin: l.vin,
              make: l.make,
              model: l.model,
              ...l.landedCost,
            })),
          }),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/purchases/:id",
      summary: "Edit a draft purchase and its vehicles",
      tags: ["purchases"],
      access: create,
      request: { params: idParams, body: purchaseBody },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await purchases.revise(principalOf(res), params.id, {
              ...body,
              lines: body.lines.map(toLine),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/order",
      summary: "Order the purchase: each vehicle's price becomes a bill to the seller",
      tags: ["purchases"],
      access: access.permission("purchases.approve"),
      request: {
        params: idParams,
        body: z.object({ orderedOn: date.optional(), fxRate: rate.nullable().optional() }),
      },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await purchases.order(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/cancel",
      summary: "Cancel a purchase before anything was received (its unpaid costs are voided)",
      tags: ["purchases"],
      access: access.permission("purchases.approve"),
      request: { params: idParams, body: z.object({ reason: z.string().trim().min(3).max(500) }) },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await purchases.cancel(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/costs",
      summary:
        "Add a cost component (a bill to its payee in its currency), for one vehicle or shared",
      tags: ["purchases"],
      access: access.permission("purchases.costs.manage"),
      request: {
        params: idParams,
        body: z.object({
          kind: z.enum(COST_KINDS),
          lineId: uuid.nullable().optional(),
          allocation: z.enum(ALLOCATIONS).optional(),
          description: text(300),
          supplierId: uuid,
          amount,
          currency: currency.optional(),
          fxRate: rate.nullable().optional(),
          date: date.optional(),
          taxCode: z.string().trim().max(40).nullable().optional(),
          reference: text(60),
        }),
      },
      responses: { 201: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await purchases.addCost(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/costs/:costId/remove",
      summary:
        "Remove a cost component (its bill is voided; a paid one: reverse the payment first)",
      tags: ["purchases"],
      access: access.permission("purchases.costs.manage"),
      request: {
        params: z.object({ id: uuid, costId: uuid }),
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
      },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await purchases.removeCost(principalOf(res), params.id, params.costId, body.reason),
          ),
        );
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/purchases/:id/shipping",
      summary: "Vessel, bill of lading, container, ETA and free days at the port",
      tags: ["purchases"],
      access: create,
      request: {
        params: idParams,
        body: z.object({
          vessel: text(100),
          billOfLading: text(60),
          containerNumber: text(30),
          eta: date.nullable().optional(),
          portFreeDays: z.number().int().min(0).max(90).nullable().optional(),
        }),
      },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await purchases.setShipping(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/stage",
      summary: "Move an import forward along its timeline (shipped, arrived at the port …)",
      tags: ["purchases"],
      access: create,
      request: {
        params: idParams,
        body: z.object({
          stage: z.enum(IMPORT_STAGES),
          on: date.optional(),
          note: text(1_000),
        }),
      },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await purchases.advance(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/notes",
      summary: "Add a note to the purchase's timeline",
      tags: ["purchases"],
      access: create,
      request: {
        params: idParams,
        body: z.object({ note: z.string().trim().min(1).max(1_000), on: date.optional() }),
      },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await purchases.addNote(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/purchases/:id/lines/:lineId",
      summary: "Correct a vehicle's details (VIN, year, colour …) until it is received",
      tags: ["purchases"],
      access: create,
      request: { params: lineParams, body: z.object(lineDetails).partial() },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await purchases.editLine(principalOf(res), params.id, params.lineId, body)),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/lines/:lineId/receive",
      summary: "Receive a vehicle: registers it in the fleet at its landed cost so far",
      tags: ["purchases"],
      access: access.permission("purchases.receive"),
      request: {
        params: lineParams,
        body: z.object({
          receivedOn: date.optional(),
          branchId: uuid.optional(),
          status: z.enum(["available", "reconditioning"]).optional(),
          usage: z.enum(["fleet", "rental", "workpay", "stock", "personal"]).optional(),
          plateNumber: z.string().trim().max(20).nullable().optional(),
          odometer: z.number().int().min(0).max(5_000_000).nullable().optional(),
          mileageUnit: z.enum(["km", "mi"]).optional(),
        }),
      },
      responses: { 200: { description: "Purchase" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await purchases.receive(principalOf(res), params.id, params.lineId, body)),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/purchases/:id/documents",
      summary: "The purchase's papers",
      tags: ["purchases"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Files" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await purchases.listDocuments(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/documents",
      summary: "Attach a paper (invoice, bill of lading, title, customs declaration …)",
      tags: ["purchases"],
      access: create,
      request: {
        params: idParams,
        body: z.object({
          filename: z.string().trim().min(1).max(200),
          contentType: z.string().trim().min(3).max(100),
          sizeBytes: z.number().int().min(1).max(FILE_KINDS.purchase_document.maxBytes),
        }),
      },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await purchases.startDocument(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/purchases/:id/documents/:fileId/complete",
      summary: "Confirm a paper's upload",
      tags: ["purchases"],
      access: create,
      request: { params: z.object({ id: uuid, fileId: uuid }) },
      responses: { 200: { description: "File" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await purchases.completeDocument(principalOf(res), params.id, params.fileId)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/purchases/:id/documents/:fileId",
      summary: "Remove a paper",
      tags: ["purchases"],
      access: create,
      request: { params: z.object({ id: uuid, fileId: uuid }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await purchases.removeDocument(principalOf(res), params.id, params.fileId);
        res.status(204).end();
      },
    }),
  ];
}
