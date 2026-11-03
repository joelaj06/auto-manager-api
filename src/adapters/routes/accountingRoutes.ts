import { z } from "zod";
import type { AccountingExports } from "../../application/use-cases/finance/AccountingExports.js";
import type { BankReconciliation } from "../../application/use-cases/finance/BankReconciliation.js";
import { STATEMENT_LINE_STATUSES } from "../../application/ports/IAccountingRecords.js";
import {
  EXPORT_DETAILS,
  EXPORT_FORMATS,
  EXPORT_TARGETS,
} from "../../domain/finance/AccountingExport.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { CsvFormatError, parseCsvRows } from "../presenters/csv.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { RequestValidationError } from "../validators/RequestValidationError.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const flag = z.enum(["true", "false"]).transform((v) => v === "true");
const history = { limit: z.coerce.number().int().min(1).max(100).default(50) };
const columnName = z.string().trim().min(1).max(80);

function statementRows(csv: string): string[][] {
  try {
    return parseCsvRows(csv);
  } catch (error) {
    if (error instanceof CsvFormatError)
      throw new RequestValidationError([{ field: "body.csv", message: error.message }]);
    throw error;
  }
}

export type AccountingRouteDependencies = Readonly<{
  exports: AccountingExports;
  reconciliation: BankReconciliation;
}>;

/**
 * Accounting export and reconciliation (docs/13 §2.4, §4, decisions 510–514): journals for
 * QuickBooks, Xero or CSV with mapped accounts and the history of exports; statements imported
 * and matched to the ledger, what the books lack posted from the line, and the difference.
 */
