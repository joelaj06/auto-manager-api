# 11 — Vehicle Purchases & Procurement

> **Update 2026-10-28 (P7-2):** §5 is implemented. A supplier's bills are its approved, unpaid expenses, due after its payment terms. Aged payables, open bills and the supplier statement come from the payables account. One supplier payment can settle several bills with optional withholding tax (2230 Withholding tax payable) and the exchange difference. Permissions are `finance.payables.view` and `suppliers.payments.make` (decisions 415–420). Purchases (§3–4, §6) follow in P7-3.

> **Update 2026-10-28 (P7-3):** §2 (local, import, auction), §3, §4, §6 and §9 are implemented. Ordering turns the vehicle prices into bills. Cost components are expenses in their own currency, capitalised to 1500 Vehicles. Landed cost is shared by value or equally. The import timeline has ETA and demurrage alerts, and papers are attached. Receiving creates the vehicle at its landed cost, and late costs update it. Trade-ins, consignment, financed purchases, repossessions, the duty estimator and initial inspection at receiving are not built yet (decisions 421–428).

Covers how vehicles **enter** the business — for every segment (fleet owners buying cars for drivers, rental firms growing fleet, dealers buying stock).

## 1. Why it matters

Today a vehicle is just "created" — its cost is unknown, so there is no ROI / payback / profit per vehicle. A purchase record makes acquisition cost (and therefore every profitability report) real.

## 2. Purchase types

| Type | Typical flow |
|---|---|
| **Local purchase** | Buy from a dealer/individual; pay; receive; register |
| **Import** (very common: US/Canada/Korea/Europe "home-used") | Buy at auction (Copart/IAAI/Manheim) or from exporter → ship → arrive at Tema port → customs duty & clearing → transport → register (DVLA) |
| **Auction (local)** | Bid, win, pay, collect |
| **Trade-in** | Created from a dealer deal (doc 10) |
| **Consignment** | Not purchased — owned by consignor, tracked for payout |
| **Financed purchase** | Bank/asset finance: loan principal, interest, repayment schedule (track liability) |
| **Repossession** | From Work & Pay default (doc 08) — re-entry at book value |

## 3. Purchase record

- Header: supplier, type, reference (auction lot / invoice no.), currency, status, ordered/expected/received dates, branch.
- Lines: one per vehicle (VIN, make/model/year, price) — a container may hold several cars.
- **Cost components** (each with amount, currency, FX rate, payee/supplier, paid status):
  - vehicle price, auction fees, inland (origin) transport, shipping/freight, marine insurance,
  - port charges, customs import duty, VAT/levies, clearing agent fee, DVLA registration, number plates,
  - local transport/towing, initial repairs (or via reconditioning work order), other.
- **Landed cost per vehicle** = sum of direct costs + allocated shared costs (container shipping split by value / equal / CBM).
- Documents: purchase invoice, bill of lading, title, customs declaration, duty receipt, DVLA docs.

## 4. Import tracking (status timeline)

```
ordered → paid → picked_up (origin) → at_origin_port → shipped (vessel, ETA) → arrived_tema
       → under_clearing → duty_paid → released → in_transit_local → received → registered
```
- ETA reminders, demurrage risk alerts (days at port vs free days), notes per stage.
- Optionally a "duty estimator" (needs current GRA/ICUMS rates — manual input table first).

## 5. Supplier management

- Suppliers (shared with maintenance vendors, parts suppliers, fuel stations, insurers, clearing agents).
- Supplier balances (payables), payment history, documents.
- Supplier payments through finance module (`payments.direction = out`), multi-currency with FX gain/loss tracking (simple: record base-currency equivalent at payment time).

## 6. Receiving

- Receiving a purchase line creates (or activates) a **vehicle** in the registry with `acquisition { purchaseId, date, landedCostMinor }`, status `reconditioning` or `available`, usage set by the receiving user (fleet / rental / stock).
- Initial inspection (doc 06) recorded at receiving.
- Late-arriving costs (e.g. duty paid after receiving) update landed cost → recalculated on vehicle and in reports.

## 7. Fleet procurement planning (V3)

- Requests/approvals: "Branch manager requests 3 more SUVs" → owner approves budget → purchase.
- Replacement planning: vehicles approaching end of useful life / high cost-per-km flagged for replacement.
- Buy vs lease comparison calculator.

## 8. Financing of purchases

- Record bank/asset loans per vehicle (or per batch): principal, interest rate, term, repayment schedule → liability; repayments as outgoing payments.
- Reports show vehicle profit **after finance costs**.

## 9. API sketch

```
CRUD  /purchases
POST  /purchases/:id/costs              (add cost component)
POST  /purchases/:id/status             (advance import stage)
POST  /purchases/:id/lines/:lineId/receive   → creates vehicle
GET   /purchases/:id/landed-cost
CRUD  /suppliers
GET   /suppliers/:id/statement
```

## 10. Permissions

`purchases.view`, `purchases.create`, `purchases.approve`, `purchases.costs.manage`, `purchases.receive`, `suppliers.manage`, `suppliers.payments.make`.
