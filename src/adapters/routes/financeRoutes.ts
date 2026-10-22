import { z } from "zod";
import type { CashSessions } from "../../application/use-cases/finance/CashSessions.js";
import type { FinanceSettingsService } from "../../application/use-cases/finance/FinanceSettingsService.js";
import type { Invoicing } from "../../application/use-cases/finance/Invoicing.js";
import type { LedgerViews } from "../../application/use-cases/finance/LedgerViews.js";
import type { PaymentRecording } from "../../application/use-cases/finance/PaymentRecording.js";
import { INVOICE_STATUSES } from "../../domain/finance/Invoice.js";
import { ACCOUNT_TYPES } from "../../domain/finance/Journal.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { CURRENCY_CODES, type CurrencyCode } from "../../domain/money/Currency.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "1250.50"');
const rate = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/, 'An exchange rate, e.g. "15.42"');
const currency = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);
const reason = z.string().trim().min(3).max(500);
const partyType = z.enum(["customer", "driver", "supplier"]);
const page = {
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

const invoiceBody = z.object({
  partyType: z.enum(["customer", "driver"]),
  partyId: uuid,
  branchId: uuid.optional(),
  vehicleId: uuid.nullable().optional(),
  issueDate: date.optional(),
  dueDate: date.optional(),
  currency: currency.optional(),
  fxRate: rate.nullable().optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        quantity: z.number().int().min(1).max(100_000),
        unitPrice: amount,
        discount: amount.optional(),
        taxCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{1,19}$/)
          .nullable()
          .optional(),
        accountId: uuid.optional(),
        vehicleId: uuid.nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export type FinanceRouteDependencies = Readonly<{
  invoices: Invoicing;
  payments: PaymentRecording;
  cashSessions: CashSessions;
  ledger: LedgerViews;
  settings: FinanceSettingsService;
}>;

/**
 * Finance recording core (docs/13, decision 16 — record only): invoices with tax, recorded
 * payments with allocations and receipts, cash sessions, the ledger and the period lock.
 */
export function financeRoutes(deps: FinanceRouteDependencies): ApiRoute[] {
  const { invoices, payments, cashSessions, ledger, settings } = deps;
  return [
    // --- settings ---
    defineRoute({
      method: "get",
      path: "/api/v1/settings/finance",
      summary: "Finance settings (cash sessions, payment terms)",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/finance",
      summary: "Change the finance settings",
      tags: ["settings"],
      access: access.permission("finance.settings.manage"),
      request: {
        body: z.object({
          requireCashSession: z.boolean().optional(),
          defaultDueDays: z.number().int().min(0).max(365).optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),

    // --- invoices ---
    defineRoute({
      method: "get",
      path: "/api/v1/invoices",
      summary: "Invoices in your branches, newest first",
      tags: ["finance"],
      access: access.permission("finance.invoices.view"),
      request: {
        query: z.object({
          status: z
            .string()
            .optional()
            .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
            .pipe(z.array(z.enum(INVOICE_STATUSES)).optional()),
          branchId: uuid.optional(),
          partyType: z.enum(["customer", "driver"]).optional(),
          partyId: uuid.optional(),
          from: date.optional(),
          to: date.optional(),
          overdueOn: date.optional(),
          ...page,
        }),
      },
      responses: { 200: { description: "Invoices; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { status, partyType: type, partyId, ...rest } = query;
        const result = await invoices.list(principalOf(res), {
          ...rest,
          ...(status === undefined ? {} : { statuses: status }),
          ...(type === undefined || partyId === undefined ? {} : { party: { type, id: partyId } }),
        });
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/invoices",
      summary: "Draft an invoice (tax from the business's tax codes)",
      tags: ["finance"],
      access: access.permission("finance.invoices.manage"),
      request: { body: invoiceBody },
      responses: { 201: { description: "Draft invoice" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await invoices.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/invoices/:id",
      summary: "An invoice with lines and tax breakdown",
      tags: ["finance"],
      access: access.permission("finance.invoices.view"),
      request: { params: idParams },
      responses: { 200: { description: "Invoice" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await invoices.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/invoices/:id",
      summary: "Replace a draft invoice",
      tags: ["finance"],
      access: access.permission("finance.invoices.manage"),
      request: { params: idParams, body: invoiceBody },
      responses: { 200: { description: "Draft invoice" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await invoices.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/invoices/:id",
      summary: "Delete a draft invoice",
      tags: ["finance"],
      access: access.permission("finance.invoices.manage"),
      request: { params: idParams },
      responses: { 204: { description: "Deleted" } },
      handler: async ({ params }, _req, res) => {
        await invoices.deleteDraft(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/invoices/:id/issue",
      summary: "Issue a draft: number it, snapshot its tax, post it",
      tags: ["finance"],
      access: access.permission("finance.invoices.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Issued invoice" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await invoices.issue(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/invoices/:id/void",
      summary: "Void an issued invoice without payments (posts the reversal)",
      tags: ["finance"],
      access: access.permission("finance.invoices.void"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Void invoice" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await invoices.void(principalOf(res), params.id, body.reason)));
      },
    }),

    // --- payments ---
    defineRoute({
      method: "get",
      path: "/api/v1/payments",
      summary: "Recorded payments in your branches, newest first",
      tags: ["finance"],
      access: access.permission("finance.payments.view"),
      request: {
        query: z.object({
          direction: z.enum(["in", "out"]).optional(),
          branchId: uuid.optional(),
          partyType: partyType.optional(),
          partyId: uuid.optional(),
          cashSessionId: uuid.optional(),
          from: date.optional(),
          to: date.optional(),
          withCredit: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          ...page,
        }),
      },
      responses: { 200: { description: "Payments; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { partyType: type, partyId, ...rest } = query;
        const result = await payments.list(principalOf(res), {
          ...rest,
          ...(type === undefined || partyId === undefined ? {} : { party: { type, id: partyId } }),
        });
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/payments",
      summary: "Record a payment received or made (cash, MoMo, bank, cheque, card)",
      tags: ["finance"],
      access: access.permission("finance.payments.record"),
      request: {
        body: z.object({
          direction: z.enum(["in", "out"]),
          method: z.enum(PAYMENT_METHODS),
          partyType: partyType.nullable().optional(),
          partyId: uuid.nullable().optional(),
          partyName: z.string().trim().min(1).max(160).nullable().optional(),
          branchId: uuid.optional(),
          paidOn: date.optional(),
          currency: currency.optional(),
          fxRate: rate.nullable().optional(),
          amount,
          reference: z.string().trim().max(100).nullable().optional(),
          momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
          vehicleId: uuid.nullable().optional(),
          notes: z.string().trim().max(2_000).nullable().optional(),
          counterAccountId: uuid.nullable().optional(),
          allocations: z
            .array(z.object({ invoiceId: uuid, amount }))
            .max(50)
            .optional(),
        }),
      },
      responses: { 201: { description: "Payment" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await payments.record(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/payments/:id",
      summary: "A payment with its allocations",
      tags: ["finance"],
      access: access.permission("finance.payments.view"),
      request: { params: idParams },
      responses: { 200: { description: "Payment" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await payments.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/payments/:id/receipt",
      summary: "The receipt of money received (data; the PDF comes with P2-10)",
      tags: ["finance"],
      access: access.permission("finance.payments.view"),
      request: { params: idParams },
      responses: { 200: { description: "Receipt" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await payments.receipt(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/payments/:id/allocations",
      summary: "Apply part of a payment (credit) to an invoice of the same party",
      tags: ["finance"],
      access: access.permission("finance.payments.record"),
      request: { params: idParams, body: z.object({ invoiceId: uuid, amount }) },
      responses: { 200: { description: "Payment" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await payments.allocate(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/payments/:id/allocations/:allocationId/release",
      summary: "Release an allocation (the money becomes credit again)",
      tags: ["finance"],
      access: access.permission("finance.payments.reverse"),
      request: {
        params: z.object({ id: uuid, allocationId: uuid }),
        body: z.object({ reason }),
      },
      responses: { 200: { description: "Payment" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await payments.release(principalOf(res), params.id, params.allocationId, body.reason),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/payments/:id/reverse",
      summary: "Reverse a payment recorded by mistake",
      tags: ["finance"],
      access: access.permission("finance.payments.reverse"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Payment" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await payments.reverse(principalOf(res), params.id, body.reason)));
      },
    }),

    // --- cash sessions ---
    defineRoute({
      method: "post",
      path: "/api/v1/cash-sessions",
      summary: "Open your cash session with a float",
      tags: ["finance"],
      access: access.permission("finance.cash_sessions.manage"),
      request: { body: z.object({ branchId: uuid.optional(), float: amount }) },
      responses: { 201: { description: "Cash session" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await cashSessions.open(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/cash-sessions/current",
      summary: "Your open cash session (null when none)",
      tags: ["finance"],
      access: access.permission("finance.cash_sessions.manage"),
      responses: { 200: { description: "Cash session or null" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await cashSessions.current(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/cash-sessions",
      summary: "Cash sessions (yours, or every session of the branches you supervise)",
      tags: ["finance"],
      access: access.permission("finance.cash_sessions.manage"),
      request: {
        query: z.object({
          branchId: uuid.optional(),
          cashierId: uuid.optional(),
          status: z.enum(["open", "closed"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Cash sessions" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await cashSessions.list(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/cash-sessions/:id",
      summary: "A cash session",
      tags: ["finance"],
      access: access.permission("finance.cash_sessions.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Cash session" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await cashSessions.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/cash-sessions/:id/close",
      summary: "Count the cash and close the session (the variance is posted)",
      tags: ["finance"],
      access: access.permission("finance.cash_sessions.manage"),
      request: {
        params: idParams,
        body: z.object({
          counted: amount,
          notes: z.string().trim().max(2_000).nullable().optional(),
        }),
      },
      responses: { 200: { description: "Closed cash session" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await cashSessions.close(principalOf(res), params.id, body)));
      },
    }),

    // --- ledger ---
    defineRoute({
      method: "get",
      path: "/api/v1/ledger/accounts",
      summary: "Chart of accounts with balances",
      tags: ["finance"],
      access: access.permission("finance.ledger.view"),
      responses: { 200: { description: "Accounts" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await ledger.accounts()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/ledger/accounts",
      summary: "Add an account (e.g. a separate income line)",
      tags: ["finance"],
      access: access.permission("finance.accounts.manage"),
      request: {
        body: z.object({
          code: z.string().regex(/^[0-9]{3,6}$/),
          name: z.string().trim().min(1).max(120),
          type: z.enum(ACCOUNT_TYPES),
        }),
      },
      responses: { 201: { description: "Account" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await ledger.createAccount(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/ledger/trial-balance",
      summary: "Trial balance (debits always equal credits)",
      tags: ["finance"],
      access: access.permission("finance.ledger.view"),
      request: { query: z.object({ asOf: date.optional() }) },
      responses: { 200: { description: "Trial balance" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await ledger.trialBalance(query.asOf ?? null)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/ledger/integrity",
      summary:
        "Check the books: entries balanced, allocations add up, work and pay sub-ledgers agree with the ledger",
      tags: ["finance"],
      access: access.permission("finance.ledger.view"),
      responses: { 200: { description: "Each check, with the first offenders" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await ledger.integrity()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/ledger/lines",
      summary: "Ledger lines by account, party, vehicle, branch or period, newest first",
      tags: ["finance"],
      access: access.permission("finance.ledger.view"),
      request: {
        query: z.object({
          accountId: uuid.optional(),
          partyType: partyType.optional(),
          partyId: uuid.optional(),
          vehicleId: uuid.optional(),
          branchId: uuid.optional(),
          from: date.optional(),
          to: date.optional(),
          ...page,
        }),
      },
      responses: { 200: { description: "Lines; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { partyType: type, partyId, ...rest } = query;
        const result = await ledger.lines({
          ...rest,
          ...(type === undefined || partyId === undefined ? {} : { party: { type, id: partyId } }),
        });
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/ledger/parties/:partyType/:id",
      summary: "A party's account: credit, what they owe, net",
      tags: ["finance"],
      access: access.permission("finance.invoices.view"),
      request: { params: z.object({ partyType, id: uuid }) },
      responses: { 200: { description: "Party account" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await ledger.partyAccount(params.partyType, params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/ledger/period-lock",
      summary: "Until when the books are locked",
      tags: ["finance"],
      access: access.permission("finance.ledger.view"),
      responses: { 200: { description: "Lock" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await ledger.periodLock()));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/ledger/period-lock",
      summary: "Lock the books up to a past date (null unlocks); with a reason",
      tags: ["finance"],
      access: access.permission("finance.period.lock"),
      request: { body: z.object({ lockedUntil: date.nullable(), reason }) },
      responses: { 200: { description: "Lock" } },
      handler: async ({ body }, _req, res) => {
        res.json(
          envelope(await ledger.setPeriodLock(principalOf(res), body.lockedUntil, body.reason)),
        );
      },
    }),
  ];
}
