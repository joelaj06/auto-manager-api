import { z } from "zod";
import type { DealerCommissions } from "../../application/use-cases/dealer/DealerCommissions.js";
import type { DealerDeals } from "../../application/use-cases/dealer/DealerDeals.js";
import type { DealerGrossProfit } from "../../application/use-cases/dealer/DealerGrossProfit.js";
import { COMMISSION_BASES } from "../../domain/dealer/Commission.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A month: YYYY-MM");
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Send a percentage as text, e.g. "2.5"');

const planBody = z.object({
  name: z.string().trim().min(1).max(120),
  basis: z.enum(COMMISSION_BASES),
  tiers: z
    .array(
      z.object({
        fromUnits: z.number().int().min(1).max(1_000),
        percent: percent.optional(),
        amount: amount.optional(),
      }),
    )
    .min(1)
    .max(10),
});

export type DealerCommissionRouteDependencies = Readonly<{
  commissions: DealerCommissions;
  deals: DealerDeals;
  grossProfit: DealerGrossProfit;
}>;

/**
 * Sales commissions and gross profit (docs/10 §1, §8): plans, a deal's split, the monthly
 * statement, payouts and clawbacks; gross profit per unit sold (decisions 453–458).
 */
export function dealerCommissionRoutes(deps: DealerCommissionRouteDependencies): ApiRoute[] {
  const { commissions, deals, grossProfit } = deps;
  const tags = ["dealer"];
  const manage = access.permission("dealer.commissions.manage");
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/commission-plans",
      summary: "Commission plans, current first",
      tags,
      access: manage,
      responses: { 200: { description: "Plans" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await commissions.plans(principalOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/commission-plans",
      summary: "Set a seller's commission plan, or the plan for everyone (userId null)",
      tags,
      access: manage,
      request: { body: planBody.extend({ userId: uuid.nullable() }) },
      responses: { 201: { description: "Plan" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await commissions.createPlan(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/dealer/commission-plans/:id",
      summary: "Revise a plan (from the next delivery)",
      tags,
      access: manage,
      request: { params: idParams, body: planBody },
      responses: { 200: { description: "Plan" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await commissions.revisePlan(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/commission-plans/:id/retire",
      summary: "Retire a plan",
      tags,
      access: manage,
      request: { params: idParams },
      responses: { 200: { description: "Plan" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.retirePlan(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/dealer/deals/:id/commission-split",
      summary: "Share a sale's commission between sellers (whole percentages adding up to 100)",
      tags,
      access: manage,
      request: {
        params: idParams,
        body: z.object({
          split: z
            .array(z.object({ userId: uuid, percent: z.number().int().min(1).max(100) }))
            .min(1)
            .max(5),
        }),
      },
      responses: { 200: { description: "Deal" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await deals.splitCommission(principalOf(res), params.id, body.split)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/commissions",
      summary: "The commission statement for a month (own: yours)",
      tags,
      access: access.permission("dealer.commissions.view"),
      request: { query: z.object({ period, userId: uuid.optional() }) },
      responses: { 200: { description: "Statement" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await commissions.statement(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/commissions/payouts",
      summary: "Pay a seller what is payable up to a month, less clawbacks",
      tags,
      access: manage,
      request: {
        body: z.object({
          userId: uuid,
          period,
          method: z.enum(["cash", "momo", "bank_transfer"]),
          paidOn: date.optional(),
          reference: z.string().trim().max(120).nullable().optional(),
        }),
      },
      responses: { 201: { description: "Payout" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await commissions.pay(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/dealer/commissions/:id/clawback",
      summary: "Claw a commission back (recovered from the next payout once paid)",
      tags,
      access: manage,
      request: { params: idParams, body: z.object({ reason: z.string().trim().min(1).max(500) }) },
      responses: { 200: { description: "Commission" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await commissions.clawBack(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dealer/gross-profit",
      summary: "Gross profit per unit sold in a period",
      tags,
      access: access.permission("dealer.stock.cost.view"),
      request: {
        query: z.object({
          from: date,
          to: date,
          branchId: uuid.optional(),
          salesExecutiveId: uuid.optional(),
        }),
      },
      responses: { 200: { description: "Report" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await grossProfit.report(principalOf(res), query)));
      },
    }),
  ];
}
