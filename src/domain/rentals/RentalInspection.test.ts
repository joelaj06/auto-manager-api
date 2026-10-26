import { describe, expect, it } from "vitest";
import {
  differences,
  inspect,
  quartersMissing,
  RentalInspectionError,
  type ChecklistAnswer,
  type InspectionPhoto,
  type InspectionStage,
} from "./RentalInspection.js";
import { VehicleDamage } from "./VehicleDamage.js";

const items = [
  { key: "spare_tyre", label: "Spare tyre" },
  { key: "clean", label: "Clean inside and out" },
];
const allOk: ChecklistAnswer[] = [
  { key: "spare_tyre", ok: true },
  { key: "clean", ok: true },
];
const sides = (prefix: string): InspectionPhoto[] =>
  (["front", "back", "left", "right", "interior"] as const).map((view) => ({
    fileId: `${prefix}-${view}`,
    view,
  }));

const at = new Date("2027-04-10T09:00:00Z");
const record = (stage: InspectionStage, overrides: Partial<Parameters<typeof inspect>[0]> = {}) =>
  inspect({
    id: stage,
    bookingId: "b1",
    stage,
    vehicleId: "v1",
    odometer: 1_000,
    fuel: "full",
    items,
    answers: allOk,
    requiredViews: ["front", "back", "left", "right", "interior"],
    photos: sides(stage),
    idChecked: stage === "check_out",
    inspectedBy: "u1",
    inspectedAt: at,
    ...overrides,
  });

describe("an inspection", () => {
  it("needs the ID seen at check-out, every item answered and every side photographed", () => {
    expect(() => record("check_out", { idChecked: false })).toThrow("ID and driving licence");
    expect(() => record("check_out", { answers: [allOk[0]!] })).toThrow(
      "missing: Clean inside and out",
    );
    expect(() =>
      record("check_out", { answers: [...allOk, { key: "sunroof", ok: true }] }),
    ).toThrow('Unknown inspection item "sunroof"');
    expect(() => record("check_out", { photos: sides("x").slice(0, 3) })).toThrow(
      "Photograph the right, interior of the vehicle",
    );
    expect(() =>
      record("check_out", { photos: [...sides("x"), { fileId: "x-front", view: "other" }] }),
    ).toThrow("Each photo is used once");
    const ok = record("check_out", {
      answers: [{ key: "spare_tyre", ok: false, note: "  Flat  " }, allOk[1]!],
    });
    expect(ok.checklist).toEqual([
      { key: "spare_tyre", label: "Spare tyre", ok: false, note: "Flat" },
      { key: "clean", label: "Clean inside and out", ok: true, note: null },
    ]);
    expect(record("check_in").idChecked).toBe(false);
  });

  it("compares check-in with check-out", () => {
    const out = record("check_out", {
      answers: [{ key: "spare_tyre", ok: false }, allOk[1]!],
    });
    const back = record("check_in", {
      odometer: 1_420,
      fuel: "quarter",
      answers: [
        { key: "spare_tyre", ok: false },
        { key: "clean", ok: false, note: "Sand everywhere" },
      ],
      photos: [...sides("in"), { fileId: "in-scratch", view: "other" }],
    });
    const diff = differences(out, back);
    expect(diff).toMatchObject({
      km: 420,
      fuel: { out: "full", in: "quarter", quartersMissing: 3 },
      // The spare tyre was already missing at check-out.
      checklist: [{ key: "clean", label: "Clean inside and out", note: "Sand everywhere" }],
    });
    expect(diff.photos.find((p) => p.view === "front")).toEqual({
      view: "front",
      out: ["check_out-front"],
      in: ["in-front"],
    });
    expect(diff.photos.find((p) => p.view === "other")).toEqual({
      view: "other",
      out: [],
      in: ["in-scratch"],
    });
    expect(quartersMissing("half", "full")).toBe(0);
  });
});

describe("a damage", () => {
  const found = (stage: InspectionStage, chargeCustomer = false) =>
    VehicleDamage.record({
      id: "d1",
      vehicleId: "v1",
      branchId: "hq",
      booking: { id: "b1", inspectionId: "i1", stage },
      area: "left",
      severity: "moderate",
      description: "  Dent in the rear door  ",
      currency: "GHS",
      estimateMinor: 80_000,
      chargeCustomer,
      createdBy: "u1",
      now: at,
    });

  it("is the renter's to pay only when found at check-in", () => {
    expect(() => found("check_out", true)).toThrow(RentalInspectionError);
    expect(found("check_out").snapshot()).toMatchObject({
      liability: "business",
      description: "Dent in the rear door",
    });
    const theirs = found("check_in", true);
    expect(theirs.customerShareMinor()).toBe(80_000);
    theirs.settle({ finalMinor: 65_000 }, at);
    expect(theirs.customerShareMinor()).toBe(65_000);
    theirs.settle({ liability: "insurance", claimRef: " CLM-77 " }, at);
    expect(theirs.customerShareMinor()).toBe(0);
    expect(theirs.snapshot().claimRef).toBe("CLM-77");
    expect(() => found("check_out").settle({ liability: "customer" }, at)).toThrow(
      "found when the vehicle comes back",
    );
  });

  it("is repaired once", () => {
    const damage = found("check_in");
    damage.repaired({ finalMinor: 50_000, workOrderRef: "WO-12" }, "u2", at);
    expect(damage.snapshot()).toMatchObject({
      status: "repaired",
      finalMinor: 50_000,
      workOrderRef: "WO-12",
      repairedBy: "u2",
    });
    expect(() => damage.repaired({}, "u2", at)).toThrow("repaired already");
  });
});
