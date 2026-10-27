# 07 — Car Rentals (Enhanced)

> **Status (2026-10-27):** pricing (§4) is built (P5-1): classes, rate plans with seasons, extras, zones, promo codes, holidays and `POST /rentals/quotes`; the rules as built are decisions 314–323. Availability (§3) is built (P5-2): `vehicle_blocks` with an exclusion constraint, class turnaround, holds, best-fit class allocation, manual blocks that can move class bookings, availability search and the calendar; decisions 324–331. The booking lifecycle (§2, §6 odometer and fuel, §7) is built (P5-3): bookings with events and charge lines, reservations that lapse, check-out and check-in moving the vehicle, extensions, late return and mileage at the booked rates, cancellation and no-show fees; decisions 332–341. Inspections and damages (§6) are built (P5-4): check-out and check-in inspections with checklist and photos by side, the ID check, the check-in vs check-out differences, the damage register with the renter's share kept in step as charges, refuelling and cleaning charges; decisions 342–351. Payments, deposits, invoices and renter accounts (§5, §8) are built (P5-5): booking payments and the class security deposit recorded through finance, the invoice issued at close, corporate customers on account with authorised drivers and credit limits, the blacklist and watchlist checked at booking, confirmation and check-out; decisions 352–361. The agreement (P5-6) follows.

## 1. What exists

`Rental { renter, vehicle, startDate, endDate, cost, totalAmount, amountPaid, balance, status(active/completed/canceled), extensions[], receiptNumber, dateReturned }` with CRUD + extend + remove extension.

### Gaps / bugs
- No reservation concept; vehicle is marked "Rented" at creation even for future dates (H10).
- No overlap check, no availability search.
- Vehicle never returned to `available` (H9).
- Price is typed in manually; no rate plans, no extras, no deposits, no late fees.
- `amountPaid` is a mutable number — no payment history, no receipts (H11).
- `date` default bug (H8).
- No check-out/check-in inspection (fuel, mileage, damages).
- No contract/agreement document.
- Customer KYC limited; no blacklist.

## 2. Target booking lifecycle

```
quote ─▶ reserved ─▶ confirmed ─▶ checked_out ─▶ returned ─▶ closed
  │          │            │             │             │
  └──────────┴────────────┴─▶ cancelled │             └─▶ (disputed: damages/claims pending)
                          └─▶ no_show   └─▶ extended (stays checked_out, new return time)
```

| State | Meaning | Side effects |
|---|---|---|
| quote | Price calculated, nothing held | — |
| reserved | Vehicle class (or specific vehicle) held, maybe unpaid; auto-expires after N hours | `vehicle_blocks` (soft hold) |
| confirmed | Deposit/prepayment received or corporate approved | block becomes hard |
| checked_out | Keys handed over; check-out inspection, odometer, fuel, contract signed | vehicle → `on_rent` |
| returned | Vehicle back; check-in inspection; charges computed (late, km, fuel, damage) | vehicle → `available` or `in_maintenance` / cleaning |
| closed | Balance settled, deposit released/applied | invoice paid |
| cancelled / no_show | Cancellation policy fee applied | block released |

## 3. Availability engine

- `vehicle_blocks { vehicleId, from, to, reason, refType, refId }` is the single source of truth for "busy" — rentals, maintenance, sale holds, transfers all create blocks.
- Overlap query: `{ vehicleId, from: { $lt: reqTo }, to: { $gt: reqFrom } }` with index `{ vehicleId: 1, from: 1, to: 1 }`.
- Race-safe booking: inside a transaction, re-check overlap then insert block (or use a per-vehicle lock document with `findOneAndUpdate`).
- Buffer time between rentals (cleaning) configurable per class.
- **Book by class** (common practice): reserve "SUV", assign a specific vehicle at check-out. Capacity per class per day = vehicles in class − blocks.
- Endpoints:
  - `GET /rentals/availability?from&to&classId&branchId` → available vehicles / classes with price quote.
  - `GET /rentals/calendar?from&to` → Gantt-style data (vehicle rows, booking bars).

## 4. Pricing

