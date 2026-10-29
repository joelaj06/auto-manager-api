import { describe, expect, it } from "vitest";
import { Appraisal, type AppraisalDetails } from "./Appraisal.js";

const now = new Date("2026-10-29T09:00:00Z");
const today = "2026-10-29";
const details: AppraisalDetails = {
  make: "Toyota",
  model: "Vitz",
  year: 2012,
  plateNumber: "gr 1234-12",
  vin: "abc123",
  colour: "Silver",
  mileage: 140_000,
  condition: "fair",
  findings: "Scratched rear bumper",
  valueMinor: 20_000_00,
  validUntil: "2026-11-12",
};
const record = (d: Partial<AppraisalDetails> = {}) =>
  Appraisal.record({
    ...details,
    ...d,
    id: "a1",
    number: "APR-1",
    branchId: "b1",
    leadId: null,
    customerId: "c1",
    appraisedBy: "u1",
    today,
    now,
  });

describe("Appraisal", () => {
  it("records the vehicle offered with its plate and VIN in capitals", () => {
    const a = record().snapshot();
    expect(a).toMatchObject({ status: "open", plateNumber: "GR 1234-12", vin: "ABC123" });
    expect(a.appraisedOn).toBe(today);
  });

  it("needs a value and a date not passed", () => {
    expect(() => record({ valueMinor: 0 })).toThrow(/value/i);
    expect(() => record({ validUntil: "2026-10-28" })).toThrow();
  });

  it("goes on one deal at a time and is used at the sale", () => {
    const a = record();
    a.attach("d1", today, now);
    expect(() => a.assertUsable(today, "d2")).toThrow(/another deal/);
    expect(() => a.decline("No thanks", now)).toThrow(/on a deal/);
    a.use("v9", now);
    expect(a.snapshot()).toMatchObject({ status: "used", vehicleId: "v9", dealId: "d1" });
    expect(() => a.assertUsable(today, "d1")).toThrow(/closed/);
  });

  it("is freed from a deal and declined with a reason", () => {
    const a = record();
    a.attach("d1", today, now);
    a.detach(now);
    expect(a.snapshot().dealId).toBeNull();
    expect(() => a.decline(" ", now)).toThrow(/why/);
    a.decline("Wanted more", now);
    expect(a.snapshot()).toMatchObject({ status: "declined", declinedReason: "Wanted more" });
  });

  it("runs out after its date", () => {
    expect(() => record().assertUsable("2026-11-13", "d1")).toThrow(/run out/);
  });
});
