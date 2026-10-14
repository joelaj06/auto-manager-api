# 19 — Open Questions

> **Answered 2026-10-13** — see [21_decisions_log.md](21_decisions_log.md). Items 1–21 and 25 have answers (22–24, compliance, are still open). New questions raised by those answers are in the **"Round 2"** section at the end of this file.

Decisions needed from the product owner before (or during) implementation. Suggested defaults in *italics*.

## Business & market

1. **Primary market** — Ghana only, or West Africa / wider Africa from day one? (affects currencies, tax rules, payment providers, SMS vendors) — *Ghana first, design for multi-country.* ✅ **Partly decided (2026-10-13):** currency is user-selectable with **GHS as the default** — see doc 20.
2. Which **segment launches first** commercially: fleet/W&P operators, rental companies, or dealers? — *Fleet + W&P (closest to existing code), then rentals.*
3. Are there existing **production tenants/data**? How many, and is downtime acceptable for migrations? (determines strangler vs big-bang data migration)
4. Is there a **mobile app** consuming this API today (`deviceToken` suggests yes)? Which endpoints must stay backward compatible, and for how long?
5. Pricing model for the SaaS — per vehicle, per user, or flat tiers? — *Tiered with vehicle limits (doc 02 §6).*

## Domain rules

6. Work & Pay: typical **frequency** (daily/weekly/monthly)? Are **penalties** charged? Is there a **deposit**? What happens on default (repossession, refund of part of paid amount)?
7. Work & Pay: on completion, does the system need to produce a **transfer letter / DVLA paperwork**?
8. Remittances: is the "sale" always a fixed **target** per day/week, or variable declared earnings (ride-hailing)? Do drivers have days off?
9. Can a vehicle have **multiple drivers** at once (day/night shifts)?
10. Rentals: book by **class** or by specific vehicle? Self-drive, chauffeur-driven, or both? Corporate monthly leases?
11. Dealers: mostly **imports** (need landed cost & port tracking) or local used cars? Consignment?
12. Is **VAT** relevant for most tenants (are they VAT-registered)?
13. Is a single **Party** collection (one person can be customer + driver + supplier) preferred over separate collections? — *Separate collections with a shared `personId` link, simpler permissions.*

## Technical

