# 25 — Platform Billing & Subscriptions

How **Autoforce collects its monthly subscription fee from tenants**, through the app (decision 27).

> Scope boundary: this is **platform revenue** (tenant → Autoforce). Money between a tenant and *its* customers/drivers is still **record-only** (decision 16 stands for that). Confirm this reading — open question 37 in doc 19.

## 1. Pricing recap

Monthly subscription, **priced per branch** (doc 02 §6). **Two licence types** (flagged by the Super Admin on the tenant): **Standard** = a flat price per branch (decision 48); **Enterprise** = custom pricing built from the number of branches, business size and setup/other costs (decisions 50, §2.1). The engine supports both through `price_rule`.

## 2. Data model (platform DB)

| Table | Key columns |
|---|---|
| `plans` | code (`standard`, `enterprise`), name, currency (GHS), `price_rule` jsonb (`flat` for standard; `custom` for enterprise), trial_days, features jsonb, is_active |
| `enterprise_quotes` | tenant_id, version, lines jsonb, total recurring/one-time minor, valid_until, status, created_by, approved_by |
| `subscription_price_items` | subscription_id, kind (`branch_rate`,`size_adjustment`,`setup`,`other`,`discount`), description, amount_minor, recurrence (`monthly`/`one_time`), `counts_as_licence` bool, quote_id |
| `subscriptions` | tenant_id, plan_id, status (`trialing, active, past_due, deactivated, canceled`; optional `read_only`), branch_count, billing_cycle_anchor, current_period_start/end, next_invoice_at, cancel_at_period_end, default_payment_method_id, discount/coupon |
| `subscription_events` | subscription_id, type (`branch_added, branch_removed, plan_changed, trial_started, trial_ended, payment_failed, …`), delta jsonb, at |
| `billing_invoices` | code, tenant_id, period_start/end, lines jsonb (per-branch charges, proration, discounts, VAT), subtotal/tax/total minor, currency, status (`draft, open, paid, void, uncollectible`), due_at, paid_at |
| `billing_payments` | invoice_id, provider (`paystack`…), provider_reference, method (`card, momo, bank_transfer`), channel details (masked), amount_minor, status (`pending, succeeded, failed, refunded`), raw_event ref |
| `payment_methods` | tenant_id, provider, type, masked label (e.g. "Visa •• 4081", "MTN MoMo •• 5521"), provider authorization token (encrypted), is_default, expires |
| `webhook_events` | provider, event_id (unique), payload, processed_at — idempotency |
| `credit_notes` / `balance_credits` | proration credits, refunds |
| `billing_contacts` | tenant owner name/email/phone for notices |

### 2.1 Enterprise pricing (decision 50)

A tenant flagged **Enterprise** by the Super Admin (`tenants.licence_type`) is priced **differently from the flat rate**, based on the **number of branches, business size and other costs involved in setup**.

- **Quote builder** in the console (doc 27 §3.6). **Quotes are built by hand** (decision 53): Billing/Super Admin enter free-form line items; there is no pricing formula engine. "Business size" is a judgement recorded on the quote (a free-text note and optional size band), not a computed input. Once accepted, the quote becomes the tenant's subscription pricing.

| Line item kind | Examples | Recurs? |
|---|---|---|
| Per-branch rate | Negotiated GHS/branch/month × branch count | monthly |
| Size adjustment | Fleet size / user count / data volume tier, or a fixed monthly uplift | monthly |
| Setup & onboarding | Data import, configuration, training, custom documents/templates | one-time |
| Other costs | Dedicated database/cluster, integrations, custom reports, extra support level | one-time or monthly |
| Discounts | Volume or contract discount, free months | either |

- Every line has a **`counts_as_licence`** flag. Per-branch rates and size adjustments default to *true*; setup, onboarding and other costs default to *false* (editable per line). It decides what counts as "licence amount" for reseller commission (decision 54, doc 29 §4.3): commission is calculated **only on licence lines**, with discounts applied pro rata.

- Quotes are versioned (`enterprise_quotes`: lines, valid until, status `draft → sent → accepted → superseded`), approved by Super Admin, and the accepted quote generates `subscription_price_items` (recurring and one-time). One-time items are invoiced on the first invoice; recurring items on every cycle.
- Branch additions on an Enterprise tenant are re-priced from the accepted quote's per-branch rate (or trigger a quote revision if size thresholds change).
- Standard tenants never use the quote builder; Enterprise tenants never use the flat price list. The licence type can be changed by the Super Admin only until the first payment is made; afterwards it is locked (changes go through a new quote and are audited).
- The first-purchase reseller commission uses the licence type at that moment (doc 29 §4).

## 3. Billing cycle

> The trial clock starts when the tenant is **approved and provisioned** (doc 27 §3.2), not at signup. Billing administration screens (plans, invoices, refunds, dunning, webhook replay) live in the platform console, doc 27 §3.6.

