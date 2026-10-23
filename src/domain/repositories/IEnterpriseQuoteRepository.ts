import type { EnterpriseQuote, QuoteLine } from "../billing/EnterpriseQuote.js";

/** One line of a tenant's price list (from its accepted quote). */
export type PriceItem = QuoteLine &
  Readonly<{
    id: string;
    subscriptionId: string;
    quoteId: string;
    /** One-time items: the invoice that charged them; null until then. */
    invoiceId: string | null;
    createdAt: Date;
  }>;

/** Enterprise quotes and subscription price items (platform database, platform unit of work). */
export interface IEnterpriseQuoteRepository {
  /** The next quote code for `year`, e.g. AF-QUO-2026-000007. */
  nextQuoteCode(year: number): Promise<string>;
  nextVersion(tenantId: string): Promise<number>;
  quote(id: string, lock?: boolean): Promise<EnterpriseQuote | null>;
  save(quote: EnterpriseQuote): Promise<void>;
  /** Newest version first. */
  quotes(tenantId: string): Promise<EnterpriseQuote[]>;
  accepted(tenantId: string, lock?: boolean): Promise<EnterpriseQuote | null>;

  /** The price list in force (not ended). */
  priceItems(subscriptionId: string): Promise<PriceItem[]>;
  /** Ends the current price list and starts the quote's (one item per line). */
  replacePriceItems(
    subscriptionId: string,
    quoteId: string,
    lines: readonly QuoteLine[],
    now: Date,
  ): Promise<void>;
  endPriceItems(subscriptionId: string, now: Date): Promise<void>;
  markItemsInvoiced(itemIds: readonly string[], invoiceId: string): Promise<void>;
  /** A voided invoice gives its one-time items back to the next one. */
  releaseItems(invoiceId: string): Promise<void>;
}
