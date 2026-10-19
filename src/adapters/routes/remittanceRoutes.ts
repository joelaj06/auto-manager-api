import { z } from "zod";
import type { DriverLedger } from "../../application/use-cases/remittances/DriverLedger.js";
import type { OperationsBoard } from "../../application/use-cases/remittances/OperationsBoard.js";
import type { RemittanceSettingsService } from "../../application/use-cases/remittances/RemittanceSettingsService.js";
import type { Remittances } from "../../application/use-cases/remittances/Remittances.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { REMITTANCE_STATUSES } from "../../domain/remittances/Remittance.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const submissionParams = z.object({ id: uuid, submissionId: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const reason = z.string().trim().min(3).max(500);

const money = {
  amount,
  method: z.enum(PAYMENT_METHODS),
  momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
};
const declaration = z.object({
  ...money,
  earnings: z
    .record(z.string().max(30), z.number().min(0).max(1_000_000_000))
    .nullable()
    .optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
});

export type RemittanceRouteDependencies = Readonly<{
  remittances: Remittances;
  ledger: DriverLedger;
  board: OperationsBoard;
  settings: RemittanceSettingsService;
}>;

/**
 * Remittances and the driver ledger (docs/09): expected periods, declarations and their approval,
 * money recorded directly, waivers; driver statements and adjustments; the operations board.
 */
export function remittanceRoutes(deps: RemittanceRouteDependencies): ApiRoute[] {
  const { remittances, ledger, board, settings } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/settings/remittances",
      summary: "Remittance settings (grace days, shortfall alert)",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/remittances",
      summary: "Change the remittance settings",
      tags: ["settings"],
      access: access.permission("settings.update"),
      request: {
        body: z.object({
          graceDays: z.number().int().min(0).max(30).optional(),
          shortfallAlertPeriods: z.number().int().min(1).max(14).optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/operations/board",
      summary: "Daily operations board: fleet out/idle, remittances due, drivers behind, licences",
      tags: ["remittances"],
      access: access.permission("operations.board.view"),
      request: { query: z.object({ date: date.optional(), branchId: uuid.optional() }) },
      responses: { 200: { description: "Board" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await board.board(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/remittances",
      summary: "Remittances in your branches, latest periods first",
      tags: ["remittances"],
      access: access.permission("remittances.list"),
      request: {
        query: z.object({
          status: z
            .string()
            .optional()
            .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
            .pipe(z.array(z.enum(REMITTANCE_STATUSES)).optional()),
          branchId: uuid.optional(),
          driverId: uuid.optional(),
          vehicleId: uuid.optional(),
          from: date.optional(),
          to: date.optional(),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Remittances; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        const page = await remittances.list(principalOf(res), {
          ...rest,
          ...(status === undefined ? {} : { statuses: status }),
        });
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/remittances/declare",
      summary: "Declare a variable-mode period (what the driver paid in)",
      tags: ["remittances"],
      access: access.permission("remittances.submit"),
      request: {
        body: declaration.extend({ vehicleId: uuid, periodStart: date, periodEnd: date }),
      },
      responses: { 201: { description: "Remittance waiting for approval" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await remittances.declarePeriod(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/remittances/:id",
      summary: "A remittance with its declarations and payments",
      tags: ["remittances"],
      access: access.permission("remittances.view"),
      request: { params: idParams },
      responses: { 200: { description: "Remittance" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await remittances.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/remittances/:id/submissions",
      summary: "Declare what was paid for the period (waits for approval)",
      tags: ["remittances"],
      access: access.permission("remittances.submit"),
      request: { params: idParams, body: declaration },
      responses: { 201: { description: "Remittance" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await remittances.submit(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/remittances/:id/submissions/:submissionId/approve",
      summary: "Confirm a declaration (the money received; records the payment)",
      tags: ["remittances"],
      access: access.permission("remittances.approve"),
      request: { params: submissionParams, body: z.object({ amount: amount.optional() }) },
      responses: { 200: { description: "Remittance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await remittances.approve(principalOf(res), params.id, {
              submissionId: params.submissionId,
              ...(body.amount === undefined ? {} : { amount: body.amount }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/remittances/:id/submissions/:submissionId/reject",
      summary: "Reject a declaration (money not received)",
      tags: ["remittances"],
      access: access.permission("remittances.approve"),
      request: { params: submissionParams, body: z.object({ reason }) },
      responses: { 200: { description: "Remittance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await remittances.reject(principalOf(res), params.id, params.submissionId, body.reason),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/remittances/:id/record",
      summary: "Record money taken for this period directly (cash at the desk …)",
      tags: ["remittances"],
      access: access.permission("remittances.record"),
      request: { params: idParams, body: z.object(money) },
      responses: { 200: { description: "Remittance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await remittances.record(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/remittances/:id/waive",
      summary: "Waive (part of) the shortfall of a period, with a reason",
      tags: ["remittances"],
      access: access.permission("remittances.waive"),
      request: { params: idParams, body: z.object({ amount: amount.optional(), reason }) },
      responses: { 200: { description: "Remittance" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await remittances.waive(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/:id/ledger",
      summary: "Driver statement: opening, lines, closing balance and shortfall ageing",
      tags: ["remittances"],
      access: access.permission("drivers.ledger.view"),
      request: {
        params: idParams,
        query: z.object({ from: date.optional(), to: date.optional() }),
      },
      responses: { 200: { description: "Statement" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await ledger.statement(principalOf(res), params.id, query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/drivers/:id/ledger/adjustments",
      summary: "Charge a driver (deduction) or credit them (bonus)",
      tags: ["remittances"],
      access: access.permission("drivers.ledger.adjust"),
      request: {
        params: idParams,
        body: z.object({
          kind: z.enum(["deduction", "bonus"]),
          amount,
          reason,
          accountId: uuid.optional(),
          vehicleId: uuid.nullable().optional(),
          date: date.optional(),
        }),
      },
      responses: { 201: { description: "Statement after the adjustment" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await ledger.adjust(principalOf(res), params.id, body)));
      },
    }),
  ];
}
