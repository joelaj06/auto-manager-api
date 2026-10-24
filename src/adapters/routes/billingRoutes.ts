import { z } from "zod";
import type { GatewayBilling } from "../../application/use-cases/billing/GatewayBilling.js";
import type { GatewayReconciliation } from "../../application/use-cases/billing/GatewayReconciliation.js";
import type { ManualBilling } from "../../application/use-cases/billing/ManualBilling.js";
import type { SubscriptionAdministration } from "../../application/use-cases/billing/SubscriptionAdministration.js";
import type { TenantBilling } from "../../application/use-cases/billing/TenantBilling.js";
import { principalOf, staffOf } from "../middleware/AccessGuard.js";
import type { RawBodyRequest } from "../middleware/rawBody.js";
import { sendPdf } from "../presenters/pdfResponse.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const CONSOLE = "/api/platform/v1";
const uuid = z.uuid();
const reason = z.string().trim().min(5).max(1_000);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const tenantParams = z.object({ id: uuid });
const minor = z.number().int();
const nextBefore = (items: readonly { id: string }[], pageSize: number) =>
  items.length === pageSize ? (items.at(-1)?.id ?? null) : null;

export type BillingRouteDependencies = Readonly<{
  tenantBilling: TenantBilling;
  subscriptions: SubscriptionAdministration;
  billing: ManualBilling;
  gateway: GatewayBilling;
  reconciliation: GatewayReconciliation;
  /** Development only: complete a fake-gateway payment as the payer would. */
  completeFakePayment?: (reference: string) => Promise<number>;
}>;

/**
 * Subscriptions and billing (docs/25): the tenant's Billing tab (subscription, the next invoice,
 * invoices and receipts with PDFs, the transaction history, billing details and contacts,
 * payment methods) and the console (plans, billing settings and VAT, licence type, trial
 * extension, billed branches, invoices and recorded payments). Amounts are minor units.
 */