14. **Hosting**: OK to move from Vercel serverless to a container host (needed for workers, connection pooling)? — *Yes, recommended.*
15. Introduce **Redis** (queues, cache, rate limits)? — *Yes.*
16. Payment provider preference: **Paystack**, Hubtel, Flutterwave? Will tenants bring their own accounts (money goes to tenant)? — *Paystack subaccounts per tenant.*
17. SMS provider preference and who pays for SMS (bundled credits vs tenant's own account)?
18. Do we keep **subdomain-per-tenant** for the web app, plus header/claim-based resolution for mobile? Custom domains for Enterprise?
19. Keep **Mongo** (yes assumed) — any appetite for Postgres for the finance/ledger part? — *Stay on Mongo with transactions; revisit only if reporting needs outgrow it.*
20. API versioning: OK to introduce `/api/v1` and treat current routes as legacy aliases?
21. Frontend stack and repos — is there a web dashboard repo that will need parallel changes?

## Compliance

22. Legal review needed for hire-purchase agreements (consumer credit rules) and remote immobilisation?
23. Data protection registration (Ghana Data Protection Commission) and data residency expectations from enterprise tenants?
24. Audit-log retention requirements?

## Currency

25. Currency: is tenant-level currency selection enough, or should each user also pick a display currency? Show `₵` or `GH₵`? (doc 20 §14)

---

## Round 2 — questions raised by the answers

**Domains & clients**
26. **"Shared domain"**: is it *one API domain for all tenants* (tenant from token/header) with the web portal on `<slug>.<domain>`? Or per-tenant API subdomains? (doc 23 §1)
27. What are the actual **domain names** (API, web portal, link/landing domain) and the app's Android package / iOS bundle IDs?
28. ~~Mobile app contract~~ **Answered (28): APIs will change; the app is revisited after the backend.**

**Pricing & billing**
29. Per-branch price: flat per branch, volume tiers, or base fee + per extra branch? Are all modules included or sold in bundles? Trial length?
30. ~~How will we collect subscription fees?~~ **Answered (27): tenants pay in the app.** Remaining: which gateway (Paystack? Hubtel? Flutterwave?), card auto-charge + MoMo prompt each cycle OK, and VAT on our fee (doc 25).

**Hosting**
31. ~~Backups~~ **Answered (29): essential** (doc 26). Remaining: VPS provider/spec, off-site storage provider/budget, RPO/RTO targets (proposal: 5 min / 1 h per tenant / 4 h full), and when to add a standby server.
32. Job queue: **pg-boss** (fewer moving parts, recommended) or BullMQ on Redis? (Redis stays for cache/rate limits either way.)

**Product rules**
33. **VAT**: which tenants are VAT-registered, and does the accountant confirm the current rates/flat-rate scheme to seed? (doc 13 §6)
34. **Transfer letter**: who is the legal "owner" signatory when the owner is a company (director? authorised signatory?). Is a witness required? Is OTP confirmation of signers acceptable, or must a lawyer-approved wet-ink copy always be kept? (doc 24)
35. Remittance mode: may drivers choose their own mode, or only owners (doc 09 §2.1)?
36. Should tenants be able to extend **roles beyond the built-in ones** (custom roles) — assumed yes.

**Still open from round 1**: 22 (legal review of hire-purchase terms), 23 (data protection registration and residency), 24 (audit retention).

**Round 3 (from revision 2)**
37. **Confirm interpretation**: "tenants pay through the app" = tenants pay **Autoforce's subscription** via a gateway; tenants' own customer/driver payments remain **record-only**. Correct? If tenants *should* also collect from their customers/drivers through the app, doc 13 and doc 15 need a second look (per-tenant gateway accounts/subaccounts, settlement, fees).
38. Tenant database scale: expected tenant count in year 1 and year 3? (drives cluster sizing; doc 22 plans ≈1,000 per cluster.) Any tenant likely to need a **dedicated cluster** or per-tenant DB credentials?
39. Trial: card required at signup or not? Length (14 days)? What happens to unverified signups (auto-delete after N days)?
40. Mobile payments: confirm billing UI lives on the **web portal**, with the app linking out (doc 25 §6), pending app-store policy check.

**Round 4 (platform console & roles)**
41. **Approval policy**: manual approval of every new tenant at launch? Later auto-approve low-risk signups? What do you check (TIN/registration documents, phone call, referral)? Who reviews, and what SLA?
42. **Who are the platform staff** at launch (roles/people)? Do you want a **partner/reseller program** (referral codes + commissions, doc 27 §5.1)?
43. **Impersonation policy**: read-only by default with a logged reason; should the tenant owner be notified or have to consent each time? Is write-mode ever allowed?
44. **Suspension vs deactivation** semantics (doc 27 §3.3): is "deactivated = paused, no billing" the right meaning? Should a deactivated tenant keep read access for export?
45. **Deletion policy**: grace period before dropping a tenant database (30/60/90 days) and how long backups are kept afterwards (doc 26 §8).
46. **Console hosting**: `admin.<domain>`, separate deployment from the tenant API now or later? IP allow-list/VPN for staff? MFA method (authenticator app, passkeys)?
47. **Alerts and support tools** to integrate: Slack/Telegram/WhatsApp for alerts, Sentry/Grafana, a ticketing tool or the built-in minimal one, public status page provider.
48. **Roles**: are the proposed system roles (doc 28 §6) right for your customers? Should tenants be able to restrict a user to specific branches (assumed yes) and set numeric limits (discount %, approval amount)?
49. **New-permission rollout**: when a release adds permissions, should they stay off for custom roles until the owner opts in (proposed) or default-on for admin-type custom roles?

**Round 4 — answered 2026-10-13** (see decisions 32–37 in [21](21_decisions_log.md))
- 41 approval policy → accepted as proposed (manual at launch; auto-approve rules later).
- 42 platform staff / partners → anyone given console credentials; resellers can have console accounts (scoped to their own referred tenants).
- 43 impersonation → no consent needed, any permitted console user, mandatory trail.
- 44 deactivation → tenant deactivated = no one can access the system; branch deactivated = no one can access that branch.
- 45 deletion → tenants are never deleted; deactivate and restore.
- 46 console hosting → accepted as proposed.
- 47 alert/ticket/status-page tools → **still open** (tool choices).
- 48 system roles, branch-restricted assignments, numeric limits → accepted ("good with everything").
- 49 new permissions → accepted as proposed (off for custom roles until the owner opts in).

**Round 5 (from the answers above)**
50. **Reseller powers**: may a partner approve its own clients' applications ("trusted partner"), or does every partner-created application go to staff review? What do partners see (status, subscription state, onboarding progress, commissions)? Commission terms (percent / fixed per branch, for how many months)?
51. **Billing while deactivated**: paused when the tenant asks for a pause (assumed), but what when we deactivate for non-payment — keep accruing, or treat that as `suspended` with a pay-to-restore page? Do we still need `suspended` as a separate state from `deactivated`? (Suggested: keep both — `suspended` shows a pay/contact page, `deactivated` shows a contact page only.)
52. **Cold archive**: OK to move tenants deactivated for ≥ 12 months to cold archive (restorable, never deleted) to free server capacity? Accept an hours-long restore for them and the ongoing storage cost?
53. **Legal erasure**: with a no-delete policy, are you comfortable handling data-protection erasure requests by anonymisation (with an erasure ledger), pending legal advice?
54. **Branch reactivation**: can the tenant owner reactivate a branch themselves (subject to billing/entitlement), or only platform staff? Deactivating a branch requires first moving/closing its open rentals, agreements, assignments and cash sessions — acceptable?
55. **W&P during tenant deactivation**: the real-world agreements continue while the system is off. On restore, should arrears/penalties for the gap be waived by default, or accrued normally? (Proposed: waived by default, staff can override.)
56. **Support access scope**: confirm "any user" means any console user whose role has the support-access permission (not partner/reseller accounts).

**Round 5 — answered 2026-10-13** (decisions 38–42 in [21](21_decisions_log.md))
- 50 reseller powers → resellers see all their tenants and commissions; commission terms per reseller, set by Super Admin on the reseller profile (doc 29). *Trusted-partner auto-approval stays off by default.*
- 51 billing while deactivated → paused until the tenant pays; deactivation is automated from billing, with reminders and staff-granted extensions (doc 25 §5). `suspended` retired.
- 52 cold archive, 53 anonymisation → yes for now, may change later.
- 54, 55, 56 → "Yes" read as accepting the proposed defaults (see decision 42).

**Round 6 (from the answers above)**
57. **Billing-only page**: for tenants deactivated for non-payment, is it OK that owners/billing users can still reach a restricted page (invoice, pay, request extension) and a public pay link — while everything else stays blocked? (doc 25 §5.2)
58. **Default schedule**: reminders at −7/−3/−1 days, overdue notices, **7-day grace**, then auto-deactivation, optional read-only step off. Right numbers? Business days only, or calendar days?
59. **Extension policy**: maximum days per extension, maximum per 90 days, who may approve beyond the limit, and should a small first extension (e.g. ≤ 3 days) auto-approve?
60. **Billing notices sender**: OK to send billing reminders from the platform's own email/SMS/WhatsApp sender (not the tenant's)? Who pays for that SMS volume (us)?
61. **Billing restart**: after a late payment, the new billing period starts on the payment date and the unbilled deactivated gap is not charged (doc 25 §5.3). Agreed?
62. **Commission defaults**: percent of fee vs fixed per branch vs bounty; duration (months vs lifetime); hold period before approval; payout frequency and method (MoMo/bank, recorded manually at first); minimum payout. Apply new terms only to *new* referrals by default (proposal) or to existing ones too?
63. **What resellers can see about their tenants**: owner name/phone/email (so they can follow up), subscription state and overdue/deactivated status, fee amounts — OK? Any item to hide?
64. Withholding tax or invoicing requirements on reseller commission payments — accountant to confirm.

