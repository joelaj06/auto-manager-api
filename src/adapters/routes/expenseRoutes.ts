import { z } from "zod";
import type { ExpenseAdministration } from "../../application/use-cases/expenses/ExpenseAdministration.js";
import type { Expenses } from "../../application/use-cases/expenses/Expenses.js";
import type { FuelLogs } from "../../application/use-cases/expenses/FuelLogs.js";
import type { RecurringExpenses } from "../../application/use-cases/expenses/RecurringExpenses.js";
import { EXPENSE_STATUSES } from "../../domain/expenses/Expense.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const reason = z.string().trim().min(3).max(500);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const taxCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,19}$/)
  .nullable()
  .optional();

const expenseBody = z.object({
  categoryId: uuid,
  description: z.string().trim().min(1).max(300),
  branchId: uuid.optional(),
  expenseDate: date.optional(),
  payeeType: z.enum(["supplier", "driver"]).nullable().optional(),
  payeeId: uuid.nullable().optional(),
  payeeName: text(160),
  driverId: uuid.nullable().optional(),
  chargeToDriver: z.boolean().optional(),
  amount,
  taxCode,
  vehicleIds: z.array(uuid).max(200).optional(),
  split: z
    .array(z.object({ vehicleId: uuid, amount }))
    .max(200)
    .optional(),
  reference: text(60),
  notes: text(2_000),
});

const ruleBody = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.number().int().min(0).max(10_000).optional(),
  categoryId: uuid.nullable().optional(),
  branchId: uuid.nullable().optional(),
  minAmount: amount.optional(),
  maxAmount: amount.nullable().optional(),
  action: z.enum(["auto_approve", "require_approval"]),
  active: z.boolean().optional(),
});

const budgetBody = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: uuid.nullable().optional(),
  branchId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
  monthlyAmount: amount,
  active: z.boolean().optional(),
});

const recurringBody = z.object({
  name: z.string().trim().min(1).max(120),
  categoryId: uuid,
  branchId: uuid,
  description: z.string().trim().min(1).max(300),
  payeeType: z.enum(["supplier", "driver"]).nullable().optional(),
  payeeId: uuid.nullable().optional(),
  payeeName: text(160),
  amount,
  taxCode,
  vehicleIds: z.array(uuid).max(200).optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  startOn: date,
  endOn: date.nullable().optional(),
  autoSubmit: z.boolean().optional(),
  active: z.boolean().optional(),
});

export type ExpenseRouteDependencies = Readonly<{
  expenses: Expenses;
  fuel: FuelLogs;
  administration: ExpenseAdministration;
  recurring: RecurringExpenses;
}>;

/**
 * Expenses (docs/12 part B): enter, split, submit, approve or reject, pay and void; receipts;
 * fuel logs per vehicle; approval rules, budgets, recurring expenses and expense settings.
 */
