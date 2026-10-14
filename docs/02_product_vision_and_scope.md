# 02 — Product Vision & Scope

## 1. Vision

AutoManager becomes the **operating system for vehicle-based businesses**: anyone who owns, rents, finances, sells or operates vehicles for money. One SaaS platform, multi-tenant, where each business switches on the modules it needs and every vehicle has a complete financial and operational history from purchase to disposal.

> Elevator pitch: *"Know what every vehicle costs you, earns you, and owes you — today."*

## 2. Target segments (tenant types)

| Segment | Typical business | Core needs | Modules |
|---|---|---|---|
| **Fleet owner / operator** | Taxi, ride-hailing (Uber/Bolt), trotro/minibus, delivery, logistics | Assign vehicles to drivers, collect daily/weekly remittances, track expenses & maintenance | Fleet, Drivers, Remittances, Maintenance, Expenses |
| **Hire-purchase ("Work & Pay") operator** | Owner buys cars, drivers pay them off over 1–4 years | Agreements, schedules, arrears, penalties, ownership transfer | Fleet, Drivers, Work & Pay, Payments |
| **Car rental company** | Self-drive and chauffeur rentals, corporate leases | Reservations, availability, rate plans, check-out/in, deposits, damages | Rentals, Customers, Fleet, Payments |
| **Car dealer** | New/used car sales, importers, showrooms | Stock, acquisition cost, reconditioning, leads, deals, trade-ins, profit per car | Dealership, Purchases, Customers, Payments |
| **Mixed businesses** (very common) | A dealer who also rents; a rental firm that does work-and-pay | All of the above sharing one vehicle registry | Any combination |

Key insight: **the same physical vehicle moves between modules** — bought (Purchases) → reconditioned (Maintenance) → listed (Dealership) or rented (Rentals) or given to a driver (Work & Pay / Remittances) → sold (Dealership / W&P completion). The vehicle registry and the ledger must be shared, not per module.

## 3. Personas

| Persona | Where they work | Top jobs |
|---|---|---|
| **Owner / Director** | Web dashboard, mobile | See profit, cash position, overdue debts, fleet utilisation |
| **Fleet / Operations manager** | Web | Assign vehicles, approve expenses, schedule maintenance |
| **Rental agent / front desk** | Web, tablet | Book, check-out, check-in, take payment, print contract |
| **Sales executive (dealer)** | Web, mobile | Manage leads, quote, close deals, track commission |
| **Accountant / cashier** | Web | Record payments, reconcile MoMo/bank, export reports |
| **Mechanic / workshop** | Mobile | See work orders, log parts and labour |
| **Driver** | Mobile app (low-end Android, intermittent data) | See balance, pay via MoMo, submit remittance, report issues, upload fuel receipts |
| **Customer (renter / buyer)** | Web portal / WhatsApp link | Book, pay, view contract/receipt |
| **Platform admin (us)** | Admin console | Manage tenants, plans, billing, support impersonation |

## 4. Module map

```
                         ┌───────────────────────────┐
                         │  Platform (control plane) │  tenants, plans, billing, platform admins
                         └─────────────┬─────────────┘
                                       │
┌─────────────────────────────── Tenant ─────────────────────────────────┐
│ Core: Organisation & Branches · Users/Roles · Settings · Audit · Files │
│                                                                        │
│  Vehicle Registry (hub) ── Documents ── Odometer ── Assignments        │
│        │                                                               │
│  ┌─────┼────────────┬──────────────┬──────────────┬─────────────┐      │
│  │ Purchases   Dealership     Rentals       Work & Pay    Remittances│ │
│  └─────┬────────────┴──────────────┴──────────────┴─────────────┘      │
│        │                                                               │
│  Maintenance & Parts ·  Expenses & Fuel  ·  Parties (Customers,        │
│                                             Drivers, Suppliers)        │
│        │                                                               │
│  Finance: Invoices · Payments · Ledger · Reconciliation                │
│        │                                                               │
│  Reports & Analytics  ·  Notifications & Automation                   │
└────────────────────────────────────────────────────────────────────────┘
```

## 5. Scope by phase (summary — detail in doc 18)

| Phase | Theme | Contents |
|---|---|---|
| **P0 — Foundation** | Make it safe | Security fixes, tenant-bound auth, validation, single DI root, data model conventions, migrations framework |
| **P1 — Core money** | One money pipeline | Payments/ledger, vehicle registry v2, remittances v2, expenses v2, W&P v2 (schedules, arrears) |
| **P2 — Rentals v2** | Revenue module | Reservations, availability, rate plans, check-out/in, deposits, invoices |
| **P3 — Maintenance & documents** | Cost control | Service schedules, work orders, parts, document expiry reminders |
| **P4 — Dealership & purchases** | New segment | Stock, landed cost, leads, deals, trade-ins |
| **P5 — Reports, notifications, portals** | Stickiness | Report catalogue, scheduled exports, driver app endpoints, customer portal |
| **P6 — Integrations** | Scale | Paystack/MoMo collections, telematics/GPS, accounting export, WhatsApp |

## 6. Pricing & entitlements (revised — decision 5)

**Model: monthly subscription priced by the number of branches.**

| Element | Proposal |
|---|---|
| Unit | Price per active **branch** per month (a single-location business = 1 branch) |
| Price structure | **Standard licence: flat price per branch** (decision 48). **Enterprise licence** (flagged by Super Admin): custom price from number of branches, business size and setup/other costs (decision 50, doc 25 §2.1) |
| Modules | Option A: all modules included. Option B: bundles (Fleet, Rentals, Dealer) priced per branch. *Suggested: all modules, simplest to sell, revisit if needed* |
| Billing events | Add branch → prorated charge. Remove/deactivate branch → credit from next cycle. Trial period on signup (e.g. 14 days) |
| Limits | `branches.max` is the main entitlement. Vehicles/users unlimited by default; optional fair-use caps on Starter |
| Enforcement | Creating a branch beyond the paid count is blocked until the plan is updated. Past-due → grace → **automatic deactivation**, restored automatically on payment (doc 25 §5). Deactivated (non-payment) tenants can sign in to the Billing tab only, to pay (doc 25 §5.2) |
| Platform tables | `plans`, `subscriptions` (branch_count, price_per_branch_minor, currency, status, current_period_end), `subscription_events`, `platform_invoices` |

Tenants **pay the subscription through the app/portal** (decision 27): see [25](25_platform_billing_and_subscriptions.md). Payments between a tenant and its own customers/drivers are record-only (decision 16).

Add-ons (optional): extra storage, API access, dedicated database (Enterprise), white-label.

## 7. Non-goals (for now)

- Full double-entry accounting suite (we export to QuickBooks/Xero/Tally-style instead — doc 13).
- Building our own GPS hardware (integrate with providers).
- Insurance underwriting / lending (we track loans, we don't originate them).
- Marketplace between tenants (possible V3: dealer listings marketplace).

## 8. Localisation assumptions (to confirm — doc 19)

- Primary market appears to be **Ghana / West Africa** (work-and-pay model, MoMo, Paystack reference in Subscription). Design for:
  - Currency **GHS by default, user-selectable** (doc 20), multi-currency for imports (USD, EUR).
  - Mobile Money (MTN MoMo, Telecel Cash, AT Money) as a first-class payment method.
  - SMS and WhatsApp more reliable than email for drivers.
  - Vehicle documents: DVLA registration, roadworthy certificate, insurance sticker, income-tax sticker.
  - Low-bandwidth mobile clients → compact payloads, offline-tolerant driver flows.
