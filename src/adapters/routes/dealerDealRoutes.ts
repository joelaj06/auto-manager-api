import { z } from "zod";
import type { Appraisals } from "../../application/use-cases/dealer/Appraisals.js";
import type { DealerDeals } from "../../application/use-cases/dealer/DealerDeals.js";
import { APPRAISAL_STATUSES, CONDITIONS } from "../../domain/dealer/Appraisal.js";
import { DEAL_STATUSES, LOAN_STATUSES, PLAN_FREQUENCIES } from "../../domain/dealer/Deal.js";
import { ADD_ON_KINDS, FINANCING } from "../../domain/dealer/Quote.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const photoParams = z.object({ id: uuid, fileId: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Send a percentage as text, e.g. "12.5"');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v.split(",")))
    .pipe(z.array(z.enum(values)).optional());
const page = {
  beforeId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};
const photo = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(FILE_KINDS.vehicle_photo.maxBytes),
});
const reason = z.object({ reason: z.string().trim().min(1).max(500) });
const money = z.object({
  amount,
  method: z.enum(PAYMENT_METHODS),
  momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
  reference: text(120),
  paidOn: date.optional(),
});

const appraisalBody = z.object({
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  plateNumber: text(20),
  vin: text(40),
  colour: text(40),
  mileage: z.number().int().min(0).max(5_000_000).nullable().optional(),
  condition: z.enum(CONDITIONS),
  findings: text(4_000),
  value: amount,
  validUntil: date.optional(),
});

const dealTerms = {
  customerId: uuid.optional(),
  salesExecutiveId: uuid.optional(),
  price: amount.optional(),
  discount: amount.optional(),
  addOns: z
    .array(z.object({ kind: z.enum(ADD_ON_KINDS), description: text(300), amount }))
    .max(20)
    .optional(),
  tradeInId: uuid.nullable().optional(),
  financing: z.enum(FINANCING).optional(),
  loan: z
    .object({ lender: z.string().trim().min(1).max(160), amount, reference: text(120) })
    .nullable()
    .optional(),
  plan: z
    .object({
      downPayment: amount,
      markupPercent: percent,
      frequency: z.enum(PLAN_FREQUENCIES),
      months: z.number().int().min(1).max(120),
      firstDueOn: date.nullable().optional(),
    })
    .nullable()
    .optional(),
  warrantyMonths: z.number().int().min(0).max(120).optional(),
  serviceVouchers: z.number().int().min(0).max(20).optional(),
  notes: text(2_000),
};

export type DealerDealRouteDependencies = Readonly<{
  appraisals: Appraisals;
  deals: DealerDeals;
}>;

/**
 * Dealer deals (docs/10 §6–7): trade-in appraisals; deals reserved, paid, financed, sold and
 * delivered with their agreement and delivery note (decisions 445–452).
 */
