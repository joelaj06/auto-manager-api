import { DomainError } from "../errors/DomainError.js";
import type { BillingDate } from "./Subscription.js";

export type InvoiceLineKind =
  "branch_rate" | "size_adjustment" | "setup" | "other" | "discount" | "proration";

export type InvoiceLine = Readonly<{
  kind: InvoiceLineKind;
  description: string;
  quantity: number;
  /** Minor units; negative for discounts. */
  unitMinor: number;
  amountMinor: number;
  /** Counts as licence amount (reseller commission base, docs/25 §2.1). */
  countsAsLicence: boolean;
}>;

export type InvoiceStatus = "open" | "paid" | "void";

/** A levy on the invoice (VAT, NHIL, GETFund …) with the rate applied. */
export type InvoiceTaxLine = Readonly<{
  key: string;
  name: string;
  rate: string;
  amountMinor: number;
}>;

/** Seller or buyer as printed on the invoice when it was issued. */
export type InvoiceParty = Readonly<{
  name: string;
  address: string | null;
  tin: string | null;
  vatNumber?: string | null;
  email?: string | null;
  phone?: string | null;
}>;

export type InvoiceProps = Readonly<{
  id: string;
  code: string;
  tenantId: string;
  subscriptionId: string;
  periodStart: BillingDate;
  periodEnd: BillingDate;
  lines: readonly InvoiceLine[];
  subtotalMinor: number;
  taxLines: readonly InvoiceTaxLine[];
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  seller: InvoiceParty | null;
  buyer: InvoiceParty | null;
  currency: string;
  status: InvoiceStatus;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdBy: string | null;
}>;

export class InvoiceRuleError extends DomainError {
  readonly code = "INVOICE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const invoiceSubtotal = (lines: readonly InvoiceLine[]) =>
  lines.reduce((sum, line) => sum + line.amountMinor, 0);

/** A line with its amount computed (quantity × unit price). */
export function invoiceLine(params: Omit<InvoiceLine, "amountMinor">): InvoiceLine {
  if (!Number.isInteger(params.quantity) || params.quantity < 1)
    throw new InvoiceRuleError("Quantities are whole numbers of at least 1");
  if (params.description.trim().length === 0 || params.description.length > 300)
    throw new InvoiceRuleError("A line needs a description (up to 300 characters)");
  if (!Number.isInteger(params.unitMinor))
    throw new InvoiceRuleError("Amounts are whole minor units (pesewas)");
  if ((params.kind === "discount") !== params.unitMinor < 0)
    throw new InvoiceRuleError("Only discount lines are negative, and they must be");
  return {
    ...params,
    description: params.description.trim(),
    amountMinor: params.quantity * params.unitMinor,
  };
}

/**
 * A platform invoice for a subscription period (docs/25 §3). Payments are recorded by staff for
 * now (no gateway); a payment never exceeds what is outstanding, and an invoice is paid only
 * when fully paid (partial payments do not activate anything, §5.3).
 */
export class Invoice {
  private constructor(private props: InvoiceProps) {}

  static issue(params: {
    id: string;
    code: string;
    tenantId: string;
    subscriptionId: string;
    period: Readonly<{ start: BillingDate; end: BillingDate }>;
    lines: readonly InvoiceLine[];
    /** Computed on the subtotal (`billingTax`); empty when we charge no VAT. */
    taxLines: readonly InvoiceTaxLine[];
    seller: InvoiceParty | null;
    buyer: InvoiceParty | null;
    currency: string;
    now: Date;
    dueAt: Date;
    createdBy: string | null;
  }): Invoice {
    if (params.lines.length === 0) throw new InvoiceRuleError("An invoice needs at least one line");
    const subtotal = invoiceSubtotal(params.lines);
    if (subtotal <= 0) throw new InvoiceRuleError("The invoice total must be more than zero");
    const tax = params.taxLines.reduce((sum, t) => sum + t.amountMinor, 0);
    return new Invoice({
      id: params.id,
      code: params.code,
      tenantId: params.tenantId,
      subscriptionId: params.subscriptionId,
      periodStart: params.period.start,
      periodEnd: params.period.end,
      lines: params.lines,
      subtotalMinor: subtotal,
      taxLines: params.taxLines,
      taxMinor: tax,
      totalMinor: subtotal + tax,
      paidMinor: 0,
      seller: params.seller,
      buyer: params.buyer,
      currency: params.currency,
      status: "open",
      issuedAt: params.now,
      dueAt: params.dueAt,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      createdBy: params.createdBy,
    });
  }

  static restore(props: InvoiceProps): Invoice {
    return new Invoice(props);
  }

  get id(): string {
    return this.props.id;
  }
  get status(): InvoiceStatus {
    return this.props.status;
  }
  get outstandingMinor(): number {
    return this.props.totalMinor - this.props.paidMinor;
  }

  /** Returns true when this payment settles the invoice. */
  recordPayment(amountMinor: number, currency: string, now: Date): boolean {
    if (this.props.status !== "open")
      throw new InvoiceRuleError(`This invoice is ${this.props.status}`);
    if (currency !== this.props.currency)
      throw new InvoiceRuleError(`The invoice is in ${this.props.currency}`);
    if (!Number.isInteger(amountMinor) || amountMinor <= 0)
      throw new InvoiceRuleError("A payment is a positive whole amount in minor units");
    if (amountMinor > this.outstandingMinor)
      throw new InvoiceRuleError(
        `The payment is more than the ${this.outstandingMinor} outstanding on this invoice`,
      );
    const paidMinor = this.props.paidMinor + amountMinor;
    const settled = paidMinor === this.props.totalMinor;
    this.props = {
      ...this.props,
      paidMinor,
      status: settled ? "paid" : "open",
      paidAt: settled ? now : null,
    };
    return settled;
  }

  /**
   * Money given back on this invoice: it is owed again (open) unless the staff then void it; the
   * subscription period it paid stays as it was.
   */
  refund(amountMinor: number): void {
    if (this.props.status === "void") throw new InvoiceRuleError("This invoice is void");
    if (!Number.isInteger(amountMinor) || amountMinor <= 0)
      throw new InvoiceRuleError("A refund is a positive whole amount in minor units");
    if (amountMinor > this.props.paidMinor)
      throw new InvoiceRuleError(`At most the ${this.props.paidMinor} paid can be refunded`);
    const paidMinor = this.props.paidMinor - amountMinor;
    this.props = { ...this.props, paidMinor, status: "open", paidAt: null };
  }

  void(reason: string, now: Date): void {
    if (this.props.status !== "open")
      throw new InvoiceRuleError(`A ${this.props.status} invoice cannot be voided`);
    if (this.props.paidMinor > 0)
      throw new InvoiceRuleError("An invoice with payments cannot be voided");
    this.props = { ...this.props, status: "void", voidedAt: now, voidReason: reason.trim() };
  }

  snapshot(): InvoiceProps {
    return this.props;
  }
}