```
signup → trial (e.g. 14 days, no card needed?) → first invoice at trial end
   → each month on the anchor date: compute charge = Σ(branches active during period × price) ± proration
   → invoice (open) → in-app + email/SMS notice → payment attempt / customer pays
   → paid → subscription active, receipt sent
   → unpaid → dunning schedule (below)
```

- **Proration**: adding a branch mid-cycle charges the remaining fraction immediately (or on the next invoice — decide: *suggested: add to next invoice for simplicity, but block no action*); removing a branch gives a credit on the next invoice.
- **Annual prepay discount** (option): 2 months free.
- **Currency**: GHS (platform currency). Independent from the tenant's own base currency.
- **Tax**: VAT on our subscription fee if Autoforce is VAT-registered; invoice carries our TIN/VAT number. Confirm with an accountant.

## 4. Payment methods & provider

| Method | Behaviour |
|---|---|
| **Card** | Tokenised authorization saved after first payment; can be **charged automatically** each cycle |
| **Mobile Money (MTN / Telecel / AT)** | Customer approves a prompt on their phone each cycle. Recurring auto-debit generally isn't available, so the system sends the invoice + prompts and relies on the owner approving |
| **Bank transfer / cash / MoMo outside the gateway** | Manual: staff record the payment with method, reference and proof attachment (Enterprise and special cases) |

Provider: **Paystack** is the leading candidate (cards + MoMo in Ghana, hosted checkout, webhooks, saved authorizations). Alternatives: Hubtel, Flutterwave. Selection is an open question (doc 19, #16 revised). Keep behind a `PaymentGateway` interface so the provider can change.

### Flow (hosted checkout)
```
Owner opens Billing page → "Pay now" on open invoice
 → POST /billing/invoices/:id/checkout → server creates provider transaction (amount, reference = invoice code, metadata {tenantId, invoiceId}) → returns checkout URL / access code
 → owner pays on provider page (card or MoMo prompt)
 → provider webhook → verify signature → look up by reference → verify amount/currency via provider API → mark billing_payment succeeded + invoice paid (idempotent on event id) → activate subscription, send receipt
 → return URL shows result (webhook is the source of truth, not the redirect)
```

## 5. Billing automation: reminders, deactivation, restore & extensions

Decision 38: **deactivation and reactivation are automated from billing.** Staff intervene only in special cases or to grant extensions. There is no separate "suspended" state (decision 39): non-payment ends in `deactivated` with reason `non_payment`.

### 5.1 Default automated schedule (configurable in `dunning_policies`)

| When (vs due date) | What happens | Subscription / tenant status |
|---|---|---|
| Invoice issued (≈ 7 days before due) | Invoice created; owner can pay early | active |
| **−7, −3, −1 days** | **Reminder notifications**: amount, due date, branch count, link to the Billing tab (sign-in required), "request extension" link | active |
| **Due day** | Auto-charge saved card; else MoMo prompt / notification to pay in the Billing tab | active |
| +1 day | Payment-overdue notice; retry card; in-app banner for all tenant admins | **past_due** (full access) |
| +3, +5 days | Reminders with countdown to deactivation | past_due |
| **+7 days (end of grace)** | **Automatic deactivation** (reason `non_payment`): sessions revoked, branch states untouched, jobs paused, **billing paused** | **deactivated** |
| Invoice paid, any time | **Automatic restore** (§5.3) | active |

- Trial ending uses the same path: reminders before trial end → first invoice → grace → `deactivated` with reason `trial_expired` → restore on first payment.
- An optional **read-only** step (view and export, no writes) can be inserted between past-due and deactivation. It is **off by default**.
- All day counts, templates and channels are platform settings editable by Billing/Super Admin (doc 27 §3.18), versioned. Times use Africa/Accra.
- **Notification channels** (decision 45): **email, SMS, in-app banner, and push (normal notification) in the app**. WhatsApp is not used for now. Email and SMS go out from the **platform's** own senders (tenants' SMS accounts are never used for our billing notices; the platform pays the SMS cost). Recipients: the tenant's billing contacts and all users holding `billing.manage`. The banner shows in web and mobile for every tenant admin from the first reminder until paid. **Reminders link to the portal (sign-in required) and carry no invoice reference** (decision 51). Each notice is logged in `billing_notices` (what, when, channel, delivery result) and is viewable in the tenant's timeline (doc 27 §3.4).
- Reseller (if any) is notified when their tenant goes overdue or is deactivated (doc 29 §6).
- Terminology: a tenant's **subscription payment is a "licence purchase"** (each billing-cycle payment is a licence purchase/renewal). Doc 29 uses this wording for commissions.

### 5.2 Paying: sign in to the Billing tab, including when deactivated (decision 51)

