import { z } from "zod";
import type { ReceiptReadings } from "../../application/use-cases/receipts/ReceiptReadings.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const SCANS = "/api/v1/receipt-readings";
const ATTACHED = "/api/v1/expenses/:id/receipts/:fileId/reading";
const attachedParams = z.object({ id: uuid, fileId: uuid });

/**
 * Reading receipts (decisions 520–522): the business's switch, scanning a receipt before the
 * expense exists, and reading one already attached. Readings are suggestions; nothing here
 * changes an expense.
 */
export function receiptReadingRoutes(readings: ReceiptReadings): ApiRoute[] {
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/settings/receipt-reading",
      summary: "Whether receipts are read, the monthly limit and how much of it is used",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await readings.settings()));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/settings/receipt-reading",
      summary: "Switch reading on or off (receipts go to an outside AI provider) and set the limit",
      tags: ["settings"],
      access: access.permission("settings.update"),
      request: {
        body: z
          .object({
            enabled: z.boolean(),
            monthlyLimit: z.number().int().min(1).max(100_000),
          })
          .partial(),
      },
      responses: {
        200: { description: "Settings" },
        409: { description: "No provider is set up" },
      },
      handler: async ({ body }, _req, res) => {
        const { enabled, monthlyLimit } = body;
        res.json(
          envelope(
            await readings.setSettings(principalOf(res), {
              ...(enabled === undefined ? {} : { enabled }),
              ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: SCANS,
      summary: "Scan a receipt before entering the expense: start its upload",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: {
        body: z.object({
          filename: z.string().min(1).max(255),
          contentType: z.string().max(100),
          sizeBytes: z.number().int().positive(),
        }),
      },
      responses: {
        201: { description: "The reading's id and where to upload" },
        409: { description: "Reading is off, or the monthly limit is reached" },
      },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await readings.startScan(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${SCANS}/:id/complete`,
      summary: "The scan is uploaded: read it",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Reading, queued" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await readings.completeScan(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${SCANS}/:id`,
      summary: "Your scan: the figures to fill the expense in with, once read",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Reading" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await readings.scan(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${SCANS}/:id/attach`,
      summary: "Attach the scanned receipt to the expense entered from it",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: z.object({ id: uuid }), body: z.object({ expenseId: uuid }) },
      responses: { 200: { description: "Reading, with anything that disagrees" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await readings.attachScan(principalOf(res), params.id, body.expenseId)));
      },
    }),
    defineRoute({
      method: "post",
      path: ATTACHED,
      summary: "Read a receipt attached to an expense (again, if it was read before)",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: attachedParams },
      responses: { 200: { description: "Reading, queued" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await readings.readAttached(principalOf(res), params.id, params.fileId)));
      },
    }),
    defineRoute({
      method: "get",
      path: ATTACHED,
      summary: "What the receipt says, and where it disagrees with the expense",
      tags: ["expenses"],
      access: access.permission("expenses.view"),
      request: { params: attachedParams },
      responses: { 200: { description: "Reading with warnings" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await readings.attached(principalOf(res), params.id, params.fileId)));
      },
    }),
  ];
}