**Round 6 — answered 2026-10-14** (decisions 43–48 in [21](21_decisions_log.md))
- 57 billing page → public but addressed to a tenant (`/pay/<tenantSlug>`), no login; replaces the restricted in-app billing area.
- 59 extension policy → **maximum 10 days** per extension (other limits at proposed defaults).
- 60 billing notification channels → email, SMS, in-app (banner + normal notification).
- 62 commission → types **Standard** and **Enterprise**; payable after the client's payment (licence purchase).
- 63 reseller visibility → yes, but every item is a permission product owners grant per reseller.
- "Flat for now" → read as flat per-branch price (Q29).
- **Not answered, kept at my proposals**: 58 (reminders −7/−3/−1, 7-day grace, calendar days), 61 (billing restarts on payment date; gap not billed), 64 (tax on commissions — accountant).

**Round 7 (from the answers above)**
65. **Commission details**: (a) does commission apply to **every licence payment** (renewals) or only the first purchase? For how many months or lifetime? (b) Is the commission a **percentage** of the payment, a **fixed amount**, or either per reseller? (c) Does "Standard vs Enterprise" mean the tenant's plan type (my reading) or two tiers of reseller?
66. **Enterprise licence**: what makes a tenant Enterprise (branch count threshold, custom contract, manually flagged by Super Admin)? Is Enterprise priced differently from flat per-branch?
67. **Public billing page domain**: `pay.<domain>` or a path on the portal domain? Should reminders always include the unguessable invoice reference, or just the tenant link?
68. **Extension frequency**: keep the proposed limit of 2 extensions per rolling 90 days, and Super Admin approval above it?
69. **Payout method for resellers**: MoMo, bank, or both; paid by Finance manually at first (proposal)?