export function billingRoutes(deps: BillingRouteDependencies): ApiRoute[] {
  const { tenantBilling, subscriptions, billing, gateway, reconciliation } = deps;
  const reference = z.string().regex(/^[A-Za-z0-9._=-]{6,100}$/);
  return [
    // --- tenant: Billing tab ---
    defineRoute({
      method: "get",
      path: "/api/v1/billing/subscription",
      summary: "Your plan, licence, billed branches, period and entitlements",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Subscription" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.subscription()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/invoices",
      summary: "Your invoices (newest first)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { query: z.object({ before: uuid.optional(), limit }) },
      responses: { 200: { description: "Invoices" } },
      handler: async ({ query }, _req, res) => {
        const invoices = await tenantBilling.invoices(query);
        res.json(envelope(invoices, { nextBefore: nextBefore(invoices, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/invoices/:id",
      summary: "One of your invoices with its payments",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Invoice" }, 404: { description: "Not found" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await tenantBilling.invoice(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/invoices/:id/pdf",
      summary: "One of your invoices as a PDF",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await tenantBilling.invoicePdf(params.id));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/upcoming",
      summary: "Your next invoice as it stands today: branches, prorations, VAT",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Invoice preview" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.upcoming()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/transactions",
      summary: "Your billing history: invoices, cancellations and payments with the balance",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Transactions, oldest first, and what is owed now" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.transactions()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/receipts",
      summary: "Receipts of your payments (newest first)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Receipts" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.receipts()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/receipts/:id",
      summary: "One receipt",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Receipt" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await tenantBilling.receipt(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/receipts/:id/pdf",
      summary: "A receipt as a PDF",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await tenantBilling.receiptPdf(params.id));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/details",
      summary: "Your billing details (as printed on invoices) and billing contacts",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Billing details" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.profile()));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/billing/details",
      summary: "Change your legal name, TIN and address on invoices (from the next invoice)",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: {
        body: z.object({
          legalName: z.string().trim().min(2).max(160),
          tin: z.string().trim().max(40).nullish(),
          address: z.string().trim().max(500).nullish(),
        }),
      },
      responses: { 200: { description: "Billing details" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await tenantBilling.updateProfile(body, principalOf(res).userId)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/billing/contacts",
      summary: "Who receives invoices, receipts and billing notices (1–5, one primary)",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: {
        body: z.object({
          contacts: z
            .array(
              z.object({
                name: z.string().trim().min(2).max(120),
                email: z.string().trim().max(200).nullish(),
                phone: z.string().trim().max(20).nullish(),
                isPrimary: z.boolean().optional(),
                receivesNotices: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(5),
        }),
      },
      responses: { 200: { description: "Contacts" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await tenantBilling.replaceContacts(body.contacts)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/payment-methods",
      summary: "Saved cards and MoMo numbers (default first)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Payment methods" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.paymentMethods()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/billing/payment-methods/:id/default",
      summary: "Make a saved payment method the default",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: { params: tenantParams },
      responses: { 200: { description: "Payment methods" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await tenantBilling.setDefaultPaymentMethod(params.id)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/billing/payment-methods/:id",
      summary: "Forget a saved payment method",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: { params: tenantParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await tenantBilling.removePaymentMethod(params.id);
        res.status(204).end();
      },
    }),

    // --- tenant: paying through the gateway ---
    defineRoute({
      method: "post",
      path: "/api/v1/billing/invoices/:id/checkout",
      summary: "Pay an invoice on the provider's hosted page (card, MoMo, bank transfer)",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: { params: tenantParams, body: z.object({ saveCard: z.boolean().optional() }) },
      responses: { 201: { description: "The payment with its checkout URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await gateway.checkout(params.id, body, principalOf(res).userId)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/billing/invoices/:id/pay",
      summary: "Pay an invoice with a saved card or MoMo number",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: { params: tenantParams, body: z.object({ paymentMethodId: uuid }) },
      responses: { 201: { description: "The payment" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(
            envelope(
              await gateway.payWithSavedMethod(
                params.id,
                body.paymentMethodId,
                principalOf(res).userId,
              ),
            ),
          );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/billing/invoices/:id/momo",
      summary: "Pay an invoice by mobile money: a prompt on the phone (or a code to enter)",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: {
        params: tenantParams,
        body: z.object({
          phone: z.string().trim().min(9).max(20),
          network: z.enum(["mtn", "telecel", "at"]),
          save: z.boolean().optional(),
        }),
      },
      responses: { 201: { description: "The payment and what to do next" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await gateway.payWithMomo(params.id, body, principalOf(res).userId)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/invoices/:id/payment-attempts",
      summary: "Payments started on an invoice through the gateway",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Attempts" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await gateway.invoiceAttempts(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/payments/:reference",
      summary: "Where a payment stands (the return page asks the provider while it is pending)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: z.object({ reference }) },
      responses: { 200: { description: "The payment" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await gateway.status(params.reference)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/billing/payments/:reference/otp",
      summary: "Enter the code or voucher the mobile network sent",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: {
        params: z.object({ reference }),
        body: z.object({ otp: z.string().trim().min(3).max(12) }),
      },
      responses: { 200: { description: "The payment" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await gateway.submitOtp(params.reference, body.otp)));
      },
    }),
    ...(deps.completeFakePayment === undefined
      ? []
      : [
          defineRoute({
            method: "post",
            path: "/api/v1/billing/fake-gateway/:reference/complete",
            summary: "Development only: pay a fake-gateway payment as the payer would",
            tags: ["billing"],
            access: access.permission("billing.manage"),
            request: { params: z.object({ reference }) },
            responses: { 204: { description: "Paid (the webhook was delivered)" } },
            handler: async ({ params }, _req, res) => {
              res
                .status((await deps.completeFakePayment!(params.reference)) === 200 ? 204 : 500)
                .end();
            },
          }),
        ]),

    // --- the provider ---
    defineRoute({
      method: "post",
      path: "/api/v1/webhooks/billing",
      summary:
        "Payment provider webhook (signed; verified with the provider before anything is credited)",
      tags: ["billing"],
      access: access.public(),
      request: { body: z.record(z.string(), z.unknown()) },
      responses: { 200: { description: "Received" }, 401: { description: "Bad signature" } },
      handler: async ({ body }, req, res) => {
        const raw = (req as unknown as RawBodyRequest).rawBody ?? Buffer.from(JSON.stringify(body));
        const signature = req.header("x-paystack-signature") ?? req.header("x-gateway-signature");
        res.status(await gateway.receiveWebhook(raw, signature, body)).end();
      },
    }),

    // --- console: gateway ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/gateway-transactions`,
      summary:
        "Gateway payments (status=failed: the failed-payments queue; review: needs a person)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: {
        query: z.object({
          status: z.enum(["pending", "succeeded", "failed", "abandoned", "review"]).optional(),
          tenantId: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Attempts" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await gateway.attempts(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/webhooks`,
      summary: "Webhook inspector: what the provider sent and what we did with it",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: {
        query: z.object({
          outcome: z.enum(["applied", "ignored", "failed", "rejected"]).optional(),
          before: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Webhook events" } },
      handler: async ({ query }, _req, res) => {
        const events = await gateway.webhooks(query);
        res.json(envelope(events, { nextBefore: nextBefore(events, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/webhooks/:id`,
      summary: "One webhook event with its payload",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Webhook event" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await gateway.webhook(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/webhooks/:id/replay`,
      summary: "Process a signed webhook again (idempotent)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: tenantParams, body: z.object({}) },
      responses: { 200: { description: "Webhook event after the replay" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await gateway.replayWebhook(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/payments/:id/refunds`,
      summary: "Refund a payment (through the gateway, or recorded as paid back outside)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.refunds.issue"),
      request: {
        params: tenantParams,
        body: z.object({ amountMinor: minor.min(1), reason }),
      },
      responses: {
        201: { description: "Refund" },
        202: { description: "Waiting for a second staff member's approval" },
      },
      handler: async ({ params, body }, _req, res) => {
        const result = await gateway.requestRefund(params.id, body, staffOf(res));
        // Above the threshold the refund waits for a second staff member (four-eyes).
        res.status("approvalId" in result ? 202 : 201).json(envelope(result));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/payments/:id/refunds`,
      summary: "Refunds of a payment",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Refunds" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await gateway.refunds(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/reconciliations`,
      summary: "Daily reconciliations with the payment provider (newest first)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { query: z.object({ limit }) },
      responses: { 200: { description: "Reconciliations" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reconciliation.list(query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/reconciliations`,
      summary: "Reconcile one day again",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { body: z.object({ day: z.iso.date() }) },
      responses: { 200: { description: "Reconciliation" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await reconciliation.runFor(body.day, staffOf(res))));
      },
    }),

    // --- console: billing settings ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/settings`,
      summary: "Autoforce as the seller on invoices, VAT and payment instructions",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      responses: { 200: { description: "Billing settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await subscriptions.billingSettings()));
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/billing/settings`,
      summary: "Change the seller details, VAT registration and rates (applies to new invoices)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.prices.manage"),
      request: {
        body: z.object({
          sellerName: z.string().trim().min(2).max(160),
          sellerAddress: z.string().trim().max(500).nullable(),
          sellerTin: z.string().trim().max(40).nullable(),
          sellerEmail: z.string().trim().max(200).nullable(),
          sellerPhone: z.string().trim().max(40).nullable(),
          vatRegistered: z.boolean(),
          vatNumber: z.string().trim().max(40).nullable(),
          taxComponents: z
            .array(
              z.object({
                key: z.string().max(30),
                name: z.string().trim().min(1).max(60),
                rate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
                base: z.enum(["net", "net_plus_previous"]),
                effectiveFrom: z.iso.date(),
                effectiveTo: z.iso.date().nullable(),
              }),
            )
            .max(10),
          paymentInstructions: z.string().trim().max(1_000).nullable(),
          invoiceDueDays: z.number().int().min(0).max(60),
          reason,
        }),
      },
      responses: { 200: { description: "Billing settings" } },
      handler: async ({ body }, _req, res) => {
        const { reason: why, ...settings } = body;
        res.json(envelope(await subscriptions.updateBillingSettings(settings, why, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/tenants/:id/billing-details`,
      summary: "A tenant's billing details and contacts",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Billing details" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await subscriptions.billingDetails(params.id)));
      },
    }),

    // --- console: plans ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/plans`,
      summary: "Plans and prices",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      responses: { 200: { description: "Plans" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await subscriptions.plans()));
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/billing/plans/:code/price`,
      summary: "Set the standard price per branch per month (applies to the next invoices)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.prices.manage"),
      request: {
        params: z.object({ code: z.string().regex(/^[a-z][a-z_]*$/) }),
        body: z.object({ branchPriceMinor: minor.min(1).max(100_000_000), reason }),
      },
      responses: { 200: { description: "Plan" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await subscriptions.setPlanPrice(
              params.code,
              body.branchPriceMinor,
              body.reason,
              staffOf(res),
            ),
          ),
        );
      },
    }),

    // --- console: a tenant's subscription ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/tenants/:id/subscription`,
      summary: "A tenant's subscription, entitlements and billing events",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Subscription" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope({
            ...(await subscriptions.view(params.id)),
            events: await subscriptions.events(params.id),
          }),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/tenants/:id/licence-type`,
      summary: "Standard or Enterprise licence (only until the first payment)",
      tags: ["console: billing"],
      access: access.platform("platform.tenants.set_licence_type"),
      request: {
        params: tenantParams,
        body: z.object({ licenceType: z.enum(["standard", "enterprise"]), reason }),
      },
      responses: { 200: { description: "Subscription" }, 409: { description: "Locked" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await subscriptions.setLicenceType(
              params.id,
              body.licenceType,
              body.reason,
              staffOf(res),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/tenants/:id/subscription/extend-trial`,
      summary: "Extend a trial (at most 60 days from today)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: tenantParams, body: z.object({ until: z.coerce.date(), reason }) },
      responses: { 200: { description: "Subscription" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await subscriptions.extendTrial(params.id, body.until, body.reason, staffOf(res)),
          ),
        );
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/tenants/:id/subscription/branches`,
      summary: "Set the billed branch count (the branch entitlement out of trial)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: {
        params: tenantParams,
        body: z.object({ branchCount: z.number().int().min(1).max(1_000), reason }),
      },
      responses: { 200: { description: "Subscription" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await subscriptions.setBranchCount(
              params.id,
              body.branchCount,
              body.reason,
              staffOf(res),
            ),
          ),
        );
      },
    }),

    // --- console: invoices and payments ---
    defineRoute({
      method: "post",
      path: `${CONSOLE}/tenants/:id/invoices`,
      summary: "Issue the invoice for the next period (enterprise: enter the lines)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: {
        params: tenantParams,
        body: z.object({
          dueInDays: z.number().int().min(0).max(60).optional(),
          lines: z
            .array(
              z.object({
                kind: z.enum(["branch_rate", "size_adjustment", "setup", "other", "discount"]),
                description: z.string().trim().min(1).max(200),
                quantity: z.number().int().min(1).max(10_000),
                unitMinor: minor.min(-100_000_000).max(100_000_000),
                countsAsLicence: z.boolean().optional(),
              }),
            )
            .max(50)
            .optional(),
        }),
      },
      responses: { 201: { description: "Invoice" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await billing.issue(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/invoices`,
      summary: "Invoices (newest first)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: {
        query: z.object({
          tenantId: uuid.optional(),
          status: z.enum(["open", "paid", "void"]).optional(),
          before: uuid.optional(),
          limit,
        }),
      },
      responses: { 200: { description: "Invoices" } },
      handler: async ({ query }, _req, res) => {
        const invoices = await billing.invoices(query);
        res.json(envelope(invoices, { nextBefore: nextBefore(invoices, query.limit) }));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/invoices/:id`,
      summary: "An invoice with its payments",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "Invoice" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await billing.invoice(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/invoices/:id/pdf`,
      summary: "An invoice as a PDF",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await billing.invoicePdf(params.id));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/payments/:id/receipt/pdf`,
      summary: "The receipt of a payment as a PDF",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: tenantParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await billing.receiptPdf(params.id));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/invoices/:id/payments`,
      summary: "Record a payment received (bank transfer, MoMo, cash, cheque)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.payments.record"),
      request: {
        params: tenantParams,
        body: z.object({
          method: z.enum(["bank_transfer", "momo", "cash", "cheque", "other"]),
          reference: z.string().trim().min(1).max(120),
          amountMinor: minor.min(1),
          receivedAt: z.coerce.date(),
          notes: z.string().trim().max(1_000).nullish(),
        }),
      },
      responses: { 200: { description: "Invoice (paid when fully paid)" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await billing.recordPayment(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/invoices/:id/void`,
      summary: "Void an unpaid invoice",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: tenantParams, body: z.object({ reason }) },
      responses: { 200: { description: "Invoice" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await billing.void(params.id, body.reason, staffOf(res))));
      },
    }),
  ];
}