export function accountingRoutes(deps: AccountingRouteDependencies): ApiRoute[] {
  const { exports, reconciliation } = deps;
  return [
    // --- accounting export ---
    defineRoute({
      method: "get",
      path: "/api/v1/accounting/export",
      summary: "Journals of a period as a file for QuickBooks, Xero or plain CSV",
      tags: ["finance"],
      access: access.permission("finance.export"),
      request: {
        query: z.object({
          format: z.enum(EXPORT_FORMATS),
          from: date,
          to: date,
          detail: z.enum(EXPORT_DETAILS).default("entry"),
          xeroTaxRate: z.string().trim().min(1).max(50).optional(),
        }),
      },
      responses: {
        200: {
          description:
            "text/csv; X-Export-Lines counts its lines, X-Export-Overlaps earlier exports of the period",
        },
      },
      handler: async ({ query }, _req, res) => {
        const file = await exports.export(principalOf(res), query);
        res
          .status(200)
          .set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${file.name}"`,
            "Cache-Control": "no-store",
            "X-Export-Lines": String(file.lines),
            "X-Export-Overlaps": String(file.overlaps),
          })
          .send(file.text);
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/accounting/exports",
      summary: "Exports taken, with the entries posted into each period since",
      tags: ["finance"],
      access: access.permission("finance.export"),
      request: { query: z.object(history) },
      responses: { 200: { description: "Exports, newest first" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await exports.history(query.limit)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/accounting/mappings",
      summary: "Every ledger account with its name or code in the accounting package",
      tags: ["finance"],
      access: access.permission("finance.export"),
      request: { query: z.object({ target: z.enum(EXPORT_TARGETS) }) },
      responses: { 200: { description: "Mappings" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await exports.mappings(query.target)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/accounting/mappings",
      summary: "Set account names or codes in the package (external null removes one)",
      tags: ["finance"],
      access: access.permission("finance.export"),
      request: {
        body: z.object({
          target: z.enum(EXPORT_TARGETS),
          mappings: z
            .array(
              z.object({
                accountId: uuid,
                external: z.string().trim().min(1).max(120).nullable(),
              }),
            )
            .min(1)
            .max(500),
        }),
      },
      responses: { 200: { description: "Mappings" } },
      handler: async ({ body }, _req, res) => {
        res.json(
          envelope(await exports.saveMappings(principalOf(res), body.target, body.mappings)),
        );
      },
    }),
    // --- statements ---
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/imports",
      summary: "Check (and with commit: import and match) a bank or mobile money statement CSV",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: {
        body: z.object({
          accountId: uuid,
          fileName: z.string().trim().min(1).max(200),
          csv: z.string().min(1).max(1_000_000),
          columns: z
            .object({
              date: columnName,
              description: columnName,
              reference: columnName,
              amount: columnName,
              debit: columnName,
              credit: columnName,
              direction: columnName,
              balance: columnName,
            })
            .partial()
            .optional(),
          dayFirst: z.boolean().default(true),
          commit: z.boolean().default(false),
        }),
      },
      responses: { 200: { description: "What the file holds; `import` when committed" } },
      handler: async ({ body }, _req, res) => {
        const { csv, columns, ...input } = body;
        res.json(
          envelope(
            await reconciliation.importStatement(principalOf(res), {
              ...input,
              rows: statementRows(csv),
              ...(columns === undefined ? {} : { columns }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reconciliation/imports",
      summary: "Statements imported, newest first",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: { query: z.object({ accountId: uuid.optional(), ...history }) },
      responses: { 200: { description: "Statements" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reconciliation.imports(query.accountId ?? null, query.limit)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/imports/:id/void",
      summary: "Take a statement back with its matches",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: { params: idParams },
      responses: { 204: { description: "Voided" } },
      handler: async ({ params }, _req, res) => {
        await reconciliation.voidImport(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    // --- matching ---
    defineRoute({
      method: "get",
      path: "/api/v1/reconciliation/lines",
      summary: "An account's statement lines; unmatched ones come with likely ledger lines",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: {
        query: z.object({
          accountId: uuid,
          status: z.enum(STATEMENT_LINE_STATUSES).default("unmatched"),
          from: date.optional(),
          to: date.optional(),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Page of statement lines" } },
      handler: async ({ query }, _req, res) => {
        const page = await reconciliation.lines(query);
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reconciliation/ledger-lines",
      summary: "An account's ledger lines of a period not on a statement yet",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: {
        query: z.object({
          accountId: uuid,
          from: date,
          to: date,
          includeCancelled: flag.default(false),
        }),
      },
      responses: { 200: { description: "Ledger lines" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reconciliation.ledgerLines(query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/auto-match",
      summary: "Match an account's lines again, for payments recorded since",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: { body: z.object({ accountId: uuid }) },
      responses: { 200: { description: "How many were matched" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await reconciliation.rerunAutoMatch(principalOf(res), body.accountId)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/match",
      summary: "Match a statement line to ledger lines of the same total",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: {
        body: z.object({
          statementLineId: uuid,
          ledgerLineIds: z.array(uuid).min(1).max(200),
        }),
      },
      responses: { 200: { description: "Statement line" } },
      handler: async ({ body }, _req, res) => {
        res.json(
          envelope(
            await reconciliation.match(principalOf(res), body.statementLineId, body.ledgerLineIds),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/lines/:id/post",
      summary: "Post what the books lack (bank charges, cash banked) from a statement line",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: {
        params: idParams,
        body: z.object({
          counterAccountId: uuid,
          description: z.string().trim().min(1).max(200).optional(),
        }),
      },
      responses: { 200: { description: "Statement line" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await reconciliation.post(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/lines/:id/ignore",
      summary: "Mark a statement line as needing no entry, with a note",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: {
        params: idParams,
        body: z.object({ note: z.string().trim().min(3).max(500) }),
      },
      responses: { 200: { description: "Statement line" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await reconciliation.ignore(principalOf(res), params.id, body.note)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reconciliation/lines/:id/unmatch",
      summary: "Put a statement line back to unmatched, reversing an entry posted from it",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: { params: idParams },
      responses: { 200: { description: "Statement line" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await reconciliation.unmatch(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reconciliation/summary",
      summary: "Statement against books for an account at a date, with the difference",
      tags: ["finance"],
      access: access.permission("finance.reconcile"),
      request: { query: z.object({ accountId: uuid, asOf: date.optional() }) },
      responses: { 200: { description: "Reconciliation" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await reconciliation.summary(query.accountId, query.asOf ?? null)));
      },
    }),
  ];
}
