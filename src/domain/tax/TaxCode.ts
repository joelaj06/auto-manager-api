import { DomainError } from "../errors/DomainError.js";
import { divideHalfEven, parseDecimal, pow10 } from "../money/Decimal.js";
import { Money } from "../money/Money.js";

export type TaxKind = "standard" | "flat_rate" | "exempt" | "zero_rated" | "custom";
export type TaxAppliesTo = "sales" | "purchases";

/**
 * One levy of a tax code (VAT, NHIL, GETFund …) with its rate for a period. `base` says what it
 * is charged on: the net amount, or the net amount plus the components before it (compounding).
 */
export type TaxComponent = Readonly<{
  /** Stored components have an id (to end a rate later). */
  id?: string;
  key: string;
  name: string;
  /** Percent as a decimal string: "15", "2.5". */
  rate: string;
  base: "net" | "net_plus_previous";
  /** `YYYY-MM-DD`, inclusive. */
  effectiveFrom: string;
  /** `YYYY-MM-DD`, exclusive; null: still in force. */
  effectiveTo: string | null;
}>;

export type TaxCodeProps = Readonly<{
  code: string;
  name: string;
  kind: TaxKind;
  appliesTo: readonly TaxAppliesTo[];
  components: readonly TaxComponent[];
  /** Usable on documents (needs rates unless exempt or zero-rated). */
  active: boolean;
}>;

export type TaxLine = Readonly<{
  code: string;
  net: Money;
  /** The rates applied, snapshotted on the document line (docs/13 §6). */
  components: readonly Readonly<{ key: string; name: string; rate: string; amount: Money }>[];
  tax: Money;
  gross: Money;
}>;

export class TaxRatesMissingError extends DomainError {
  readonly code = "TAX_RATES_MISSING";
  constructor(code: string, date: string) {
    super(`No rates are configured for tax code ${code} on ${date}; ask your administrator`);
  }
}

export class InvalidTaxCodeError extends DomainError {
  readonly code = "INVALID_TAX_CODE";
  constructor(message: string) {
    super(message);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z][a-z0-9_]{0,29}$/;
/** Components that charge nothing, by nature of the code. */
const TAX_FREE: ReadonlySet<TaxKind> = new Set(["exempt", "zero_rated"]);

/**
 * A tax code (docs/13 §6). Rates are data with effective dates, never hard-coded; the rates in
 * force on the document date are applied and snapshotted. Exempt and zero-rated codes charge
 * nothing; any other code without rates on that date cannot be used.
 */
export class TaxCode {
  private constructor(private readonly props: TaxCodeProps) {}

  static create(props: TaxCodeProps): TaxCode {
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(props.code))
      throw new InvalidTaxCodeError("Tax codes use capitals, digits and _ (e.g. VAT_STANDARD)");
    if (props.name.trim().length === 0 || props.name.length > 120)
      throw new InvalidTaxCodeError("A tax code needs a name (up to 120 characters)");
    if (props.appliesTo.length === 0)
      throw new InvalidTaxCodeError("A tax code applies to sales, purchases or both");
    if (props.active && !TAX_FREE.has(props.kind) && props.components.length === 0)
      throw new InvalidTaxCodeError("Enter the rates before activating this tax code");
    if (TAX_FREE.has(props.kind) && props.components.length > 0)
      throw new InvalidTaxCodeError(`A ${props.kind.replace("_", "-")} code has no rates`);
    for (const c of props.components) {
      if (!KEY.test(c.key)) throw new InvalidTaxCodeError(`Invalid component key "${c.key}"`);
      const rate = parseDecimal(c.rate);
      if (rate.units < 0n || rate.units > 100n * pow10(rate.scale))
        throw new InvalidTaxCodeError("A rate is between 0 and 100 percent");
      if (!DATE.test(c.effectiveFrom) || (c.effectiveTo !== null && !DATE.test(c.effectiveTo)))
        throw new InvalidTaxCodeError("Effective dates are YYYY-MM-DD");
      if (c.effectiveTo !== null && c.effectiveTo <= c.effectiveFrom)
        throw new InvalidTaxCodeError("A rate must end after it starts");
    }
    for (const key of new Set(props.components.map((c) => c.key))) {
      const periods = props.components
        .filter((c) => c.key === key)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      for (let i = 1; i < periods.length; i += 1) {
        const previousEnd = periods[i - 1]!.effectiveTo;
        if (previousEnd === null || previousEnd > periods[i]!.effectiveFrom)
          throw new InvalidTaxCodeError(`Rates of ${key} overlap; end the old rate first`);
      }
    }
    return new TaxCode(props);
  }

