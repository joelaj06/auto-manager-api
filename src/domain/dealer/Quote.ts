import { DomainError } from "../errors/DomainError.js";

export class QuoteRuleError extends DomainError {
  readonly code = "SALES_QUOTE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
  "withdrawn",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const ADD_ON_KINDS = [
  "registration",
  "tint",
  "tracker",
  "warranty",
  "insurance",
  "service_plan",
  "other",
] as const;
export type AddOnKind = (typeof ADD_ON_KINDS)[number];

export const FINANCING = ["cash", "bank", "in_house"] as const;
export type Financing = (typeof FINANCING)[number];

export type AddOn = Readonly<{ kind: AddOnKind; description: string; amountMinor: number }>;

export type QuoteTerms = Readonly<{
  vehicleId: string;
  customerId: string | null;
  customerName: string;
  priceMinor: number;
  discountMinor: number;
  addOns: readonly AddOn[];
  tradeInDescription: string | null;
  tradeInMinor: number;
  financing: Financing;
  depositMinor: number | null;
  termMonths: number | null;
  financingNote: string | null;
  validUntil: string;
  notes: string | null;
}>;

export type QuoteProps = QuoteTerms &
  Readonly<{
    id: string;
    number: string;
    branchId: string;
    leadId: string | null;
    status: QuoteStatus;
    belowMinimum: boolean;
    approvedBy: string | null;
    approvedAt: Date | null;
    documentId: string | null;
    sentAt: Date | null;
    decidedAt: Date | null;
    decisionNote: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

export type QuoteTotals = Readonly<{
  /** Price less discount: what the vehicle sells for. */
  vehicleMinor: number;
  addOnsMinor: number;
  /** Vehicle and add-ons. */
  totalMinor: number;
  /** What is left to pay after the trade-in (never below zero). */
  balanceMinor: number;
}>;

const MAX_MINOR = 1_000_000_000_00;
const MAX_ADD_ONS = 20;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A sales quote (docs/10 §6): a vehicle at a price less a discount, add-ons, a trade-in and a
 * financing option, valid until a date; drafted, sent as a PDF, then accepted, rejected, expired
 * or withdrawn. A vehicle price below the minimum is approved before it is sent (decisions
 * 437–444).
 */
export class Quote {
  private constructor(private props: QuoteProps) {}

  static draft(
    input: QuoteTerms &
      Readonly<{
        id: string;
        number: string;
        branchId: string;
        leadId: string | null;
        minimumPriceMinor: number | null;
        today: string;
        createdBy: string | null;
        now: Date;
      }>,
  ): Quote {
    const { id, number, branchId, leadId, minimumPriceMinor, today, createdBy, now, ...terms } =
      input;
    const checked = checkTerms(terms, today);
    return new Quote({
      ...checked,
      id,
      number,
      branchId,
      leadId,
      status: "draft",
      belowMinimum: isBelow(checked, minimumPriceMinor),
      approvedBy: null,
      approvedAt: null,
      documentId: null,
      sentAt: null,
      decidedAt: null,
      decisionNote: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: QuoteProps): Quote {
    return new Quote(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): QuoteStatus {
    return this.props.status;
  }

  snapshot(): QuoteProps {
    return this.props;
  }

  totals(): QuoteTotals {
    return totalsOf(this.props);
  }

  /** A draft is edited; an approval is dropped when the price changes. */
  revise(terms: QuoteTerms, minimumPriceMinor: number | null, today: string, now: Date): void {
    if (this.props.status !== "draft") throw new QuoteRuleError("Only a draft quote is edited");
    const checked = checkTerms(terms, today);
    const samePrice =
      checked.priceMinor === this.props.priceMinor &&
      checked.discountMinor === this.props.discountMinor;
    this.props = {
      ...this.props,
      ...checked,
      belowMinimum: isBelow(checked, minimumPriceMinor),
      approvedBy: samePrice ? this.props.approvedBy : null,
      approvedAt: samePrice ? this.props.approvedAt : null,
      updatedAt: now,
    };
  }

  /** Approves a price below the minimum. */
  approve(userId: string, now: Date): void {
    if (this.props.status !== "draft") throw new QuoteRuleError("Only a draft quote is approved");
    if (!this.props.belowMinimum)
      throw new QuoteRuleError("The quote is not below the minimum price");
    if (this.props.approvedBy !== null) throw new QuoteRuleError("The quote is already approved");
    this.props = { ...this.props, approvedBy: userId, approvedAt: now, updatedAt: now };
  }

  /** Sent to the customer with its PDF; still valid today. */
  send(documentId: string, today: string, now: Date): void {
    this.assertSendable(today);
    this.props = { ...this.props, status: "sent", documentId, sentAt: now, updatedAt: now };
  }

  assertSendable(today: string): void {
    if (this.props.status !== "draft") throw new QuoteRuleError("The quote is already sent");
    if (this.props.belowMinimum && this.props.approvedBy === null)
      throw new QuoteRuleError("The price is below the minimum: have it approved first");
    if (this.props.validUntil < today) throw new QuoteRuleError("The quote has run out");
  }

  decide(
    outcome: "accepted" | "rejected" | "withdrawn",
    note: string | null,
    today: string,
    now: Date,
  ): void {
    const p = this.props;
    if (outcome === "withdrawn") {
      if (p.status !== "draft" && p.status !== "sent")
        throw new QuoteRuleError("The quote is closed");
    } else {
      if (p.status !== "sent") throw new QuoteRuleError("Only a sent quote is answered");
      if (outcome === "accepted" && p.validUntil < today)
        throw new QuoteRuleError("The quote has run out: send a new one");
    }
    this.props = {
      ...p,
      status: outcome,
      decidedAt: now,
      decisionNote: note?.trim() || null,
      updatedAt: now,
    };
  }

  /** A sent quote past its date (the daily job). */
  expire(today: string, now: Date): boolean {
    if (this.props.status !== "sent" || this.props.validUntil >= today) return false;
    this.props = { ...this.props, status: "expired", decidedAt: now, updatedAt: now };
    return true;
  }
}

function checkTerms(t: QuoteTerms, today: string): QuoteTerms {
  const amount = (value: number, what: string) => {
    if (!(Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR))
      throw new QuoteRuleError(`The ${what} is zero or more`);
  };
  amount(t.priceMinor, "price");
  amount(t.discountMinor, "discount");
  amount(t.tradeInMinor, "trade-in value");
  if (t.depositMinor !== null) amount(t.depositMinor, "deposit");
  if (t.discountMinor > t.priceMinor) throw new QuoteRuleError("The discount is above the price");
  const customerName = t.customerName.trim();
  if (customerName === "") throw new QuoteRuleError("Give the customer's name");
  if (!DATE.test(t.validUntil)) throw new QuoteRuleError("The validity date is YYYY-MM-DD");
  if (t.validUntil < today) throw new QuoteRuleError("The quote is valid from today on");
  if (t.addOns.length > MAX_ADD_ONS)
    throw new QuoteRuleError(`A quote has at most ${MAX_ADD_ONS} add-ons`);
  const addOns = t.addOns.map((a) => {
    amount(a.amountMinor, "add-on amount");
    const description = a.description.trim();
    if (description === "") throw new QuoteRuleError("Describe each add-on");
    return { ...a, description };
  });
  const tradeInDescription = t.tradeInDescription?.trim() || null;
  if (t.tradeInMinor > 0 && tradeInDescription === null)
    throw new QuoteRuleError("Describe the trade-in");
  if (t.financing === "cash" && (t.termMonths !== null || t.depositMinor !== null))
    throw new QuoteRuleError("A cash quote has no deposit or term");
  if (
    t.termMonths !== null &&
    !(Number.isInteger(t.termMonths) && t.termMonths >= 1 && t.termMonths <= 120)
  )
    throw new QuoteRuleError("The term is 1 to 120 months");
  const draft = { ...t, addOns };
  if (t.depositMinor !== null && t.depositMinor > totalsOf(draft).totalMinor)
    throw new QuoteRuleError("The deposit is above the total");
  return {
    ...draft,
    customerName,
    tradeInDescription,
    financingNote: t.financingNote?.trim() || null,
    notes: t.notes?.trim() || null,
  };
}

function isBelow(t: QuoteTerms, minimumPriceMinor: number | null): boolean {
  return minimumPriceMinor !== null && t.priceMinor - t.discountMinor < minimumPriceMinor;
}

function totalsOf(
  t: Pick<QuoteTerms, "priceMinor" | "discountMinor" | "addOns" | "tradeInMinor">,
): QuoteTotals {
  const vehicleMinor = t.priceMinor - t.discountMinor;
  const addOnsMinor = t.addOns.reduce((s, a) => s + a.amountMinor, 0);
  const totalMinor = vehicleMinor + addOnsMinor;
  return {
    vehicleMinor,
    addOnsMinor,
    totalMinor,
    balanceMinor: Math.max(0, totalMinor - t.tradeInMinor),
  };
}
