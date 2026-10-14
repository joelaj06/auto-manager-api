# 06 — Vehicle Records & Lifecycle

The vehicle is the hub of the product. Every module reads from and writes to the vehicle's timeline.

## 1. Problems today

- Status enum mismatch (schema vs TS type vs written values) — H9.
- Vehicle is never released after a rental; no status history.
- Unbounded embedded arrays duplicating other collections.
- `ownerId` (ref Company) is overwritten with a **driver id** on work-and-pay completion.
- Only one image, base64 upload; insurance is a sub-object with no reminders.
- No odometer, no documents, no assignment history.

## 2. Vehicle master record

Grouped fields (see doc 05 §2.3 for full list):

| Group | Fields |
|---|---|
| Identity | code, plateNumber, VIN, engine number, chassis, make, model, trim, year, colour, body type |
| Specs | fuel, transmission, engine cc, seats, doors, drive (2WD/4WD), tyre size, fuel tank capacity |
| Classification | vehicleClassId (rental), groupIds (e.g. "Uber fleet", "Kumasi buses"), usage, branchId, tags |
| Ownership | owned / financed (bank loan) / leased / consigned (dealer) / driver_owned (after W&P) |
| Financials | acquisition cost, acquisition date, depreciation method & useful life, current book value, residual value |
| Operational | status, currentOdometer, currentAssignment, location (last GPS), fuel level (last inspection) |
| Media | photos (gallery, primary), 360° optional |
| Custom fields | tenant-defined key/values (`customFields`) with a schema in organisation settings |

## 3. Lifecycle state machine

```
             ┌──────────── purchase ordered ────────────┐
             ▼                                          │
        [incoming] ──received──▶ [reconditioning] ──▶ [available] ◀───────────────┐
                                        ▲                │  │  │  │                │
                                        │       assign ──┘  │  │  └── list ──▶ [for_sale]──reserve──▶[reserved]──deliver──▶[sold]
                                        │                   │  │                    ▲                      │
                                 [in_maintenance] ◀─────────┘  └─ book ──▶ [reserved_rental]──checkout──▶[on_rent]──checkin──┘
                                        │                                                                 
                                 [assigned] (remittance / salary driver)                                   
                                 [on_workpay] ──complete──▶ [transferred]  (ownership → driver)
                                 [on_workpay] ──default──▶ [repossessed] ──▶ [reconditioning]
                       any ──▶ [accident / impounded / stolen] ──▶ [written_off] | back to flow
                       any ──▶ [retired / scrapped]
```

- Transitions are **only** done by domain methods (`vehicle.checkOutForRental(rentalId)`), never by `PATCH status`.
- Each transition writes `vehicle_status_history` (from, to, reason, ref).
- Guards: can't rent a vehicle with expired insurance/roadworthy (configurable: block / warn); can't assign a vehicle `in_maintenance`.
- Some states are *derived* from blocks: availability for a date range = no overlapping `vehicle_blocks`.

## 4. Documents & compliance

| Document | Typical expiry | Reminder default |
|---|---|---|
| Registration (DVLA) | — / renewal | — |
| Roadworthy certificate | 6–12 months | 30, 14, 3 days |
| Insurance (comprehensive / third-party) | 12 months | 30, 14, 3 days |
| Income-tax sticker / road levy | quarterly / annual | 14, 3 days |
| Commercial permit / DVLA commercial | annual | 30 days |
| Customs papers (imports) | — | — |
| Driver's licence (on driver) | varies | 60, 30 days |

Features:
- Upload scans/photos; OCR expiry date (later).
- **Compliance dashboard**: red/amber/green per vehicle; "vehicles that cannot legally operate today".
- Renewal creates an expense automatically (cost on the document) — optional.

## 5. Odometer & usage

- Readings from: manual entry, rental check-out/in, fuel logs, work orders, telematics.
- Validation: monotonic (reject lower values unless "odometer replaced" flag with reason).
- Derived: km/day, km per period, cost per km, fuel efficiency (km/l).
- Triggers maintenance due checks (doc 12).

## 6. Assignments (vehicle ↔ driver)

Replace `Driver.vehicleId` / `Vehicle.currentDriverId` with an **assignment history**:

- `vehicle_assignments` with start/end, odometer at both ends, terms (daily/weekly target for remittance), type.
- **Decision 9: one driver per vehicle at a time.** Partial unique indexes guarantee one open assignment per vehicle and per driver. No shift/multi-driver model.
- Handover checklist (mini inspection) on change of driver.
- Powers "who was driving on date X" (traffic fines, accidents).

## 7. Fuel management

- Fuel logs with litres, price, station, odometer, receipt photo.
- Fuel card integration (later).
- Anomaly detection: km/l far below vehicle baseline → flag (possible siphoning).
- Fuel logs post an expense automatically (category "Fuel").

## 8. Incidents

- Accidents, traffic offences, police impound, theft.
- Fields: date, location, driverId (auto from assignment), description, photos, police report no., third party details, insurance claim {claimNo, status, amountClaimed, amountSettled}, cost to company, charged to driver.
- Links to work orders and expenses.

## 9. Telematics / GPS (V3)

- Integrate providers (e.g. Teltonika via Flespi, Traccar, Cartrack-style APIs) via webhook ingestion → `telematics_positions` time-series collection.
- Features: live map, trip history, geofences (alert when vehicle leaves Accra), ignition-on hours (utilisation), over-speed alerts, odometer sync, remote immobilisation hook (for W&P defaults — legal review needed).
- Utilisation metric becomes accurate (engine hours vs idle).

## 10. Vehicle 360° page (API needs)

`GET /api/v1/vehicles/:id/overview` returns:
- Header: photo, plate, make/model/year, status, branch, current driver/renter.
- Compliance badges.
- KPIs (period selectable): revenue by source, costs by category, net profit, km, utilisation %, downtime days, cost/km.
- Timeline (paginated, merged): status changes, assignments, rentals, payments, work orders, expenses, documents, incidents, notes.

Backed by `daily_vehicle_stats` (doc 14) for KPIs and a union query over source collections (or an `activity` collection written by event handlers) for the timeline.

## 11. Depreciation & valuation

- Straight-line or declining-balance per vehicle (or per class default).
- Monthly job writes depreciation to ledger (doc 13) → true P&L per vehicle.
- Book value vs market value (dealer valuation) → informs sell-or-keep decisions.

## 12. Bulk operations

- CSV/Excel import of vehicles (template download, validation preview, commit).
- Bulk status change (e.g. move 10 cars to another branch).
- Export register.

## 13. Permissions (examples)

`vehicles.view`, `vehicles.create`, `vehicles.update`, `vehicles.delete`, `vehicles.change_status`, `vehicles.assign_driver`, `vehicles.documents.manage`, `vehicles.financials.view` (hide cost/profit from agents), `vehicles.import`.