  get code(): string {
    return this.props.code;
  }

  get active(): boolean {
    return this.props.active;
  }

  /** A code can be used once it has rates (exempt and zero-rated codes need none). */
  activate(): TaxCode {
    if (!TAX_FREE.has(this.props.kind) && this.props.components.length === 0)
      throw new InvalidTaxCodeError("Enter the rates before activating this tax code");
    return new TaxCode({ ...this.props, active: true });
  }

  deactivate(): TaxCode {
    return new TaxCode({ ...this.props, active: false });
  }

  /** A new rate period for a component (validated against the existing ones). */
  withComponent(component: TaxComponent): TaxCode {
    return TaxCode.create({ ...this.props, components: [...this.props.components, component] });
  }

  /** Ends a rate period: the rate stops applying from `effectiveTo` (exclusive). */
  endComponent(componentId: string, effectiveTo: string): TaxCode {
    const target = this.props.components.find((c) => c.id === componentId);
    if (target === undefined) throw new InvalidTaxCodeError("Unknown rate");
    return TaxCode.create({
      ...this.props,
      components: this.props.components.map((c) =>
        c.id === componentId ? { ...c, effectiveTo } : c,
      ),
    });
  }

  rename(name: string, appliesTo: readonly TaxAppliesTo[]): TaxCode {
    return TaxCode.create({ ...this.props, name: name.trim(), appliesTo });
  }

  snapshot(): TaxCodeProps {
    return this.props;
  }

  /** Components in force on `date`, in their defined order. */
  componentsOn(date: string): TaxComponent[] {
    return this.props.components.filter(
      (c) => c.effectiveFrom <= date && (c.effectiveTo === null || date < c.effectiveTo),
    );
  }

  /**
   * Tax on an amount. `inclusive`: `amount` already contains the tax (prices entered tax
   * inclusive) and the net is worked back; the parts always add up to the amount.
   */
  apply(amount: Money, date: string, inclusive: boolean): TaxLine {
    const components = this.componentsOn(date);
    if (!this.props.active)
      throw new InvalidTaxCodeError(`Tax code ${this.props.code} is not active`);
    if (components.length === 0 && !TAX_FREE.has(this.props.kind))
      throw new TaxRatesMissingError(this.props.code, date);
    const net = inclusive ? this.netFromGross(amount, components) : amount;
    const charged: { key: string; name: string; rate: string; amount: Money }[] = [];
    let running = net;
    for (const c of components) {
      const base = c.base === "net" ? net : running;
      const tax = base.percent(c.rate);
      charged.push({ key: c.key, name: c.name, rate: c.rate, amount: tax });
      running = running.add(tax);
    }
    let tax = charged.reduce((sum, c) => sum.add(c.amount), Money.zero(amount.currency));
    if (inclusive && charged.length > 0) {
      // Rounding: the last component absorbs the difference so net + tax = the entered amount.
      const diff = amount.subtract(net).subtract(tax);
      const last = charged.at(-1)!;
      charged[charged.length - 1] = { ...last, amount: last.amount.add(diff) };
      tax = tax.add(diff);
    }
    return { code: this.props.code, net, components: charged, tax, gross: net.add(tax) };
  }

  /** gross / (1 + effective rate), half-even. */
  private netFromGross(gross: Money, components: readonly TaxComponent[]): Money {
    // Effective multiplier m = Π or Σ of (1 + rate), as an exact fraction num/den.
    const SCALE = 12;
    let factor = pow10(SCALE); // running "1 + taxes so far" for compounding, scaled
    let sumNet = 0n; // Σ rates charged on the net, scaled
    for (const c of components) {
      const r = parseDecimal(c.rate);
      const rate = (r.units * pow10(SCALE)) / (pow10(r.scale) * 100n);
      if (c.base === "net") sumNet += rate;
      else factor += divideHalfEven((factor + sumNet) * rate, pow10(SCALE));
    }
    const multiplier = factor + sumNet;
    const minor = divideHalfEven(BigInt(gross.amountMinor) * pow10(SCALE), multiplier);
    return Money.ofMinor(Number(minor), gross.currency);
  }
}