export function expenseRoutes(deps: ExpenseRouteDependencies): ApiRoute[] {
  const { expenses, fuel, administration, recurring } = deps;
  const action = (
    name: "submit" | "approve",
    permission: "expenses.create" | "expenses.approve",
    summary: string,
  ) =>
    defineRoute({
      method: "post",
      path: `/api/v1/expenses/:id/${name}`,
      summary,
      tags: ["expenses"],
      access: access.permission(permission),
      request: { params: idParams },
      responses: { 200: { description: "Expense" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await expenses[name](principalOf(res), params.id)));
      },
    });

  return [
    // --- settings, rules, budgets, recurring ---
    defineRoute({
      method: "get",
      path: "/api/v1/settings/expenses",
      summary: "Expense settings (receipt threshold, fuel category)",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await administration.settings()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/expenses",
      summary: "Change the expense settings",
      tags: ["settings"],
      access: access.permission("expenses.rules.manage"),
      request: {
        body: z.object({
          receiptRequiredAbove: amount.nullable().optional(),
          fuelCategoryCode: z
            .string()
            .regex(/^[a-z][a-z_]{1,39}$/)
            .optional(),
          maintenanceCategoryCode: z
            .string()
            .regex(/^[a-z][a-z_]{1,39}$/)
            .optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await administration.updateSettings(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/expense-approval-rules",
      summary: "Approval rules (the first match by priority decides)",
      tags: ["expenses"],
      access: access.permission("expenses.rules.manage"),
      responses: { 200: { description: "Rules" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await administration.rules()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expense-approval-rules",
      summary: "Add an approval rule",
      tags: ["expenses"],
      access: access.permission("expenses.rules.manage"),
      request: { body: ruleBody },
      responses: { 201: { description: "Rule" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.saveRule(principalOf(res), null, body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/expense-approval-rules/:id",
      summary: "Change an approval rule",
      tags: ["expenses"],
      access: access.permission("expenses.rules.manage"),
      request: { params: idParams, body: ruleBody },
      responses: { 200: { description: "Rule" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.saveRule(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/expense-approval-rules/:id",
      summary: "Retire an approval rule",
      tags: ["expenses"],
      access: access.permission("expenses.rules.manage"),
      request: { params: idParams },
      responses: { 204: { description: "Retired" } },
      handler: async ({ params }, _req, res) => {
        await administration.removeRule(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/budgets",
      summary: "Budgets with spending for a month (80% warns, 100% exceeded)",
      tags: ["expenses"],
      access: access.permission("expenses.budgets.view"),
      request: {
        query: z.object({
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional(),
        }),
      },
      responses: { 200: { description: "Budget statuses" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await administration.budgets(query.month ?? null)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/budgets",
      summary: "Add a monthly budget (by category, branch and/or vehicle)",
      tags: ["expenses"],
      access: access.permission("expenses.budgets.manage"),
      request: { body: budgetBody },
      responses: { 201: { description: "Budget" } },
      handler: async ({ body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await administration.saveBudget(principalOf(res), null, body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/budgets/:id",
      summary: "Change a budget",
      tags: ["expenses"],
      access: access.permission("expenses.budgets.manage"),
      request: { params: idParams, body: budgetBody },
      responses: { 200: { description: "Budget" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.saveBudget(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/budgets/:id",
      summary: "Remove a budget",
      tags: ["expenses"],
      access: access.permission("expenses.budgets.manage"),
      request: { params: idParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await administration.removeBudget(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/recurring-expenses",
      summary: "Recurring expenses",
      tags: ["expenses"],
      access: access.permission("expenses.recurring.manage"),
      responses: { 200: { description: "Recurring expenses" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await recurring.list()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/recurring-expenses",
      summary: "Set up a recurring expense (created by the daily job when due)",
      tags: ["expenses"],
      access: access.permission("expenses.recurring.manage"),
      request: { body: recurringBody },
      responses: { 201: { description: "Recurring expense" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await recurring.save(principalOf(res), null, body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/recurring-expenses/:id",
      summary: "Change a recurring expense",
      tags: ["expenses"],
      access: access.permission("expenses.recurring.manage"),
      request: { params: idParams, body: recurringBody },
      responses: { 200: { description: "Recurring expense" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await recurring.save(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/recurring-expenses/:id",
      summary: "Remove a recurring expense (its expenses stay)",
      tags: ["expenses"],
      access: access.permission("expenses.recurring.manage"),
      request: { params: idParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await recurring.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),

    // --- fuel ---
    defineRoute({
      method: "post",
      path: "/api/v1/vehicles/:id/fuel",
      summary: "Record a fuel fill (creates the fuel expense and an odometer reading)",
      tags: ["expenses"],
      access: access.permission("expenses.fuel.record"),
      request: {
        params: idParams,
        body: z.object({
          litres: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'Litres, e.g. "42.5"'),
          amount,
          odometer: z.number().int().min(0).max(5_000_000),
          fullTank: z.boolean().optional(),
          filledAt: z.iso.datetime({ offset: true }).optional(),
          station: text(120),
          supplierId: uuid.nullable().optional(),
          driverId: uuid.nullable().optional(),
          notes: text(2_000),
        }),
      },
      responses: { 201: { description: "Fuel log and its expense" } },
      handler: async ({ params, body }, _req, res) => {
        const { filledAt, ...input } = body;
        res.status(201).json(
          envelope(
            await fuel.record(principalOf(res), params.id, {
              ...input,
              ...(filledAt === undefined ? {} : { filledAt: new Date(filledAt) }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicles/:id/fuel",
      summary: "Fuel fills with efficiency between full tanks (flagged when far below usual)",
      tags: ["expenses"],
      access: access.permission("vehicles.view"),
      request: {
        params: idParams,
        query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
      responses: { 200: { description: "Fuel report" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await fuel.report(principalOf(res), params.id, query.limit)));
      },
    }),

    // --- expenses ---
    defineRoute({
      method: "get",
      path: "/api/v1/expenses",
      summary: "Expenses you may see (yours only with own scope), newest first",
      tags: ["expenses"],
      access: access.permission("expenses.list"),
      request: {
        query: z.object({
          status: z
            .string()
            .optional()
            .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
            .pipe(z.array(z.enum(EXPENSE_STATUSES)).optional()),
          branchId: uuid.optional(),
          categoryId: uuid.optional(),
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
          from: date.optional(),
          to: date.optional(),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
      responses: { 200: { description: "Expenses; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        const page = await expenses.list(principalOf(res), {
          ...rest,
          ...(status === undefined ? {} : { statuses: status }),
        });
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expenses",
      summary: "Enter an expense (a draft; split across vehicles if shared)",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { body: expenseBody },
      responses: { 201: { description: "Expense and warnings (possible duplicates)" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await expenses.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/expenses/:id",
      summary: "An expense with its split and receipts",
      tags: ["expenses"],
      access: access.permission("expenses.view"),
      request: { params: idParams },
      responses: { 200: { description: "Expense" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await expenses.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/expenses/:id",
      summary: "Correct a draft or rejected expense",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: idParams, body: expenseBody },
      responses: { 200: { description: "Expense and warnings" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await expenses.revise(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/expenses/:id",
      summary: "Delete a draft",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: idParams },
      responses: { 204: { description: "Deleted" } },
      handler: async ({ params }, _req, res) => {
        await expenses.deleteDraft(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    action("submit", "expenses.create", "Submit for approval (a matching rule may approve it)"),
    action(
      "approve",
      "expenses.approve",
      "Approve (someone else than the submitter, within your limit)",
    ),
    defineRoute({
      method: "post",
      path: "/api/v1/expenses/:id/reject",
      summary: "Reject with a reason (it can be corrected and resubmitted)",
      tags: ["expenses"],
      access: access.permission("expenses.approve"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Expense" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await expenses.reject(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expenses/:id/pay",
      summary: "Pay an approved expense (records the payment out)",
      tags: ["expenses"],
      access: access.permission("expenses.pay"),
      request: {
        params: idParams,
        body: z.object({
          method: z.enum(PAYMENT_METHODS),
          momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
          reference: text(100),
          paidOn: date.optional(),
        }),
      },
      responses: { 200: { description: "Paid expense" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await expenses.pay(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expenses/:id/void",
      summary: "Void an unpaid expense (an approved one is reversed in the ledger)",
      tags: ["expenses"],
      access: access.permission("expenses.void"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 200: { description: "Void expense" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await expenses.void(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expenses/:id/receipts",
      summary: "Attach a receipt scan or photo",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: {
        params: idParams,
        body: z.object({
          filename: z.string().trim().min(1).max(200),
          contentType: z.string().trim().min(3).max(100),
          sizeBytes: z.number().int().min(1).max(FILE_KINDS.expense_receipt.maxBytes),
        }),
      },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await expenses.startReceipt(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expenses/:id/receipts/:fileId/complete",
      summary: "Confirm a receipt upload",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: z.object({ id: uuid, fileId: uuid }) },
      responses: { 200: { description: "File" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await expenses.completeReceipt(principalOf(res), params.id, params.fileId)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/expenses/:id/receipts/:fileId",
      summary: "Remove a receipt (drafts and rejected expenses)",
      tags: ["expenses"],
      access: access.permission("expenses.create"),
      request: { params: z.object({ id: uuid, fileId: uuid }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await expenses.removeReceipt(principalOf(res), params.id, params.fileId);
        res.status(204).end();
      },
    }),
  ];
}