**Round 7 — answered 2026-10-14** (decisions 49–52 in [21](21_decisions_log.md))
- 65 commission → first licence purchase only; percentage. "Standard vs Enterprise" = the tenant's licence type, as I read it.
- 66 Enterprise → flagged by the Super Admin; priced by number of branches, business size and setup/other costs.
- 67 billing page → no dedicated address; tenants sign in and use the Billing tab; reminders carry no invoice reference.
- 68 extension frequency → not answered; proposal (2 per 90 days) stands.
- 69 reseller payouts → any method including cash, always recorded.

**Round 8 (from the answers above)**
70. **Enterprise pricing**: do you want to build each quote by hand (line items), or a formula (per-branch rate × business-size factor + setup fee)? What defines "business size" — vehicles, drivers, users, branches, or your judgement? Which setup costs are one-time, and which recur?
71. **Commission base for Enterprise**: percentage of the licence (subscription) amount only, or of the whole first payment including one-time setup fees? (Proposal: licence lines only, with a per-reseller switch to include setup fees.)
72. **Billing-only sign-in**: confirm that a tenant deactivated for non-payment can sign in to the **Billing tab only** (users with billing permission), with everything else blocked, as the single exception to "nobody can access". Other users see a "contact your account owner" screen.
73. **Licence flag timing**: Super Admin can set Standard/Enterprise any time before the first payment, and it locks after. OK? Who besides you may set it?
74. **Cash payouts**: above what amount should a second approver be required, and must resellers always acknowledge receipt of cash in the console?
75. **First purchase refunded**: if a reseller's tenant's first licence payment is fully refunded, does the reseller lose the commission and the next paid invoice count as the "first purchase" (proposal), or is the commission simply reversed with nothing later?

**Round 8 — answered 2026-10-14** (decisions 53–57 in [21](21_decisions_log.md))
- 70 Enterprise pricing → quotes built by hand.
- 71 commission base → licence amount only.
- 72 billing-only sign-in → confirmed.
- 74 cash payouts → "any amount" (read as: second approver always).
- 75 refunded first purchase → reseller loses the commission.
- 73 licence-flag timing → not answered; proposal stands (Super Admin sets it until the first payment, then it locks; others only with `platform.tenants.set_licence_type`).

---

## Consolidated open questions (2026-10-14)

Everything that is still unanswered, grouped by how much it blocks. Items with a proposal in *italics* will be assumed unless you say otherwise.

**Needed before the first build step (Phase 0)**
- **27** Domain names (API, web portal, admin console) and the mobile app's Android package / iOS bundle IDs.
- **26** "Shared domain": one API address for all tenants with the tenant taken from the login token/header? *Yes (doc 23 §1).*
- **31** VPS provider and size, off-site backup storage provider and budget, and recovery targets. *5 min of data loss, 1 h per tenant, 4 h full rebuild (doc 26).*
- **32** Job queue: *pg-boss (fewer moving parts)* or BullMQ on Redis.
- **38** Expected number of tenants in year 1 and year 3; any tenant that will need its own server.

**Needed before billing goes live**
- **30** Payment gateway for tenants paying us: *Paystack*, Hubtel or Flutterwave; and VAT on our own fee.
- **29 / 39** Actual price per branch, trial length, and whether a card is required at signup; *unverified signups expire after N days.*
- **58 / 61 / 68** Reminder and grace schedule (*−7/−3/−1 days, 7-day grace, calendar days*), billing restart on payment date (*yes; deactivated gap not billed*), extension frequency (*2 per 90 days*).
- **64** Tax treatment of reseller commission (accountant).

**Needed before the matching module**
- **33** Which tenants are VAT-registered and the current rates to load (accountant).
- **34** Transfer letter details: who signs for a company owner, witness required, OTP acceptable (lawyer).
- **22 / 23 / 24** Legal review of hire-purchase terms, data-protection registration and residency, audit-log retention.
- **47** Tools for alerts, support tickets and the public status page.
- **40** Billing UI on the web portal only, with the mobile app linking out (*yes, pending app-store policy check*).

**Small confirmations**
- **57** Next paid invoice counts as the tenant's first purchase after a refund (*assumed*).
- **74** Cash payout approver meaning (*second approver always*), reseller acknowledgement of cash (*required*).

