import { DomainError } from "../errors/DomainError.js";

export class PartRuleError extends DomainError {
  readonly code = "PART_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const PART_UNITS = ["each", "pair", "set", "litre", "kg", "metre"] as const;
export type PartUnit = (typeof PART_UNITS)[number];

export const MOVE_KINDS = [
  "opening",
  "receipt",
  "issue",
  "adjustment",
  "transfer_out",
  "transfer_in",
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** A make it fits, and the model (null: every model of the make). */
export type Fit = Readonly<{ make: string; model: string | null }>;

export type PartProps = Readonly<{
  id: string;
  sku: string;
  name: string;
  unit: PartUnit;
  category: string | null;
  compatible: readonly Fit[];
  notes: string | null;
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PartDetails = Pick<
  PartProps,
  "sku" | "name" | "unit" | "category" | "compatible" | "notes" | "active"
>;

const SKU = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;
const MAX_QUANTITY = 1_000_000;

/** A part of the catalogue (docs/12 §4): what it is and the vehicles it fits (decision 389). */
export class Part {
  private constructor(private props: PartProps) {}

  static create(input: PartDetails & Readonly<{ id: string; createdBy: string; now: Date }>): Part {
    return new Part({
      id: input.id,
      ...details(input),
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: PartProps): Part {
    return new Part(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): PartProps {
    return this.props;
  }

  change(changes: Partial<PartDetails>, now: Date): void {
    this.props = { ...this.props, ...details({ ...this.props, ...changes }), updatedAt: now };
  }

  /** Fits the vehicle: nothing listed fits all, or its make (and model) is listed. */
  fits(make: string, model: string): boolean {
    const { compatible } = this.props;
    if (compatible.length === 0) return true;
    const m = make.trim().toLowerCase();
    const mo = model.trim().toLowerCase();
    return compatible.some(
      (f) => f.make.toLowerCase() === m && (f.model === null || f.model.toLowerCase() === mo),
    );
  }
}

function details(input: PartDetails): PartDetails {
  const sku = input.sku.trim().toUpperCase();
  if (!SKU.test(sku))
    throw new PartRuleError(
      "The SKU is 1 to 40 letters, digits, dots, dashes or slashes, starting with a letter or digit",
    );
  const name = input.name.trim();
  if (name.length < 2 || name.length > 160)
    throw new PartRuleError("Name the part (2 to 160 characters)");
  const blank = (v: string | null) => (v === null || v.trim() === "" ? null : v.trim());
  const seen = new Set<string>();
  const compatible: Fit[] = [];
  for (const f of input.compatible) {
    const make = f.make.trim();
    const model = blank(f.model);
    if (make.length === 0) throw new PartRuleError("Name the make each fit is for");
    const key = `${make.toLowerCase()}|${model?.toLowerCase() ?? ""}`;
    if (!seen.has(key)) compatible.push({ make, model });
    seen.add(key);
  }
  if (compatible.length > 50) throw new PartRuleError("At most 50 makes and models");
  return {
    sku,
    name,
    unit: input.unit,
    category: blank(input.category),
    compatible,
    notes: blank(input.notes),
    active: input.active,
  };
}

export type StockProps = Readonly<{
  id: string;
  partId: string;
  branchId: string;
  /** Hundredths of the part's unit are kept as decimals with two places. */
  onHand: number;
  avgCostMinor: number;
  reorderLevel: number | null;
  reorderQty: number | null;
  location: string | null;
  belowSince: Date | null;
  updatedAt: Date;
}>;

/** What a move did to the stock. */
export type StockChange = Readonly<{
  quantity: number;
  unitCostMinor: number;
  valueMinor: number;
  onHandAfter: number;
  avgCostAfter: number;
  /** It just went to or below the reorder level. */
  fellBelow: boolean;
}>;

/**
 * A part's stock at one branch, at weighted average cost: what comes in at its cost changes the
 * average, what goes out leaves at the average (decision 390). Never below nothing.
 */
export class Stock {
  private constructor(private props: StockProps) {}

  static restore(props: StockProps): Stock {
    return new Stock(props);
  }

  snapshot(): StockProps {
    return this.props;
  }

  /** At or below its reorder level. */
  get low(): boolean {
    const { reorderLevel, onHand } = this.props;
    return reorderLevel !== null && onHand <= reorderLevel;
  }

  /** In at a unit cost (purchases, opening stock, transfers in, counts up). */
  receive(quantity: number, unitCostMinor: number, now: Date): StockChange {
    const q = hundredths(quantity, "quantity");
    if (q <= 0) throw new PartRuleError("Receive more than nothing");
    if (!Number.isInteger(unitCostMinor) || unitCostMinor < 0)
      throw new PartRuleError("The unit cost is not valid");
    const before = hundredths(this.props.onHand, "on hand");
    const after = before + q;
    if (after > MAX_QUANTITY * 100) throw new PartRuleError("That is more stock than is kept");
    const valueMinor = Math.round((q * unitCostMinor) / 100);
    const avg =
      after === 0
        ? unitCostMinor
        : Math.round((before * this.props.avgCostMinor + q * unitCostMinor) / after);
    return this.apply(after, avg, q, unitCostMinor, valueMinor, now);
  }

  /** Out at the average cost (issues to work orders, transfers out, counts down). */
  take(quantity: number, label: string, now: Date): StockChange {
    const q = hundredths(quantity, "quantity");
    if (q <= 0) throw new PartRuleError("Take more than nothing");
    const before = hundredths(this.props.onHand, "on hand");
    if (q > before)
      throw new PartRuleError(
        `Only ${this.props.onHand} of ${label} in stock: ${quantity} cannot be taken`,
      );
    const avg = this.props.avgCostMinor;
    const valueMinor = Math.round((q * avg) / 100);
    return this.apply(before - q, avg, -q, avg, -valueMinor, now);
  }

  setReorder(
    input: Readonly<{
      reorderLevel: number | null;
      reorderQty: number | null;
      location: string | null;
    }>,
    now: Date,
  ): boolean {
    const level = input.reorderLevel === null ? null : hundredths(input.reorderLevel, "level");
    const qty = input.reorderQty === null ? null : hundredths(input.reorderQty, "quantity");
    if (level !== null && level < 0) throw new PartRuleError("The reorder level is 0 or more");
    if (qty !== null && qty <= 0) throw new PartRuleError("Reorder more than nothing");
    const wasLow = this.low;
    this.props = {
      ...this.props,
      reorderLevel: level === null ? null : level / 100,
      reorderQty: qty === null ? null : qty / 100,
      location: input.location?.trim() || null,
      updatedAt: now,
    };
    return this.track(wasLow, now);
  }

  private apply(
    afterHundredths: number,
    avgCostMinor: number,
    qHundredths: number,
    unitCostMinor: number,
    valueMinor: number,
    now: Date,
  ): StockChange {
    const wasLow = this.low;
    this.props = {
      ...this.props,
      onHand: afterHundredths / 100,
      avgCostMinor,
      updatedAt: now,
    };
    const fellBelow = this.track(wasLow, now);
    return {
      quantity: qHundredths / 100,
      unitCostMinor,
      valueMinor,
      onHandAfter: this.props.onHand,
      avgCostAfter: avgCostMinor,
      fellBelow,
    };
  }

  /** Keeps when it went low; true when it has just gone low (alert once each time). */
  private track(wasLow: boolean, now: Date): boolean {
    if (!this.low) {
      this.props = { ...this.props, belowSince: null };
      return false;
    }
    if (wasLow && this.props.belowSince !== null) return false;
    this.props = { ...this.props, belowSince: now };
    return true;
  }
}

/** A quantity with two decimals at most, as hundredths. */
export function hundredths(value: number, what: string): number {
  const h = Math.round(value * 100);
  if (!Number.isFinite(value) || Math.abs(h - value * 100) > 1e-6 || Math.abs(value) > MAX_QUANTITY)
    throw new PartRuleError(`The ${what} has two decimals at most`);
  return h;
}
