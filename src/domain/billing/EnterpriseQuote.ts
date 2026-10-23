import { DomainError } from "../errors/DomainError.js";
import type { BillingDate } from "./Subscription.js";

export type QuoteLineKind = "branch_rate" | "size_adjustment" | "setup" | "other" | "discount";
export type Recurrence = "monthly" | "one_time";
export type QuoteStatus = "draft" | "sent" | "accepted" | "superseded" | "withdrawn";
export type SizeBand = "small" | "medium" | "large" | "very_large";

export type QuoteLine = Readonly<{
  kind: QuoteLineKind;
  description: string;
  /** Branches for the per-branch rate (re-priced on the billed branches at each invoice). */
  quantity: number;
  /** Minor units; negative for discounts. */
  unitMinor: number;
  recurrence: Recurrence;
  /** Licence amount for reseller commission (docs/29 §4.3). */
  countsAsLicence: boolean;
}>;

export type QuoteLineInput = Omit<QuoteLine, "countsAsLicence" | "recurrence"> &
  Readonly<{ countsAsLicence?: boolean; recurrence?: Recurrence }>;

export type QuoteProps = Readonly<{
  id: string;
  code: string;
  tenantId: string;
  subscriptionId: string;
  version: number;
  status: QuoteStatus;
  lines: readonly QuoteLine[];
  currency: string;
  recurringMinor: number;
  oneTimeMinor: number;
  sizeBand: SizeBand | null;
  sizeNote: string | null;
  notes: string | null;
  validUntil: BillingDate | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  approvedBy: string | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  acceptedBy: Readonly<{ type: "user" | "platform_staff"; id: string }> | null;
  closedAt: Date | null;
}>;

export type QuoteTerms = Readonly<{
  lines: readonly QuoteLineInput[];
  sizeBand?: SizeBand | null;
  sizeNote?: string | null;
  notes?: string | null;
  validUntil?: BillingDate | null;
}>;

export class QuoteRuleError extends DomainError {
  readonly code = "QUOTE_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** A quote can be valid for at most this many days when it is sent. */
export const MAX_QUOTE_VALIDITY_DAYS = 90;
const MAX_LINES = 30;
const DAY_MS = 86_400_000;

/** Monthly only: the per-branch rate and size adjustments; one-time only: setup. */
const FIXED_RECURRENCE: Partial<Record<QuoteLineKind, Recurrence>> = {
  branch_rate: "monthly",
  size_adjustment: "monthly",
  setup: "one_time",
};
const LICENCE_BY_DEFAULT: ReadonlySet<QuoteLineKind> = new Set(["branch_rate", "size_adjustment"]);

/** A line as staff typed it, with the defaults of its kind (docs/25 §2.1). */
export function quoteLine(input: QuoteLineInput): QuoteLine {
  const fixed = FIXED_RECURRENCE[input.kind];
  const recurrence = input.recurrence ?? fixed ?? "one_time";
  if (fixed !== undefined && recurrence !== fixed)
    throw new QuoteRuleError(
      `A ${input.kind.replace("_", " ")} line is ${fixed === "monthly" ? "monthly" : "one-time"}`,
    );
  const description = input.description.trim();
  if (description.length === 0 || description.length > 300)
    throw new QuoteRuleError("A line needs a description (up to 300 characters)");
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000)
    throw new QuoteRuleError("Quantities are whole numbers from 1 to 1000");
  if (!Number.isInteger(input.unitMinor) || input.unitMinor === 0)
    throw new QuoteRuleError("Amounts are whole minor units (pesewas), not zero");
  if ((input.kind === "discount") !== input.unitMinor < 0)
    throw new QuoteRuleError("Only discount lines are negative, and they must be");
  return {
    kind: input.kind,
    description,
    quantity: input.quantity,
    unitMinor: input.unitMinor,
    recurrence,
    countsAsLicence: input.countsAsLicence ?? LICENCE_BY_DEFAULT.has(input.kind),
  };
}

const total = (lines: readonly QuoteLine[], recurrence: Recurrence) =>
  lines
    .filter((l) => l.recurrence === recurrence)
    .reduce((sum, l) => sum + l.quantity * l.unitMinor, 0);

/**
 * A hand-built Enterprise quote (docs/25 §2.1, decision 53): free-form lines — the negotiated
 * per-branch rate, size adjustments, one-time setup, other costs, discounts — each counting as
 * licence or not. Versioned per tenant: draft (edited) → sent (approved by a Super Admin, valid
 * until a date) → accepted (by the tenant, or recorded by staff) → superseded by the next
 * accepted version; a draft or sent quote can be withdrawn.
 */
