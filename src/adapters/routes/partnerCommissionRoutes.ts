import type { Response } from "express";
import { z } from "zod";
import type { PartnerCommissions } from "../../application/use-cases/partners/PartnerCommissions.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { sendPdf } from "../presenters/pdfResponse.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/platform/v1";
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const reason = z.string().trim().min(5).max(1_000);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/);
const period = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
const periodParams = idParams.extend(period.shape);
const entryQuery = z.object({
  status: z.enum(["accrued", "payable", "paid"]).optional(),
  type: z.enum(["standard", "enterprise"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit,
});

const sendCsv = (res: Response, name: string, body: string) =>
  res
    .status(200)
    .set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    })
    .send(body);

export type PartnerCommissionRouteDependencies = Readonly<{ commissions: PartnerCommissions }>;

/**
 * Reseller commissions (docs/29 §4–§8): staff set terms and overrides, work the payable queue,
 * record, approve and reverse payouts, adjust and read statements and liability; resellers see
 * their own ledger, balance, payouts (and acknowledge them) and statements.
 */
export function partnerCommissionRoutes(deps: PartnerCommissionRouteDependencies): ApiRoute[] {
  const { commissions } = deps;
  return [
    // --- staff ---
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/commission-terms`,
      summary: "A reseller's commission terms in force, with every version",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: idParams },
      responses: { 200: { description: "Terms" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.terms(params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/partners/:id/commission-terms`,
      summary: "Set a reseller's commission terms (a new version; never retroactive)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.commission_terms.manage"),
      request: {
        params: idParams,
        body: z.object({
          standardPercent: percent.nullable(),
          enterprisePercent: percent.nullable(),
          holdDays: z.number().int().default(0),
          minPayoutMinor: z.number().int().default(0),
          capPerTenantMinor: z.number().int().nullable().default(null),
          /** Bind the reseller's existing tenants to the new terms too (default: no). */
          applyToExistingTenants: z.boolean().default(false),
          reason,
        }),
      },
      responses: { 200: { description: "The new version" } },
      handler: async ({ params, body }, _req, res) => {
        const { applyToExistingTenants, reason: why, ...terms } = body;
        res.json(
          envelope(
            await commissions.setTerms(
              params.id,
              terms,
              { reason: why, applyToExistingTenants },
              staffOf(res),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: `${BASE}/tenants/:id/partner-terms`,
      summary: "A different commission percentage for one tenant (null removes it)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.commission_terms.manage"),
      request: { params: idParams, body: z.object({ percent: percent.nullable(), reason }) },
      responses: { 204: { description: "Saved" } },
      handler: async ({ params, body }, _req, res) => {
        await commissions.setTenantOverride(params.id, body.percent, body.reason, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/commissions/payable`,
      summary: "Commissions payable now, per reseller (with cash payouts awaiting approval)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      responses: { 200: { description: "Payable balances" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await commissions.payable()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/reports/liability`,
      summary: "What Autoforce owes resellers: accrued, payable and awaiting approval",
      tags: ["console: partners"],
      access: access.platform("platform.partners.reports.view"),
      responses: { 200: { description: "Liability per reseller" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await commissions.liability()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/commissions`,
      summary: "A reseller's commission ledger (newest first)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: idParams, query: entryQuery },
      responses: { 200: { description: "Entries" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await commissions.entries({ ...query, partnerId: params.id })));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partners/:id/adjustments`,
      summary: "Credit (+) or debit (−) a reseller's commission balance",
      tags: ["console: partners"],
      access: access.platform("platform.partners.adjust"),
      request: { params: idParams, body: z.object({ amountMinor: z.number().int(), reason }) },
      responses: { 201: { description: "Adjustment" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await commissions.adjust(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/payouts`,
      summary: "A reseller's payouts (newest first)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: idParams, query: z.object({ limit }) },
      responses: { 200: { description: "Payouts" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await commissions.payouts({ partnerId: params.id, limit: query.limit })));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partners/:id/payouts`,
      summary: "Record a payout settling everything payable (cash waits for a second approver)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.commissions.pay"),
      request: {
        params: idParams,
        body: z.object({
          method: z.enum(["momo", "bank", "cash", "cheque", "other"]),
          reference: z.string().trim().max(120).nullish(),
          details: z.record(z.string().max(40), z.string().trim().max(200)).default({}),
          proofFileIds: z.array(uuid).max(10).default([]),
          notes: z.string().trim().max(1_000).nullish(),
          paidAt: z.coerce.date(),
        }),
      },
      responses: { 201: { description: "Payout" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await commissions.recordPayout(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner-payouts`,
      summary: "Payouts across resellers (cash awaiting approval, or not yet acknowledged)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: {
        query: z.object({
          status: z.enum(["awaiting_approval", "paid", "reversed"]).optional(),
          unacknowledged: z.stringbool().optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Payouts" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await commissions.payouts(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner-payouts/:id`,
      summary: "A payout with the entries it settles",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: idParams },
      responses: { 200: { description: "Payout" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.payout(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partner-payouts/:id/approve`,
      summary: "Approve a cash payout as the second staff member",
      tags: ["console: partners"],
      access: access.platform("platform.partners.commissions.pay"),
      request: { params: idParams },
      responses: { 200: { description: "Paid payout" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.approvePayout(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partner-payouts/:id/reverse`,
      summary: "Reverse a payout (its commissions become payable again)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.commissions.pay"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Reversed payout" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await commissions.reversePayout(params.id, body.reason, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/statements/:period`,
      summary: "A reseller's monthly commission statement (YYYY-MM)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: periodParams },
      responses: { 200: { description: "Statement" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.statement(params.id, params.period)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/statements/:period/pdf`,
      summary: "A reseller's monthly commission statement as a PDF",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: periodParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await commissions.statementPdf(params.id, params.period));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partners/:id/statements/:period/csv`,
      summary: "A reseller's monthly commission statement as CSV",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: periodParams },
      responses: { 200: { description: "text/csv" } },
      handler: async ({ params }, _req, res) => {
        sendCsv(
          res,
          `commissions-${params.period}`,
          await commissions.statementCsv(params.id, params.period),
        );
      },
    }),

    // --- the reseller ---
    defineRoute({
      method: "get",
      path: `${BASE}/partner/commissions`,
      summary: "Your commission ledger (newest first)",
      tags: ["partner"],
      access: access.partner("platform.partner.commissions.view"),
      request: { query: entryQuery },
      responses: { 200: { description: "Entries" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await commissions.myEntries(staffOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/commissions/balance`,
      summary: "What is payable to you now, waiting for its hold, or awaiting approval",
      tags: ["partner"],
      access: access.partner("platform.partner.commissions.view"),
      responses: { 200: { description: "Balance (null before any commission)" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await commissions.myBalance(staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/payouts`,
      summary: "Payouts made to you",
      tags: ["partner"],
      access: access.partner("platform.partner.commissions.view"),
      request: { query: z.object({ limit }) },
      responses: { 200: { description: "Payouts" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await commissions.myPayouts(staffOf(res), query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/partner/payouts/:id/acknowledge`,
      summary: "Confirm you received a payout",
      tags: ["partner"],
      access: access.partner("platform.partner.commissions.view"),
      request: { params: idParams },
      responses: { 200: { description: "Payout" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.acknowledge(staffOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/commissions/statements/:period`,
      summary: "Your monthly statement (YYYY-MM)",
      tags: ["partner"],
      access: access.partner("platform.partner.commissions.view"),
      request: { params: period },
      responses: { 200: { description: "Statement" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await commissions.myStatement(staffOf(res), params.period)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/commissions/statements/:period/pdf`,
      summary: "Your monthly statement as a PDF",
      tags: ["partner"],
      access: access.partner("platform.partner.commissions.view"),
      request: { params: period },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await commissions.myStatementPdf(staffOf(res), params.period));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/partner/commissions/statements/:period/csv`,
      summary: "Your monthly statement as CSV",
      tags: ["partner"],
      access: access.partner("platform.partner.export"),
      request: { params: period },
      responses: { 200: { description: "text/csv" } },
      handler: async ({ params }, _req, res) => {
        sendCsv(
          res,
          `commissions-${params.period}`,
          await commissions.myStatementCsv(staffOf(res), params.period),
        );
      },
    }),
  ];
}
