import type { IQuotes, QuoteFilter } from "../../application/ports/IDealerSales.js";
import { Quote, type AddOn, type QuoteProps } from "../../domain/dealer/Quote.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  "id",
  "number",
  "branch_id",
  "lead_id",
  "customer_id",
  "customer_name",
  "vehicle_id",
  "status",
  "price_minor",
  "discount_minor",
  "trade_in_description",
  "trade_in_minor",
  "financing",
  "deposit_minor",
  "term_months",
  "financing_note",
  "valid_until",
  "notes",
  "below_minimum",
  "approved_by",
  "approved_at",
  "document_id",
  "sent_at",
  "decided_at",
  "decision_note",
  "created_by",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, unknown>;
const SELECT = COLUMNS.map((c) => (c === "valid_until" ? `q.${c}::text as ${c}` : `q.${c}`)).join(
  ", ",
);

const minor = (value: unknown): number | null => (value === null ? null : Number(value));

function toRow(p: QuoteProps): Row {
  return {
    id: p.id,
    number: p.number,
    branch_id: p.branchId,
    lead_id: p.leadId,
    customer_id: p.customerId,
    customer_name: p.customerName,
    vehicle_id: p.vehicleId,
    status: p.status,
    price_minor: p.priceMinor,
    discount_minor: p.discountMinor,
    trade_in_description: p.tradeInDescription,
    trade_in_minor: p.tradeInMinor,
    financing: p.financing,
    deposit_minor: p.depositMinor,
    term_months: p.termMonths,
    financing_note: p.financingNote,
    valid_until: p.validUntil,
    notes: p.notes,
    below_minimum: p.belowMinimum,
    approved_by: p.approvedBy,
    approved_at: p.approvedAt,
    document_id: p.documentId,
    sent_at: p.sentAt,
    decided_at: p.decidedAt,
    decision_note: p.decisionNote,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const toQuote = (r: Row, addOns: AddOn[]): Quote =>
  Quote.restore({
    id: r.id as string,
    number: r.number as string,
    branchId: r.branch_id as string,
    leadId: r.lead_id as string | null,
    customerId: r.customer_id as string | null,
    customerName: r.customer_name as string,
    vehicleId: r.vehicle_id as string,
    status: r.status as QuoteProps["status"],
    priceMinor: Number(r.price_minor),
    discountMinor: Number(r.discount_minor),
    addOns,
    tradeInDescription: r.trade_in_description as string | null,
    tradeInMinor: Number(r.trade_in_minor),
    financing: r.financing as QuoteProps["financing"],
    depositMinor: minor(r.deposit_minor),
    termMonths: r.term_months as number | null,
    financingNote: r.financing_note as string | null,
    validUntil: r.valid_until as string,
    notes: r.notes as string | null,
    belowMinimum: r.below_minimum as boolean,
    approvedBy: r.approved_by as string | null,
    approvedAt: r.approved_at as Date | null,
    documentId: r.document_id as string | null,
    sentAt: r.sent_at as Date | null,
    decidedAt: r.decided_at as Date | null,
    decisionNote: r.decision_note as string | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });

export class PostgresQuotes implements IQuotes {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(quote: Quote): Promise<void> {
    const values = toRow(quote.snapshot());
    await this.tx.query(
      `insert into dealer_quotes (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
    await this.items(quote);
  }

  async update(quote: Quote): Promise<void> {
    const values = toRow(quote.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update dealer_quotes set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
    await this.items(quote);
  }

  get(id: string): Promise<Quote | null> {
    return this.one(id, "");
  }

  lock(id: string): Promise<Quote | null> {
    return this.one(id, "for update");
  }

  async list(filter: QuoteFilter): Promise<Quote[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("q.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.leadId !== undefined) add("q.lead_id = ?", filter.leadId);
    if (filter.vehicleId !== undefined) add("q.vehicle_id = ?", filter.vehicleId);
    if (filter.customerId !== undefined) add("q.customer_id = ?", filter.customerId);
    if (filter.statuses !== undefined) add("q.status = any(?::text[])", filter.statuses);
    if (filter.beforeId !== undefined && UUID.test(filter.beforeId))
      add("q.id < ?", filter.beforeId);
    params.push(filter.limit);
    return this.load(
      `${where.length === 0 ? "" : `where ${where.join(" and ")}`}
       order by q.id desc limit $${params.length}`,
      params,
    );
  }

  async lapsed(today: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      "select id from dealer_quotes where status = 'sent' and valid_until < $1::date order by id",
      [today],
    );
    return rows.map((r) => r.id);
  }

  private async items(quote: Quote): Promise<void> {
    const p = quote.snapshot();
    await this.tx.query("delete from dealer_quote_items where quote_id = $1", [p.id]);
    if (p.addOns.length > 0)
      await this.tx.query(
        `insert into dealer_quote_items (quote_id, position, kind, description, amount_minor)
         select $1, n, k, d, a
           from unnest($2::text[], $3::text[], $4::bigint[]) with ordinality as x (k, d, a, n)`,
        [
          p.id,
          p.addOns.map((a) => a.kind),
          p.addOns.map((a) => a.description),
          p.addOns.map((a) => a.amountMinor),
        ],
      );
  }

  private async one(id: string, lock: string): Promise<Quote | null> {
    if (!UUID.test(id)) return null;
    const [quote] = await this.load(`where q.id = $1 ${lock}`, [id]);
    return quote ?? null;
  }

  private async load(tail: string, params: unknown[]): Promise<Quote[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_quotes q ${tail}`,
      params,
    );
    if (rows.length === 0) return [];
    const items = await this.tx.query<{
      quote_id: string;
      kind: AddOn["kind"];
      description: string;
      amount_minor: string;
    }>(
      `select quote_id, kind, description, amount_minor from dealer_quote_items
        where quote_id = any($1::uuid[]) order by quote_id, position`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) =>
      toQuote(
        r,
        items.rows
          .filter((i) => i.quote_id === r.id)
          .map((i) => ({
            kind: i.kind,
            description: i.description,
            amountMinor: Number(i.amount_minor),
          })),
      ),
    );
  }
}
