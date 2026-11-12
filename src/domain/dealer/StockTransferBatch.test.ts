import { describe, expect, it } from "vitest";
import { StockTransferBatch, type StockTransferBatchProps } from "./StockTransferBatch.js";

const base: StockTransferBatchProps = {
  id: "b1",
  reference: "STR-2026-000001",
  fromBranchId: "accra",
  toBranchId: "kumasi",
  transferredOn: "2026-11-12",
  reason: "  Kumasi is short of SUVs ",
  vehicleIds: ["v1", "v2"],
  transferredBy: "u1",
  createdAt: new Date("2026-11-12T09:00:00Z"),
};

describe("StockTransferBatch", () => {
  it("keeps the vehicles and a trimmed reason", () => {
    const batch = StockTransferBatch.create(base);
    expect(batch.vehicleIds).toEqual(["v1", "v2"]);
    expect(batch.snapshot().reason).toBe("Kumasi is short of SUVs");
  });

  it("refuses an empty, oversized or repeated list", () => {
    expect(() => StockTransferBatch.create({ ...base, vehicleIds: [] })).toThrow(
      "Transfer 1 to 100 vehicles at a time",
    );
    const many = Array.from({ length: 101 }, (_, i) => `v${i}`);
    expect(() => StockTransferBatch.create({ ...base, vehicleIds: many })).toThrow(
      "Transfer 1 to 100 vehicles at a time",
    );
    expect(() => StockTransferBatch.create({ ...base, vehicleIds: ["v1", "v1"] })).toThrow(
      "A vehicle is named twice",
    );
  });

  it("refuses the same branch, a bad date and no reason", () => {
    expect(() => StockTransferBatch.create({ ...base, toBranchId: "accra" })).toThrow(
      "The vehicles are already there",
    );
    expect(() => StockTransferBatch.create({ ...base, transferredOn: "12/11/2026" })).toThrow(
      "YYYY-MM-DD",
    );
    expect(() => StockTransferBatch.create({ ...base, reason: " a " })).toThrow("Give a reason");
  });
});
