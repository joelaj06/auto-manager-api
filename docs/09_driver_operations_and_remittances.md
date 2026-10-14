# 09 — Driver Operations & Remittances

## 1. Naming problem

Today's **"Sales"** module records money a driver brings in (daily/weekly "sales") for a vehicle, with pending/approved/rejected status. Once the **Dealership** module arrives, "sales" will mean *selling cars*. Rename:

| Today | Proposed |
|---|---|
| `Sale` / `/api/sales` | `Remittance` / `/api/v1/remittances` (keep `/api/sales` as deprecated alias) |
| Dashboard "sales" | "Driver remittances" (or "Fleet income") |
| Dealer vehicle sales | `Deal` (doc 10) |

## 2. Remittance model

Concepts:
- **Target / expected amount** per period from the assignment terms (e.g. GHS 250/day, Sunday off; or GHS 1,500/week).
- **Declared** amount (what driver says), **received** amount (what cashier/MoMo confirms).
- **Shortfall** = expected − received → accumulates on the **driver ledger**.
- Optional earnings breakdown for ride-hailing (Uber/Bolt/Yango gross, commission, cash vs card) — enables profitability per platform.

Flow:
```
(job) generate expected remittance rows per active assignment per period
driver submits (app) or cashier records ─▶ submitted ─▶ approved (payment confirmed) | rejected (reason)
                                                     └▶ partially_paid → shortfall carried
```

- Payment captured through finance (`payments`) so cash/MoMo reconciliation is consistent.
- Approval permission separation (driver can submit, only supervisor approves) — already partly present (`approvedOrRejectedBy`).

### 2.1 Remittance mode (decision 8)

Whether a driver has a fixed target depends on the business owner, so it is a setting on the **assignment** (with a tenant default):

| Mode | Behaviour |
|---|---|
| `fixed_target` | Expected rows are generated per period; shortfalls accumulate on the driver ledger |
| `variable` | Driver declares what they earned/paid in; no expected amount, no shortfall |
| `none` | No remittance tracking (salaried driver, or W&P-only where the instalment is the payment) |

A driver can be offered the option to switch only where the owner enables it (`allowDriverChoosesMode`). One vehicle has one driver at a time (decision 9).

## 3. Driver ledger

One running account per driver combining:
- targets (+ owed), payments (−), shortfall carry-forward, advances/loans to driver (+), deductions (fines, damage, fuel overuse) (+), bonuses (−), salary (if salaried drivers) etc.

Views:
- Driver statement (period), current balance, ageing of shortfall.
- Fleet view: top debtors, collection rate per driver, per vehicle.

## 4. Driver management improvements

- Driver profile: Ghana Card, licence (class, expiry + reminders), guarantors, emergency contact, photos, documents, bank/MoMo details, employment type (remittance / work & pay / salaried / chauffeur).
- Onboarding checklist (documents collected, training, contract signed).
- Status: applicant → active → suspended → terminated (with reason, final settlement).
- Performance scorecard: remittance compliance %, incidents, fuel efficiency, telematics behaviour (harsh braking, speeding — V3), customer ratings for chauffeurs.
- Driver ↔ User: a driver may get an app login (role `Driver`, scope `own`) → sees only their vehicle, ledger, agreement, can submit remittance, fuel log, issue report, upload photos.
- Payroll-lite for salaried drivers/chauffeurs: monthly salary, allowances (per-trip/out-of-town), deductions → expense postings (no full payroll/tax).

## 5. Daily operations board

For fleet managers each morning:
- Vehicles out today / idle today (and why: no driver, maintenance, no remittance yesterday).
- Remittances due today vs received (live).
- Drivers with ≥ N days of shortfall.
- Expiring licences/documents this week.

## 6. API sketch

```
GET  /remittances?status&driverId&vehicleId&from&to&branchId
POST /remittances                        (submit / record)
POST /remittances/:id/approve | /reject
POST /remittances/generate-expected      (admin/job)
GET  /drivers/:id/ledger?from&to
GET  /drivers/:id/statement.pdf
POST /drivers/:id/adjustments            (advance, deduction, bonus — needs permission)
GET  /operations/board?date
```

## 7. Permissions

`remittances.view_own`, `remittances.view_all`, `remittances.submit`, `remittances.record`, `remittances.approve`, `drivers.ledger.view`, `drivers.ledger.adjust`, `drivers.manage`.

(Replaces today's `view:others-sales`, `view:sales-filter-by-driver` etc. with scope-based permissions — doc 16.)
