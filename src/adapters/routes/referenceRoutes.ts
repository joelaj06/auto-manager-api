import { z } from "zod";
import type { CurrencySettingsService } from "../../application/use-cases/reference/CurrencySettingsService.js";
import type { ExpenseCategoryAdministration } from "../../application/use-cases/reference/ExpenseCategoryAdministration.js";
import type { FxRateBook } from "../../application/use-cases/reference/FxRateBook.js";
import type { TaxAdministration } from "../../application/use-cases/reference/TaxAdministration.js";
import type { VehicleCatalogue } from "../../application/use-cases/reference/VehicleCatalogue.js";
import { CURRENCY_CODES, type CurrencyCode } from "../../domain/money/Currency.js";
import { Money } from "../../domain/money/Money.js";
import { principalOf, staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const currency = z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]);
/** Money crosses the wire as a decimal string, never a float (docs/20 §8). */
const amount = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "1250.50"');
const taxCodeParam = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/) });
const appliesTo = z
  .array(z.enum(["sales", "purchases"]))
  .min(1)
  .max(2);
const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'A percentage, e.g. "15" or "2.5"');

export type ReferenceRouteDependencies = Readonly<{
  currencies: CurrencySettingsService;
  tax: TaxAdministration;
  fxRates: FxRateBook;
  expenseCategories: ExpenseCategoryAdministration;
  vehicles: VehicleCatalogue;
}>;

/**
 * Reference data and settings (docs/20, docs/13 §6, docs/12, docs/27 §3.11): currencies and the
 * business's currency settings, tax settings and tax codes with dated rates, manual exchange
 * rates, expense categories, vehicle makes and models.
 */
