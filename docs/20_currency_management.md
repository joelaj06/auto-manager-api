# 20 — Currency Management

> **Update 2026-10-13:** decision 25 — currency selection is **tenant level** (no per-user display currency; §14 closed). Storage targets PostgreSQL: `*_minor bigint`, `currency char(3)`, `fx_rate numeric(18,8)`, `fx_rates` table; settings live in `organisation` columns/`jsonb`. Section 10 (migrating existing data) is not needed — no data is carried over; seed new tenants with `base_currency = 'GHS'`. Payment-provider wording in §6 applies to *recording* payments only (decision 16).

> Status: **Design / brainstorm.** Requested 2026-10-13.
> Requirement: the user selects a currency; **the default is Ghana Cedi (GHS, ₵)**.

## 1. Goals

1. Every tenant works in a **base currency** they choose, defaulting to **GHS**.
2. Every amount in the system carries its currency explicitly. No more bare numbers.
3. Users can **record individual transactions in another currency** when needed (imports in USD, a rental priced in USD for a foreign customer). Reports still roll up into the base currency.
4. Amounts are **displayed** correctly: symbol, decimals, separators.
5. Today's data migrates to GHS without loss.

## 2. Today

- All money fields are plain JS `Number` (`amount`, `cost`, `totalAmount`, `amountPaid`, `balance`, `installmentAmount`, …). Nothing says which currency they are in.
- No currency setting exists on `Company` or `Tenant`.
- Clients presumably hard-code "GHS" / "₵" for display.

## 3. Levels of currency selection

| Level | Who selects | Default | Where stored | Purpose |
|---|---|---|---|---|
| **Platform default** | Us | `GHS` | config `DEFAULT_CURRENCY=GHS` | Used when a tenant is created without a choice |
| **Tenant base currency** | Owner, at signup or in Settings | `GHS` | `organisation.baseCurrency` | Reporting / ledger currency. All totals and dashboards use it |
| **Enabled currencies** | Owner / Admin in Settings | `["GHS"]` | `organisation.currencies[]` | Which currencies users may pick on transactions |
| **Branch default** (optional) | Admin | tenant base | `branches.defaultCurrency` | E.g. a branch in Togo defaults to XOF |
| **Transaction currency** | Any user creating a money document | branch default, otherwise tenant base | on each document (`currency`) | The currency the deal was actually made in |
| **User display preference** (optional, V2) | Each user | tenant base | `users.preferences.displayCurrency` | Show converted *indicative* figures only; stored amounts never change |

The **user's currency selection** happens in two places:
- **Settings → Currency**: owner/admin picks the base currency (default GHS) and enables any extra currencies.
- **Forms**: on any amount field (rental, expense, payment, purchase cost, deal price), a currency dropdown pre-filled with the default. It is hidden entirely when only one currency is enabled, which keeps the UI simple for most tenants.

### Rule: base currency changes
- Changing the base currency **is allowed only while the tenant has no financial transactions** (e.g. during onboarding).
- After that it is locked. Changing it would silently re-denominate history. Support can do it via a migration with an explicit FX conversion if ever required.

## 4. Currency catalogue

A static, code-level catalogue (ISO 4217), seeded with the currencies relevant to the market:

| Code | Name | Symbol | Minor units | Notes |
|---|---|---|---|---|
| **GHS** | Ghana Cedi | ₵ (also `GH₵`) | 2 (pesewas) | **Default** |
| USD | US Dollar | $ | 2 | Imports, auctions, some rentals |
| EUR | Euro | € | 2 | European imports |
| GBP | Pound Sterling | £ | 2 | UK imports |
| NGN | Nigerian Naira | ₦ | 2 | Regional expansion |
| XOF | West African CFA franc | CFA | **0** | Togo, Côte d'Ivoire, Burkina Faso, … |
| KES | Kenyan Shilling | KSh | 2 | Possible expansion |
| ZAR | South African Rand | R | 2 | Possible expansion |
| CAD | Canadian Dollar | CA$ | 2 | Canadian imports |
| KRW | South Korean Won | ₩ | 0 | Korean imports |
| AED | UAE Dirham | AED | 2 | Dubai imports |

