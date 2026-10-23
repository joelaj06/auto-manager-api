import {
  EnterpriseQuote,
  type QuoteLine,
  type QuoteProps,
} from "../../domain/billing/EnterpriseQuote.js";
import type {
  IEnterpriseQuoteRepository,
  PriceItem,
} from "../../domain/repositories/IEnterpriseQuoteRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  code: string;
  tenant_id: string;
  subscription_id: string;
  version: number;
  status: QuoteProps["status"];
  lines: QuoteLine[];
  currency: string;
  recurring_minor: string;
  one_time_minor: string;
  size_band: QuoteProps["sizeBand"];
  size_note: string | null;
  notes: string | null;
  valid_until: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  approved_by: string | null;
  sent_at: Date | null;
  accepted_at: Date | null;
  accepted_by_type: "user" | "platform_staff" | null;
  accepted_by: string | null;
  closed_at: Date | null;
};

type ItemRow = {
  id: string;
  subscription_id: string;
  quote_id: string;
  kind: PriceItem["kind"];
  description: string;
  quantity: number;
  unit_minor: string;
  recurrence: PriceItem["recurrence"];
  counts_as_licence: boolean;
  invoice_id: string | null;
  created_at: Date;
};

const QUOTE_COLUMNS = `id, code, tenant_id, subscription_id, version, status, lines, currency,
  recurring_minor, one_time_minor, size_band, size_note, notes, valid_until::text, created_by,
  created_at, updated_at, approved_by, sent_at, accepted_at, accepted_by_type, accepted_by,
  closed_at`;

const toQuote = (r: QuoteRow): EnterpriseQuote =>
  EnterpriseQuote.restore({
    id: r.id,
    code: r.code,
    tenantId: r.tenant_id,
    subscriptionId: r.subscription_id,
    version: r.version,
    status: r.status,
    lines: r.lines,
    currency: r.currency,
    recurringMinor: Number(r.recurring_minor),
    oneTimeMinor: Number(r.one_time_minor),
    sizeBand: r.size_band,
    sizeNote: r.size_note,
    notes: r.notes,
    validUntil: r.valid_until,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedBy: r.approved_by,
    sentAt: r.sent_at,
    acceptedAt: r.accepted_at,
    acceptedBy:
      r.accepted_by_type === null || r.accepted_by === null
        ? null
        : { type: r.accepted_by_type, id: r.accepted_by },
    closedAt: r.closed_at,
  });

const toItem = (r: ItemRow): PriceItem => ({
  id: r.id,
  subscriptionId: r.subscription_id,
  quoteId: r.quote_id,
  kind: r.kind,
  description: r.description,
  quantity: r.quantity,
  unitMinor: Number(r.unit_minor),
  recurrence: r.recurrence,
  countsAsLicence: r.counts_as_licence,
  invoiceId: r.invoice_id,
  createdAt: r.created_at,
});

export class PostgresEnterpriseQuoteRepository implements IEnterpriseQuoteRepository {
  constructor(private readonly db: PlatformDb) {}

