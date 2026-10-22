import { z } from "zod";
import type { WorkPayAgreements } from "../../application/use-cases/workpay/WorkPayAgreements.js";
import type { WorkPayCollections } from "../../application/use-cases/workpay/WorkPayCollections.js";
import type { WorkPayLifecycle } from "../../application/use-cases/workpay/WorkPayLifecycle.js";
import type { WorkPayReports } from "../../application/use-cases/workpay/WorkPayReports.js";
import type { WorkPayTransfers } from "../../application/use-cases/workpay/WorkPayTransfers.js";
import { sendPdf } from "../presenters/pdfResponse.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import type { WorkPaySettingsService } from "../../application/use-cases/workpay/WorkPaySettingsService.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { AGREEMENT_STATUSES, TERMINATION_REASONS } from "../../domain/workpay/WorkPayAgreement.js";
import { FREQUENCIES } from "../../domain/workpay/WorkPayTerms.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const decimal = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);
const responsibility = z.enum(["driver", "owner", "shared"]);
const reason = z.string().trim().min(3).max(500);

const terms = z.object({
  vehicleValue: amount.optional(),
  pricing: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("multiplier"), multiplier: decimal }),
    z.object({ kind: z.literal("markup_percent"), percent: decimal }),
    z.object({ kind: z.literal("total"), total: amount }),
  ]),
  deposit: amount.optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  periods: z.number().int().min(1).max(2_000).optional(),
  months: z.number().int().min(1).max(120).optional(),
  firstDueOn: z.iso.date().optional(),
  daysOff: z.array(z.number().int().min(0).max(6)).max(6).optional(),
  roundTo: amount.optional(),
});
const guarantor = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "A phone number as +233…"),
  ghanaCardNumber: z
    .string()
    .regex(/^GHA-\d{9}-\d$/)
    .nullable()
    .default(null),
  relationship: z.string().trim().max(60).nullable().default(null),
  address: z.string().trim().max(300).nullable().default(null),
  signs: z.boolean().default(false),
});
const percent = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'A percentage as text, e.g. "5"');
const penalty = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("flat"), amount }),
  z.object({ kind: z.literal("percent"), percent }),
  z.object({ kind: z.literal("daily"), amount, cap: amount.nullable().optional() }),
]);
const minor = z.number().int().min(1).max(10_000_000_000);
const penaltyRule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("flat"), amountMinor: minor }),
  z.object({ kind: z.literal("percent"), percent }),
  z.object({ kind: z.literal("daily"), amountMinor: minor, capMinor: minor.nullable() }),
]);
const money = z.object({
  amount,
  method: z.enum(PAYMENT_METHODS),
  momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
});
const waiver = z.object({ amount: amount.optional(), reason });
const checklist = z.object({
  items: z.array(
    z.object({
      key: z.string().max(60),
      ok: z.boolean(),
      note: z.string().trim().max(300).nullable().optional(),
    }),
  ),
});
const odometer = z.number().int().min(0).max(5_000_000);
const settlement = {
  owedByDriver: amount.optional(),
  refundToDriver: amount.optional(),
};

const agreementFields = {
  terms,
  graceDays: z.number().int().min(0).max(60).optional(),
  penalty: penalty.optional(),
  maintenance: responsibility.optional(),
  insurance: responsibility.optional(),
  guarantors: z.array(guarantor).max(5).optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
};

export type WorkPayRouteDependencies = Readonly<{
  agreements: WorkPayAgreements;
  collections: WorkPayCollections;
  lifecycle: WorkPayLifecycle;
  transfers: WorkPayTransfers;
  reports: WorkPayReports;
  settings: WorkPaySettingsService;
}>;

/**
 * Work & Pay agreements (docs/08 §9): simulator, drafts, signing, deposit, start, then
 * instalment payments, balances, late fees and waivers, and the lifecycle — holidays,
 * restructures, early settlement, termination, repossession and vehicle downtime.
 */
