import { Money } from "../money/Money.js";
import type { TaxCode } from "../tax/TaxCode.js";
import { FinanceRuleError } from "./Journal.js";

export const INVOICE_STATUSES = ["draft", "issued", "partially_paid", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type InvoicePartyType = "customer" | "driver";

export type InvoiceLineInput = Readonly<{
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  /** null: no tax on this line. */
  taxCode: string | null;
  /** Income account of the line. */
  accountId: string;
  vehicleId: string | null;
}>;

export type TaxComponentAmount = Readonly<{
  key: string;
  name: string;
  rate: string;
  amountMinor: number;
}>;

export type InvoiceLine = InvoiceLineInput &
  Readonly<{
    position: number;
    /** The rates in force on the issue date and their amounts (snapshot, docs/13 §6). */
    taxComponents: readonly TaxComponentAmount[];
    netMinor: number;
    taxMinor: number;
    grossMinor: number;
  }>;

export type InvoiceHeader = Readonly<{
  partyType: InvoicePartyType;
  partyId: string;
  partyName: string;
  branchId: string;
  vehicleId: string | null;
  issueDate: string;
  dueDate: string;
  currency: string;
  /** Base-currency units per 1 unit of `currency` ("1" for the base currency). */
  fxRate: string;
  pricesIncludeTax: boolean;
  notes: string | null;
}>;

export type InvoiceProps = InvoiceHeader &
  Readonly<{
    id: string;
    number: string | null;
    status: InvoiceStatus;
    lines: readonly InvoiceLine[];
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
    paidMinor: number;
    totalBaseMinor: number | null;
    sourceType: string | null;
    sourceId: string | null;
    issuedAt: Date | null;
    issuedBy: string | null;
    voidReason: string | null;
    voidedAt: Date | null;
    voidedBy: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

const MAX_LINES = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An invoice (docs/13 §2.1): a draft is edited freely; issuing gives it a number and posts it;
 * payments allocated to it move it to partially paid and paid; an issued invoice without
 * payments can be voided (with a reason). Each line's tax is computed with the rates in force
 * on the issue date and snapshotted, so later rate changes never alter it.
 */
export class Invoice {
  private constructor(private props: InvoiceProps) {}

  static draft(
    params: Readonly<{
      id: string;
      header: InvoiceHeader;
      lines: readonly InvoiceLineInput[];
      taxCodes: ReadonlyMap<string, TaxCode>;
      source: Readonly<{ type: string; id: string }> | null;
      createdBy: string | null;
      now: Date;
    }>,
  ): Invoice {
    return new Invoice({
      ...computed(params.header, params.lines, params.taxCodes),
      id: params.id,
      number: null,
      status: "draft",
      paidMinor: 0,
      totalBaseMinor: null,
      sourceType: params.source?.type ?? null,
      sourceId: params.source?.id ?? null,
      issuedAt: null,
      issuedBy: null,
      voidReason: null,
      voidedAt: null,
      voidedBy: null,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
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

  get balanceMinor(): number {
    return this.props.totalMinor - this.props.paidMinor;
  }

  snapshot(): InvoiceProps {
    return this.props;
  }

  /** Replaces a draft's header and lines (recomputing tax). */
  revise(
    header: InvoiceHeader,
    lines: readonly InvoiceLineInput[],
    taxCodes: ReadonlyMap<string, TaxCode>,
    now: Date,
  ): void {
    if (this.props.status !== "draft")
      throw new FinanceRuleError("Only a draft invoice can be changed; void and reissue instead");
    this.props = { ...this.props, ...computed(header, lines, taxCodes), updatedAt: now };
  }

  /** Gives the draft its number and final tax; the caller posts it, then calls `posted`. */
  issue(
    params: Readonly<{
      number: string;
      taxCodes: ReadonlyMap<string, TaxCode>;
      issuedBy: string | null;
      now: Date;
    }>,
  ): void {
    if (this.props.status !== "draft") throw new FinanceRuleError("This invoice is already issued");
    // Recomputed on issue: the rates in force on the issue date are the ones snapshotted.
    const recomputed = computed(this.props, this.props.lines, params.taxCodes);
    if (recomputed.totalMinor <= 0)
      throw new FinanceRuleError("An invoice needs an amount to issue");
    this.props = {
      ...this.props,
      ...recomputed,
      number: params.number,
      status: "issued",
      issuedAt: params.now,
      issuedBy: params.issuedBy,
      updatedAt: params.now,
    };
  }

  /** The receivable as posted, in the base currency. */
  posted(totalBaseMinor: number): void {
    this.props = { ...this.props, totalBaseMinor };
  }

  applyPayment(amountMinor: number, now: Date): void {
    if (this.props.status !== "issued" && this.props.status !== "partially_paid")
      throw new FinanceRuleError(
        `A ${this.props.status.replace("_", " ")} invoice takes no payment`,
      );
    if (amountMinor <= 0 || amountMinor > this.balanceMinor)
      throw new FinanceRuleError(
        `At most ${Money.ofMinor(this.balanceMinor, this.props.currency).format()} is still due`,
      );
    this.setPaid(this.props.paidMinor + amountMinor, now);
  }

  releasePayment(amountMinor: number, now: Date): void {
    if (amountMinor <= 0 || amountMinor > this.props.paidMinor)
      throw new FinanceRuleError("More is released than was paid");
    this.setPaid(this.props.paidMinor - amountMinor, now);
  }

  void(reason: string, userId: string | null, now: Date): void {
    if (this.props.status === "draft")
      throw new FinanceRuleError("Delete a draft instead of voiding it");
    if (this.props.status === "void") throw new FinanceRuleError("This invoice is already void");
    if (this.props.paidMinor > 0)
      throw new FinanceRuleError("Release the payments allocated to this invoice first");
    if (reason.trim().length < 3) throw new FinanceRuleError("Give a reason for voiding it");
    this.props = {
      ...this.props,
      status: "void",
      voidReason: reason.trim(),
      voidedAt: now,
      voidedBy: userId,
      updatedAt: now,
    };
  }

  private setPaid(paidMinor: number, now: Date): void {
    const status: InvoiceStatus =
      paidMinor === 0 ? "issued" : paidMinor === this.props.totalMinor ? "paid" : "partially_paid";
    this.props = { ...this.props, paidMinor, status, updatedAt: now };
  }
}

function computed(
  header: InvoiceHeader,
  inputs: readonly InvoiceLineInput[],
  taxCodes: ReadonlyMap<string, TaxCode>,
): InvoiceHeader &
  Readonly<{
    lines: InvoiceLine[];
    subtotalMinor: number;
    taxMinor: number;
    totalMinor: number;
  }> {
  if (!DATE.test(header.issueDate) || !DATE.test(header.dueDate))
    throw new FinanceRuleError("Dates are YYYY-MM-DD");
  if (header.dueDate < header.issueDate)
    throw new FinanceRuleError("An invoice cannot be due before it is issued");
  if (inputs.length === 0 || inputs.length > MAX_LINES)
    throw new FinanceRuleError(`An invoice has 1 to ${MAX_LINES} lines`);
  const partyName = header.partyName.trim();
  if (partyName === "") throw new FinanceRuleError("The invoice needs the customer's name");
  const lines = inputs.map((input, index) => line(header, input, index + 1, taxCodes));
  const sum = (pick: (l: InvoiceLine) => number) => lines.reduce((total, l) => total + pick(l), 0);
  const notes = header.notes?.trim() ?? "";
  return {
    ...header,
    partyName,
    notes: notes === "" ? null : notes.slice(0, 2_000),
    lines,
    subtotalMinor: sum((l) => l.netMinor),
    taxMinor: sum((l) => l.taxMinor),
    totalMinor: sum((l) => l.grossMinor),
  };
}

function line(
  header: InvoiceHeader,
  input: InvoiceLineInput,
  position: number,
  taxCodes: ReadonlyMap<string, TaxCode>,
): InvoiceLine {
  const description = input.description.trim();
  if (description === "" || description.length > 300)
    throw new FinanceRuleError(`Line ${position}: describe it in up to 300 characters`);
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 100_000)
    throw new FinanceRuleError(`Line ${position}: the quantity is a whole number from 1`);
  const gross = Money.ofMinor(input.unitPriceMinor, header.currency).times(input.quantity);
  if (input.discountMinor < 0 || input.discountMinor > gross.amountMinor)
    throw new FinanceRuleError(`Line ${position}: the discount is more than the line`);
  const amount = gross.subtract(Money.ofMinor(input.discountMinor, header.currency));
  if (input.taxCode === null)
    return {
      ...input,
      description,
      position,
      taxComponents: [],
      netMinor: amount.amountMinor,
      taxMinor: 0,
      grossMinor: amount.amountMinor,
    };
  const code = taxCodes.get(input.taxCode);
  if (code === undefined)
    throw new FinanceRuleError(`Line ${position}: unknown tax code ${input.taxCode}`);
  const taxed = code.apply(amount, header.issueDate, header.pricesIncludeTax);
  return {
    ...input,
    description,
    position,
    taxComponents: taxed.components.map((c) => ({
      key: c.key,
      name: c.name,
      rate: c.rate,
      amountMinor: c.amount.amountMinor,
    })),
    netMinor: taxed.net.amountMinor,
    taxMinor: taxed.tax.amountMinor,
    grossMinor: taxed.gross.amountMinor,
  };
}
