import { describe, expect, it } from "vitest";
import { defaultCurrencyFor, UnknownCurrencyError } from "./Currency.js";
import { divideHalfEven, InvalidDecimalError, parseDecimal, decimalToString } from "./Decimal.js";
import { CurrencyMismatchError, Money } from "./Money.js";

describe("Money", () => {
  it("parses decimal strings by the currency's minor units, never rounding input", () => {
    expect(Money.parse("1250.50", "GHS").amountMinor).toBe(125_050);
    expect(Money.parse("1250.5", "GHS").amountMinor).toBe(125_050);
    expect(Money.parse("-3", "GHS").amountMinor).toBe(-300);
    expect(Money.parse("5000", "XOF").amountMinor).toBe(5_000);
    expect(() => Money.parse("1.005", "GHS")).toThrow(InvalidDecimalError);
    expect(() => Money.parse("10.5", "XOF")).toThrow(/no decimals/);
    expect(() => Money.parse("1e5", "GHS")).toThrow(InvalidDecimalError);
    expect(() => Money.parse("1", "XYZ")).toThrow(UnknownCurrencyError);
    expect(() => Money.ofMinor(1.5, "GHS")).toThrow(InvalidDecimalError);
  });

  it("formats for screens and for SMS", () => {
    expect(Money.parse("1250.5", "GHS").format()).toBe("₵1,250.50");
    expect(Money.parse("1250.5", "GHS").formatAscii()).toBe("GHS 1,250.50");
    expect(Money.ofMinor(-5, "GHS").format()).toBe("-₵0.05");
    expect(Money.ofMinor(1_234_567, "XOF").format()).toBe("CFA1,234,567");
    expect(Money.ofMinor(125_050, "GHS").toJSON()).toEqual({
      amountMinor: 125_050,
      currency: "GHS",
      formatted: "₵1,250.50",
    });
  });

  it("adds within one currency only", () => {
    const a = Money.ofMinor(100, "GHS");
    expect(a.add(Money.ofMinor(50, "GHS")).amountMinor).toBe(150);
    expect(a.subtract(Money.ofMinor(150, "GHS")).amountMinor).toBe(-50);
    expect(() => a.add(Money.ofMinor(1, "USD"))).toThrow(CurrencyMismatchError);
    expect(a.times(3).amountMinor).toBe(300);
  });

  it("takes percentages and converts with half-even rounding", () => {
    expect(Money.ofMinor(1_000, "GHS").percent("15").amountMinor).toBe(150);
    expect(Money.ofMinor(1_000, "GHS").percent("2.5").amountMinor).toBe(25);
    expect(Money.ofMinor(10, "GHS").percent("25").amountMinor).toBe(2); // 2.5 → 2 (even)
    expect(Money.ofMinor(30, "GHS").percent("25").amountMinor).toBe(8); // 7.5 → 8 (even)
    // USD 1,200.00 at 15.42 → GHS 18,504.00
    expect(Money.parse("1200", "USD").convert("15.42", "GHS").amountMinor).toBe(1_850_400);
    // GHS 100.00 at 41.3 XOF per GHS → 4130 XOF (no decimals)
    expect(Money.parse("100", "GHS").convert("41.3", "XOF").amountMinor).toBe(4_130);
    expect(() => Money.ofMinor(1, "GHS").convert("0", "USD")).toThrow(InvalidDecimalError);
  });

  it("allocates parts that always add up exactly", () => {
    const parts = Money.ofMinor(1_000, "GHS").allocate([1, 1, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([334, 333, 333]);
    const negative = Money.ofMinor(-1_000, "GHS").allocate([1, 2]);
    expect(negative.map((p) => p.amountMinor)).toEqual([-333, -667]);
    for (const total of [1, 7, 99_999, 123_457]) {
      const split = Money.ofMinor(total, "GHS").allocate([3, 5, 2, 0, 9]);
      expect(split.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(total);
    }
    expect(() => Money.ofMinor(1, "GHS").allocate([0, 0])).toThrow(InvalidDecimalError);
  });
});

describe("Decimal", () => {
  it("rounds half to even and round-trips strings", () => {
    expect(divideHalfEven(5n, 2n)).toBe(2n);
    expect(divideHalfEven(7n, 2n)).toBe(4n);
    expect(divideHalfEven(-5n, 2n)).toBe(-2n);
    expect(divideHalfEven(-7n, 2n)).toBe(-4n);
    expect(divideHalfEven(10n, 3n)).toBe(3n);
    expect(decimalToString(parseDecimal("-0.0500"))).toBe("-0.0500");
    expect(decimalToString(parseDecimal("15"))).toBe("15");
  });

  it("suggests a base currency by country", () => {
    expect(defaultCurrencyFor("gh")).toBe("GHS");
    expect(defaultCurrencyFor("NG")).toBe("NGN");
    expect(defaultCurrencyFor("TG")).toBe("XOF");
    expect(defaultCurrencyFor("US")).toBe("GHS");
  });
});
