import { describe, expect, it } from "vitest";
import { TestDrive } from "./TestDrive.js";

const now = new Date("2026-10-29T09:00:00Z");
const book = (hours = 1) =>
  TestDrive.book({
    id: "t1",
    branchId: "b1",
    vehicleId: "v1",
    leadId: null,
    startsAt: new Date("2026-10-30T10:00:00Z"),
    endsAt: new Date(Date.parse("2026-10-30T10:00:00Z") + hours * 3_600_000),
    driverName: " Kofi ",
    driverPhone: "+233241234567",
    licenceNumber: " gh-1234 ",
    licenceExpiresOn: "2027-01-01",
    accompaniedBy: "u1",
    blockId: "k1",
    notes: null,
    createdBy: "u1",
    now,
  });

describe("TestDrive", () => {
  it("books a window of at most eight hours with the licence tidied", () => {
    expect(book().snapshot()).toMatchObject({
      status: "booked",
      driverName: "Kofi",
      licenceNumber: "GH-1234",
    });
    expect(() => book(9)).toThrow("at most 8 hours");
    expect(() => book(0)).toThrow("ends after it starts");
  });

  it("goes out on a valid licence and comes back with the distance", () => {
    const d = book();
    expect(() =>
      d.start({ odometer: 100, today: "2027-01-02", waiverDocumentId: null }, now),
    ).toThrow("licence has expired");
    d.start({ odometer: 100, today: "2026-10-30", waiverDocumentId: "doc1" }, now);
    expect(d.snapshot()).toMatchObject({
      status: "out",
      odometerOut: 100,
      waiverDocumentId: "doc1",
    });
    expect(() => d.finish(99, null, now)).toThrow("at least 100");
    expect(d.finish(112, " Liked it ", now)).toBe(12);
    expect(d.snapshot()).toMatchObject({ status: "returned", feedback: "Liked it" });
    expect(() => d.cancel("cancelled", "Too late", now)).toThrow("not booked");
  });

  it("is cancelled with a reason, or marked a no-show", () => {
    expect(() => book().cancel("cancelled", "", now)).toThrow("Give a reason");
    const d = book();
    d.cancel("no_show", null, now);
    expect(d.snapshot()).toMatchObject({ status: "no_show", cancelReason: null });
  });
});
