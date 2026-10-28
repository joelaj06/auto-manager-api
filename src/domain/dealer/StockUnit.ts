import { DomainError } from "../errors/DomainError.js";
import { divideHalfEven, parseDecimal, pow10 } from "../money/Decimal.js";

export class StockRuleError extends DomainError {
  readonly code = "STOCK_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const STOCK_STATUSES = [
  "incoming",
  "reconditioning",
  "ready",
  "listed",
  "reserved",
  "sold",
  "delivered",
  "withdrawn",
  "returned",
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Still on the lot: what ages and accrues holding cost. */
export const IN_STOCK: readonly StockStatus[] = [
  "incoming",
  "reconditioning",
  "ready",
  "listed",
  "reserved",
];

export const STOCK_SOURCES = [
  "purchase",
  "trade_in",
  "consignment",
  "repossession",
  "other",
] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

/** Where a vehicle enters stock (sold, delivered and the rest come from the sale). */
export const ENTRY_STATUSES = ["incoming", "reconditioning", "ready"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export type Consignment = Readonly<{
  consignorId: string;
  /** `fixed`: the consignor gets a set amount; `commission`: the price less a percentage. */
  terms: "fixed" | "commission";
  payoutMinor: number | null;
  commissionRate: string | null;
}>;

export type StockUnitProps = Readonly<{
  vehicleId: string;
  status: StockStatus;
  source: StockSource;
  stockedOn: string;
  askingPriceMinor: number | null;
  minimumPriceMinor: number | null;
  holdingCostPerDayMinor: number;
  consignment: Consignment | null;
  listedOn: string | null;
  withdrawnOn: string | null;
  withdrawReason: string | null;
  soldOn: string | null;
  deliveredOn: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type PriceChange = Readonly<{
  askingPriceMinor: number | null;
  minimumPriceMinor: number | null;
  previousAskingMinor: number | null;
  previousMinimumMinor: number | null;
}>;

export type StockTerms = Readonly<{
  holdingCostPerDayMinor: number;
  consignment: Consignment | null;
  notes: string | null;
}>;

const MAX_MINOR = 1_000_000_000_00;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * A vehicle held for sale (docs/10 §2): it enters stock incoming, in reconditioning or ready,
 * is priced and listed (the vehicle goes for sale), is reserved, sold and delivered by a deal, or
 * is withdrawn; a consignment carries the consignor's terms (decisions 429–436).
 */
export class StockUnit {
  private constructor(private props: StockUnitProps) {}

  static add(
    input: Readonly<{
      vehicleId: string;
      source: StockSource;
      status: EntryStatus;
      stockedOn: string;
      terms: StockTerms;
      createdBy: string | null;
      now: Date;
    }>,
  ): StockUnit {
    if (!DATE.test(input.stockedOn)) throw new StockRuleError("The stock date is YYYY-MM-DD");
    return new StockUnit({
      vehicleId: input.vehicleId,
      status: input.status,
      source: input.source,
      stockedOn: input.stockedOn,
      askingPriceMinor: null,
      minimumPriceMinor: null,
      ...checkTerms(input.source, input.terms),
      listedOn: null,
      withdrawnOn: null,
      withdrawReason: null,
      soldOn: null,
      deliveredOn: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: StockUnitProps): StockUnit {
    return new StockUnit(props);
  }

  get vehicleId(): string {
    return this.props.vehicleId;
  }

  get status(): StockStatus {
    return this.props.status;
  }

  get inStock(): boolean {
    return IN_STOCK.includes(this.props.status);
  }

  snapshot(): StockUnitProps {
    return this.props;
  }

  /** A withdrawn or returned vehicle comes back into stock, ageing from the new date. */
  restock(
    input: Readonly<{
      source: StockSource;
      status: EntryStatus;
      stockedOn: string;
      terms: StockTerms;
    }>,
    now: Date,
  ): void {
    if (this.props.status !== "withdrawn" && this.props.status !== "returned")
      throw new StockRuleError("The vehicle is already in stock");
    if (!DATE.test(input.stockedOn)) throw new StockRuleError("The stock date is YYYY-MM-DD");
    this.props = {
      ...this.props,
      status: input.status,
      source: input.source,
      stockedOn: input.stockedOn,
      ...checkTerms(input.source, input.terms),
      listedOn: null,
      withdrawnOn: null,
      withdrawReason: null,
      soldOn: null,
      deliveredOn: null,
      updatedAt: now,
    };
  }

  /** Holding cost, consignment terms and notes. */
  setTerms(terms: StockTerms, now: Date): void {
    this.assertInStock();
    this.props = { ...this.props, ...checkTerms(this.props.source, terms), updatedAt: now };
  }

  /** Reconditioning is done: the vehicle can be priced and listed. */
  markReady(now: Date): void {
    if (this.props.status !== "incoming" && this.props.status !== "reconditioning")
      throw new StockRuleError("Only an incoming vehicle or one in reconditioning becomes ready");
    this.props = { ...this.props, status: "ready", updatedAt: now };
  }

  recondition(now: Date): void {
    if (this.props.status !== "incoming" && this.props.status !== "ready")
      throw new StockRuleError(
        this.props.status === "listed"
          ? "Take the vehicle off sale first"
          : "Only an incoming or ready vehicle goes into reconditioning",
      );
    this.props = { ...this.props, status: "reconditioning", updatedAt: now };
  }

  /** New prices; the minimum is never above the asking price. */
  price(askingPriceMinor: number | null, minimumPriceMinor: number | null, now: Date): PriceChange {
    this.assertInStock();
    for (const value of [askingPriceMinor, minimumPriceMinor])
      if (value !== null && !(Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR))
        throw new StockRuleError("A price is zero or more");
    if (askingPriceMinor === null && this.props.status === "listed")
      throw new StockRuleError("A listed vehicle keeps an asking price");
    if (
      askingPriceMinor !== null &&
      minimumPriceMinor !== null &&
      minimumPriceMinor > askingPriceMinor
    )
      throw new StockRuleError("The minimum price is above the asking price");
    const change: PriceChange = {
      askingPriceMinor,
      minimumPriceMinor,
      previousAskingMinor: this.props.askingPriceMinor,
      previousMinimumMinor: this.props.minimumPriceMinor,
    };
    if (
      change.askingPriceMinor === change.previousAskingMinor &&
      change.minimumPriceMinor === change.previousMinimumMinor
    )
      throw new StockRuleError("The prices are unchanged");
    this.props = { ...this.props, askingPriceMinor, minimumPriceMinor, updatedAt: now };
    return change;
  }

  /** Puts the vehicle on sale at its asking price. */
  list(on: string, now: Date): void {
    if (this.props.status !== "ready")
      throw new StockRuleError(
        this.props.status === "listed"
          ? "The vehicle is already listed"
          : "Only a ready vehicle is listed",
      );
    if (this.props.askingPriceMinor === null) throw new StockRuleError("Set an asking price first");
    this.props = { ...this.props, status: "listed", listedOn: on, updatedAt: now };
  }

  unlist(now: Date): void {
    if (this.props.status !== "listed") throw new StockRuleError("The vehicle is not listed");
    this.props = { ...this.props, status: "ready", listedOn: null, updatedAt: now };
  }

  /** Taken out of stock (kept by the business, handed back to its consignor …). */
  withdraw(reason: string, on: string, now: Date): void {
    if (this.props.status === "reserved")
      throw new StockRuleError("The vehicle is reserved: cancel the deal first");
    this.assertInStock();
    if (reason.trim().length < 3) throw new StockRuleError("Give a reason");
    this.props = {
      ...this.props,
      status: "withdrawn",
      withdrawnOn: on,
      withdrawReason: reason.trim(),
      listedOn: null,
      updatedAt: now,
    };
  }

  /** A deal holds the vehicle. */
  reserve(now: Date): void {
    if (this.props.status !== "listed" && this.props.status !== "ready")
      throw new StockRuleError("Only a ready or listed vehicle is reserved");
    this.props = { ...this.props, status: "reserved", updatedAt: now };
  }

  /** The deal fell through: back on sale (or ready when it was never listed). */
  release(now: Date): void {
    if (this.props.status !== "reserved") throw new StockRuleError("The vehicle is not reserved");
    this.props = {
      ...this.props,
      status: this.props.listedOn === null ? "ready" : "listed",
      updatedAt: now,
    };
  }

  sell(on: string, now: Date): void {
    if (!["ready", "listed", "reserved"].includes(this.props.status))
      throw new StockRuleError("The vehicle is not for sale");
    this.props = { ...this.props, status: "sold", soldOn: on, updatedAt: now };
  }

  deliver(on: string, now: Date): void {
    if (this.props.status !== "sold") throw new StockRuleError("Only a sold vehicle is delivered");
    this.props = { ...this.props, status: "delivered", deliveredOn: on, updatedAt: now };
  }

  /** The buyer brought it back. */
  returnFromSale(now: Date): void {
    if (this.props.status !== "sold" && this.props.status !== "delivered")
      throw new StockRuleError("Only a sold vehicle comes back");
    this.props = { ...this.props, status: "returned", updatedAt: now };
  }

  /** Moved to another branch while on the lot and not held by a deal. */
  assertTransferable(): void {
    if (this.props.status === "reserved")
      throw new StockRuleError("The vehicle is reserved: it stays in its branch");
    this.assertInStock();
  }

  private assertInStock(): void {
    if (!this.inStock) throw new StockRuleError(`The vehicle is ${this.props.status}`);
  }
}

function checkTerms(
  source: StockSource,
  terms: StockTerms,
): Pick<StockUnitProps, "holdingCostPerDayMinor" | "consignment" | "notes"> {
  const perDay = terms.holdingCostPerDayMinor;
  if (!(Number.isSafeInteger(perDay) && perDay >= 0 && perDay <= MAX_MINOR))
    throw new StockRuleError("The holding cost per day is zero or more");
  const c = terms.consignment;
  if ((source === "consignment") !== (c !== null))
    throw new StockRuleError(
      source === "consignment"
        ? "A consignment needs its consignor and terms"
        : "Only a consignment has a consignor",
    );
  let consignment: Consignment | null = null;
  if (c !== null) {
    if (c.terms === "fixed") {
      if (
        c.payoutMinor === null ||
        !(Number.isSafeInteger(c.payoutMinor) && c.payoutMinor >= 0 && c.payoutMinor <= MAX_MINOR)
      )
        throw new StockRuleError("Give the consignor's payout");
      consignment = { ...c, commissionRate: null };
    } else {
      if (c.commissionRate === null) throw new StockRuleError("Give the commission rate");
      commissionOf(0, c.commissionRate);
      consignment = { ...c, payoutMinor: null };
    }
  }
  const notes = terms.notes?.trim() ?? "";
  return { holdingCostPerDayMinor: perDay, consignment, notes: notes === "" ? null : notes };
}

/** The dealer's commission at `rate` percent of a price (half-even to the minor unit). */
export function commissionOf(priceMinor: number, rate: string): number {
  const r = parseDecimal(rate);
  if (r.units < 0n || r.units > 100n * pow10(r.scale) || r.scale > 2)
    throw new StockRuleError("A commission rate is 0 to 100% with at most 2 decimals");
  return Number(divideHalfEven(BigInt(priceMinor) * r.units, 100n * pow10(r.scale)));
}

/** What the consignor is owed when the vehicle sells at `priceMinor`. */
export function consignorPayout(consignment: Consignment, priceMinor: number): number {
  return consignment.terms === "fixed"
    ? consignment.payoutMinor!
    : priceMinor - commissionOf(priceMinor, consignment.commissionRate!);
}

/** Whole days from the stock date to `today` (zero on the day it arrives). */
export function daysInStock(stockedOn: string, today: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${stockedOn}T00:00:00Z`)) / DAY_MS),
  );
}

/** The ageing buckets of stock by days in stock (docs/10 §2). */
export const AGEING_BUCKETS = ["days0to30", "days31to60", "days61to90", "over90"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export function ageingBucket(days: number): AgeingBucket {
  if (days <= 30) return "days0to30";
  if (days <= 60) return "days31to60";
  if (days <= 90) return "days61to90";
  return "over90";
}

/** Margin on a price over a cost, with the percentage of the price to one decimal. */
export function marginOf(
  priceMinor: number,
  costMinor: number,
): Readonly<{ marginMinor: number; percent: string | null }> {
  const marginMinor = priceMinor - costMinor;
  if (priceMinor === 0) return { marginMinor, percent: null };
  const tenths = divideHalfEven(BigInt(marginMinor) * 1000n, BigInt(priceMinor));
  const negative = tenths < 0n;
  const abs = negative ? -tenths : tenths;
  return {
    marginMinor,
    percent: `${negative ? "-" : ""}${abs / 10n}.${abs % 10n}`,
  };
}
