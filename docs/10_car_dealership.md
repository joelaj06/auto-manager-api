# 10 — Car Dealership

New module for tenants who **sell** vehicles (new, used, imported "home-used"/"foreign-used", trade-ins, consignment).

## 1. Core idea

A dealer's inventory unit **is a vehicle in the shared registry** with `usage = stock`. Everything that happens to it — purchase cost (doc 11), reconditioning (doc 12), listing, test drives, sale — accumulates onto that one record, giving **gross profit per unit**:

```
Gross profit = sale price − discounts + fees charged
             − (landed cost + reconditioning + holding costs + commission + sale-related expenses)
```

## 2. Inventory management

- Stock list with filters: make/model/year/price/status/days-in-stock/branch/source.
- Stock statuses: `incoming → reconditioning → ready → listed → reserved → sold → delivered` (+ `withdrawn`, `returned`).
- **Days in stock / ageing buckets** (0–30, 31–60, 61–90, 90+) — key dealer KPI; holding cost accrual (e.g. GHS x/day).
- Pricing: cost, asking price, minimum price (hidden from junior sales), margin %, price history (reductions logged).
- Consignment stock: owned by a third party; dealer earns commission or margin; payout to consignor on sale.
- Multi-branch stock transfers with transfer records.
- Vehicle spec sheet + photo gallery + condition report → shareable listing page / PDF.

## 3. Listings & marketing (V2–V3)

- Public stock feed per tenant (JSON/website widget).
- Export to classifieds (Jiji, Tonaton, Facebook Marketplace via catalogue CSV) — manual export first.
- Share-to-WhatsApp card (image + price + link).
- Track which channel generated the lead.

## 4. CRM: leads & pipeline

- Lead capture: walk-in, phone, WhatsApp, website form, social, referral.
- Pipeline stages: new → contacted → appointment/test drive → negotiation → won / lost (reason).
- Assignment to sales exec; round-robin option.
- Follow-up tasks & reminders; activity log (calls, messages, visits).
- Matching: "notify me when a 2018 Corolla under GHS 150k arrives" → saved search → auto alert when stock arrives.
- Conversion metrics per exec and per source.

## 5. Test drives

- Book slot, verify licence (photo), odometer out/in, accompanied by staff, signed waiver.
- Blocks the vehicle in the shared `vehicle_blocks` (so rentals don't double-book a car that's also rentable).

## 6. Quotes & deals

- **Quote**: vehicle, price, discount, add-ons (registration, tint, tracker, warranty, insurance), trade-in valuation, financing option, validity date → PDF.
- **Deal (sale)**:
  - reserve with deposit (vehicle → `reserved`, hold expiry),
  - payments (multiple, mixed methods) via finance module,
  - financing: cash / bank loan (track lender, approval, disbursement) / in-house installments (**reuse Work & Pay engine** with customer instead of driver) ,
  - documents: sales agreement, invoice, receipt, delivery note, DVLA transfer checklist, customs docs handed over,
  - delivery: date, odometer, handover checklist, photos,
  - post-sale: warranty period, free service vouchers, follow-up survey.
- On delivery: vehicle `sold`, ledger: revenue, COGS (landed + reconditioning), commission payable.

## 7. Trade-ins

- Appraisal form (condition, mileage, photos, valuation, appraiser).
- Trade-in value applied as payment on the deal (allocation type `offset`).
- Creates a new stock vehicle with acquisition cost = trade-in value (purchase source `trade_in`).

## 8. Commissions

- Rules: % of gross profit / % of price / flat per unit; tiers by monthly volume; split between execs.
- Commission accrues on delivery, payable after full payment received; clawback on cancellation.
- Commission statement per exec per month.

## 9. After-sales (optional V3)

- Warranty claims tracking.
- Service bookings for sold vehicles (if dealer has workshop) → reuses maintenance work orders with external customer.

## 10. Dealer reports

- Stock value at cost, ageing report, units sold, revenue, gross profit per unit / per make / per exec / per source.
- Lead funnel & conversion rates.
- Price reductions report, aged stock alert.
- Cash collected vs outstanding on deals.

## 11. API sketch

```
GET/POST   /dealer/stock                      (vehicles where usage=stock, with pricing)
PATCH      /dealer/stock/:vehicleId/pricing
POST       /dealer/stock/:vehicleId/list | /withdraw | /transfer
CRUD       /dealer/leads, /dealer/leads/:id/activities
POST       /dealer/test-drives
CRUD       /dealer/quotes  + GET /dealer/quotes/:id.pdf
CRUD       /dealer/deals
POST       /dealer/deals/:id/reserve | /deliver | /cancel
POST       /dealer/appraisals                (trade-in)
GET        /dealer/commissions?userId&period
```

## 12. Permissions

`dealer.stock.view`, `dealer.stock.cost.view` (hide cost/min price), `dealer.stock.price.manage`, `dealer.leads.view_own|view_all`, `dealer.deals.create`, `dealer.deals.discount` (cap per role), `dealer.deals.approve` (below min price), `dealer.deals.deliver`, `dealer.commissions.view|manage`.
