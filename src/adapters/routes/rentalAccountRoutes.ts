import { z } from "zod";
import type { RentalAccounts } from "../../application/use-cases/rentals/RentalAccounts.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Send amounts as text, e.g. "250.00"');
const counter = {
  method: z.enum(PAYMENT_METHODS),
  momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  paidOn: z.iso.date().optional(),
};
const money = z.object({ amount, ...counter });

export type RentalAccountRouteDependencies = Readonly<{ accounts: RentalAccounts }>;

/** A rental's money (docs/07 §5) and the renter's account (§8), recorded through finance. */
export function rentalAccountRoutes(deps: RentalAccountRouteDependencies): ApiRoute[] {
  const { accounts } = deps;
  const step = (
    path: string,
    summary: string,
    body: z.ZodType,
    run: (actor: ReturnType<typeof principalOf>, id: string, body: never) => Promise<unknown>,
    permission: Parameters<typeof access.permission>[0] = "rentals.payments.record",
  ) =>
    defineRoute({
      method: "post",
      path: `/api/v1/rentals/:id/${path}`,
      summary,
      tags: ["rentals"],
      access: access.permission(permission),
      request: { params: idParams, body },
      responses: { 200: { description: "Account" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await run(principalOf(res), params.id, input as never)));
      },
    });

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/rentals/:id/account",
      summary: "A booking's charges, invoices, balance, payments and deposit",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: idParams },
      responses: { 200: { description: "Account" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await accounts.account(principalOf(res), params.id)));
      },
    }),
    step(
      "payments",
      "Take a payment for the booking (applied to its invoices; the rest to the next one)",
      money,
      (actor, id, body) => accounts.recordPayment(actor, id, body),
    ),
    step(
      "deposit",
      "Take the security deposit (held as the customer's credit)",
      money,
      (actor, id, body) => accounts.holdDeposit(actor, id, body),
    ),
    step(
      "deposit/apply",
      "Apply the deposit to the booking's open invoices (all it can without an amount)",
      z.object({ amount: amount.nullable().optional() }),
      (actor, id, body: { amount?: string | null }) =>
        accounts.applyDeposit(actor, id, body.amount ?? null),
    ),
    step(
      "deposit/release",
      "Return what the deposit still holds to the customer",
      z.object(counter),
      (actor, id, body) => accounts.releaseDeposit(actor, id, body),
    ),
    step(
      "invoice",
      "Invoice the charges not invoiced yet (a later damage, a cancellation fee)",
      z.object({}),
      (actor, id) => accounts.invoiceNow(actor, id),
      "rentals.update",
    ),
    defineRoute({
      method: "get",
      path: "/api/v1/customers/:id/rental-account",
      summary:
        "A renter's account: risk, credit limit and what is owed, rental history, authorised drivers",
      tags: ["customers"],
      access: access.permission("customers.view"),
      request: { params: idParams },
      responses: { 200: { description: "Renter" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await accounts.renterSummary(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/customers/:id/authorised-drivers",
      summary: "Authorise an individual customer to drive a company's rentals",
      tags: ["customers"],
      access: access.permission("customers.update"),
      request: { params: idParams, body: z.object({ driverId: uuid }) },
      responses: { 200: { description: "Renter" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await accounts.authoriseDriver(principalOf(res), params.id, body.driverId)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/customers/:id/authorised-drivers/:driverId",
      summary: "Withdraw a driver's authorisation",
      tags: ["customers"],
      access: access.permission("customers.update"),
      request: { params: z.object({ id: uuid, driverId: uuid }) },
      responses: { 200: { description: "Renter" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await accounts.revokeDriver(principalOf(res), params.id, params.driverId)),
        );
      },
    }),
  ];
}
