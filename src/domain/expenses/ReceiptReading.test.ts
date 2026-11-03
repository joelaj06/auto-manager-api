import { describe, expect, it } from "vitest";
import { cleanReading, readingWarnings, type ReceiptFields } from "./ReceiptReading.js";

const fields: ReceiptFields = {
  merchant: " Shell Airport ",
  date: "2026-11-02",
  total: "1,250.50",
  tax: "62.50",
  currency: "ghs",
  isReceipt: true,
  confidence: "high",
};
const expense = {
  status: "draft",
  amount: "GH₵1,250.50",
  amountMinor: 125_050,
  currency: "GHS",
  date: "2026-11-02",
};

describe("cleanReading", () => {
  it("tidies what can stand as a figure", () => {
    expect(cleanReading(fields, "2026-11-03")).toMatchObject({
      merchant: "Shell Airport",
      total: "1250.50",
      currency: "GHS",
    });
  });

  it("drops what cannot", () => {
    const read = cleanReading(
      { ...fields, date: "2026-02-31", total: "about 50", tax: "-3", currency: "cedis" },
      "2026-11-03",
    );
    expect(read).toMatchObject({ date: null, total: null, tax: null, currency: null });
  });

  it("will not take a date in the future", () => {
    expect(cleanReading({ ...fields, date: "2026-12-01" }, "2026-11-03").date).toBeNull();
  });
});

describe("readingWarnings", () => {
  const clean = cleanReading(fields, "2026-11-03");

  it("has nothing to say when they agree", () => {
    expect(readingWarnings(clean, expense)).toEqual([]);
  });

  it("names each disagreement", () => {
    expect(
      readingWarnings(clean, {
        ...expense,
        amount: "GH₵1,500.00",
        amountMinor: 150_000,
        date: "2026-11-03",
      }),
    ).toEqual([
      "The receipt says 1250.50, the expense GH₵1,500.00",
      "The receipt is dated 2026-11-02, the expense 2026-11-03",
    ]);
  });

  it("does not compare amounts across currencies", () => {
    expect(
      readingWarnings(clean, { ...expense, currency: "USD", amount: "$90.00", amountMinor: 9_000 }),
    ).toEqual(["The receipt is in GHS, the expense in USD"]);
  });

  it("flags a photo that is not a receipt", () => {
    expect(readingWarnings({ ...clean, isReceipt: false }, expense)).toEqual([
      "This does not look like a receipt",
    ]);
  });
});