export function referenceRoutes(deps: ReferenceRouteDependencies): ApiRoute[] {
  const { currencies, tax, fxRates, expenseCategories, vehicles } = deps;
  return [
    // --- currencies ---
    defineRoute({
      method: "get",
      path: "/api/v1/currencies",
      summary: "Currency catalogue (code, name, symbol, minor units)",
      tags: ["reference"],
      access: access.public(),
      responses: { 200: { description: "Currencies" } },
      handler: (_input, _req, res) => {
        res.set("Cache-Control", "public, max-age=86400").json(envelope(currencies.catalogue()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/settings/currency",
      summary: "Base currency, enabled currencies and display options",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Currency settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await currencies.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/currency",
      summary: "Change currency settings (the base currency only before money is recorded)",
      tags: ["settings"],
      access: access.permission("settings.currency.manage"),
      request: {
        body: z.object({
          baseCurrency: currency.optional(),
          enabledCurrencies: z.array(currency).min(1).max(11).optional(),
          display: z.object({ showCodeForForeign: z.boolean() }).optional(),
        }),
      },
      responses: { 200: { description: "Currency settings" }, 409: { description: "Locked" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await currencies.update(principalOf(res), body)));
      },
    }),

    // --- tax ---
    defineRoute({
      method: "get",
      path: "/api/v1/settings/tax",
      summary: "Tax registration settings",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Tax settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tax.settings()));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/settings/tax",
      summary: "Set tax registration settings",
      tags: ["settings"],
      access: access.permission("settings.tax.manage"),
      request: {
        body: z.object({
          scheme: z.enum(["not_registered", "standard", "flat_rate"]),
          vatNumber: z.string().trim().min(3).max(40).nullable(),
          pricesIncludeTax: z.boolean(),
          defaultSalesTaxCode: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]{1,19}$/)
            .nullable(),
        }),
      },
      responses: { 200: { description: "Tax settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await tax.updateSettings(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/tax-codes",
      summary: "The business's tax codes with their rates",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Tax codes" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await tax.codes()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/tax-codes/:code",
      summary: "One tax code",
      tags: ["settings"],
      access: access.permission("settings.view"),
      request: { params: taxCodeParam },
      responses: { 200: { description: "Tax code" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await tax.code(params.code)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/tax-codes",
      summary: "Create a tax code (inactive until it has rates)",
      tags: ["settings"],
      access: access.permission("settings.tax.manage"),
      request: {
        body: z.object({
          code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,19}$/),
          name: z.string().trim().min(1).max(120),
          kind: z.enum(["standard", "flat_rate", "exempt", "zero_rated", "custom"]),
          appliesTo,
        }),
      },
      responses: { 201: { description: "Tax code" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await tax.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/tax-codes/:code",
      summary: "Rename a tax code or change what it applies to",
      tags: ["settings"],
      access: access.permission("settings.tax.manage"),
      request: {
        params: taxCodeParam,
        body: z.object({ name: z.string().trim().min(1).max(120), appliesTo }),
      },
      responses: { 200: { description: "Tax code" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await tax.rename(principalOf(res), params.code, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/tax-codes/:code/rates",
      summary: "Add a rate period (e.g. VAT 15 % from a date); periods of a levy never overlap",
      tags: ["settings"],
      access: access.permission("settings.tax.manage"),
      request: {
        params: taxCodeParam,
        body: z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
          name: z.string().trim().min(1).max(60),
          rate: percent,
          base: z.enum(["net", "net_plus_previous"]).default("net"),
          effectiveFrom: date,
          effectiveTo: date.nullable().default(null),
        }),
      },
      responses: { 200: { description: "Tax code" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await tax.addRate(principalOf(res), params.code, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/tax-codes/:code/rates/:rateId/end",
      summary: "End a rate period (it no longer applies from the given date)",
      tags: ["settings"],
      access: access.permission("settings.tax.manage"),
      request: {
        params: taxCodeParam.extend({ rateId: uuid }),
        body: z.object({ effectiveTo: date }),
      },
      responses: { 200: { description: "Tax code" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await tax.endRate(principalOf(res), params.code, params.rateId, body.effectiveTo),
          ),
        );
      },
    }),
    ...(["activate", "deactivate"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `/api/v1/tax-codes/:code/${action}`,
        summary:
          action === "activate" ? "Make a tax code usable on documents" : "Stop using a tax code",
        tags: ["settings"],
        access: access.permission("settings.tax.manage"),
        request: { params: taxCodeParam },
        responses: { 200: { description: "Tax code" } },
        handler: async ({ params }, _req, res) => {
          res.json(
            envelope(await tax.setActive(principalOf(res), params.code, action === "activate")),
          );
        },
      }),
    ),
    defineRoute({
      method: "post",
      path: "/api/v1/tax-codes/:code/preview",
      summary: "What a document line would carry for an amount on a date",
      tags: ["settings"],
      access: access.permission("settings.view"),
      request: {
        params: taxCodeParam,
        body: z.object({
          amount,
          currency: currency.optional(),
          date,
          inclusive: z.boolean().optional(),
        }),
      },
      responses: { 200: { description: "Net, components, tax and gross" } },
      handler: async ({ params, body }, _req, res) => {
        const base = (await currencies.get()).baseCurrency;
        const money = Money.parse(body.amount, body.currency ?? base);
        res.json(envelope(await tax.preview(params.code, money, body.date, body.inclusive)));
      },
    }),

    // --- exchange rates ---
    defineRoute({
      method: "get",
      path: "/api/v1/fx-rates",
      summary: "Exchange rates against the base currency (newest first)",
      tags: ["finance"],
      access: access.permission("finance.fx_rates.view"),
      request: {
        query: z.object({
          quote: currency.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Rates" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await fxRates.list(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/fx-rates/suggestion",
      summary: "The rate to suggest on a form: latest on or before the date (or null)",
      tags: ["finance"],
      access: access.signedIn(),
      request: { query: z.object({ quote: currency, date }) },
      responses: { 200: { description: "Rate or null" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await fxRates.suggest(query.quote, query.date)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/fx-rates",
      summary: "Enter a rate: 1 unit of `quote` = `rate` units of the base currency",
      tags: ["finance"],
      access: access.permission("finance.fx_rates.manage"),
      request: {
        body: z.object({
          quote: currency,
          rate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/),
          rateDate: date,
        }),
      },
      responses: { 201: { description: "Rate" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await fxRates.add(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/fx-rates/:id",
      summary: "Remove a rate (documents keep the rate they were made with)",
      tags: ["finance"],
      access: access.permission("finance.fx_rates.manage"),
      request: { params: z.object({ id: uuid }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await fxRates.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),

    // --- expense categories ---
    defineRoute({
      method: "get",
      path: "/api/v1/expense-categories",
      summary: "Expense categories as a tree",
      tags: ["expenses"],
      access: access.signedIn(),
      request: {
        query: z.object({
          includeInactive: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .default(false),
        }),
      },
      responses: { 200: { description: "Categories with children" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await expenseCategories.tree(query.includeInactive)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/expense-categories",
      summary: "Add an expense category (or a subcategory)",
      tags: ["expenses"],
      access: access.permission("expenses.categories.manage"),
      request: {
        body: z.object({
          code: z.string().trim().min(2).max(40),
          name: z.string().trim().min(1).max(80),
          parentId: uuid.nullish(),
        }),
      },
      responses: { 201: { description: "Category" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await expenseCategories.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/expense-categories/:id",
      summary: "Rename, move, reorder or (de)activate an expense category",
      tags: ["expenses"],
      access: access.permission("expenses.categories.manage"),
      request: {
        params: z.object({ id: uuid }),
        body: z.object({
          name: z.string().trim().min(1).max(80).optional(),
          parentId: uuid.nullable().optional(),
          active: z.boolean().optional(),
          sort: z.number().int().min(0).max(100_000).optional(),
        }),
      },
      responses: { 200: { description: "Category" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await expenseCategories.update(principalOf(res), params.id, body)));
      },
    }),

    // --- vehicle makes and models ---
    defineRoute({
      method: "get",
      path: "/api/v1/reference/vehicle-makes",
      summary: "Vehicle makes (search with q)",
      tags: ["reference"],
      access: access.signedIn(),
      request: { query: z.object({ q: z.string().trim().min(1).max(60).optional() }) },
      responses: { 200: { description: "Makes" } },
      handler: async ({ query }, _req, res) => {
        res
          .set("Cache-Control", "private, max-age=3600")
          .json(envelope(await vehicles.makes(query.q)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reference/vehicle-makes/:id/models",
      summary: "Models of a make",
      tags: ["reference"],
      access: access.signedIn(),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Models" } },
      handler: async ({ params }, _req, res) => {
        res
          .set("Cache-Control", "private, max-age=3600")
          .json(envelope(await vehicles.models(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/platform/v1/reference/vehicle-makes",
      summary: "Add a vehicle make",
      tags: ["console: reference"],
      access: access.platform("platform.reference.manage"),
      request: { body: z.object({ name: z.string().trim().min(1).max(60) }) },
      responses: { 201: { description: "Make" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await vehicles.addMake(body.name, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/platform/v1/reference/vehicle-makes/:id/models",
      summary: "Add a model to a make",
      tags: ["console: reference"],
      access: access.platform("platform.reference.manage"),
      request: {
        params: z.object({ id: uuid }),
        body: z.object({ name: z.string().trim().min(1).max(60) }),
      },
      responses: { 201: { description: "Model" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await vehicles.addModel(params.id, body.name, staffOf(res))));
      },
    }),
  ];
}
