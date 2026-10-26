import { describe, expect, it } from "vitest";
import { Money } from "../money/Money.js";
import {
  cancellationFee,
  isMileage,
  quoteDelta,
  RentalBooking,
  RentalBookingError,
} from "./RentalBooking.js";
import type { PricingTerms, QuoteLine, QuoteLineKind, RentalQuote } from "./RentalPricing.js";

const at = (day: number, hour = 9) =>
  new Date(`2027-04-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`);

const booking = (confirmed = false) =>
  RentalBooking.reserve({
    id: "b1",
    number: "RNT-2027-000001",
    branchId: "hq",
    customerId: "c1",
    classId: "suv",
    vehicleId: "v1",
    byClass: true,
    blockId: "k1",
    pickupAt: at(10),
    returnAt: at(12),
    expiresAt: confirmed ? null : at(2),
    currency: "GHS",
    terms: {} as PricingTerms,
    quote: {},
    notes: "  Airport  ",
    createdBy: "u1",
    createdAt: at(1),
    confirmed,
  });

const ghs = (minor: number) => Money.ofMinor(minor, "GHS");
const line = (kind: QuoteLineKind, net: number, tax: number): QuoteLine =>
  ({ kind, net: ghs(net), tax: ghs(tax), total: ghs(net + tax) }) as unknown as QuoteLine;
const quote = (...lines: QuoteLine[]) => ({ lines }) as unknown as RentalQuote;

describe("a booking's life", () => {
  it("goes reserved → confirmed → out → returned → closed", () => {
    const b = booking();
    expect(b.snapshot()).toMatchObject({ status: "reserved", expiresAt: at(2), notes: "Airport" });
    expect(b.shownStatus(at(1, 10))).toBe("reserved");
    expect(b.shownStatus(at(2))).toBe("expired");
    expect(() =>
      b.checkOut({ at: at(10), odometer: 100, fuel: "full", vehicleId: "v1", now: at(10) }),
    ).toThrow("Only a confirmed booking");
    b.confirm(at(1, 12));
    expect(b.snapshot()).toMatchObject({ status: "confirmed", expiresAt: null });
    expect(() => b.confirm(at(1, 13))).toThrow(RentalBookingError);

    b.checkOut({ at: at(10), odometer: 1_000, fuel: "full", vehicleId: "v2", now: at(10) });
    expect(b.snapshot()).toMatchObject({
      status: "checked_out",
      vehicleId: "v2",
      odometerOut: 1_000,
    });
    expect(() => b.cancel("Changed mind", at(10, 10))).toThrow("checked out is not cancelled");
    b.extend({ returnAt: at(13), quote: { extended: true }, now: at(11) });
    expect(() => b.extend({ returnAt: at(12), quote: {}, now: at(11) })).toThrow("later");
    expect(() =>
      b.checkIn({ at: at(13), odometer: 900, fuel: "half", quote: {}, now: at(13) }),
    ).toThrow("at least what it was at check-out (1000)");
    expect(() =>
      b.checkIn({ at: at(14), odometer: 1_400, fuel: "half", quote: {}, now: at(13) }),
    ).toThrow("not in the future");
    b.checkIn({ at: at(13), odometer: 1_450, fuel: "half", quote: {}, now: at(13) });
    expect(b.drivenKm()).toBe(450);
    b.close(at(14));
    expect(b.snapshot()).toMatchObject({ status: "closed", closedAt: at(14) });
  });

  it("is cancelled or a no-show only before check-out", () => {
    const cancelled = booking(true);
    cancelled.cancel("  Flight cancelled ", at(5));
    expect(cancelled.snapshot()).toMatchObject({
      status: "cancelled",
      cancelReason: "Flight cancelled",
    });
    const noShow = booking(true);
    expect(() => noShow.noShow("Did not come", at(9))).toThrow("pickup time has come");
    noShow.noShow("Did not come", at(10, 12));
    expect(noShow.status).toBe("no_show");
    expect(() => noShow.close(at(11))).toThrow("Only a returned booking");
  });
});

describe("fees and charges", () => {
  const policy = {
    freeCancellationHours: 24,
    lateCancellationFeePercent: "25",
    noShowFeePercent: "50",
  };
  const b = { pickupAt: at(10), chargedMinor: 90_050, currency: "GHS" };

  it("charge late cancellations and no-shows a share of the booking", () => {
    expect(cancellationFee(policy, b, at(9, 9), "cancellation")).toEqual({
      percent: "0",
      amountMinor: 0,
    });
    // 25 % of ₵900.50 = ₵225.125, half to even ₵225.12.
    expect(cancellationFee(policy, b, at(9, 10), "cancellation")).toEqual({
      percent: "25",
      amountMinor: 22_512,
    });
    expect(cancellationFee(policy, b, at(10, 12), "no_show")).toEqual({
      percent: "50",
      amountMinor: 45_025,
    });
    expect(
      cancellationFee(policy, { ...b, chargedMinor: -500 }, at(10), "no_show").amountMinor,
    ).toBe(0);
  });

  it("price changes as the difference of two quotes, line by line", () => {
    const booked = quote(line("rental", 60_000, 9_000), line("extra_km_estimate", 5_000, 750));
    const kept = quote(line("rental", 64_000, 9_600), line("extra_km_estimate", 5_000, 750));
    expect(quoteDelta(booked, kept, (k) => !isMileage(k))).toEqual({
      netMinor: 4_000,
      taxMinor: 600,
      totalMinor: 4_600,
    });
    const driven = quote(line("rental", 64_000, 9_600), line("extra_km_estimate", 2_000, 300));
    expect(quoteDelta(kept, driven, isMileage)).toEqual({
      netMinor: -3_000,
      taxMinor: -450,
      totalMinor: -3_450,
    });
  });
});
