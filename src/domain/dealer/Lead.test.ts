import { describe, expect, it } from "vitest";
import { Lead, conversionRate, type LeadDetails } from "./Lead.js";

const now = new Date("2026-10-29T09:00:00Z");
const details: LeadDetails = {
  source: "walk_in",
  name: " Ama Mensah ",
  phone: "+233241234567",
  email: null,
  customerId: null,
  vehicleId: null,
  make: " Toyota ",
  model: "Corolla",
  yearFrom: 2018,
  yearTo: 2022,
  budgetMaxMinor: 200_000_00,
  notifyMatches: true,
  notes: "  ",
};
const lead = (d: Partial<LeadDetails> = {}) =>
  Lead.open({ ...details, ...d, id: "l1", number: "LD-1", branchId: "b1", createdBy: "u1", now });

describe("Lead", () => {
  it("opens new, trimmed, with a way to reach the person", () => {
    expect(lead().snapshot()).toMatchObject({
      stage: "new",
      name: "Ama Mensah",
      make: "Toyota",
      notes: null,
      assignedTo: null,
    });
    expect(() => lead({ phone: null })).toThrow("Give a phone number or email");
    expect(lead({ phone: null, email: " AMA@Example.com " }).snapshot().email).toBe(
      "ama@example.com",
    );
    expect(() => lead({ yearFrom: 2023 })).toThrow("The years run");
    expect(() => lead({ make: null })).toThrow("A saved search needs at least the make");
  });

  it("is assigned, reassigned and unassigned", () => {
    const l = lead();
    expect(l.assign("u2", now)).toBeNull();
    expect(() => l.assign("u2", now)).toThrow("already with them");
    expect(l.assign(null, now)).toBe("u2");
    expect(l.snapshot()).toMatchObject({ assignedTo: null, assignedAt: null });
  });

  it("moves through the pipeline; lost needs a reason and closes the lead", () => {
    const l = lead();
    expect(l.moveTo("contacted", null, now)).toBe("new");
    expect(() => l.moveTo("contacted", null, now)).toThrow("already contacted");
    expect(() => l.moveTo("lost", " ", now)).toThrow("Say why");
    l.moveTo("lost", "Bought elsewhere", now);
    expect(l.isOpen).toBe(false);
    expect(l.snapshot()).toMatchObject({ lostReason: "Bought elsewhere", closedAt: now });
    l.moveTo("negotiation", null, now);
    expect(l.snapshot()).toMatchObject({ lostReason: null, closedAt: null });
  });

  it("only advances forward while open", () => {
    const l = lead();
    expect(l.advanceTo("appointment", now)).toBe(true);
    expect(l.advanceTo("contacted", now)).toBe(false);
    expect(l.stage).toBe("appointment");
    l.moveTo("won", null, now);
    expect(l.advanceTo("negotiation", now)).toBe(false);
  });

  it("matches listed stock against the saved search", () => {
    const l = lead();
    const car = { make: "toyota", model: "COROLLA", year: 2020, askingPriceMinor: 150_000_00 };
    expect(l.matches(car)).toBe(true);
    expect(l.matches({ ...car, model: "Camry" })).toBe(false);
    expect(l.matches({ ...car, year: 2017 })).toBe(false);
    expect(l.matches({ ...car, year: null })).toBe(false);
    expect(l.matches({ ...car, askingPriceMinor: 250_000_00 })).toBe(false);
    expect(lead({ notifyMatches: false }).matches(car)).toBe(false);
  });

  it("reports conversion to one decimal", () => {
    expect(conversionRate(0, 0)).toBeNull();
    expect(conversionRate(1, 3)).toBe("33.3");
    expect(conversionRate(2, 2)).toBe("100.0");
  });
});