Tenants **sign in and pay from the Billing tab** of the web portal. This keeps one flow for everyone and lets them view previous transactions. There is **no public billing page** (decision 43 is withdrawn).

**Billing tab contents** (permissions `billing.view` to look, `billing.manage` to act): current plan/licence type and branch count, next invoice and due date, open invoices, **full invoice and payment history**, receipts and PDFs, saved payment methods, pay now (gateway checkout: card or MoMo), request extension and extension history, plan/branch changes (active tenants), billing notices received.

**When the tenant is deactivated for non-payment or trial expiry — "billing-only mode":**
- Sign-in is still allowed, but only for users holding `billing.view` or `billing.manage` (normally the owner). The access token carries `scope: "billing_only"`; the API accepts nothing except `/auth/*`, `/me` and `/billing/*`. Everything else returns `403 TENANT_DEACTIVATED`.
- The portal shows the Billing tab with a banner ("Account deactivated for non-payment — pay to restore, or request an extension"). **All other screens stay blocked.**
- Users without billing permissions see a blocking screen ("Your account is deactivated. Contact your account owner <masked name>").
- Mobile app: sign-in shows the same status screen and sends the user to the web portal's Billing tab to pay (store-policy reasons, §6).
- This is the single, deliberate narrow exception to "nobody can access the system when deactivated" (decision 35). **Confirm in doc 19, Q72.**
- **Other deactivation reasons** (requested pause, abuse, legal, other): no sign-in at all; the screen shows "This account is deactivated. Contact support".
- **Billing is paused** while deactivated: no new invoices or charges. The one unpaid invoice stays open until paid or extended.
- Anyone paying on the tenant's behalf (an accountant) signs in with their own account if they have billing permission, or asks the owner to grant it.

### 5.3 Automatic restore on payment

```
payment webhook succeeds (or staff records a manual payment) for the open invoice
  → verify amount/currency with the provider → mark invoice paid (idempotent)
  → if the deactivation is billing-driven and not manually locked (§5.5):
        tenant status → previous status (active); sessions allowed again; jobs resume
        billing re-anchored: the paid invoice covers a new period starting at the restore date
        branch count recomputed (see below); catch-up report generated (doc 27 §3.3)
  → owner notified (email, in-app, push); reseller notified
```
- Partial payments do not restore (unless an extension is active).
- **Fewer branches**: billing-only mode cannot change branches. A tenant that wants to pay for fewer branches asks support before paying (staff adjust the branch count, doc 27 §3.5), or deactivates branches after restore; the saving applies from the next invoice.
- The unpaid days after grace are **not billed** (billing was paused); grace days were service already delivered and are free.

### 5.4 Extensions

A tenant can ask for more time; platform staff decide.

```
Owner clicks "Request extension" in the Billing tab (also available in billing-only mode)
   → enters requested date (+ optional promise-to-pay note)
   → billing_extensions: requested
Staff with platform.billing.extensions.grant: approve (possibly a different date) | deny (reason)
   → approved: automation for THAT invoice pauses until extended_until
        · if already deactivated → restored immediately, banner "extension until <date>"
        · reminders continue (−3, −1 days before extended_until)
   → extended_until passes unpaid: short final notice, then normal path resumes (auto-deactivate after a short final grace, default 1 day)
   → paid at any time: normal restore/active, extension closed
```
- Guardrails (platform settings): **maximum 10 days per extension (decision 44)**; the number of extensions per rolling 90 days is limited (default 2, configurable); anything over a limit needs Super Admin. Auto-approval is **off** by default (staff decide each request).
- Optional auto-approval policy (suggestion): first request in 90 days, ≤ 3 days, tenant has no history of lapses.
- Every request, decision, actor and reason is audited; shown on tenant timeline; reseller sees only that an extension exists.

### 5.5 Manual overrides (special cases only)

- Staff can still deactivate or restore a tenant manually (doc 27 §3.3). A **manual deactivation is locked** (`lifecycle_lock = manual`): payments do **not** auto-restore it. A payment received while locked is recorded, and the owner is told the account is on hold. Only staff unlock.
- A staff member can restore a non-payment deactivation without payment only by granting an extension (never a silent bypass).
- `dispute_hold`: billing disputes or pending refunds stop automatic deactivation for that invoice.

### 5.6 Safeguards on the automation

| Risk | Guard |
|---|---|
| Wrongly deactivating paying customers (gateway outage, webhook delay) | **Gateway-health guard**: if webhook lag or provider errors are detected, deactivation pauses and alerts fire; before deactivating, re-verify payment status with the provider API |
| Bug deactivates many tenants at once | **Circuit breaker**: a run deactivating more than N tenants or X% of active tenants stops and pages on-call |
| Launch risk | **Dry-run mode** for the first weeks: the job logs who would be deactivated, staff review |
| Surprise for large customers | **Pending-deactivation review queue**: 24 h before auto-deactivation, tenants above a size threshold (e.g. many branches) are listed for staff to check/contact |
| Duplicate processing | Jobs idempotent per (tenant, invoice, step) |
| Weekend/holiday timing | Optionally skip Sundays/public holidays when counting grace |
| Staff changes lost | Every automated and manual transition recorded in `tenant_status_history` with source (`automation`/`staff`) |

