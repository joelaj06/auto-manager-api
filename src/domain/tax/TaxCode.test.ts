import { describe, expect, it } from "vitest";
import { Money } from "../money/Money.js";
import {
  InvalidTaxCodeError,
  TaxCode,
  TaxRatesMissingError,
  type TaxComponent,
} from "./TaxCode.js";

// Example rates for tests only — real rates are entered by staff after the accountant confirms.
const levy = (
  key: string,
  rate: string,
  from = "2024-01-01",
  to: string | null = null,
): TaxComponent => ({
  key,
  name: key.toUpperCase(),
  rate,
  base: "net",
  effectiveFrom: from,
  effectiveTo: to,
});
const compounded = (key: string, rate: string): TaxComponent => ({
  ...levy(key, rate),
  base: "net_plus_previous",
});
const code = (components: TaxComponent[], kind: "standard" | "exempt" = "standard") =>
  TaxCode.create({
    code: "TEST_VAT",
    name: "Test VAT",
    kind,
    appliesTo: ["sales"],
    components,
    active: true,
  });
const ghs = (amount: string) => Money.parse(amount, "GHS");

describe("TaxCode", () => {
  it("charges levies on the net and compounding VAT on net plus levies", () => {
    const vat = code([
      levy("nhil", "2.5"),
      levy("getfund", "2.5"),
      levy("covid", "1"),
      compounded("vat", "15"),
    ]);
    const line = vat.apply(ghs("100"), "2026-10-18", false);
    expect(line.components.map((c) => [c.key, c.amount.toDecimalString()])).toEqual([
      ["nhil", "2.50"],
      ["getfund", "2.50"],
      ["covid", "1.00"],
      ["vat", "15.90"],
    ]);
    expect(line.tax.toDecimalString()).toBe("21.90");
    expect(line.gross.toDecimalString()).toBe("121.90");
  });

  it("works back from tax-inclusive prices, with parts adding up exactly", () => {
    const vat = code([
      levy("nhil", "2.5"),
      levy("getfund", "2.5"),
      levy("covid", "1"),
      compounded("vat", "15"),
    ]);
    const line = vat.apply(ghs("121.90"), "2026-10-18", true);
    expect(line.net.toDecimalString()).toBe("100.00");
    expect(line.gross.toDecimalString()).toBe("121.90");
    for (const amount of ["0.01", "1.00", "99.99", "1234.57"]) {
      const l = vat.apply(ghs(amount), "2026-10-18", true);
      expect(l.net.add(l.tax).toDecimalString()).toBe(ghs(amount).toDecimalString());
    }
  });

  it("applies the rate in force on the document date", () => {
    const vat = code([
      levy("vat", "12.5", "2020-01-01", "2025-01-01"),
      levy("vat", "15", "2025-01-01"),
    ]);
    expect(vat.apply(ghs("100"), "2024-12-31", false).tax.toDecimalString()).toBe("12.50");
    expect(vat.apply(ghs("100"), "2025-01-01", false).tax.toDecimalString()).toBe("15.00");
    expect(() => vat.apply(ghs("100"), "2019-06-01", false)).toThrow(TaxRatesMissingError);
  });

  it("charges nothing on exempt codes and refuses bad definitions", () => {
    expect(code([], "exempt").apply(ghs("100"), "2026-10-18", false).tax.isZero()).toBe(true);
    expect(() => code([levy("vat", "15")], "exempt")).toThrow(InvalidTaxCodeError);
    expect(() => code([levy("vat", "150")])).toThrow(InvalidTaxCodeError);
    expect(() => code([levy("vat", "15", "2024-01-01"), levy("vat", "12", "2025-01-01")])).toThrow(
      /overlap/,
    );
    expect(() => code([levy("vat", "15", "2025-01-01", "2024-01-01")])).toThrow(
      InvalidTaxCodeError,
    );
  });

  it("activates only with rates (or when nothing is charged) and refuses inactive codes", () => {
    const placeholder = TaxCode.create({
      code: "VAT",
      name: "Value Added Tax",
      kind: "standard",
      appliesTo: ["sales"],
      components: [],
      active: false,
    });
    expect(() => placeholder.activate()).toThrow(InvalidTaxCodeError);
    expect(() => placeholder.apply(ghs("100"), "2026-10-18", false)).toThrow(/not active/);
    const withRate = placeholder.withComponent({ ...levy("vat", "15"), id: "r1" }).activate();
    expect(withRate.apply(ghs("100"), "2026-10-18", false).tax.toDecimalString()).toBe("15.00");
    const ended = withRate.endComponent("r1", "2026-01-01");
    expect(() => ended.apply(ghs("100"), "2026-10-18", false)).toThrow(TaxRatesMissingError);
    expect(() => withRate.endComponent("nope", "2026-01-01")).toThrow(InvalidTaxCodeError);
  });
});
