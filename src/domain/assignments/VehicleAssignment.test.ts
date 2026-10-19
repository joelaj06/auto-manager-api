import { describe, expect, it } from "vitest";
import {
  buildChecklist,
  checkTerms,
  VehicleAssignment,
  type RemittanceTerms,
} from "./VehicleAssignment.js";

const now = new Date("2026-10-19T09:00:00Z");
const items = [
  { key: "spare_tyre", label: "Spare tyre" },
  { key: "clean", label: "Clean" },
];
const answers = {
  items: [
    { key: "spare_tyre", ok: true },
    { key: "clean", ok: false, note: " Dusty " },
  ],
  fuelLevel: "half" as const,
};
const target: RemittanceTerms = {
  mode: "fixed_target",
  targetMinor: 25_000,
  frequency: "daily",
  daysOff: [0, 0],
};

const start = (overrides: Partial<Parameters<typeof VehicleAssignment.start>[0]> = {}) =>
  VehicleAssignment.start({
    id: "a1",
    vehicleId: "v1",
    driverId: "d1",
    branchId: "b1",
    type: "remittance",
    terms: target,
    startedAt: now,
    startOdometer: 10_000,
    checklist: buildChecklist(items, answers),
    startedBy: "u1",
    notes: null,
    now,
    ...overrides,
  });

describe("handover checklist", () => {
  it("answers every configured item, with labels from the definitions", () => {
    expect(buildChecklist(items, answers)).toEqual({
      items: [
        { key: "spare_tyre", label: "Spare tyre", ok: true, note: null },
        { key: "clean", label: "Clean", ok: false, note: "Dusty" },
      ],
      fuelLevel: "half",
      notes: null,
      driverAcknowledged: false,
    });
    expect(() => buildChecklist(items, { items: [{ key: "spare_tyre", ok: true }] })).toThrow(
      /missing: Clean/,
    );
    expect(() =>
      buildChecklist(items, { items: [...answers.items, { key: "radio", ok: true }] }),
    ).toThrow(/Unknown checklist item/);
  });
});

describe("remittance terms", () => {
  it("need an amount and period for a fixed target; other modes carry none", () => {
    expect(checkTerms(target)).toEqual({ ...target, daysOff: [0] });
    expect(() => checkTerms({ ...target, targetMinor: null })).toThrow(/amount and a period/);
    expect(() => checkTerms({ ...target, frequency: "weekly" })).toThrow(/daily targets only/);
    expect(checkTerms({ ...target, mode: "variable" })).toEqual({
      mode: "variable",
      targetMinor: null,
      frequency: null,
      daysOff: [],
    });
  });
});

describe("VehicleAssignment", () => {
  it("ends after it started, with an odometer not lower than at the start", () => {
    const assignment = start();
    const end = (endedAt: Date, endOdometer: number) =>
      assignment.end({
        endedAt,
        endOdometer,
        checklist: buildChecklist(items, answers),
        reason: "Driver change",
        endedBy: "u1",
        now: new Date("2026-10-25T09:00:00Z"),
      });
    expect(() => end(now, 10_500)).toThrow(/ends after it started/);
    expect(() => end(new Date("2026-10-20T09:00:00Z"), 9_000)).toThrow(/lower than at the start/);
    end(new Date("2026-10-20T09:00:00Z"), 10_420);
    expect([assignment.open, assignment.distance]).toEqual([false, 420]);
    expect(() => assignment.changeTerms(target, now)).toThrow(/already ended/);
  });

  it("gives salaried drivers no target and never starts in the future", () => {
    expect(() => start({ type: "salary" })).toThrow(/salaried/);
    expect(() => start({ startedAt: new Date("2026-10-20T09:00:00Z") })).toThrow(/future/);
  });
});
