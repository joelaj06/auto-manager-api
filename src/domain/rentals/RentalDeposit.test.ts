import { describe, expect, it } from "vitest";
import { RentalBookingError } from "./RentalBooking.js";
import { RentalDeposit } from "./RentalDeposit.js";

const now = new Date("2027-04-10T09:00:00Z");
const later = new Date("2027-04-12T09:00:00Z");

const deposit = (amountMinor = 100_000) =>
  RentalDeposit.hold({
    id: "d1",
    bookingId: "b1",
    paymentId: "p1",
    currency: "GHS",
    amountMinor,
    heldBy: "u1",
    now,
  });

describe("RentalDeposit", () => {
  it("holds an amount above zero", () => {
    expect(deposit().snapshot()).toMatchObject({ status: "held", appliedMinor: 0 });
    expect(deposit().heldMinor()).toBe(100_000);
    expect(() => deposit(0)).toThrow(RentalBookingError);
  });

  it("applies part, then releases the rest", () => {
    const d = deposit();
    d.apply(30_000, later);
    expect(d.snapshot().status).toBe("partially_applied");
    expect(d.heldMinor()).toBe(70_000);
    expect(() => d.apply(80_000, later)).toThrow("Apply up to what the deposit still holds");

    d.release("p2", later);
    expect(d.snapshot()).toMatchObject({
      status: "released",
      refundedMinor: 70_000,
      refundPaymentId: "p2",
      releasedAt: later,
    });
    expect(d.heldMinor()).toBe(0);
    expect(() => d.release(null, later)).toThrow("The deposit is released: nothing is held");
  });

  it("is applied when nothing is left", () => {
    const d = deposit();
    d.apply(100_000, later);
    expect(d.snapshot().status).toBe("applied");
    expect(() => d.apply(1, later)).toThrow("The deposit is applied: nothing is held");
  });

  it("holds nothing once its payment is reversed", () => {
    const d = deposit();
    d.reversed(later);
    expect(d.heldMinor()).toBe(0);
    expect(() => d.apply(1, later)).toThrow(RentalBookingError);
  });
});
