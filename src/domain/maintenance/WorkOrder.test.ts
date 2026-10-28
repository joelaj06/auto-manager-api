import { describe, expect, it } from "vitest";
import { WorkOrder, WorkOrderError, type Allocation } from "./WorkOrder.js";

const now = new Date("2026-10-28T08:00:00Z");
const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

function order(vendorId: string | null = "vendor-1") {
  return WorkOrder.open({
    id: "wo-1",
    number: "WO-2026-000001",
    vehicleId: "veh-1",
    branchId: "br-1",
    type: "corrective",
    priority: "normal",
    title: "  Brake pads  ",
    description: " ",
    serviceTaskIds: ["t1", "t1", "t2"],
    vendorId,
    assignedTo: null,
    warranty: false,
    expectedBackAt: null,
    notes: null,
    issueId: null,
    damageId: null,
    odometerIn: 42_000,
    currency: "GHS",
    createdBy: "user-1",
    now,
  });
}

const pay = (payer: Allocation["payer"], amountMinor: number): Allocation => ({
  payer,
  amountMinor,
  driverId: payer === "driver" ? "drv-1" : null,
  customerId: null,
  insurerId: null,
  claimRef: null,
});

function done(o: WorkOrder, allocations: Allocation[] = [], vendorRating: number | null = null) {
  o.complete({
    allocations,
    odometerOut: 42_010,
    vendorInvoiceRef: " INV-9 ",
    vendorRating,
    userId: "user-1",
    now: later(30),
  });
}

describe("work order", () => {
  it("opens with a clean title, no blank description and each service task once", () => {
    const p = order().snapshot();
    expect(p.status).toBe("open");
    expect(p.title).toBe("Brake pads");
    expect(p.description).toBeNull();
    expect(p.serviceTaskIds).toEqual(["t1", "t2"]);
    expect(() => order().change({ title: "x" }, now)).toThrow(WorkOrderError);
  });

  it("moves open → in progress ⇄ awaiting parts, starting the clock once", () => {
    const o = order();
    o.move("in_progress", later(1));
    o.move("awaiting_parts", later(2));
    o.move("in_progress", later(5));
    expect(o.snapshot().startedAt).toEqual(later(1));
    expect(() => o.move("open", later(6))).toThrow(/cannot be marked open/);
  });

  it("costs lines as quantity × unit cost and totals them", () => {
    const o = order();
    o.setLines(
      [
        {
          id: "l1",
          kind: "labour",
          description: "Fit pads",
          quantity: 1.5,
          unitCostMinor: 8_000,
          partRef: null,
        },
        {
          id: "l2",
          kind: "part",
          description: "Pads",
          quantity: 2,
          unitCostMinor: 12_550,
          partRef: " BP-1 ",
        },
      ],
      now,
    );
    const lines = o.snapshot().lines;
    expect(lines.map((l) => [l.position, l.amountMinor, l.partRef])).toEqual([
      [0, 12_000, null],
      [1, 25_100, "BP-1"],
    ]);
    expect(o.totalMinor()).toBe(37_100);
    expect(() =>
      o.setLines(
        [
          {
            id: "l3",
            kind: "part",
            description: "Odd",
            quantity: 1.555,
            unitCostMinor: 1,
            partRef: null,
          },
        ],
        now,
      ),
    ).toThrow(/two decimals/);
  });

  it("completes with the business paying what others do not", () => {
    const o = order();
    o.setLines(
      [
        {
          id: "l1",
          kind: "part",
          description: "Pads",
          quantity: 1,
          unitCostMinor: 10_000,
          partRef: null,
        },
      ],
      now,
    );
    done(o, [pay("driver", 4_000)], 4);
    const p = o.snapshot();
    expect(p.status).toBe("completed");
    expect(p.allocations.map((a) => [a.payer, a.amountMinor])).toEqual([
      ["company", 6_000],
      ["driver", 4_000],
    ]);
    expect(p.vendorInvoiceRef).toBe("INV-9");
    expect(p.vendorRating).toBe(4);
    expect(() => o.move("in_progress", later(40))).toThrow(/completed: it cannot change/);
  });

  it("refuses payers above the total, twice, or for nothing, and ratings without a vendor", () => {
    const priced = (vendor: string | null = "vendor-1") => {
      const o = order(vendor);
      o.setLines(
        [
          {
            id: "l1",
            kind: "labour",
            description: "Job",
            quantity: 1,
            unitCostMinor: 5_000,
            partRef: null,
          },
        ],
        now,
      );
      return o;
    };
    expect(() => done(priced(), [pay("insurer", 6_000)])).toThrow(/more than the work order costs/);
    expect(() => done(priced(), [pay("driver", 1), pay("driver", 1)])).toThrow(/once/);
    expect(() => done(priced(), [pay("customer", 0)])).toThrow(/more than nothing/);
    expect(() => done(priced(null), [], 5)).toThrow(/outside vendor/);
    expect(() => done(priced(), [], 6)).toThrow(/1 to 5/);
  });

  it("counts downtime from going off the road until done or cancelled", () => {
    const o = order();
    expect(o.downtimeHours(now)).toBeNull();
    o.wentOffRoad({
      at: now,
      blockId: "blk-1",
      statusBefore: "available",
      workpayAgreementId: null,
    });
    expect(() =>
      o.wentOffRoad({ at: now, blockId: "blk-2", statusBefore: null, workpayAgreementId: null }),
    ).toThrow(/already off the road/);
    expect(o.downtimeHours(later(6))).toBe(6);
    o.cancel("Not needed", "user-1", later(12));
    expect(o.snapshot().downtimeEndedAt).toEqual(later(12));
    expect(o.downtimeHours(later(100))).toBe(12);
    expect(() => order().cancel("no", "user-1", now)).toThrow(/Say why/);
  });
});
