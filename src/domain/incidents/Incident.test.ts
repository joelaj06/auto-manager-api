import { describe, expect, it } from "vitest";
import { fuelAnomaly } from "../expenses/ExpenseRules.js";
import { Incident, IncidentRuleError, InsuranceClaim, TrafficOffence } from "./Incident.js";

const now = new Date("2026-10-28T08:00:00Z");

const incident = () =>
  Incident.report({
    id: "i1",
    number: "INC-2026-000001",
    vehicleId: "v1",
    branchId: "b1",
    driverId: "d1",
    type: "accident",
    severity: "major",
    occurredAt: new Date("2026-10-27T18:00:00Z"),
    location: " Tema motorway ",
    description: " Rear-ended at the toll ",
    injuries: false,
    policeReportNo: " ",
    policeStation: null,
    thirdParties: [
      {
        name: " K. Mensah ",
        phone: null,
        plateNumber: "GR 1-24",
        insurer: null,
        policyNo: null,
        notes: null,
      },
    ],
    issueId: null,
    damageId: null,
    createdBy: "u1",
    now,
  });

const claim = () =>
  InsuranceClaim.submit({
    id: "c1",
    incidentId: "i1",
    insurerId: "s1",
    policyNo: "POL-1",
    claimNo: null,
    claimedMinor: 500_000,
    excessMinor: 50_000,
    submittedOn: "2026-10-28",
    notes: null,
    createdBy: "u1",
    now,
  });

const offence = (driverId: string | null = "d1", fineMinor = 20_000) =>
  TrafficOffence.record({
    id: "o1",
    vehicleId: "v1",
    branchId: "b1",
    driverId,
    type: "speeding",
    offenceAt: new Date("2026-10-26T10:00:00Z"),
    location: null,
    authority: " MTTD ",
    noticeRef: "N-1",
    fineMinor,
    dueOn: "2026-11-10",
    driverPays: true,
    notes: null,
    createdBy: "u1",
    now,
  });

describe("Incident", () => {
  it("trims what was reported and is open", () => {
    const s = incident().snapshot();
    expect(s.status).toBe("open");
    expect(s.location).toBe("Tema motorway");
    expect(s.description).toBe("Rear-ended at the toll");
    expect(s.policeReportNo).toBeNull();
    expect(s.thirdParties[0]!.name).toBe("K. Mensah");
  });

  it("refuses an incident in the future", () => {
    const i = incident();
    expect(() => i.change({ occurredAt: new Date("2026-10-29T08:00:00Z") }, now)).toThrow(
      IncidentRuleError,
    );
  });

  it("closes with an outcome, refuses changes until reopened", () => {
    const i = incident();
    i.movedVehicle("accident", "assigned", now);
    expect(() => i.close(" ", "u1", now)).toThrow(IncidentRuleError);
    i.close("Repaired and back on the road", "u1", now);
    expect(i.snapshot()).toMatchObject({
      status: "closed",
      closedBy: "u1",
      statusBefore: "assigned",
    });
    expect(() => i.change({ severity: "minor" }, now)).toThrow(/reopen/);
    i.reopen(now);
    expect(i.snapshot()).toMatchObject({ status: "open", closedAt: null });
  });
});

describe("InsuranceClaim", () => {
  it("expects the claim less the excess until approved", () => {
    const c = claim();
    expect(c.expectedMinor()).toBe(450_000);
    c.approve(400_000, " CL-9 ", now);
    expect(c.expectedMinor()).toBe(400_000);
    expect(c.snapshot().claimNo).toBe("CL-9");
  });

  it("refuses an excess at or above the claim and approving more than claimed", () => {
    expect(() =>
      InsuranceClaim.submit({ ...claim().snapshot(), excessMinor: 500_000, createdBy: "u1", now }),
    ).toThrow(/excess/);
    expect(() => claim().approve(600_000, null, now)).toThrow(/more than was claimed/);
  });

  it("settles from submitted or approved, not after a rejection", () => {
    const c = claim();
    c.settle(
      { amountMinor: 300_000, on: "2026-11-01", method: "bank_transfer", reference: null },
      now,
    );
    expect(c.snapshot()).toMatchObject({
      status: "settled",
      settledMinor: 300_000,
      approvedMinor: 300_000,
    });
    const r = claim();
    r.reject("Driver was unlicensed", now);
    expect(() =>
      r.settle({ amountMinor: 1, on: "2026-11-01", method: "momo", reference: null }, now),
    ).toThrow(/rejected/);
    expect(() => r.withdraw("No longer", now)).toThrow(/rejected/);
  });
});

describe("TrafficOffence", () => {
  it("is contested, then paid by the driver", () => {
    const o = offence();
    expect(o.snapshot().authority).toBe("MTTD");
    o.contest(now);
    expect(() => o.contest(now)).toThrow(IncidentRuleError);
    o.paid("driver", "2026-10-30", null, now);
    expect(o.snapshot()).toMatchObject({ status: "paid", paidBy: "driver", paidOn: "2026-10-30" });
    expect(() => o.waive("Too late", now)).toThrow(/paid/);
  });

  it("cannot be paid by a driver it does not name or without a fine", () => {
    expect(() => offence(null).paid("driver", "2026-10-30", null, now)).toThrow(/No driver/);
    expect(() => offence("d1", 0).paid("business", "2026-10-30", "e1", now)).toThrow(/no fine/);
  });

  it("is waived with a note kept", () => {
    const o = offence();
    o.waive("Notice withdrawn by MTTD", now);
    expect(o.snapshot()).toMatchObject({ status: "waived", notes: "Notice withdrawn by MTTD" });
  });
});

describe("fuelAnomaly", () => {
  const fill = (id: string, odometer: number, litres: number, fullTank = true) => ({
    id,
    odometer,
    litres,
    fullTank,
  });
  // ~10 km/L usually
  const history = [
    fill("f0", 10_000, 40),
    fill("f1", 10_400, 40),
    fill("f2", 10_800, 40),
    fill("f3", 11_200, 40),
  ];

  it("passes a normal fill and the first full fill", () => {
    expect(fuelAnomaly([...history, fill("f4", 11_600, 40)], "f4")).toBeNull();
    expect(fuelAnomaly([fill("a", 100, 40)], "a")).toBeNull();
  });

  it("flags a fill far below the vehicle's usual km per litre", () => {
    expect(fuelAnomaly([...history, fill("f4", 11_400, 40)], "f4")).toEqual({
      kind: "low_efficiency",
      distance: 200,
      litres: 40,
      kmPerLitre: 5,
      baseline: 10,
    });
  });

  it("flags litres put in with no km since the last full fill, partial fills included", () => {
    expect(
      fuelAnomaly([...history, fill("p", 11_200, 10, false), fill("f4", 11_200, 30)], "f4"),
    ).toMatchObject({ kind: "no_distance", distance: 0, litres: 40 });
  });

  it("ignores a partial fill", () => {
    expect(fuelAnomaly([...history, fill("p", 11_200, 30, false)], "p")).toBeNull();
  });
});