### 5.7 Data & API

| Table | Purpose |
|---|---|
| `dunning_policies` | Versioned schedule: reminder offsets, grace days, optional read-only step, channels, templates, holiday rules |
| `billing_notices` | Sent log: tenant, invoice, type, channel, status, sent_at |
| `billing_extensions` | tenant_id, invoice_id, requested_until, reason, status (`requested, approved, denied, expired, closed`), approved_until, decided_by, decided_at, decision_reason |
| `subscriptions` (extra columns) | `grace_until`, `deactivated_reason`, `lifecycle_lock` (`none`/`manual`), `dispute_hold`, `automation_state` |

```
Tenant:   POST /billing/extensions { invoiceId, requestedUntil, reason } · GET /billing/extensions
Tenant:   GET  /billing/transactions (payment history) · GET /billing/invoices/:id(.pdf) · POST /billing/invoices/:id/checkout
Platform: GET  /billing/extensions?status=requested · PUT /billing/extensions/:id/{approve|deny}
          GET  /billing/automation/pending         (who will be deactivated in the next 48 h)
          PUT  /billing/dunning-policy
```

## 6. Where the user pays — web vs mobile

- **Primary: web portal Billing tab** (`billing.view` / `billing.manage`, §5.2): current plan and licence type, branches counted, next invoice, invoices and full transaction history, receipts, payment methods, pay-now, request extension, change plan, cancel. It is also the only area reachable in billing-only mode.
- **Mobile app**: show status and a "Pay on web" link opening the portal Billing page in the browser. Reason: app-store rules may require in-app purchase for digital subscriptions sold inside an iOS/Android app; B2B and external-payment exceptions exist but vary by region and change. **Verify with current Apple/Google policy before putting a payment form inside the app.** Until verified, don't embed the checkout in the mobile app.

## 7. Entitlement enforcement

- Resolved entitlement object: `{ status, branchesMax, features[], readOnly }`, cached in Redis, invalidated on subscription change.
- Middleware `requireWritable()` rejects mutations in `read_only` (if that step is enabled). `deactivated` tenants are blocked earlier, at tenant resolution (doc 27 §3.3).
- `branchesMax` = paid branch count (or plan limit). Creating a branch beyond it → error `ENTITLEMENT_BRANCH_LIMIT` with a link to upgrade, or auto-add (billing event) if the tenant enabled "bill automatically when I add a branch" (suggested default: explicit confirmation dialog showing the new monthly price).
- Branch deactivation: allowed anytime; billed through period end.

## 8. Platform admin console features

- Plans CRUD, coupons, trial extension, manual invoice/payment (bank transfer), refund, credit note, write-off.
- Revenue dashboard: MRR, branches billed, churn, failed payments, ageing, trial conversions.
- Per-tenant billing timeline.
- Impersonation read-only for support (audited).

## 9. Security & compliance

- Never store card numbers. Store only provider tokens/authorization codes, encrypted (envelope encryption; key outside DB).
- Webhook endpoint: verify HMAC signature, allow-list provider IPs where available, replay protection by `event_id`, strict idempotency.
- Always re-verify transaction status/amount with the provider API before crediting.
- Amount tampering: server computes amount from the invoice; clients never send amounts.
- PCI scope stays minimal by using hosted checkout.
- Audit log every billing state change; reconcile daily with provider settlement report (job) and alert on mismatches.
- Receipts and invoices retained per Ghana tax record rules (confirm period).

## 10. API sketch (tenant-facing)

```
GET  /billing/subscription               plan, status, branches, next invoice, entitlements
GET  /billing/invoices | /billing/invoices/:id(.pdf)
POST /billing/invoices/:id/checkout      → { checkoutUrl }
GET  /billing/payment-methods | DELETE /billing/payment-methods/:id | POST …/default
POST /billing/plan                       change plan / confirm branch count
POST /billing/cancel | /billing/resume
POST /webhooks/paystack                  (platform, public, signed)
```
Platform-admin APIs live under `/api/platform/billing/*`.

## 11. Phasing

- P1: plans, subscriptions, entitlement enforcement, trial, manual (bank/MoMo-recorded-by-staff) payments, invoices PDF.
- P2: Paystack checkout + webhooks, saved cards + auto-charge, dunning automation, receipts.
- Later: annual plans, coupons, VAT invoicing refinements, MoMo recurring if a provider supports it, usage analytics.