export function workpayRoutes(deps: WorkPayRouteDependencies): ApiRoute[] {
  const { agreements, collections, lifecycle, transfers, reports, settings } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/settings/workpay",
      summary: "Work and pay defaults",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/workpay",
      summary: "Change the work and pay defaults",
      tags: ["settings"],
      access: access.permission("workpay.settings.manage"),
      request: {
        body: z.object({
          defaultFrequency: z.enum(FREQUENCIES).optional(),
          defaultGraceDays: z.number().int().optional(),
          roundToMinor: z.number().int().optional(),
          firstDueAfterDays: z.number().int().optional(),
          requireDeposit: z.boolean().optional(),
          defaultMaintenance: responsibility.optional(),
          defaultInsurance: responsibility.optional(),
          defaultPenalty: penaltyRule.optional(),
          defaultAfterOverdue: z.number().int().optional(),
          defaultAfterDays: z.number().int().optional(),
          settlementDiscountPercent: z.string().max(6).optional(),
          quoteValidDays: z.number().int().min(1).max(60).optional(),
          repossessionRefundPercent: z.string().max(6).optional(),
          driverExpenses: z.enum(["driver_ledger", "agreement"]).optional(),
          transferItems: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
          guarantorAlertAfterDays: z.number().int().min(1).max(90).optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/simulate",
      summary: "Try terms: price, deposit, instalments and the schedule (nothing is saved)",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { body: z.object({ vehicleId: uuid.optional(), terms }) },
      responses: { 200: { description: "Terms and schedule" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await agreements.simulate(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements",
      summary: "Work and pay agreements in your branches, newest first",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: {
        query: z.object({
          status: z
            .string()
            .optional()
            .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
            .pipe(z.array(z.enum(AGREEMENT_STATUSES)).optional()),
          driverId: uuid.optional(),
          vehicleId: uuid.optional(),
          branchId: uuid.optional(),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
      },
      responses: { 200: { description: "Agreements; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        const page = await agreements.list(principalOf(res), {
          ...rest,
          ...(status === undefined ? {} : { statuses: status }),
        });
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements",
      summary: "Draft an agreement for a vehicle and a driver",
      tags: ["workpay"],
      access: access.permission("workpay.create"),
      request: { body: z.object({ vehicleId: uuid, driverId: uuid, ...agreementFields }) },
      responses: { 201: { description: "Draft agreement" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await agreements.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id",
      summary: "An agreement with its terms, guarantors, document and schedule",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Agreement" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await agreements.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/workpay/agreements/:id",
      summary: "Change a draft (terms, guarantors, responsibilities)",
      tags: ["workpay"],
      access: access.permission("workpay.create"),
      request: {
        params: idParams,
        body: z.object({ ...agreementFields, terms: terms.optional() }),
      },
      responses: { 200: { description: "Draft agreement" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await agreements.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/send-for-signature",
      summary: "Issue the agreement document for the owner, the driver and signing guarantors",
      tags: ["workpay"],
      access: access.permission("workpay.create"),
      request: {
        params: idParams,
        body: z.object({ businessSignerId: uuid.nullable().optional() }),
      },
      responses: { 200: { description: "Agreement awaiting signatures" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await agreements.sendForSignature(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/withdraw",
      summary: "Take the agreement back to draft (its document is voided)",
      tags: ["workpay"],
      access: access.permission("workpay.create"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Draft agreement" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await agreements.withdraw(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/deposit",
      summary: "Record the deposit (or part of it) paid by the driver",
      tags: ["workpay"],
      access: access.permission("workpay.payment.record"),
      request: {
        params: idParams,
        body: money,
      },
      responses: { 200: { description: "Agreement" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await agreements.recordDeposit(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/activate",
      summary: "Start the signed agreement: the schedule begins and the vehicle is handed over",
      tags: ["workpay"],
      access: access.permission("workpay.activate"),
      request: {
        params: idParams,
        body: z.object({
          odometer,
          checklist,
          notes: z.string().trim().max(2_000).nullable().optional(),
        }),
      },
      responses: { 200: { description: "Active agreement with its schedule" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await agreements.activate(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/cancel",
      summary: "Cancel an agreement that has not started",
      tags: ["workpay"],
      access: access.permission("workpay.activate"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Agreement" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await agreements.cancel(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/payments",
      summary: "Record an instalment payment: late fees first, then the oldest instalments",
      tags: ["workpay"],
      access: access.permission("workpay.payment.record"),
      request: { params: idParams, body: money.extend({ paidOn: z.iso.date().optional() }) },
      responses: { 201: { description: "The payment, what it paid and the new balance" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await collections.pay(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/payments",
      summary: "Payments on an agreement and what each one paid, newest first",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Payments" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await collections.paymentsOf(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/balance",
      summary: "Outstanding, overdue, late fees, days in arrears and the next instalment",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Balance" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await collections.balance(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/instalments/:number/waive",
      summary: "Waive what is left of an instalment, or part of it",
      tags: ["workpay"],
      access: access.permission("workpay.penalty.waive"),
      request: {
        params: z.object({ id: uuid, number: z.coerce.number().int().min(1) }),
        body: waiver,
      },
      responses: { 200: { description: "Balance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await collections.waiveInstalment(principalOf(res), params.id, params.number, body),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/penalties/:penaltyId/waive",
      summary: "Waive a late fee, or part of it",
      tags: ["workpay"],
      access: access.permission("workpay.penalty.waive"),
      request: { params: z.object({ id: uuid, penaltyId: uuid }), body: waiver },
      responses: { 200: { description: "Balance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await collections.waivePenalty(principalOf(res), params.id, params.penaltyId, body),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/payment-holiday",
      summary: "Move the instalments due from a date some periods later (the term gets longer)",
      tags: ["workpay"],
      access: access.permission("workpay.restructure"),
      request: {
        params: idParams,
        body: z.object({ from: z.iso.date(), periods: z.number().int().min(1).max(60), reason }),
      },
      responses: { 200: { description: "Balance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await lifecycle.holiday(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/restructure",
      summary: "Spread what is left of the instalments, arrears included, over a new schedule",
      tags: ["workpay"],
      access: access.permission("workpay.restructure"),
      request: {
        params: idParams,
        body: z.object({
          frequency: z.enum(FREQUENCIES).optional(),
          periods: z.number().int().min(1).max(2_000),
          firstDueOn: z.iso.date(),
          daysOff: z.array(z.number().int().min(0).max(6)).max(6).optional(),
          reason,
        }),
      },
      responses: { 200: { description: "Balance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await lifecycle.restructure(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/reschedules",
      summary: "Payment holidays and restructures of an agreement, newest first",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Reschedules" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await lifecycle.reschedules(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/closing-figures",
      summary:
        "What settles the agreement today, what was paid, and the suggested repossession refund",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Closing figures" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await lifecycle.closingFigures(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/settlement-quotes",
      summary: "Quote the early settlement payoff (valid for the business's days)",
      tags: ["workpay"],
      access: access.permission("workpay.payment.record"),
      request: {
        params: idParams,
        body: z.object({
          discountPercent: z
            .string()
            .regex(/^\d{1,3}(\.\d{1,2})?$/)
            .optional(),
        }),
      },
      responses: { 201: { description: "Quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await lifecycle.quote(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/settle",
      summary: "Pay the agreement off with a settlement quote (the discount is waived)",
      tags: ["workpay"],
      access: access.permission("workpay.payment.record"),
      request: {
        params: idParams,
        body: money.extend({ quoteId: uuid, paidOn: z.iso.date().optional() }),
      },
      responses: { 201: { description: "The payment, what it paid and the new balance" } },
      handler: async ({ params, body }, _req, res) => {
        const { quoteId, ...payment } = body;
        res
          .status(201)
          .json(
            envelope(await lifecycle.settleEarly(principalOf(res), params.id, quoteId, payment)),
          );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/terminate",
      summary: "End a running agreement early (mutual, death, write-off …) with its settlement",
      tags: ["workpay"],
      access: access.permission("workpay.terminate"),
      request: {
        params: idParams,
        body: z.object({
          reason: z.enum(TERMINATION_REASONS),
          notes: z.string().trim().max(2_000).nullable().optional(),
          ...settlement,
          handback: z
            .object({
              odometer,
              checklist,
              vehicleStatus: z.enum(["available", "in_maintenance"]).optional(),
            })
            .nullable()
            .optional(),
        }),
      },
      responses: { 200: { description: "Balance of the terminated agreement" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await lifecycle.terminate(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/repossess",
      summary: "Take the vehicle back from an agreement in arrears or defaulted",
      tags: ["workpay"],
      access: access.permission("workpay.terminate"),
      request: {
        params: idParams,
        body: z.object({
          odometer,
          checklist,
          condition: z.string().trim().max(2_000).nullable().optional(),
          ...settlement,
        }),
      },
      responses: { 200: { description: "Balance of the repossessed agreement" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await lifecycle.repossess(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/downtime",
      summary: "Times the vehicle was off the road, with the payment holiday each suggests",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Downtimes" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await lifecycle.downtimes(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/downtime",
      summary: "Take the vehicle off the road (workshop, accident …)",
      tags: ["workpay"],
      access: access.permission("workpay.restructure"),
      request: {
        params: idParams,
        body: z.object({ reason, ownerFault: z.boolean().optional() }),
      },
      responses: { 201: { description: "Downtime" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await lifecycle.startDowntime(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/downtime/end",
      summary:
        "The vehicle is back on the road (a holiday is suggested when the owner was at fault)",
      tags: ["workpay"],
      access: access.permission("workpay.restructure"),
      request: { params: idParams, body: z.object({}) },
      responses: { 200: { description: "Downtime with the suggested holiday" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await lifecycle.endDowntime(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/transfer",
      summary: "The transfer of a paid-up agreement: letter, signatures, ownership, DVLA",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Transfer" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await transfers.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/transfer-letter",
      summary: "Issue the transfer letter again with corrections (until both have signed)",
      tags: ["workpay"],
      access: access.permission("workpay.transfer.manage"),
      request: {
        params: idParams,
        body: z.object({
          odometer: odometer.optional(),
          condition: z.string().trim().max(500).nullable().optional(),
          handedOver: z
            .array(z.object({ item: z.string().trim().min(1).max(120), included: z.boolean() }))
            .max(30)
            .optional(),
          ownerSignerId: uuid.optional(),
        }),
      },
      responses: { 201: { description: "Transfer with the new letter" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await transfers.reissue(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/workpay/agreements/:id/transfer/dvla",
      summary: "Track the DVLA change of ownership (after the transfer)",
      tags: ["workpay"],
      access: access.permission("workpay.transfer.manage"),
      request: {
        params: idParams,
        body: z.object({
          status: z.enum(["not_started", "submitted", "completed"]),
          submittedOn: z.iso.date().nullable().optional(),
          completedOn: z.iso.date().nullable().optional(),
          reference: z.string().trim().max(100).nullable().optional(),
          notes: z.string().trim().max(2_000).nullable().optional(),
        }),
      },
      responses: { 200: { description: "Transfer" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await transfers.updateDvla(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/transfer/papers",
      summary: "Attach a DVLA form or receipt",
      tags: ["workpay"],
      access: access.permission("workpay.transfer.manage"),
      request: {
        params: idParams,
        body: z.object({
          filename: z.string().trim().min(1).max(200),
          contentType: z.string().trim().min(3).max(100),
          sizeBytes: z.number().int().min(1).max(FILE_KINDS.workpay_transfer_paper.maxBytes),
        }),
      },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await transfers.startPaper(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/workpay/agreements/:id/transfer/papers/:fileId/complete",
      summary: "Confirm a DVLA paper upload",
      tags: ["workpay"],
      access: access.permission("workpay.transfer.manage"),
      request: { params: z.object({ id: uuid, fileId: uuid }) },
      responses: { 200: { description: "File" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await transfers.completePaper(principalOf(res), params.id, params.fileId)),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/statement",
      summary: "The agreement statement: paid to date, outstanding, overdue, schedule, payments",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "Statement" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await reports.statement(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/workpay/agreements/:id/statement.pdf",
      summary: "The agreement statement as a PDF",
      tags: ["workpay"],
      access: access.permission("workpay.view"),
      request: { params: idParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await reports.statementPdf(principalOf(res), params.id));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/workpay",
      summary:
        "Work and pay portfolio: financed, collected, outstanding, PAR 7/30/60/90, ageing, collection rate, forecast",
      tags: ["dashboards"],
      access: access.permission("dashboards.workpay.view"),
      request: { query: z.object({ branchId: uuid.optional() }) },
      responses: { 200: { description: "Portfolio" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.portfolio(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/dashboards/workpay/arrears",
      summary: "Agreements in arrears, longest first, with what each driver is behind",
      tags: ["dashboards"],
      access: access.permission("dashboards.workpay.view"),
      request: {
        query: z.object({
          branchId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Arrears" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reports.arrears(principalOf(res), query)));
      },
    }),
  ];
}