export class EnterpriseQuote {
  private constructor(private props: QuoteProps) {}

  static draft(params: {
    id: string;
    code: string;
    tenantId: string;
    subscriptionId: string;
    version: number;
    currency: string;
    terms: QuoteTerms;
    createdBy: string;
    now: Date;
  }): EnterpriseQuote {
    const quote = new EnterpriseQuote({
      id: params.id,
      code: params.code,
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      version: params.version,
      status: "draft",
      lines: [],
      currency: params.currency,
      recurringMinor: 0,
      oneTimeMinor: 0,
      sizeBand: null,
      sizeNote: null,
      notes: null,
      validUntil: null,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
      approvedBy: null,
      sentAt: null,
      acceptedAt: null,
      acceptedBy: null,
      closedAt: null,
    });
    quote.edit(params.terms, params.now);
    return quote;
  }

  static restore(props: QuoteProps): EnterpriseQuote {
    return new EnterpriseQuote(props);
  }

  get id(): string {
    return this.props.id;
  }
  get status(): QuoteStatus {
    return this.props.status;
  }

  /** Only a draft is edited; a sent quote is changed by a new version. */
  edit(terms: QuoteTerms, now: Date): void {
    this.require("draft", "edit");
    if (terms.lines.length > MAX_LINES)
      throw new QuoteRuleError(`A quote has at most ${MAX_LINES} lines`);
    const lines = terms.lines.map(quoteLine);
    if (lines.filter((l) => l.kind === "branch_rate").length > 1)
      throw new QuoteRuleError("A quote has one per-branch rate");
    this.props = {
      ...this.props,
      lines,
      recurringMinor: total(lines, "monthly"),
      oneTimeMinor: total(lines, "one_time"),
      sizeBand: terms.sizeBand ?? null,
      sizeNote: terms.sizeNote?.trim() || null,
      notes: terms.notes?.trim() || null,
      validUntil: terms.validUntil ?? null,
      updatedAt: now,
    };
  }

  /** The Super Admin approves and sends it: it can then be accepted until `validUntil`. */
  send(approverId: string, now: Date): void {
    this.require("draft", "send");
    const p = this.props;
    const today = now.toISOString().slice(0, 10);
    if (!p.lines.some((l) => l.kind === "branch_rate"))
      throw new QuoteRuleError("A quote needs a per-branch rate");
    if (p.recurringMinor <= 0) throw new QuoteRuleError("The monthly total must be more than zero");
    if (p.oneTimeMinor < 0) throw new QuoteRuleError("The one-time total cannot be negative");
    const latest = new Date(now.getTime() + MAX_QUOTE_VALIDITY_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    if (p.validUntil === null || p.validUntil < today || p.validUntil > latest)
      throw new QuoteRuleError(
        `Set a valid-until date between today and ${MAX_QUOTE_VALIDITY_DAYS} days from now`,
      );
    this.props = { ...p, status: "sent", approvedBy: approverId, sentAt: now, updatedAt: now };
  }

  accept(by: Readonly<{ type: "user" | "platform_staff"; id: string }>, now: Date): void {
    this.require("sent", "accept");
    if (this.expired(now)) throw new QuoteRuleError("This quote has expired; ask for a new one");
    this.props = {
      ...this.props,
      status: "accepted",
      acceptedAt: now,
      acceptedBy: by,
      updatedAt: now,
    };
  }

  supersede(now: Date): void {
    this.require("accepted", "supersede");
    this.props = { ...this.props, status: "superseded", closedAt: now, updatedAt: now };
  }

  withdraw(now: Date): void {
    if (this.props.status !== "draft" && this.props.status !== "sent")
      throw new QuoteRuleError("Only a draft or a sent quote can be withdrawn");
    this.props = { ...this.props, status: "withdrawn", closedAt: now, updatedAt: now };
  }

  expired(now: Date): boolean {
    const until = this.props.validUntil;
    return until !== null && until < now.toISOString().slice(0, 10);
  }

  /** The per-branch rate of the quote (minor units per branch per month). */
  get branchRateMinor(): number | null {
    return this.props.lines.find((l) => l.kind === "branch_rate")?.unitMinor ?? null;
  }

  /** Branches the quote prices (the per-branch line's quantity). */
  get branches(): number | null {
    return this.props.lines.find((l) => l.kind === "branch_rate")?.quantity ?? null;
  }

  snapshot(): QuoteProps {
    return this.props;
  }

  private require(status: QuoteStatus, action: string): void {
    if (this.props.status !== status)
      throw new QuoteRuleError(`Cannot ${action} a quote that is ${this.props.status}`);
  }
}
