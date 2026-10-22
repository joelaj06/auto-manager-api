import { z } from "zod";
import type { WorkPayAgreements } from "../../application/use-cases/workpay/WorkPayAgreements.js";
import type { WorkPayCollections } from "../../application/use-cases/workpay/WorkPayCollections.js";
import type { WorkPaySettingsService } from "../../application/use-cases/workpay/WorkPaySettingsService.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { AGREEMENT_STATUSES } from "../../domain/workpay/WorkPayAgreement.js";
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
  settings: WorkPaySettingsService;
}>;

/**
 * Work & Pay agreements (docs/08 §9): simulator, drafts, signing, deposit, start, then
 * instalment payments, balances, late fees and waivers.
 */
export function workpayRoutes(deps: WorkPayRouteDependencies): ApiRoute[] {
  const { agreements, collections, settings } = deps;
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
          odometer: z.number().int().min(0).max(5_000_000),
          checklist: z.object({
            items: z.array(
              z.object({
                key: z.string().max(60),
                ok: z.boolean(),
                note: z.string().trim().max(300).nullable().optional(),
              }),
            ),
          }),
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
  ];
}
