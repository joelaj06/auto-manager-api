import { describe, expect, it } from "vitest";
import { validateCustomFields } from "./CustomFields.js";
import { checkOdometerReading } from "./OdometerReading.js";
import { NO_FINANCIALS, Vehicle, type VehicleDetails } from "./Vehicle.js";
import { evaluateCompliance } from "./VehicleCompliance.js";
import { parseVin, PlateNumber } from "./VehicleIdentifiers.js";
import { manualNextStatuses, nextStatuses } from "./VehicleStatus.js";

const now = new Date("2026-10-18T09:00:00Z");
const details: VehicleDetails = {
  plateNumber: "gr 1234 - 21",
  vin: null,
  engineNumber: null,
  chassisNumber: null,
  makeId: null,
  make: "Toyota",
  modelId: null,
  model: "Corolla",
  trim: null,
  year: 2018,
  colour: null,
  bodyType: "saloon",
  fuelType: "petrol",
  transmission: "automatic",
  engineCc: null,
  seats: 5,
  doors: 4,
  drive: null,
  mileageUnit: "km",
  usage: "fleet",
  ownershipType: "owned",
  ownershipNote: null,
  tags: ["Uber", "uber", " AC "],
  specs: {},
  customFields: {},
  notes: null,
};

const register = (overrides: Partial<Parameters<typeof Vehicle.register>[0]> = {}) =>
  Vehicle.register({
    id: "v1",
    code: "VEH-00001",
    branchId: "b1",
    status: "available",
    details,
    financials: NO_FINANCIALS,
    groupIds: [],
    createdBy: "u1",
    now,
    currentYear: 2026,
    ...overrides,
  });

describe("vehicle identifiers", () => {
  it("normalises plates and keys them by letters and digits", () => {
    const plate = PlateNumber.parse("gr 1234 - 21");
    expect([plate.value, plate.key]).toEqual(["GR 1234-21", "GR123421"]);
    expect(PlateNumber.parse("GR1234-21").key).toBe(plate.key);
    expect(() => PlateNumber.parse("-")).toThrow(/plate number/);
  });

  it("accepts 17-character VINs without I, O or Q", () => {
    expect(parseVin("jtdbr32e 1234-56789")).toBe("JTDBR32E123456789");
    expect(() => parseVin("JTDBR32E12345678O")).toThrow(/VIN/);
  });
});

describe("Vehicle", () => {
  it("registers with normalised details and a first status entry", () => {
    const { vehicle, change } = register();
    expect(vehicle.snapshot()).toMatchObject({
      plateNumber: "GR 1234-21",
      plateKey: "GR123421",
      tags: ["uber", "ac"],
      status: "available",
    });
    expect(change).toEqual({ from: null, to: "available", reason: "Registered", ref: null });
    expect(() => register({ status: "on_rent" })).toThrow(/starts as/);
    expect(() => register({ details: { ...details, year: 2030 } })).toThrow(/Year/);
  });

  it("lets users move only between states no module owns, with a reason", () => {
    const { vehicle } = register();
    expect(() => vehicle.changeStatus("on_rent", { manual: true, reason: "test", now })).toThrow(
      /through its rental, not by hand/,
    );
    expect(() =>
      vehicle.changeStatus("in_maintenance", { manual: true, reason: null, now }),
    ).toThrow(/reason/);
    const change = vehicle.changeStatus("in_maintenance", {
      manual: true,
      reason: "Brake pads",
      now,
    });
    expect(change).toMatchObject({ from: "available", to: "in_maintenance" });
    expect(() => vehicle.changeStatus("sold", { manual: true, reason: "x x", now })).toThrow(
      /cannot become sold/,
    );
  });

  it("lets modules enter their states only with the record that causes it", () => {
    const { vehicle } = register();
    expect(() => vehicle.changeStatus("on_rent", { manual: false, reason: null, now })).toThrow(
      /needs the record/,
    );
    vehicle.changeStatus("on_rent", {
      manual: false,
      reason: null,
      ref: { type: "rental", id: "r1" },
      now,
    });
    // An incident can be reported from any state; a rental vehicle cannot be moved or removed.
    expect(manualNextStatuses("on_rent")).toEqual(["accident", "impounded", "stolen"]);
    expect(() => vehicle.moveToBranch("b2", now)).toThrow(/stays in its branch/);
    expect(() => vehicle.remove("mistake", now)).toThrow(/cannot be removed/);
    expect(nextStatuses("sold")).toEqual([]);
  });

  it("works out the straight-line book value by whole months", () => {
    const { vehicle } = register({
      financials: {
        acquisitionDate: "2026-01-15",
        acquisitionCostMinor: 12_000_000,
        residualValueMinor: 2_400_000,
        depreciationMethod: "straight_line",
        usefulLifeMonths: 48,
      },
    });
    // 9 whole months: 12,000,000 − 9 × 9,600,000 / 48 = 10,200,000
    expect(vehicle.bookValue("2026-10-18", "GHS")?.amountMinor).toBe(10_200_000);
    expect(vehicle.bookValue("2040-01-01", "GHS")?.amountMinor).toBe(2_400_000);
    expect(() =>
      register({ financials: { ...NO_FINANCIALS, depreciationMethod: "straight_line" } }),
    ).toThrow(/Depreciation needs/);
  });
});