```ts
// shared/kernel/currency.ts
export const CURRENCIES = {
  GHS: { code: "GHS", name: "Ghana Cedi", symbol: "₵", minorUnits: 2, locale: "en-GH" },
  USD: { code: "USD", name: "US Dollar",  symbol: "$", minorUnits: 2, locale: "en-US" },
  XOF: { code: "XOF", name: "CFA Franc",  symbol: "CFA", minorUnits: 0, locale: "fr-SN" },
  // ...
} as const;
export type CurrencyCode = keyof typeof CURRENCIES;
export const DEFAULT_CURRENCY: CurrencyCode = "GHS";
```

- Exposed to clients via `GET /api/v1/currencies` (code, name, symbol, minor units) so apps don't hard-code anything.
- **Minor units matter:** XOF and KRW have **no** decimals. The `Money` type must use the currency's `minorUnits`, not a hard-coded ×100.

## 5. Storage model

Builds on doc 05 §1.3 (integer minor units).

### 5.1 Money on documents

```ts
// every money-bearing document
{
  currency: "GHS",              // transaction currency (required, defaults per §3)
  totalMinor: 125050,           // ₵1,250.50 → 125050 pesewas
  // only when currency !== tenant base currency:
  fxRate: "15.42",              // 1 USD = 15.42 GHS (stored as string/Decimal128 for precision)
  fxRateDate: ISODate,
  fxRateSource: "manual" | "provider",
  totalBaseMinor: 1928243       // converted to base currency at transaction time
}
```

- **One currency per document.** A rental, an invoice or a deal is in a single currency. All its lines share it.
- `*BaseMinor` fields are **frozen at transaction time**. Reports never re-convert history with today's rate.
- When `currency === baseCurrency`: `fxRate = 1`, and the `*BaseMinor` fields may be omitted (equal to the source).

### 5.2 Organisation settings

```ts
organisation.settings.currency = {
  baseCurrency: "GHS",               // default
  enabledCurrencies: ["GHS"],        // default; owner can add USD, EUR, ...
  display: {
    symbolPosition: "before",        // ₵1,250.50
    useNarrowSymbol: true,           // "₵" vs "GH₵"
    showCodeForForeign: true         // "USD 1,200.00" when not base
  },
  fx: {
    source: "manual",                // manual | provider (V2)
    allowOverrideOnTransaction: true // user can edit the rate on a form
  },
  baseCurrencyLockedAt: null         // set on the first financial transaction
}
```

### 5.3 FX rates

`fx_rates` (tenant DB): `{ base: "GHS", quote: "USD", rate: "15.42", date, source, enteredBy }`

- **V1: manual.** Accountant enters the daily/weekly rate. The latest rate on or before the transaction date is suggested on forms.
- **V2: provider feed** (e.g. Open Exchange Rates, or Bank of Ghana reference rates if an API is available), fetched by a daily job. Manual override is kept.
- Missing rate for a foreign-currency transaction → form requires the user to type one.

## 6. Rules per module

| Module | Currency behaviour |
|---|---|
| **Rentals** | Rate plans have a currency (default base). A booking takes the rate plan's currency. Deposit is in the same currency |
| **Work & Pay** | Agreement currency fixed at creation (default GHS). Schedule and penalties use it. Payments in a different currency are converted at the payment date's rate into the agreement currency (with an allocation record of both) |
| **Remittances** | Assignment target currency (default GHS) |
| **Expenses** | Any enabled currency (e.g. a USD-paid parts order). Budget comparisons use base amounts |
| **Purchases / imports** | **Each cost component has its own currency** (USD auction price, GHS duty, GHS clearing). Landed cost is reported in base currency via each component's `amountBaseMinor` |
| **Dealership** | Stock pricing in base currency by default; a deal may be priced in USD (common for high-end cars) |
| **Payments** | Payment currency may differ from the invoice. The allocation stores both amounts plus the rate. Any small difference posts to an **FX gain/loss** ledger account (doc 13) |
| **Ledger** | Always posts in **base currency** (`debitMinor/creditMinor` = base), with the original currency and amount kept as tags |
| **Reports / dashboards** | Always in base currency by default. Optional filter "show only USD transactions" or "group by currency" |
| **Platform billing** | Separate concern: the subscription is billed in GHS for Ghanaian tenants (Paystack). Independent from the tenant's base currency |