export function dealerDealRoutes(deps: DealerDealRouteDependencies): ApiRoute[] {
  const { appraisals, deals } = deps;
  const tags = ["dealer"];
  const appraise = access.permission("dealer.appraisals.manage");
  const viewDeals = access.permission("dealer.deals.view");
  return [
    // --- appraisals ---
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/appraisals",
      summary: "Trade-in appraisals in your branches, newest first",
      tags,
      access: appraise,
      request: {
        query: z.object({
          leadId: uuid.optional(),
          customerId: uuid.optional(),
          status: list(APPRAISAL_STATUSES),
          ...page,
        }),
      },
      responses: { 200: { description: "Appraisals" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        res.json(
          envelope(
            await appraisals.list(principalOf(res), {
              ...rest,
              ...(status === undefined ? {} : { statuses: status }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/appraisals",
      summary: "Appraise a vehicle offered in part exchange (valid 14 days unless a date is given)",
      tags,
      access: appraise,
      request: {
        body: appraisalBody.extend({
          branchId: uuid.optional(),
          leadId: uuid.nullable().optional(),
          customerId: uuid.nullable().optional(),
        }),
      },
      responses: { 201: { description: "Appraisal" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await appraisals.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/appraisals/:id",
      summary: "An appraisal with its photos",
      tags,
      access: appraise,
      request: { params: idParams },
      responses: { 200: { description: "Appraisal" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await appraisals.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/dealer/appraisals/:id",
      summary: "Revise an open appraisal",
      tags,
      access: appraise,
      request: { params: idParams, body: appraisalBody },
      responses: { 200: { description: "Appraisal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await appraisals.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/appraisals/:id/decline",
      summary: "The customer declined the offer for their vehicle",
      tags,
      access: appraise,
      request: { params: idParams, body: reason },
      responses: { 200: { description: "Appraisal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await appraisals.decline(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/appraisals/:id/photos",
      summary: "Attach a photo to an appraisal",
      tags,
      access: appraise,
      request: { params: idParams, body: photo },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await appraisals.startPhoto(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/appraisals/:id/photos/:fileId/complete",
      summary: "Confirm an appraisal photo upload",
      tags,
      access: appraise,
      request: { params: photoParams },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await appraisals.completePhoto(principalOf(res), params.id, params.fileId)),
        );
      },
    }),

    // --- deals ---
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/deals",
      summary: "Deals you can see, newest first",
      tags,
      access: viewDeals,
      request: {
        query: z.object({
          status: list(DEAL_STATUSES),
          customerId: uuid.optional(),
          vehicleId: uuid.optional(),
          leadId: uuid.optional(),
          salesExecutiveId: uuid.optional(),
          ...page,
        }),
      },
      responses: { 200: { description: "Deals" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        res.json(
          envelope(
            await deals.list(principalOf(res), {
              ...rest,
              ...(status === undefined ? {} : { statuses: status }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals",
      summary: "Open a deal on a stock vehicle, from a quote or afresh",
      tags,
      access: access.permission("dealer.deals.create"),
      request: {
        body: z.object({
          ...dealTerms,
          vehicleId: uuid.optional(),
          leadId: uuid.nullable().optional(),
          quoteId: uuid.nullable().optional(),
        }),
      },
      responses: { 201: { description: "Deal" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await deals.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/deals/:id",
      summary: "A deal with its payments, instalments and photos",
      tags,
      access: viewDeals,
      request: { params: idParams },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deals.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/dealer/deals/:id",
      summary: "Revise a deal before the sale (fields left out stay as they are)",
      tags,
      access: access.permission("dealer.deals.create"),
      request: { params: idParams, body: z.object(dealTerms) },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/approve",
      summary: "Approve a price below the minimum or a discount over the seller's limit",
      tags,
      access: access.permission("dealer.deals.approve"),
      request: { params: idParams },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deals.approve(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/payments",
      summary: "Record a deposit or other payment for the deal",
      tags,
      access: access.permission("dealer.deals.payments.record"),
      request: { params: idParams, body: money },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.recordPayment(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/loan",
      summary: "The bank's answer on the loan; disbursed records the bank's payment",
      tags,
      access: viewDeals,
      request: {
        params: idParams,
        body: z.object({
          status: z.enum(LOAN_STATUSES),
          reference: text(120),
          disbursement: money.partial({ amount: true }).optional(),
        }),
      },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.loan(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/reserve",
      summary: "Hold the vehicle against the deposit until a date (a week unless given)",
      tags,
      access: access.permission("dealer.deals.create"),
      request: { params: idParams, body: z.object({ holdUntil: date.optional() }) },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.reserve(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/sell",
      summary: "Sell: the invoice, the trade-in into stock, the schedule and the agreement",
      tags,
      access: access.permission("dealer.deals.create"),
      request: { params: idParams },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deals.sell(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/deliver",
      summary: "Hand the vehicle over against the checklist, with the delivery note",
      tags,
      access: access.permission("dealer.deals.deliver"),
      request: {
        params: idParams,
        body: z.object({
          odometer: z.number().int().min(0).max(5_000_000),
          checklist: z
            .array(
              z.object({
                item: z.string().trim().min(1).max(200),
                checked: z.boolean(),
                note: text(500).transform((v) => v ?? null),
              }),
            )
            .min(1)
            .max(50),
        }),
      },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.deliver(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/cancel",
      summary: "Call off a deal before the sale; payments stay as the customer's credit",
      tags,
      access: access.permission("dealer.deals.create"),
      request: { params: idParams, body: reason },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.cancel(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/photos",
      summary: "Attach a photo to a deal (the handover)",
      tags,
      access: viewDeals,
      request: { params: idParams, body: photo },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await deals.startPhoto(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/deals/:id/photos/:fileId/complete",
      summary: "Confirm a deal photo upload",
      tags,
      access: viewDeals,
      request: { params: photoParams },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deals.completePhoto(principalOf(res), params.id, params.fileId)));
      },
    }),
  ];
}
