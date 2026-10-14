# 29 — Reseller / Partner Program

Resellers bring businesses onto Autoforce Manager and earn **commission on the subscription fees those businesses pay**. They work inside the platform console (doc 27) with a restricted, scoped account.

Decisions behind this doc: 33 (resellers get console accounts), 40 (a reseller sees all the tenants they brought in plus their commissions; **commission terms are set by the Super Admin, on the reseller's profile, and differ from reseller to reseller**).

## 1. Scope

| In | Out |
|---|---|
| Reseller profile and console users | Resellers handling tenants' payments (tenants pay Autoforce directly, doc 25) |
| Referral attribution (code/link/QR + assisted signup) | Access to any tenant's business data |
| Per-reseller commission terms | Resellers changing prices, plans or commission terms |
| Commission ledger, statements, payouts | Multi-level / sub-agent networks (possible later) |
| Reseller dashboard: their tenants + commissions | |

## 2. Accounts & profile

A reseller is a **partner organisation** (`partners`) with one or more **console users** (`platform_users.user_type = 'partner'`, `partner_id` set). The Super Admin creates the partner profile, then invites its users (MFA enforced, doc 27 §2).

### 2.1 Reseller profile (set up by Super Admin)

| Section | Fields |
|---|---|
| Identity | Name (person or company), contact person(s), phone, email, address/region, TIN / ID number, KYC documents (secure files), signed reseller agreement (file + version) |
| Status | `active`, `paused` (no new attributions/commission accrual optional), `terminated` (historical data kept) |
| Referral | Referral code(s), shareable link and QR (`https://<domain>/signup?ref=CODE`), optional custom landing text |
| Permissions | `trusted` flag (applications skip manual review; **off by default**), allowed to offer coupons (and max discount), and the **capability grants** in §7 |
| **Commission terms** | See §4 — configured here, **per reseller**: one **percentage** for each commission type (**Standard**, **Enterprise**) |
| Payout details | Preferred payout method(s) — MoMo, bank, cash or other (decision 52) — with MoMo number / bank account / name on account, payout currency (GHS), minimum payout |
| Notes / tags | Internal notes, region, performance tier |

Only users with `platform.partners.manage` can create/edit profiles; **commission terms need the stricter `platform.partners.commission_terms.manage` (Super Admin by default)**.

## 3. Attribution (which tenant belongs to which reseller)

1. **Referral code/link**: the signup form captures `ref=CODE` → `tenant_applications.partner_id`.
2. **Assisted signup**: a reseller console user creates an application on the client's behalf (doc 27 §3.2); the client verifies email/phone.
3. **Manual assignment** by Super Admin (e.g. a tenant that signed up directly but was introduced by a reseller), with reason.

Rules:
- One reseller per tenant. Attribution is fixed when the application is approved and **locked** at activation; only Super Admin can change it (audited).
- Commission starts from the tenant's **first paid invoice**, never from signup, which defeats fake-signup farming.
- Self-referral check: the reseller's own phone/email/TIN matching an applicant's raises a risk flag for review.
- A tenant keeps its reseller even if deactivated; commissions simply stop accruing while no payments arrive, and resume after restoration.

## 4. Commission terms (decisions 46, 49, 50)

### 4.1 The rule

- Commission is earned **only on the tenant's first licence purchase** — its first paid subscription invoice (decision 49). Renewals, later invoices, upgrades and extra branches earn the reseller **nothing**.
- It is a **percentage** of the amount actually collected on that first purchase (excluding VAT).
- It becomes **payable as soon as the client's payment is confirmed** (decision 46).

*Illustration only:* with a 10% Standard rate and a first licence payment of GHS 500 (excluding VAT), the commission is GHS 50.

### 4.2 Commission types

| Type | Applies to | Notes |
|---|---|---|
| **Standard** | Tenants whose licence type is Standard (flat per-branch price) | Default |
| **Enterprise** | Tenants **flagged Enterprise by the Super Admin** (custom pricing, doc 25 §2.1) | Usually larger, one-off negotiated deals |

- The licence type is the one on the tenant at its first payment. The Super Admin can set it only until then (doc 27 §3.6), so a reseller's commission type cannot change after the fact.
- Each reseller profile holds **one percentage per type**, set by the Super Admin. A type left empty means no commission for that type. Different resellers can have different percentages.

### 4.3 What a definition contains

Versioned on the reseller profile (`partner_commission_terms`, `effective_from`).

| Element | Detail |
|---|---|
| **Standard rate / Enterprise rate** | Percentages |
| **Base amount** | **Licence amount only** (decision 54): the net amount collected on the first licence invoice for lines flagged `counts_as_licence` (subscription/per-branch/size lines), after coupons and discounts applied pro rata, excluding VAT. **One-time setup, onboarding and other costs are never commissionable.** There is no switch to change this |
| **Payable timing** | Immediately after payment confirmation. Optional per-reseller *hold period* in days to cover refunds (default **0**) |
| **Minimum payout** | Optional; below it the balance carries forward |
| **Clawback** | Refunds or reversed payments on that first invoice reduce the commission automatically |
| **Cap** | Optional maximum per tenant |
| **Per-tenant override** | Super Admin can set a different percentage for one tenant (e.g. a large Enterprise deal) |

Rules for edge cases: a free trial earns nothing until the first paid invoice; partial payments earn commission pro rata on each confirmed payment against that invoice; manual payments recorded by staff (bank, MoMo, cash) count once confirmed; if the first licence invoice is fully refunded, the reseller **loses that commission** (reversed, decision 57) and the tenant's **next paid licence invoice becomes its first purchase**, earning commission once. *The "next invoice counts" part is my reading of your answer; tell me if a refunded first purchase should forfeit commission for that tenant permanently.*

**Which terms apply to a tenant?** Each tenant is bound to the terms version in force **when it was attributed** (`terms_snapshot_id`), so a reseller's deal doesn't change under existing tenants. When the Super Admin edits terms, the form asks *"apply to existing tenants too?"* (default: no). Assumption to confirm.

Changes to terms: step-up auth, mandatory reason, immutable audit entry, notification to the reseller, never retroactive to commission already earned.

## 5. Commission ledger & payouts

**Accrual** is triggered by a successful platform billing payment (`billing_payments.succeeded`, doc 25). Idempotent on the payment id.

```
tenant's FIRST licence payment confirmed (gateway webhook, or staff-recorded manual payment)
   → only if the tenant has a partner attribution and this is its first paid licence invoice (`subscriptions.first_paid_invoice_id`)
   → commission = rate(Standard|Enterprise) × net collected on that payment (excluding VAT, per base rules)
   → partner_commission_entries(status = payable)            ← payable right after the client's payment
       (if the reseller has a hold period > 0: status accrued until release_at, then payable)
   → Finance pays the reseller (MoMo / bank / cash / other) and records the payout → paid
refund/reversal → negative entry (clawback) against the same source payment
```

Tables:

| Table | Purpose / key columns |
|---|---|
| `partners` | Profile fields above, status, trusted, payout details, referral codes |
| `partner_commission_terms` | partner_id, version, effective_from, definition jsonb (basis, rates, tiers, duration, hold, min payout, frequency, caps), created_by |
| `partner_tenant_attributions` | tenant_id, partner_id, attributed_at, source (`code`,`assisted`,`manual`), terms_snapshot_id, override_terms jsonb, locked_at |
| `partner_commission_entries` | partner_id, tenant_id, source_payment_id, commission_type (`standard`/`enterprise`), base_amount_minor, rate_percent, details jsonb, amount_minor, status (`payable`,`paid`,`reversed`; `accrued` only if a hold applies), release_at, payout_id |
| `partner_payouts` | partner_id, total_minor, currency, method (`momo`,`bank`,`cash`,`cheque`,`other`), reference, proof_file_ids[], paid_by, paid_at, reseller_acknowledged_at, notes, statement_file_id |
| `partner_payout_items` | payout_id, commission_entry_id, amount_minor |
| `partner_adjustments` | partner_id, amount_minor (+/−), reason, approved_by |

### 5.1 Payout methods and the record (decision 52)

Resellers can be paid **by any method, including cash — but every payout must have a record.**

| Method | Required record |
|---|---|
| **MoMo** | Network, number, transaction ID/reference, optional screenshot |
| **Bank** | Bank, account (masked), reference, deposit slip or transfer proof |
| **Cash** | Amount, date/time, paid-by staff member, **second approver**, **reseller acknowledgement** (the reseller confirms receipt in the console, or a signed receipt is scanned and attached), optional witness |
| **Cheque / other** | Reference/number, description, proof |

- A payout lists the commission entries it settles (`partner_payout_items`), so the ledger always reconciles.
- Payouts are immutable once recorded; mistakes are fixed with a reversal plus a new payout (audited), never an edit.
- **Controls for cash** (decision 56): **every cash payout, for any amount, needs a second approver** (four-eyes; the approval threshold setting is `0` by default and can be raised later). Also a daily cash-payout report, a list of payouts **awaiting reseller acknowledgement**, and alerts for unacknowledged cash payouts after N days.
- The reseller sees every payout in their console and can acknowledge it. Monthly statement shows commissions earned, payouts, method and references.
- Permission to record payouts is separate from permission to approve or edit commission terms (`platform.partners.commissions.pay`).

- Because commission is payable as soon as the client pays, Finance works from a **"commissions payable now" queue**; payouts can be recorded one by one or in batches. They are initially **recorded by Billing/Finance** after paying the reseller out-of-band (MoMo/bank), with the transaction reference. A gateway payout API can come later.
- **Statements**: monthly PDF/CSV per reseller (tenants, payments, commission lines, clawbacks, adjustments, payout).
- Tax: confirm withholding tax or invoicing requirements for commission payments with an accountant.
- Commission liability report for Finance (accrued + approved, unpaid).

## 6. What a reseller sees in the console

Only their own data, enforced in the API and in database views that filter on `partner_id`.

| Screen | Content |
|---|---|
| **Dashboard** | Tenants referred (total / trialing / active / payment overdue / deactivated), pending applications, active branches referred, commission payable / paid this month and all-time, trend chart |
| **My tenants** ⭐ | Table of **every business they brought on board**: business name, owner contact (name, phone, email so they can follow up), plan, number of branches, sign-up and activation dates, status (trial / active / payment overdue / deactivated + reason category), billing health, subscription fee, **commission earned to date and expected next**. Search, filters, CSV export |
| **Tenant detail** (limited) | Timeline of status changes, invoices summary (amounts and paid/unpaid, not line detail), commission lines for that tenant, onboarding checklist progress |
| **Applications** | Applications they submitted: status (pending review / needs info / approved / rejected), reviewer message, ability to reply or complete missing info |
| **New client** | Assisted signup form |
| **Commissions** | Ledger of entries by type (Standard/Enterprise) and status, statements, payouts, clawbacks |
| **Profile & terms** | Read-only view of **their own commission terms** and payout details (changes requested via support) |
| **Referral tools** | Code, link, QR, simple materials |
| **Notifications** | Tenant approved/activated, tenant payment overdue or deactivated (so they can help collect), commission payable/paid |

They **cannot** see: tenant business data (vehicles, customers, drivers, payments), tenant users or roles, other resellers, platform revenue or other tenants, system health, support/impersonation, or any settings.

## 7. Permissions & scoping (grantable per reseller — decision 47)

Everything a reseller can see or do is a **permission that the product owners (Super Admin, or staff holding `platform.partners.permissions.grant`) grant per reseller** on the reseller profile. Different resellers can have different sets, changeable at any time, every change audited and notified.

**Reseller capability permissions** (granted to the partner, applying to all of its console users; a partner admin may further restrict individual users):

| Permission | Allows |
|---|---|
| `platform.partner.tenants.view` | See the list of tenants they brought on board (name, plan, status, branch count, dates) |
| `platform.partner.tenants.view_owner_contact` | See the tenant owner's name, phone and email |
| `platform.partner.tenants.view_billing_state` | See subscription state (paid/overdue/deactivated + reason category) and invoice amounts/dates |
| `platform.partner.tenants.view_onboarding` | See onboarding checklist progress |
| `platform.partner.commissions.view` | See commission ledger, statements, payouts |
| `platform.partner.terms.view` | See their own commission terms (read-only) |
| `platform.applications.create_assisted` | Submit assisted signups for clients |
| `platform.partner.applications.respond` | Answer "needs info" requests on their applications |
| `platform.partner.export` | Export CSV/PDF of their tenants and commissions |
| `platform.partner.coupons.use` | Offer coupons up to the configured maximum discount |
| `platform.partner.referral_tools.view` | See referral code/link/QR and materials |
| `platform.partner.users.manage` | Invite/disable their own colleagues' console accounts |

Defaults when a partner profile is created: `tenants.view`, `commissions.view`, `terms.view`, `applications.create_assisted`, `applications.respond`, `referral_tools.view`; the more sensitive ones (`view_owner_contact`, `view_billing_state`, `export`, `coupons.use`) are **off until Super Admin turns them on**. Data: `partner_permission_grants (partner_id, permission_key, granted_by, granted_at)`.

**Staff-side permissions**: `platform.partners.manage` (profiles), `platform.partners.permissions.grant`, `platform.partners.commission_terms.manage` (terms, Super Admin only), `platform.partners.commissions.pay` (record payouts), `platform.partners.adjust`, `platform.partners.reports.view`.

**Scoping**: a partner-type user only receives data filtered by their `partner_id`, resolved server-side from the token, never from a request parameter. Isolation tests: partner A cannot fetch partner B's tenants, applications or commission entries by id (404), and a field they lack permission for is omitted from responses.

## 8. API sketch (`/api/platform/v1/partner/*` for resellers)

```
GET  /partner/dashboard
GET  /partner/tenants?status&q … | GET /partner/tenants/:id
GET  /partner/applications | POST /partner/applications | POST /partner/applications/:id/respond
GET  /partner/commissions?type&status&from&to | GET /partner/commissions/statements/:period(.pdf)
GET  /partner/payouts
GET  /partner/profile            (own profile + commission terms, read-only)
```
Staff side:
```
CRUD /partners | PUT /partners/:id/commission-terms (new version) | POST /partners/:id/{pause|resume|terminate}
PUT  /partners/:id/permissions (grant/revoke capability set) · POST /partners/:id/attributions (manual assign) | PUT /tenants/:id/partner-terms (override)
GET  /partners/commissions?status=payable | POST /partners/:id/payouts (record) | POST /partners/:id/adjustments
GET  /partners/reports/{liability|performance|conversion|churn}
```

## 9. Abuse & risk controls

- Bounties and commissions only after **cash is collected** (a confirmed licence payment); a hold period is available per reseller if refunds become a problem.
- Self-referral and duplicate-identity checks on applications.
- Rate limits and review for bursts of assisted signups from one reseller.
- Clawback on refund/chargeback; commission stops when a tenant stops paying.
- Everything in the partner area is audited (who edited terms, who approved payouts).
- `trusted` partners only by explicit Super Admin action, and revocable.

## 10. Platform-side reporting

Revenue by reseller, commission as % of revenue, conversion (application → paid), churn by reseller, tenant health by reseller, commission liability, top performers. Surfaces in doc 27 §3.6 and §3.16.

## 11. Phasing

- **P1**: partner profiles + console accounts, referral code/link, assisted signup, attribution, "My tenants" view, application tracker.
- **P2** (needs real payments from doc 25): first-purchase commission engine (Standard/Enterprise percentages), ledger, payable queue, payouts with method records and cash acknowledgement, statements, reseller commission views, clawbacks.
- **Later**: sub-agents/hierarchies, gateway payouts, tiered programs, marketing asset library, reseller leaderboards.

## 12. Open items

See doc 19 round 8.
