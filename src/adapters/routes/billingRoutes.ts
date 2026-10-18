import { z } from "zod";
import type { ManualBilling } from "../../application/use-cases/billing/ManualBilling.js";
import type { SubscriptionAdministration } from "../../application/use-cases/billing/SubscriptionAdministration.js";
import type { TenantBilling } from "../../application/use-cases/billing/TenantBilling.js";
import { staffOf } from "../middleware/AccessGuard.js";
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
}>;

/**
 * Subscriptions and manual billing (docs/25): the tenant's Billing tab (read) and the console
 * (plans, licence type, trial extension, billed branches, invoices and recorded payments).
 * Amounts are minor units (pesewas).
 */
export function billingRoutes(deps: BillingRouteDependencies): ApiRoute[] {
  const { tenantBilling, subscriptions, billing } = deps;
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
      path: "/api/v1/billing/transactions",
      summary: "Your payment history",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Payments, newest first" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tenantBilling.transactions()));
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
