# 14 — Reports & Analytics

> **Update 2026-10-30 (P8-1):** the report engine of §2 and §7 is implemented: definitions in code with described parameters and a permission, the catalogue filtered by permission (no plan entitlements), JSON answered at once and CSV, XLSX and PDF files built by a background job as the user who asked, kept 7 days with a short-lived download link and a ready notice, four jobs at once per business and two per user. `POST /reports/:id/run` takes `{ params, format }`; jobs are `/reports/jobs` (not report runs of other users). The catalogue of §3 is P8-2, scheduled reports and dashboards P8-3.

## 1. Today

Dashboard summary (sales, rentals, expenses, counts, revenue) + weekly sales in a month (with week-5 bug, H12). Totals are also returned as custom headers on lists (`_meta_total_sales` …).

## 2. Approach

| Layer | Purpose |
|---|---|
| **Live queries** | Small, indexed aggregations for lists & simple totals |
| **Read models / pre-aggregates** | `daily_vehicle_stats`, `daily_branch_stats`, `monthly_*` updated by event handlers + nightly rebuild job → fast dashboards and trends |
| **Report jobs** | Heavy/large reports generated asynchronously (queue) → file (PDF/XLSX/CSV) stored → download link + notification |
| **Scheduled reports** | Cron per tenant: "email me the weekly fleet report every Monday 7am" |

Report definitions live in code (`modules/reports/definitions/*.ts`): `{ id, title, params schema, permission, entitlement, query(params) → rows, columns, totals, chart? }`. One engine renders to JSON (UI), CSV, XLSX (`exceljs`), PDF (HTML template → Puppeteer/Playwright or `pdfmake`).

## 3. Report catalogue

### Executive / owner
| Report | Content |
|---|---|
| **Business overview** | Revenue by source (remittances, rentals, W&P, dealer sales), costs by category, net, cash in/out, vs previous period |
| **Vehicle P&L** ⭐ | Per vehicle: revenue by source − direct costs − depreciation − finance costs = profit; cost/km; ROI; payback months |
| **Fleet profitability ranking** | Best/worst vehicles, by model, by branch |
| **Cash flow** | Payments in/out by method/day; expected inflows (W&P schedule, rental balances, deal balances) |
| **Receivables ageing** | Customers, drivers (shortfall), W&P (PAR 7/30/60/90), corporate accounts |

### Fleet & operations
| Report | Content |
|---|---|
| Fleet register | All vehicles with status, branch, driver, documents, odometer |
| Utilisation | Days/hours working vs idle vs maintenance per vehicle/class |
| Compliance | Expiring/expired documents & licences |
| Fuel | Consumption, km/l, cost per km, anomalies |
| Odometer / mileage | km per vehicle per period |
| Incidents | Accidents, fines, claims |

### Drivers & remittances
| Report | Content |
|---|---|
| Remittance compliance | Expected vs received per driver/vehicle, collection rate |
| Driver ledger / statements | Balances, shortfalls, adjustments |
| Driver performance | Scorecard |

### Work & Pay
| Report | Content |
|---|---|
| Portfolio summary | Financed, collected, outstanding, completion % |
| Arrears / PAR | Overdue by bucket, by driver |
| Collections forecast | Expected next 7/30/90 days |
| Agreement statement | Per driver (PDF) |

### Rentals
| Report | Content |
|---|---|
| Bookings | By status, channel, customer, class |
| Utilisation & ADR | Per class, per branch |
| Revenue | By class, customer type, extras |
| Pickups/returns schedule | Operational sheet |
| Deposits held | Liability |
| Damages | Cost vs recovered |

### Dealership & purchases
| Report | Content |
|---|---|
| Stock valuation & ageing | Cost, asking, days in stock |
| Sales & gross profit | Per unit, per exec, per make, per source |
| Lead funnel | Conversion by stage/source/exec |
| Commissions | Per exec |
| Purchases & landed cost | Per vehicle / shipment, import pipeline status |
| Supplier payables | Ageing |

### Maintenance & expenses
| Report | Content |
|---|---|
| Expense summary | By category, vehicle, branch, period; budget vs actual |
| Maintenance cost | Per vehicle/model/km; preventive vs corrective |
| Downtime | Days off-road per vehicle |
| Service due/overdue | Upcoming |
| Approval queue / audit | Pending, approved by whom |

### Finance
Day book, receipts register, payments by method, cash session variance, tax report, ledger/trial balance export.

## 4. Dashboards (role-based)

- **Owner**: KPIs (revenue, profit, cash, overdue), revenue trend (12 months), top/bottom vehicles, alerts (documents, arrears, idle vehicles).
- **Fleet manager**: operations board (doc 09), compliance, service due, remittances today.
- **Rental agent**: today's pickups/returns, overdue returns, availability snapshot.
- **Sales exec**: my pipeline, follow-ups today, my commission MTD.
- **Accountant**: unreconciled payments, approvals pending, cash sessions open.

Dashboards are configurable widget lists per role (V3: per user).

## 5. Fix the current dashboard (quick wins)

- Use calendar weeks (ISO week or Mon–Sun) or days in month for charts; return the real number of buckets.
- Consistent date field per collection (business date, not `createdAt`).
- Include W&P collections in revenue; label "revenue" vs "cash collected" correctly.
- Serve from `daily_*` read models once they exist.

## 6. Filters & params (standard)

`from`, `to` (tenant timezone), `branchIds[]`, `vehicleIds[]`, `vehicleGroupIds[]`, `driverIds[]`, `customerIds[]`, `groupBy (day|week|month|vehicle|branch|category)`, `currency`, `compareTo (previous_period|same_period_last_year)`.

## 7. API sketch

```
GET  /reports                          (catalogue filtered by permission/entitlement)
POST /reports/:reportId/run            { params, format: json|csv|xlsx|pdf }  → sync (json, small) or job id
GET  /reports/jobs/:jobId              → status + download URL
CRUD /reports/schedules                { reportId, params, cron, recipients, format }
GET  /dashboards/:role
```

## 8. Performance notes

- All report queries must use indexes on `(branchId, date)` / `(vehicleId, date)`.
- Large exports streamed (cursor → CSV stream) to avoid memory blowups.
- Rate-limit heavy reports per tenant; queue concurrency per tenant to stop one tenant starving others.
- Consider Atlas read-preference `secondaryPreferred` for reports (staleness acceptable).
