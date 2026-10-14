# 08 — Work & Pay (Hire Purchase)

"Work & Pay": the owner buys a vehicle, hands it to a driver who works with it and pays it off in installments (often ~2× vehicle value over 2–4 years). On completion, ownership transfers to the driver.

## 1. What exists

- Agreement: vehicle price × multiplier (or final price) / periods → installment (weekly/monthly).
- Payments recorded with `amount ≥ installment`; agreement totals mutated.
- Completion → vehicle `ownerId = driverId`, status `Sold`.

### Bugs (doc 01)
H2 (transaction on wrong connection), H3 (ownership transfer never fires), H4 (final payment impossible), H5, H6 (recordedBy lost, createdBy = company id), H7 (vehicle unique forever). Permissions commented out on routes. Only one agreement per driver returned.

### Missing concepts
No due dates / schedule, no arrears, no grace period, no penalties, no deposit, no partial or advance payments, no restructuring, no default/repossession flow, no guarantors, no statement, no reminders.

## 2. Agreement model (v2)

| Field | Notes |
|---|---|
| vehicleValue | Cost/book value at agreement start |
| pricing | `multiplier` (e.g. 2.0) **or** `markupPercent` **or** `flatTotal` |
| deposit | Upfront payment (reduces financed amount) |
| totalPayable | value × multiplier − deposit (or explicit) |
| frequency | daily / weekly / monthly (daily is common for taxis) |
| termPeriods | derived from duration or set explicitly |
| installment | `totalPayable / termPeriods` with **remainder on last installment** (not ceil every period) |
| startDate, firstDueDate | e.g. first due 7 days after handover |
| workingDays | for daily frequency: skip Sundays/holidays (tenant holiday calendar) |
| graceDays | before an installment is "overdue" |
| penaltyRule | none / flat per overdue installment / % of overdue amount / daily accrual; cap |
| defaultRule | N consecutive overdue installments or overdue ≥ X → `defaulted` |
| guarantors | name, phone, ID, relationship, signed form |
| documents | signed contract PDF, driver ID, guarantor IDs |
| maintenanceResponsibility | driver / owner / shared (affects which expenses are charged to driver) |
| insuranceResponsibility | driver / owner |

## 3. Schedule generation

On activation, generate `workpay_schedule` rows (seq, dueDate, amount). Example: GHS 120,000 over 3 years weekly → 156 rows of GHS 769.23 with the last absorbing rounding.

Schedule status per row: `upcoming → due → (partially_paid) → paid | overdue | waived`.

A daily job (per tenant timezone, 00:30):
- marks rows `due` / `overdue` (after grace),
- applies penalties,
- recomputes agreement aggregates (`overdueMinor`, `daysInArrears`, `nextDue`),
- transitions agreement `active ↔ in_arrears → defaulted`,
- emits `workpay.installmentDue`, `workpay.installmentOverdue`, `workpay.defaulted` events.

## 4. Payments & allocation

- Payments come from the finance module (`payments`), any amount (partial, exact, advance, lump sum).
- **Allocation policy** (configurable): penalties first → oldest overdue → current due → future (prepayment). Or "reduce term" vs "reduce installment" for large prepayments.
- Allocation records (`payment_allocations`) make every cedi traceable to installments.
- Reversal of a payment (bounced/mistaken MoMo) re-opens allocations.
- Driver can pay via MoMo payment link / USSD collection → webhook → auto-allocate → SMS receipt with new balance.

Fixes H4 by design: there is no "minimum = installment" rule; the schedule decides what's overdue.

## 5. Agreement lifecycle

```
draft ─sign─▶ active ⇄ in_arrears ─▶ defaulted ─▶ repossessed ─▶ (vehicle back to reconditioning / resale)
                 │                       │
                 │                       └─▶ restructured (new schedule, old one closed) ─▶ active
                 ├─▶ completed ─▶ ownership_transferred
                 └─▶ terminated (mutual / death / accident write-off) with settlement figure
```

- **Early settlement**: quote payoff amount (optionally with discount on remaining markup).
- **Restructure**: pause (e.g. vehicle in workshop 2 weeks → payment holiday, extend term), change frequency, reschedule arrears.
- **Vehicle downtime** linkage: if vehicle is `in_maintenance` due to owner-responsibility fault, auto-suggest payment holiday.
- **Completion**: all rows paid → `completed` → system generates the **transfer letter of agreement, to be signed by both owner and driver** ([24](24_documents_and_esignatures.md)) → once fully signed: vehicle `ownership = driver_owned`, `status = transferred`, removed from active fleet KPIs; ledger posts disposal (doc 13). DVLA change-of-ownership is tracked as a checklist item.
- **Repossession**: record date, condition, odometer, outstanding at repossession; settlement rules (refund policy) configurable; vehicle re-enters stock.

Remove any global uniqueness on `vehicle_id`; instead a partial unique index on `(tenant_id, vehicle_id)` where `status IN ('active','in_arrears','defaulted')`.

> Decision 6: **all** cases above (arrears, penalties, grace, restructure, early settlement, default, repossession, completion/transfer) are in scope.

## 6. Driver-facing features

- Statement: paid to date, outstanding, overdue, next due, % complete, schedule list, payment history.
- Pay now (MoMo link).
- Notifications: due tomorrow, overdue, payment received, milestone (50% paid 🎉), completion.
- Shareable PDF statement.

## 7. Owner-facing features

- Portfolio dashboard: total financed, collected, outstanding, overdue (PAR — portfolio at risk 7/30/60/90 days), expected collections next 7/30 days, collection rate %.
- Arrears list with call/SMS actions and promise-to-pay notes.
- Agreement profitability: total collected − vehicle cost − owner-paid expenses.
- Agreement simulator: try price/multiplier/term/frequency combos before signing.

## 8. Interaction with other modules

- **Remittances**: some tenants run W&P drivers *also* paying a daily remittance; or the W&P installment *is* the remittance. Support both: assignment type `workpay` with optional remittance target.
- **Expenses**: expenses on a W&P vehicle flagged `chargeToDriver` add to the driver's balance (separate from installments, or capitalised into agreement — configurable).
- **Vehicles**: status `on_workpay`; maintenance due reminders go to the driver too.

## 9. API sketch

```
POST /workpay/agreements/simulate
POST /workpay/agreements                (draft)
POST /workpay/agreements/:id/activate   (generates schedule)
GET  /workpay/agreements?status&driverId&vehicleId&inArrears=true
GET  /workpay/agreements/:id            (with aggregates)
GET  /workpay/agreements/:id/schedule
GET  /workpay/agreements/:id/statement(.pdf)
POST /workpay/agreements/:id/payments   (shortcut → finance payment + allocation)
POST /workpay/agreements/:id/restructure
POST /workpay/agreements/:id/payoff-quote
POST /workpay/agreements/:id/terminate | /repossess | /complete
POST /workpay/schedule/:rowId/waive     (penalty or installment, with reason)
```

## 10. Permissions

`workpay.view`, `workpay.create`, `workpay.activate`, `workpay.payment.record`, `workpay.penalty.waive`, `workpay.restructure`, `workpay.terminate`, `workpay.settings.manage`.

## 11. Legal / compliance notes (to verify)

- Hire-purchase agreements may be regulated (consumer credit / Bank of Ghana rules for credit providers). Keep agreement templates tenant-editable and store signed versions immutably.
- Remote immobilisation on default may have legal constraints — keep as an optional integration, owner-triggered, audited.
