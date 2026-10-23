import { z } from "zod";
import type { EnterpriseQuotes } from "../../application/use-cases/billing/EnterpriseQuotes.js";
import { principalOf, staffOf, tenantOf } from "../middleware/AccessGuard.js";
import { sendPdf } from "../presenters/pdfResponse.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const CONSOLE = "/api/platform/v1";
const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const reason = z.string().trim().min(5).max(1_000);

const terms = z.object({
  lines: z
    .array(
      z.object({
        kind: z.enum(["branch_rate", "size_adjustment", "setup", "other", "discount"]),
        description: z.string().max(300),
        quantity: z.number().int(),
        unitMinor: z.number().int(),
        recurrence: z.enum(["monthly", "one_time"]).optional(),
        countsAsLicence: z.boolean().optional(),
      }),
    )
    .max(30),
  sizeBand: z.enum(["small", "medium", "large", "very_large"]).nullish(),
  sizeNote: z.string().max(1_000).nullish(),
  notes: z.string().max(2_000).nullish(),
  validUntil: z.iso.date().nullish(),
});

export type EnterpriseQuoteRouteDependencies = Readonly<{ quotes: EnterpriseQuotes }>;

/**
 * Enterprise licence (docs/25 §2.1): the console's hand-built, versioned quotes — draft, edit,
 * send (Super Admin), withdraw, record acceptance, PDF — and the tenant's Billing tab view of the
 * quotes sent to it, which it can accept, and its price list.
 */
export function enterpriseQuoteRoutes(deps: EnterpriseQuoteRouteDependencies): ApiRoute[] {
  const { quotes } = deps;
  return [
    // --- tenant: Billing tab ---
    defineRoute({
      method: "get",
      path: "/api/v1/billing/quotes",
      summary: "Enterprise quotes sent to you (newest first)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Quotes" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await quotes.tenantQuotes(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/quotes/:id",
      summary: "One of your quotes",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: idParams },
      responses: { 200: { description: "Quote" }, 404: { description: "Not found" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.quote(params.id, tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/quotes/:id/pdf",
      summary: "One of your quotes as a PDF",
      tags: ["billing"],
      access: access.permission("billing.view"),
      request: { params: idParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await quotes.pdf(params.id, tenantOf(res).id));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/billing/quotes/:id/accept",
      summary: "Accept a quote: it becomes your price list from the next invoice",
      tags: ["billing"],
      access: access.permission("billing.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Accepted quote" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(
            await quotes.acceptAsTenant(params.id, tenantOf(res).id, principalOf(res).userId),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/billing/price-items",
      summary: "Your Enterprise price list (from the accepted quote)",
      tags: ["billing"],
      access: access.permission("billing.view"),
      responses: { 200: { description: "Price items" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await quotes.priceItems(tenantOf(res).id)));
      },
    }),

    // --- console ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/tenants/:id/quotes`,
      summary: "A tenant's Enterprise quotes, every version",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: idParams },
      responses: { 200: { description: "Quotes" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.list(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/tenants/:id/quotes`,
      summary: "Start a quote (a new version) for an Enterprise tenant",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: idParams, body: terms },
      responses: { 201: { description: "Draft quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await quotes.create(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/tenants/:id/price-items`,
      summary: "A tenant's price list from its accepted quote",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: idParams },
      responses: { 200: { description: "Price items" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.priceItems(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/quotes/:id`,
      summary: "One quote",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: idParams },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.quote(params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/billing/quotes/:id/pdf`,
      summary: "A quote as a PDF (drafts are watermarked)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.view"),
      request: { params: idParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await quotes.pdf(params.id));
      },
    }),
    defineRoute({
      method: "put",
      path: `${CONSOLE}/billing/quotes/:id`,
      summary: "Edit a draft quote (lines, size, notes, valid until)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: idParams, body: terms },
      responses: { 200: { description: "Quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await quotes.update(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/quotes/:id/send`,
      summary: "Approve and send a quote to the tenant (Super Admin)",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Sent quote" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await quotes.send(params.id, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/quotes/:id/accept`,
      summary: "Record that the tenant accepted a sent quote",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Accepted quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await quotes.acceptForTenant(params.id, body.reason, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/billing/quotes/:id/withdraw`,
      summary: "Withdraw a draft or sent quote",
      tags: ["console: billing"],
      access: access.platform("platform.billing.manage"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Withdrawn quote" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await quotes.withdraw(params.id, body.reason, staffOf(res))));
      },
    }),
  ];
}