describe("odometer readings", () => {
  const at = (day: string) => new Date(`2026-10-${day}T08:00:00Z`);

  it("only go up over time, also for late entries", () => {
    const neighbours = {
      before: { value: 1_000, readAt: at("01") },
      after: { value: 2_000, readAt: at("10"), replacement: false },
    };
    const reading = (value: number) => ({
      value,
      readAt: at("05"),
      replacement: false,
      note: null,
    });
    expect(() => checkOdometerReading(reading(1_500), neighbours, now)).not.toThrow();
    expect(() => checkOdometerReading(reading(900), neighbours, now)).toThrow(/lower/);
    expect(() => checkOdometerReading(reading(2_100), neighbours, now)).toThrow(/higher/);
  });

  it("restart from a replacement with a reason", () => {
    const before = { before: { value: 150_000, readAt: at("01") }, after: null };
    const replaced = { value: 10, readAt: at("05"), replacement: true, note: null };
    expect(() => checkOdometerReading(replaced, before, now)).toThrow(/why/);
    expect(() =>
      checkOdometerReading({ ...replaced, note: "Cluster replaced" }, before, now),
    ).not.toThrow();
  });
});

describe("compliance", () => {
  const rules = {
    requiredDocuments: ["registration", "roadworthy", "insurance"] as const,
    expiringWithinDays: 30,
  };

  it("is red when a required document is missing or expired, amber when one expires soon", () => {
    const docs = [
      { id: "d1", type: "registration" as const, issuedOn: "2020-01-01", expiresOn: null },
      { id: "d2", type: "insurance" as const, issuedOn: "2026-01-01", expiresOn: "2026-11-01" },
    ];
    const missing = evaluateCompliance(docs, rules, "2026-10-18");
    expect([missing.level, missing.canOperate]).toEqual(["red", false]);
    expect(missing.items.find((i) => i.type === "roadworthy")?.state).toBe("missing");

    const renewed = [
      ...docs,
      { id: "d3", type: "roadworthy" as const, issuedOn: "2025-10-01", expiresOn: "2026-04-01" },
      { id: "d4", type: "roadworthy" as const, issuedOn: "2026-04-01", expiresOn: "2027-04-01" },
    ];
    const amber = evaluateCompliance(renewed, rules, "2026-10-18");
    expect([amber.level, amber.canOperate]).toEqual(["amber", true]);
    expect(amber.items.find((i) => i.type === "roadworthy")?.documentId).toBe("d4");
    expect(amber.items.find((i) => i.type === "insurance")).toMatchObject({
      state: "expiring",
      daysLeft: 14,
    });
    // A document is valid through its expiry date.
    expect(evaluateCompliance(renewed, rules, "2026-11-01").level).toBe("amber");
    expect(evaluateCompliance(renewed, rules, "2026-11-02").level).toBe("red");
  });
});

describe("custom fields", () => {
  const definitions = [
    { key: "tracker_id", label: "Tracker ID", type: "text" as const, required: true },
    {
      key: "fleet_type",
      label: "Fleet type",
      type: "select" as const,
      required: false,
      options: ["uber", "bolt"],
    },
  ];

  it("checks types, choices and required fields", () => {
    expect(validateCustomFields(definitions, { tracker_id: " T-1 ", fleet_type: "bolt" })).toEqual({
      tracker_id: "T-1",
      fleet_type: "bolt",
    });
    expect(() => validateCustomFields(definitions, {})).toThrow(/Tracker ID is required/);
    expect(() =>
      validateCustomFields(definitions, { tracker_id: "x", fleet_type: "yango" }),
    ).toThrow(/one of uber, bolt/);
    expect(() => validateCustomFields(definitions, { tracker_id: "x", colour: "red" })).toThrow(
      /Unknown custom field/,
    );
  });
});