- **Rate plans** per vehicle class (or per vehicle): hourly, daily, weekly, monthly; weekend/holiday rates; seasonal overrides.
- Long-term discounts (≥7 days uses weekly rate, ≥28 monthly).
- Mileage: unlimited or N km/day included + extra km price.
- **Chauffeur** (driver included): daily driver fee + driver allowance (overnight/out-of-town), assign a driver from `drivers`.
- **Out-of-town surcharge** / delivery & collection fee by zone.
- Extras: child seat, GPS, Wi-Fi, additional driver, insurance upgrade (CDW / super CDW).
- Promo codes & corporate negotiated rates.
- Taxes (VAT/NHIL/GETFund levy if tenant is VAT-registered) — configurable tax rules.
- `PricingService.quote(input) → { lines[], totals }` pure function, heavily unit-tested; snapshot stored on the booking.

## 5. Deposits & payments

- Security deposit (held, not revenue) — tracked separately: `held → partially_applied → released`.
- Payments via finance module (doc 13): cash, MoMo, card, bank transfer; multiple payments per booking.
- Payment link (Paystack) sent via SMS/WhatsApp for reservation prepayment.
- Balance = invoice total − allocations; never stored as a free-form field.
- Corporate customers: invoice on account, payment terms, credit limit check.

## 6. Check-out & check-in

Check-out:
- Verify customer ID + licence (expiry ≥ return date), capture photos.
- Inspection: odometer, fuel level, checklist, damage map with photos (front/back/left/right/interior).
- Generate **rental agreement PDF** (tenant template with T&Cs), customer signs on tablet (signature image) or via link.

Check-in:
- Odometer, fuel, new damages vs check-out (diff), late return computation, cleaning fee.
- Auto-generated charge lines: `excess_km`, `fuel_refill`, `late_return`, `damage` (estimate; final from work order).
- Damage → `damages` record → optional work order → charge customer / insurance claim / deduct deposit.

## 7. Extensions (improve existing)

- Extension = change of return time with re-quote for the extra period (rate plan), availability re-check (next booking may conflict!).
- Stored as booking events + additional invoice lines, not a separate mutable balance.
- Customer-initiated extension request via link/WhatsApp → agent approves.

## 8. Customers & risk

- KYC: Ghana Card / passport, driver's licence (number, class, expiry, photo), proof of address, selfie (optional).
- Minimum age & licence years rule per class.
- Blacklist / watchlist with reason; warning on booking.
- Customer history: bookings, spend, incidents, outstanding balance.
- Corporate accounts with multiple authorised drivers.

## 9. Channels

- Back-office booking (agent).
- Public booking widget / API for tenant website (V3), with availability + price + Paystack prepayment.
- Booking via WhatsApp link (form) → creates `quote/reserved`.

## 10. Notifications

- Booking confirmation (SMS/email with summary + payment link).
- Pickup reminder (T-24h), return reminder (T-2h), overdue return alert (to agent + customer).
- Receipt on each payment; final invoice on close.

## 11. Rental reports

- Utilisation by vehicle/class (`booked hours / available hours`).
- Revenue by class, branch, channel, customer type.
- Average daily rate (ADR), RevPAV (revenue per available vehicle).
- Outstanding balances & deposits held.
- Damage cost vs recovered.
- Upcoming pickups/returns board (operations).

## 12. API sketch (v1)

```
POST   /rentals/quotes                       → price quote (no persistence or persisted as quote)
POST   /rentals                              → create reservation
GET    /rentals?status&from&to&customerId&vehicleId&branchId
GET    /rentals/:id
PATCH  /rentals/:id                          → edit while reserved/confirmed (re-quote)
POST   /rentals/:id/confirm
POST   /rentals/:id/checkout                 { vehicleId, odometer, fuel, inspection, signature }
POST   /rentals/:id/extend                   { newReturnAt }
POST   /rentals/:id/checkin                  { odometer, fuel, inspection, damages[] }
POST   /rentals/:id/close
POST   /rentals/:id/cancel                   { reason }
GET    /rentals/:id/contract.pdf
GET    /rentals/availability
GET    /rentals/calendar
CRUD   /rental-rate-plans, /vehicle-classes, /rental-extras
```

## 13. Permissions

`rentals.view`, `rentals.create`, `rentals.update`, `rentals.checkout`, `rentals.checkin`, `rentals.cancel`, `rentals.discount.apply` (with max % per role), `rentals.price.override`, `rentals.deposit.release`, `rentals.rate_plans.manage`.
