# 34 — Beta tenant onboarding guide

How a trusted business joins the private beta (M2, doc 30), from application to its first work and pay agreement. Part A is for our staff, part B is the checklist we walk through with the owner. Billing is manual during the beta (doc 25).

## Part A — our side

| Step | Who | How |
|---|---|---|
| 1. Agree the beta | Staff | Written beta terms: data processing (we are processor, the business is controller), support hours, that features may change, manual billing at the agreed per-branch price |
| 2. Application | Owner | Public signup (`POST /api/v1/applications`), email and phone verified by code |
| 3. Review and approve | Staff (console) | Applications queue: check the business (registration, TIN where they have one), request information if needed, approve. Provisioning runs in the worker: database, seed, owner welcome email |
| 4. Check provisioning | Staff | Console → tenant → provisioning: all steps done; `yarn db:status` shows the tenant at the current version |
| 5. Billing | Staff | Set the standard per-branch price (console), issue the first invoice, record the payment when it arrives — the subscription and tenant become active |
| 6. First backup | Staff | `yarn backup run --tenant <id>` then `yarn backup verify --id <backupId>` (doc 31) — before the business enters real data |
| 7. Kick-off call | Staff + owner | Part B below, with the owner signed in |

## Part B — the business's setup checklist

Each line is a screen of the web portal (or its API). Do them in this order.

### Organisation and people

- [ ] **Owner signs in** from the welcome email and sets a strong password (12+ characters). Tell them: passwords are the only factor for tenant users during the beta (doc 32 F2) — never share accounts.
- [ ] **Organisation**: legal name, TIN, contact details, logo (shown on receipts, statements and documents).
- [ ] **Branches**: one per location; the price is per branch.
- [ ] **Tax**: VAT-registered or not; if registered, the standard codes are seeded (Ghana 15% + NHIL + GETFund) — check and activate.
- [ ] **Currency**: GHS base; other currencies and rates only if they take foreign money.
- [ ] **Users and roles**: invite staff with the least role that does the job (system roles: administrator, branch manager, fleet officer, cashier, accountant, auditor), scoped to their branches. Sensitive permissions (repossession, waivers, restructures, reversals) only to managers.

### Fleet and drivers

- [ ] **Vehicles**: import with the CSV template (`/vehicles/import/template`, preview then commit) or one by one; acquisition cost and date for book values and the work and pay simulator.
- [ ] **Vehicle documents**: registration, insurance, roadworthy with expiry dates (reminders start from these).
- [ ] **Drivers**: Ghana Card, licence with expiry, guarantors; activate.
- [ ] **Driver app**: invite each driver (`/drivers/:id/app-access`, QR or SMS). Drivers sign agreements and see their statements there.
- [ ] **Assignments**: hand each vehicle to its driver with the checklist and odometer; remittance targets for remittance drivers.

### Money

- [ ] **Finance settings**: whether cash needs a cashier's open cash session (default yes), default invoice due days.
- [ ] **Expense categories and approval rules** (small amounts may approve automatically).
- [ ] **SMS provider** (Hubtel, Arkesel or mNotify): their own account and Sender ID; send a test. Without it, drivers get no reminders.
- [ ] **Notification rules**: remittance and work and pay reminders are on by default; guarantor alerts are opt-in — the business decides, and guarantors should know when they sign.

### Work & Pay

- [ ] **Settings**: default frequency, grace days, rounding, deposit rule, late fee, default thresholds (overdue count and days), settlement discount, repossession refund policy, whether drivers' costs go on their ledger or into the agreement, the transfer-letter items.
- [ ] **Templates**: review the agreement and transfer-letter templates (locked clauses stay); their lawyer should read them (doc 08 §11, doc 24 §7).
- [ ] **First agreement together**: simulate → draft with guarantors → send for signature → driver signs in the app → deposit → activate with the handover checklist. Then show the statement, the balance and the portfolio dashboard.

### Before real money

- [ ] Record one test payment and reverse it; check the receipt and the driver's statement.
- [ ] Run the integrity check (`GET /api/v1/ledger/integrity`): all green.
- [ ] Agree who at the business reviews the arrears list and dashboards each week.

## Part C — support during the beta

- **Channel**: one WhatsApp group or email address per business, answered on working days; incidents follow doc 33 §5.
- **Feedback**: a short call after two weeks and after the first month: what is missing, what is wrong, what they would pay for.
- **Exit**: a business may leave at any time; the tenant is deactivated, never deleted (doc 21). A data export on request is manual until P4-8 builds it: staff restore the tenant's latest backup and export from it.
