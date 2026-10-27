import { describe, expect, it } from "vitest";
import type { ChargeKind } from "./RentalBooking.js";
import { rentalInvoiceLines, type InvoiceableCharge } from "./RentalInvoicing.js";

let next = 0;
const charge = (kind: ChargeKind, netMinor: number, taxMinor = 0): InvoiceableCharge => ({
  id: `c${++next}`,
  kind,
  netMinor,
  taxMinor,
  totalMinor: netMinor + taxMinor,
});

describe("rentalInvoiceLines", () => {
  it("bills one line per kind, fees and damage untaxed", () => {
    const charges = [
      charge("rental", 50_000, 10_000),
      charge("extension", 10_000, 2_000),
      charge("extension", 5_000, 1_000),
      charge("damage", 30_000),
      charge("no_show_fee", 4_000),
    ];
    const draft = rentalInvoiceLines(charges, "RNT-1", false);
    expect(draft.lines).toEqual([
      expect.objectContaining({
        kind: "rental",
        amountMinor: 50_000,
        discountMinor: 0,
        taxed: true,
      }),
      expect.objectContaining({ kind: "extension", amountMinor: 15_000, taxed: true }),
      expect.objectContaining({ kind: "damage", amountMinor: 30_000, taxed: false }),
      expect.objectContaining({ kind: "no_show_fee", amountMinor: 4_000, taxed: false }),
    ]);
    expect(draft.lines[0]!.description).toBe("Rental, booking RNT-1");
    expect(draft.chargeIds).toHaveLength(5);
    expect(draft.heldBack).toEqual([]);
  });

  it("uses the amounts with tax when prices include tax", () => {
    const draft = rentalInvoiceLines([charge("rental", 50_000, 10_000)], "RNT-1", true);
    expect(draft.lines[0]!.amountMinor).toBe(60_000);
  });

  it("takes credits of the same tax treatment off the largest lines", () => {
    const draft = rentalInvoiceLines(
      [charge("rental", 50_000), charge("mileage", 8_000), charge("change", -12_000)],
      "RNT-1",
      false,
    );
    expect(draft.lines.map((l) => [l.kind, l.amountMinor, l.discountMinor])).toEqual([
      ["rental", 50_000, 12_000],
      ["mileage", 8_000, 0],
    ]);
  });

  it("spreads a credit larger than one line over the next", () => {
    const draft = rentalInvoiceLines(
      [charge("rental", 10_000), charge("mileage", 8_000), charge("change", -15_000)],
      "RNT-1",
      false,
    );
    expect(draft.lines.map((l) => l.discountMinor)).toEqual([10_000, 5_000]);
  });

  it("covers a group that nets to zero and holds back a net credit", () => {
    const zero = rentalInvoiceLines(
      [charge("rental", 10_000), charge("cancellation", -10_000)],
      "RNT-1",
      false,
    );
    expect(zero.lines).toEqual([]);
    expect(zero.chargeIds).toHaveLength(2);

    const credit = [charge("rental", 10_000), charge("change", -14_000), charge("damage", 5_000)];
    const held = rentalInvoiceLines(credit, "RNT-1", false);
    expect(held.lines.map((l) => l.kind)).toEqual(["damage"]);
    expect(held.heldBack).toEqual([credit[0]!.id, credit[1]!.id]);
    expect(held.chargeIds).toEqual([credit[2]!.id]);
  });
});