## 7. Display & formatting

- Format via `Intl.NumberFormat(locale, { style: "currency", currency })` on clients. The API returns raw minor units **plus** a pre-formatted string for convenience on low-end mobile clients:

```json
"total": { "amountMinor": 125050, "currency": "GHS", "formatted": "₵1,250.50" }
```

- Base-currency figures for foreign transactions are shown as secondary text: `USD 1,200.00 (≈ ₵18,504.00)`.
- PDFs (receipts, invoices, contracts, statements) print the currency symbol/code from the document, never assume ₵.
- SMS templates use `{{amountFormatted}}`. Keep `GHS 1,250.50` (ASCII) in SMS, because `₵` may not render on some phones.

## 8. API changes

```
GET   /api/v1/currencies                        → catalogue
GET   /api/v1/settings/currency                 → tenant currency settings
PATCH /api/v1/settings/currency                 → { baseCurrency?, enabledCurrencies[], display }
                                                   (baseCurrency rejected once locked: error CURRENCY_BASE_LOCKED)
CRUD  /api/v1/fx-rates                          → manual rates
GET   /api/v1/fx-rates/latest?quote=USD&date=   → rate suggestion for forms
```

- All money inputs accept `{ amount: "1250.50", currency: "GHS" }` (decimal string, so floats never cross the wire). The server converts to minor units by the currency's `minorUnits`.
- `currency` is optional on input and defaults per §3. It is **always present** on output.
- Validation: currency must be in `enabledCurrencies`. Error `CURRENCY_NOT_ENABLED`.
- Legacy v1 endpoints keep accepting bare numbers, interpreted as base currency (GHS).

## 9. Tenant provisioning

- The signup form has a **currency selector, pre-selected to "Ghana Cedi (GHS)"**, with a country selector that suggests a default (Ghana → GHS, Nigeria → NGN, Togo → XOF).
- The provisioning saga (doc 04 §6) writes `organisation.settings.currency` with `baseCurrency` (default GHS) and `enabledCurrencies: [baseCurrency]`.

## 10. Migration of existing data

1. Set `baseCurrency = "GHS"`, `enabledCurrencies = ["GHS"]` for every existing tenant.
2. For every money field: `xMinor = Math.round(x * 100)`, `currency = "GHS"`.
3. Log rows where rounding changed the value by more than 0 (detect existing float noise) for review.
4. Lock the base currency (existing tenants already have transactions).

## 11. Permissions

- `settings.currency.manage`: change enabled currencies and display settings (Owner/Admin).
- `finance.fx_rates.manage`: enter and edit FX rates (Accountant).
- `finance.fx_rates.override`: change the suggested rate on a transaction form.

## 12. Edge cases

- **Currency redenomination** (Ghana redenominated in 2007: GHC → GHS). Very unlikely again soon. If it happened, it would be handled by a one-off migration that converts the base currency.
- **Rounding on conversion**: round half-even at minor-unit precision. Store the rate with ≥ 6 significant digits.
- **Mixed-currency payment on one invoice** (part USD cash, part GHS MoMo): allowed. Each allocation records its own rate; any residual goes to FX gain/loss.
- **Refunds** are in the original payment currency by default.
- **Disabling a currency** that has open documents is blocked until they're closed. It only hides the currency from new forms.

## 13. Phasing

| Phase | Scope |
|---|---|
| **P1** (with the Money/minor-units work) | Currency catalogue, `Money` type with per-currency minor units, tenant base currency (default GHS) + selector at signup/settings, `currency` field on every money document, migration of existing data to GHS, formatting in API responses |
| **P2–P4** | Enabled extra currencies, transaction-level currency selection, manual FX rates, base-currency amounts on documents, FX gain/loss posting. Needed especially for purchases/imports (P4) |
| **V3** | FX provider feed, user display-currency preference, multi-country tenants |

## 14. Open points

- Should **each user** be able to pick a *display* currency, or is the tenant-level selection enough? *Suggested: tenant-level now, user display preference later.*
- Show `₵` or `GH₵` by default? *Suggested: `₵` in the app, `GHS` in SMS and exports.*
- Which FX source to trust for V2 (Bank of Ghana reference rate vs commercial provider)?
