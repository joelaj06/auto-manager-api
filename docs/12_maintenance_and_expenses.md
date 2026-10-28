# 12 — Maintenance & Expenses

## Part A — Maintenance

> **Status (2026-10-28):** preventive maintenance (§2) is built (P6-1): service plans with templates, the most specific plan per vehicle, the due engine recomputed on every odometer reading and nightly, alerts to the branch's maintenance staff and the assigned driver, services recorded, and rentals warned of a service falling due; decisions 376–380. Work orders (§3, §5) are built (P6-2): lines, vendors, the vehicle off the road with its block and Work & Pay downtime, completion closing service tasks, damages and issues, and the cost posted with who pays; decisions 381–388. Parts (§4, basic) are built (P6-3): the catalogue with the models each part fits, stock per branch at average cost in the books, purchases, counts and transfers, parts issued to work orders on completion and reorder alerts; decisions 389–395. Incidents, insurance claims and fines are in docs/06 §8 (P6-4); KPIs (§6) follow in P6-5.

### 1. Today

Only `Vehicle.maintenanceRecords[]` (unused embed) and the expense module. No scheduling, no work orders.

### 2. Preventive maintenance (service schedules)

- **Service plans** with tasks triggered by **km and/or time**, whichever first: oil & filter every 5,000 km / 3 months; brake inspection 10,000 km; timing belt 60,000 km; tyre rotation; AC service; etc.
- Templates per make/model or vehicle class; tenant can customise.
- `service_due` recomputed on every odometer update and nightly → statuses `upcoming (within X km / Y days) → due → overdue`.
- Alerts to fleet manager + assigned driver; for rentals, warn if a booking would cross a due service.

### 3. Corrective maintenance & work orders

- Issue reporting (driver app: "brake noise", photo, voice note) → triage → work order.
- **Work order**: vehicle, type (preventive/corrective/accident/reconditioning/inspection), priority, status (`open → in_progress → awaiting_parts → completed / cancelled`), in-house mechanic or external vendor (workshop), odometer, lines (labour hours × rate, parts from stock or purchased, sublet), total, attachments, warranty flag.
- Opening a WO with "vehicle off-road" blocks the vehicle (`vehicle_blocks`, status `in_maintenance`) → downtime tracking.
- Completing a WO: updates odometer, closes due tasks, posts costs as expenses (or directly to ledger) linked to the WO.
- **Who pays**: company / driver (W&P or negligence) / customer (rental damage) / insurance → allocation of cost.

### 4. Parts & inventory (V2–V3)

- Parts catalogue (SKU, compatible models), stock per branch, moves (in from purchase, out to WO, adjustments), average cost, reorder alerts.
- Tyres tracked individually optional (serial, position, tread depth) — V3.

### 5. Vendors / workshops

- Vendor records (suppliers with type `workshop`), rates, ratings, turnaround times.
- Vendor invoices → payables.

### 6. Maintenance KPIs

- Maintenance cost per vehicle / per km / per month, by category.
- Downtime days & % availability.
- Preventive vs corrective ratio (higher preventive = healthier fleet).
- Mean time between failures (by vehicle model).
- Overdue services count.

## Part B — Expenses

### 7. Today

Expense { category, amount, status pending/approved/rejected, vehicle?, incurredBy, company } + categories (currently broken in tenant context — H1).

### 8. Enhancements

| Area | Proposal |
|---|---|
| Categories | Hierarchical (Vehicle → Fuel, Repairs, Insurance, Licensing, Tyres, Car wash, Tolls, Fines; Overhead → Rent, Utilities, Salaries, Internet, Marketing; Admin → Bank charges). System defaults seeded at provisioning; `type` drives where it appears in reports |
| Allocation | Link to vehicle, driver, branch, work order, rental, purchase, deal — multiple tags allowed; **split** an expense across vehicles (e.g. one insurance bill for 10 cars) |
| Approval workflow | Rules by amount/category/branch: e.g. < GHS 500 auto-approve; 500–5,000 branch manager; > 5,000 owner. Multi-step approvals recorded in `approvals[]` |
| States | draft → submitted → approved → paid (→ rejected / void). Separate *approved* from *paid* |
| Payment source | Cash (petty cash / till), bank, MoMo, card, **driver paid & to be reimbursed**, **deduct from driver** |
| Receipts | Photo upload mandatory above threshold; OCR amount/date (V3) |
| Recurring | Rent, insurance installments, tracker subscriptions → auto-generated drafts |
| Budgets | Monthly budget per category/branch/vehicle; variance alerts at 80% / 100% |
| Fuel | Fuel logs auto-create expenses (doc 06) |
| Reimbursements | Staff/driver out-of-pocket claims → approval → reimbursement payment |
| Petty cash | Cash sessions per branch with float, top-ups, expenses, end-of-day count (doc 13) |
| Duplicates | Warn on same amount + vehicle + date + category |
| Mass assignment | Only whitelisted fields; status changes only via approve/reject endpoints |

### 9. Expense API sketch

```
CRUD  /expenses                (draft/submit)
POST  /expenses/:id/submit | /approve | /reject | /mark-paid | /void
POST  /expenses/split          (one bill → many vehicles)
CRUD  /expense-categories      (tree)
CRUD  /expense-approval-rules
CRUD  /budgets
CRUD  /recurring-expenses
```

### 10. Permissions

`expenses.create`, `expenses.view_own|view_branch|view_all`, `expenses.approve` (+ limit amount on role), `expenses.pay`, `expenses.categories.manage`, `budgets.manage`, `maintenance.view`, `maintenance.work_orders.manage`, `maintenance.plans.manage`, `parts.manage`.
