/** What can be sent to be read; the file kind also allows nothing else. */
export const READABLE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;
export type ReadableType = (typeof READABLE_TYPES)[number];

/** The API takes images up to 5 MB; PDFs up to the 10 MB a receipt may be. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const isReadable = (contentType: string): contentType is ReadableType =>
  (READABLE_TYPES as readonly string[]).includes(contentType);

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export type ReceiptFields = Readonly<{
  merchant: string | null;
  /** YYYY-MM-DD. */
  date: string | null;
  /** Decimal strings as printed. */
  total: string | null;
  tax: string | null;
  /** ISO 4217. */
  currency: string | null;
  isReceipt: boolean;
  confidence: Confidence;
}>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,14}(\.\d{1,4})?$/;

function amount(value: string | null): string | null {
  const plain = value?.replace(/[,\s]/g, "") ?? null;
  return plain !== null && AMOUNT.test(plain) ? plain : null;
}

function realDate(value: string | null, today: string): string | null {
  if (value === null || !DATE.test(value) || value > today) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

/**
 * Keeps what can stand as a figure: a model reading a photo is an outside source, so anything that
 * is not a real amount, a past date or a currency code is dropped rather than shown as read.
 */
export function cleanReading(raw: ReceiptFields, today: string): ReceiptFields {
  const currency = raw.currency?.trim().toUpperCase() ?? null;
  const merchant = raw.merchant?.trim().slice(0, 200) ?? null;
  return {
    merchant: merchant === "" ? null : merchant,
    date: realDate(raw.date, today),
    total: amount(raw.total),
    tax: amount(raw.tax),
    currency: currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : null,
    isReceipt: raw.isReceipt,
    confidence: raw.confidence,
  };
}

export type ExpenseFigures = Readonly<{
  status: string;
  /** As shown to people. */
  amount: string;
  amountMinor: number;
  currency: string;
  date: string;
}>;

const cents = (value: string) => Math.round(Number(value) * 100);

/** Where the receipt and the expense disagree: for the person approving, not a block. */
export function readingWarnings(
  fields: Pick<ReceiptFields, "date" | "total" | "currency" | "isReceipt">,
  expense: ExpenseFigures,
): string[] {
  if (!fields.isReceipt) return ["This does not look like a receipt"];
  const warnings: string[] = [];
  const sameCurrency = fields.currency === null || fields.currency === expense.currency;
  if (!sameCurrency)
    warnings.push(`The receipt is in ${fields.currency}, the expense in ${expense.currency}`);
  if (sameCurrency && fields.total !== null && cents(fields.total) !== expense.amountMinor)
    warnings.push(`The receipt says ${fields.total}, the expense ${expense.amount}`);
  if (fields.date !== null && fields.date !== expense.date)
    warnings.push(`The receipt is dated ${fields.date}, the expense ${expense.date}`);
  return warnings;
}
