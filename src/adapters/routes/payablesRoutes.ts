import { z } from "zod";
import type { SupplierPayables } from "../../application/use-cases/payables/SupplierPayables.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const rate = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/, 'An exchange rate, e.g. "15.42"');
const percent = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'A percentage, e.g. "7.5"');

export type PayablesRouteDependencies = Readonly<{ payables: SupplierPayables }>;

/**
 * Supplier payables (docs/11 §5): aged payables, a supplier's open bills and statement, and one
 * payment for several of its approved bills (decisions 415–420).
 */
export function payablesRoutes(deps: PayablesRouteDependencies): ApiRoute[] {
  const { payables } = deps;
  const view = access.permission("finance.payables.view");

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/payables/aged",
      summary:
        "What the business owes on approved, unpaid bills by payee, aged by days past due (current, 1–30, 31–60, 61–90, over 90)",
      tags: ["finance"],
      access: view,
      request: { query: z.object({ asOf: date.optional() }) },
      responses: { 200: { description: "Aged payables" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await payables.aged(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/suppliers/:id/bills",
      summary: "A supplier's open bills with their due dates from its payment terms",
      tags: ["finance"],
      access: view,
      request: { params: idParams, query: z.object({ asOf: date.optional() }) },
      responses: { 200: { description: "Open bills" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await payables.bills(principalOf(res), params.id, query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/suppliers/:id/statement",
      summary:
        "A supplier's statement: what was billed and paid in the period with the running balance owed, and its open bills aged",
      tags: ["finance"],
      access: view,
      request: {
        params: idParams,
        query: z.object({ from: date.optional(), to: date.optional() }),
      },
      responses: { 200: { description: "Statement" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await payables.statement(principalOf(res), params.id, query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/suppliers/:id/payments",
      summary:
        "Pay several of a supplier's approved bills in one payment, optionally withholding tax",
      tags: ["finance"],
      access: access.permission("suppliers.payments.make"),
      request: {
        params: idParams,
        body: z.object({
          expenseIds: z.array(uuid).min(1).max(50),
          method: z.enum(PAYMENT_METHODS),
          paidOn: date.optional(),
          fxRate: rate.nullable().optional(),
          reference: z.string().trim().max(100).nullable().optional(),
          momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
          branchId: uuid.optional(),
          withholdingRate: percent.nullable().optional(),
          notes: z.string().trim().max(2_000).nullable().optional(),
        }),
      },
      responses: { 201: { description: "Supplier payment" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await payables.pay(principalOf(res), params.id, body)));
      },
    }),
  ];
}