  async nextQuoteCode(year: number): Promise<string> {
    const { rows } = await this.db.query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [`enterprise_quote:${year}`],
    );
    return `AF-QUO-${year}-${rows[0]!.value.padStart(6, "0")}`;
  }

  async nextVersion(tenantId: string): Promise<number> {
    const { rows } = await this.db.query<{ v: number }>(
      "select coalesce(max(version), 0)::int + 1 as v from enterprise_quotes where tenant_id = $1",
      [tenantId],
    );
    return rows[0]!.v;
  }

  async quote(id: string, lock = false): Promise<EnterpriseQuote | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<QuoteRow>(
      `select ${QUOTE_COLUMNS} from enterprise_quotes where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toQuote(rows[0]);
  }

  async save(quote: EnterpriseQuote): Promise<void> {
    const q = quote.snapshot();
    await this.db.query(
      `insert into enterprise_quotes (id, code, tenant_id, subscription_id, version, status, lines,
         currency, recurring_minor, one_time_minor, size_band, size_note, notes, valid_until,
         created_by, created_at, updated_at, approved_by, sent_at, accepted_at, accepted_by_type,
         accepted_by, closed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23)
       on conflict (id) do update set
         status = excluded.status, lines = excluded.lines,
         recurring_minor = excluded.recurring_minor, one_time_minor = excluded.one_time_minor,
         size_band = excluded.size_band, size_note = excluded.size_note, notes = excluded.notes,
         valid_until = excluded.valid_until, updated_at = excluded.updated_at,
         approved_by = excluded.approved_by, sent_at = excluded.sent_at,
         accepted_at = excluded.accepted_at, accepted_by_type = excluded.accepted_by_type,
         accepted_by = excluded.accepted_by, closed_at = excluded.closed_at`,
      [
        q.id,
        q.code,
        q.tenantId,
        q.subscriptionId,
        q.version,
        q.status,
        JSON.stringify(q.lines),
        q.currency,
        q.recurringMinor,
        q.oneTimeMinor,
        q.sizeBand,
        q.sizeNote,
        q.notes,
        q.validUntil,
        q.createdBy,
        q.createdAt,
        q.updatedAt,
        q.approvedBy,
        q.sentAt,
        q.acceptedAt,
        q.acceptedBy?.type ?? null,
        q.acceptedBy?.id ?? null,
        q.closedAt,
      ],
    );
  }

  async quotes(tenantId: string): Promise<EnterpriseQuote[]> {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<QuoteRow>(
      `select ${QUOTE_COLUMNS} from enterprise_quotes where tenant_id = $1 order by version desc`,
      [tenantId],
    );
    return rows.map(toQuote);
  }

  async accepted(tenantId: string, lock = false): Promise<EnterpriseQuote | null> {
    const { rows } = await this.db.query<QuoteRow>(
      `select ${QUOTE_COLUMNS} from enterprise_quotes
        where tenant_id = $1 and status = 'accepted'${lock ? " for update" : ""}`,
      [tenantId],
    );
    return rows[0] === undefined ? null : toQuote(rows[0]);
  }

  async priceItems(subscriptionId: string): Promise<PriceItem[]> {
    const { rows } = await this.db.query<ItemRow>(
      `select id, subscription_id, quote_id, kind, description, quantity, unit_minor, recurrence,
              counts_as_licence, invoice_id, created_at
         from subscription_price_items
        where subscription_id = $1 and ended_at is null
        order by created_at, id`,
      [subscriptionId],
    );
    return rows.map(toItem);
  }

  async replacePriceItems(
    subscriptionId: string,
    quoteId: string,
    lines: readonly QuoteLine[],
    now: Date,
  ): Promise<void> {
    await this.endPriceItems(subscriptionId, now);
    for (const l of lines)
      await this.db.query(
        `insert into subscription_price_items (subscription_id, quote_id, kind, description,
           quantity, unit_minor, recurrence, counts_as_licence, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          subscriptionId,
          quoteId,
          l.kind,
          l.description,
          l.quantity,
          l.unitMinor,
          l.recurrence,
          l.countsAsLicence,
          now,
        ],
      );
  }

  async endPriceItems(subscriptionId: string, now: Date): Promise<void> {
    await this.db.query(
      `update subscription_price_items set ended_at = $2
        where subscription_id = $1 and ended_at is null`,
      [subscriptionId, now],
    );
  }

  async markItemsInvoiced(itemIds: readonly string[], invoiceId: string): Promise<void> {
    if (itemIds.length === 0) return;
    await this.db.query(
      "update subscription_price_items set invoice_id = $2 where id = any($1::uuid[])",
      [itemIds, invoiceId],
    );
  }

  async releaseItems(invoiceId: string): Promise<void> {
    await this.db.query(
      "update subscription_price_items set invoice_id = null where invoice_id = $1",
      [invoiceId],
    );
  }
}
