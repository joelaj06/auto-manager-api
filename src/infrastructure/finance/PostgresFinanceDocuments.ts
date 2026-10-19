import type {
  CashSessionListFilter,
  FinanceSettings,
  IFinanceQueries,
  IFinanceSettingsStore,
  InvoiceListFilter,
  IPartyDirectory,
  PaymentListFilter,
} from "../../application/ports/IFinanceRecords.js";
import { DEFAULT_FINANCE_SETTINGS } from "../../application/ports/IFinanceRecords.js";
import { CashSession, type CashSessionProps } from "../../domain/finance/CashSession.js";
import { Invoice, type InvoiceLine, type InvoiceProps } from "../../domain/finance/Invoice.js";
import type { LedgerPartyType } from "../../domain/finance/Journal.js";
import { Payment, type PaymentProps } from "../../domain/finance/Payment.js";
import type {
  Allocation,
  ICashSessionRepository,
  IInvoiceRepository,
  IPaymentRepository,
} from "../../domain/repositories/IFinanceRepositories.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** numeric(20,10) comes back with trailing zeros: "15.4200000000" → "15.42". */
const trimRate = (rate: string) =>
  rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate;
const num = (value: string | null) => (value === null ? null : Number(value));

type Tx = ReturnType<PostgresTransactionContext["current"]>;

// --- invoices ---

type InvoiceRow = {
  id: string;
  number: string | null;
  status: InvoiceProps["status"];
  party_type: InvoiceProps["partyType"];
  party_id: string;
  party_name: string;
  branch_id: string;
  vehicle_id: string | null;
  issue_date: string;
  due_date: string;
  currency: string;
  fx_rate: string;
  prices_include_tax: boolean;
  subtotal_minor: string;
  tax_minor: string;
  total_minor: string;
  paid_minor: string;
  total_base_minor: string | null;
  source_type: string | null;
  source_id: string | null;
  notes: string | null;
  issued_at: Date | null;
  issued_by: string | null;
  void_reason: string | null;
  voided_at: Date | null;
  voided_by: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type LineRow = {
  invoice_id: string;
  position: number;
  description: string;
  quantity: number;
  unit_price_minor: string;
  discount_minor: string;
  tax_code: string | null;
  tax_components: InvoiceLine["taxComponents"];
  net_minor: string;
  tax_minor: string;
  gross_minor: string;
  account_id: string;
  vehicle_id: string | null;
};

const INVOICE_COLUMNS = `id, number, status, party_type, party_id, party_name, branch_id, vehicle_id,
  issue_date::text as issue_date, due_date::text as due_date, currency, fx_rate::text as fx_rate,
  prices_include_tax, subtotal_minor, tax_minor, total_minor, paid_minor, total_base_minor,
  source_type, source_id, notes, issued_at, issued_by, void_reason, voided_at, voided_by,
  created_by, created_at, updated_at`;

const toLine = (r: LineRow): InvoiceLine => ({
  position: r.position,
  description: r.description,
  quantity: r.quantity,
  unitPriceMinor: Number(r.unit_price_minor),
  discountMinor: Number(r.discount_minor),
  taxCode: r.tax_code,
  taxComponents: r.tax_components,
  netMinor: Number(r.net_minor),
  taxMinor: Number(r.tax_minor),
  grossMinor: Number(r.gross_minor),
  accountId: r.account_id,
  vehicleId: r.vehicle_id,
});

const toInvoice = (r: InvoiceRow, lines: InvoiceLine[]): InvoiceProps => ({
  id: r.id,
  number: r.number,
  status: r.status,
  partyType: r.party_type,
  partyId: r.party_id,
  partyName: r.party_name,
  branchId: r.branch_id,
  vehicleId: r.vehicle_id,
  issueDate: r.issue_date,
  dueDate: r.due_date,
  currency: r.currency.trim(),
  fxRate: trimRate(r.fx_rate),
  pricesIncludeTax: r.prices_include_tax,
  lines,
  subtotalMinor: Number(r.subtotal_minor),
  taxMinor: Number(r.tax_minor),
  totalMinor: Number(r.total_minor),
  paidMinor: Number(r.paid_minor),
  totalBaseMinor: num(r.total_base_minor),
  sourceType: r.source_type,
  sourceId: r.source_id,
  notes: r.notes,
  issuedAt: r.issued_at,
  issuedBy: r.issued_by,
  voidReason: r.void_reason,
  voidedAt: r.voided_at,
  voidedBy: r.voided_by,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function withLines(tx: Tx, rows: InvoiceRow[]): Promise<InvoiceProps[]> {
  if (rows.length === 0) return [];
  const { rows: lines } = await tx.query<LineRow>(
    "select * from invoice_lines where invoice_id = any($1::uuid[]) order by invoice_id, position",
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => toInvoice(r, lines.filter((l) => l.invoice_id === r.id).map(toLine)));
}

/** Invoices with their lines in the tenant database. */
export class PostgresInvoiceRepository implements IInvoiceRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  findById(id: string): Promise<Invoice | null> {
    return this.one(id, "");
  }

  lockById(id: string): Promise<Invoice | null> {
    return this.one(id, "for update");
  }

  private async one(id: string, lock: string): Promise<Invoice | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from invoices where id = $1 ${lock}`,
      [id],
    );
    const [props] = await withLines(this.tx, rows);
    return props === undefined ? null : Invoice.restore(props);
  }

  async save(invoice: Invoice): Promise<void> {
    const p = invoice.snapshot();
    await this.tx.query(
      `insert into invoices (id, number, status, party_type, party_id, party_name, branch_id,
         vehicle_id, issue_date, due_date, currency, fx_rate, prices_include_tax, subtotal_minor,
         tax_minor, total_minor, paid_minor, total_base_minor, source_type, source_id, notes,
         issued_at, issued_by, void_reason, voided_at, voided_by, created_by, created_at,
         updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
       on conflict (id) do update set number = excluded.number, status = excluded.status,
         party_type = excluded.party_type, party_id = excluded.party_id,
         party_name = excluded.party_name, branch_id = excluded.branch_id,
         vehicle_id = excluded.vehicle_id, issue_date = excluded.issue_date,
         due_date = excluded.due_date, currency = excluded.currency, fx_rate = excluded.fx_rate,
         prices_include_tax = excluded.prices_include_tax,
         subtotal_minor = excluded.subtotal_minor, tax_minor = excluded.tax_minor,
         total_minor = excluded.total_minor, paid_minor = excluded.paid_minor,
         total_base_minor = excluded.total_base_minor, notes = excluded.notes,
         issued_at = excluded.issued_at, issued_by = excluded.issued_by,
         void_reason = excluded.void_reason, voided_at = excluded.voided_at,
         voided_by = excluded.voided_by, updated_at = excluded.updated_at`,
      [
        p.id,
        p.number,
        p.status,
        p.partyType,
        p.partyId,
        p.partyName,
        p.branchId,
        p.vehicleId,
        p.issueDate,
        p.dueDate,
        p.currency,
        p.fxRate,
        p.pricesIncludeTax,
        p.subtotalMinor,
        p.taxMinor,
        p.totalMinor,
        p.paidMinor,
        p.totalBaseMinor,
        p.sourceType,
        p.sourceId,
        p.notes,
        p.issuedAt,
        p.issuedBy,
        p.voidReason,
        p.voidedAt,
        p.voidedBy,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
      ],
    );
    // Lines change only while a draft is revised or issued (tax snapshot): rewrite them.
    await this.tx.query("delete from invoice_lines where invoice_id = $1", [p.id]);
    for (const l of p.lines)
      await this.tx.query(
        `insert into invoice_lines (invoice_id, position, description, quantity, unit_price_minor,
           discount_minor, tax_code, tax_components, net_minor, tax_minor, gross_minor,
           account_id, vehicle_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          p.id,
          l.position,
          l.description,
          l.quantity,
          l.unitPriceMinor,
          l.discountMinor,
          l.taxCode,
          JSON.stringify(l.taxComponents),
          l.netMinor,
          l.taxMinor,
          l.grossMinor,
          l.accountId,
          l.vehicleId,
        ],
      );
  }

  async deleteDraft(id: string): Promise<void> {
    await this.tx.query("delete from invoices where id = $1 and status = 'draft'", [id]);
  }
}

// --- payments ---

type PaymentRow = {
  id: string;
  number: string;
  direction: PaymentProps["direction"];
  method: PaymentProps["method"];
  status: PaymentProps["status"];
  party_type: LedgerPartyType | null;
  party_id: string | null;
  party_name: string;
  branch_id: string;
  paid_on: string;
  currency: string;
  fx_rate: string;
  amount_minor: string;
  amount_base_minor: string;
  allocated_minor: string;
  counter_account_id: string | null;
  reference: string | null;
  momo_network: PaymentProps["momoNetwork"];
  cash_session_id: string | null;
  vehicle_id: string | null;
  notes: string | null;
  recorded_by: string | null;
  recorded_at: Date;
  reversed_at: Date | null;
  reversed_by: string | null;
  reverse_reason: string | null;
};

const PAYMENT_COLUMNS = `id, number, direction, method, status, party_type, party_id, party_name,
  branch_id, paid_on::text as paid_on, currency, fx_rate::text as fx_rate, amount_minor,
  amount_base_minor, allocated_minor, counter_account_id, reference, momo_network,
  cash_session_id, vehicle_id, notes, recorded_by, recorded_at, reversed_at, reversed_by,
  reverse_reason`;

const toPayment = (r: PaymentRow): PaymentProps => ({
  id: r.id,
  number: r.number,
  direction: r.direction,
  method: r.method,
  status: r.status,
  party:
    r.party_type === null || r.party_id === null ? null : { type: r.party_type, id: r.party_id },
  partyName: r.party_name,
  branchId: r.branch_id,
  paidOn: r.paid_on,
  currency: r.currency.trim(),
  fxRate: trimRate(r.fx_rate),
  amountMinor: Number(r.amount_minor),
  amountBaseMinor: Number(r.amount_base_minor),
  allocatedMinor: Number(r.allocated_minor),
  counterAccountId: r.counter_account_id,
  reference: r.reference,
  momoNetwork: r.momo_network,
  cashSessionId: r.cash_session_id,
  vehicleId: r.vehicle_id,
  notes: r.notes,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at,
  reversedAt: r.reversed_at,
  reversedBy: r.reversed_by,
  reverseReason: r.reverse_reason,
});

/** Payments and allocations in the tenant database. */
export class PostgresPaymentRepository implements IPaymentRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  findById(id: string): Promise<Payment | null> {
    return this.one(id, "");
  }

  lockById(id: string): Promise<Payment | null> {
    return this.one(id, "for update");
  }

  private async one(id: string, lock: string): Promise<Payment | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<PaymentRow>(
      `select ${PAYMENT_COLUMNS} from payments where id = $1 ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : Payment.restore(toPayment(rows[0]));
  }

  async save(payment: Payment): Promise<void> {
    const p = payment.snapshot();
    await this.tx.query(
      `insert into payments (id, number, direction, method, status, party_type, party_id,
         party_name, branch_id, paid_on, currency, fx_rate, amount_minor, amount_base_minor,
         allocated_minor, counter_account_id, reference, momo_network, cash_session_id,
         vehicle_id, notes, recorded_by, recorded_at, reversed_at, reversed_by, reverse_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26)
       on conflict (id) do update set status = excluded.status,
         allocated_minor = excluded.allocated_minor, reversed_at = excluded.reversed_at,
         reversed_by = excluded.reversed_by, reverse_reason = excluded.reverse_reason`,
      [
        p.id,
        p.number,
        p.direction,
        p.method,
        p.status,
        p.party?.type ?? null,
        p.party?.id ?? null,
        p.partyName,
        p.branchId,
        p.paidOn,
        p.currency,
        p.fxRate,
        p.amountMinor,
        p.amountBaseMinor,
        p.allocatedMinor,
        p.counterAccountId,
        p.reference,
        p.momoNetwork,
        p.cashSessionId,
        p.vehicleId,
        p.notes,
        p.recordedBy,
        p.recordedAt,
        p.reversedAt,
        p.reversedBy,
        p.reverseReason,
      ],
    );
  }

  async allocations(
    filter: Readonly<{ paymentId?: string; invoiceId?: string }>,
  ): Promise<Allocation[]> {
    const { rows } = await this.tx.query<{
      id: string;
      payment_id: string;
      invoice_id: string;
      amount_minor: string;
      allocated_at: Date;
      allocated_by: string | null;
      released_at: Date | null;
      released_by: string | null;
      release_reason: string | null;
    }>(
      `select * from payment_allocations
        where ($1::uuid is null or payment_id = $1) and ($2::uuid is null or invoice_id = $2)
        order by allocated_at`,
      [filter.paymentId ?? null, filter.invoiceId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      paymentId: r.payment_id,
      invoiceId: r.invoice_id,
      amountMinor: Number(r.amount_minor),
      allocatedAt: r.allocated_at,
      allocatedBy: r.allocated_by,
      releasedAt: r.released_at,
      releasedBy: r.released_by,
      releaseReason: r.release_reason,
    }));
  }

  async saveAllocation(a: Allocation): Promise<void> {
    await this.tx.query(
      `insert into payment_allocations (id, payment_id, invoice_id, amount_minor, allocated_at,
         allocated_by, released_at, released_by, release_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update set released_at = excluded.released_at,
         released_by = excluded.released_by, release_reason = excluded.release_reason`,
      [
        a.id,
        a.paymentId,
        a.invoiceId,
        a.amountMinor,
        a.allocatedAt,
        a.allocatedBy,
        a.releasedAt,
        a.releasedBy,
        a.releaseReason,
      ],
    );
  }
}

// --- cash sessions ---

type SessionRow = {
  id: string;
  branch_id: string;
  cashier_id: string;
  status: CashSessionProps["status"];
  opened_at: Date;
  opening_float_minor: string;
  cash_in_minor: string;
  cash_out_minor: string;
  closed_at: Date | null;
  counted_minor: string | null;
  variance_minor: string | null;
  closed_by: string | null;
  notes: string | null;
};

const toSession = (r: SessionRow): CashSessionProps => ({
  id: r.id,
  branchId: r.branch_id,
  cashierId: r.cashier_id,
  status: r.status,
  openedAt: r.opened_at,
  openingFloatMinor: Number(r.opening_float_minor),
  cashInMinor: Number(r.cash_in_minor),
  cashOutMinor: Number(r.cash_out_minor),
  closedAt: r.closed_at,
  countedMinor: num(r.counted_minor),
  varianceMinor: num(r.variance_minor),
  closedBy: r.closed_by,
  notes: r.notes,
});

/** Cash sessions in the tenant database. */
export class PostgresCashSessionRepository implements ICashSessionRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<CashSession | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<SessionRow>("select * from cash_sessions where id = $1", [
      id,
    ]);
    return rows[0] === undefined ? null : CashSession.restore(toSession(rows[0]));
  }

  async lockById(id: string): Promise<CashSession | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<SessionRow>(
      "select * from cash_sessions where id = $1 for update",
      [id],
    );
    return rows[0] === undefined ? null : CashSession.restore(toSession(rows[0]));
  }

  async lockOpenFor(cashierId: string): Promise<CashSession | null> {
    const { rows } = await this.tx.query<SessionRow>(
      "select * from cash_sessions where cashier_id = $1 and status = 'open' for update",
      [cashierId],
    );
    return rows[0] === undefined ? null : CashSession.restore(toSession(rows[0]));
  }

  async save(session: CashSession): Promise<void> {
    const s = session.snapshot();
    await this.tx.query(
      `insert into cash_sessions (id, branch_id, cashier_id, status, opened_at,
         opening_float_minor, cash_in_minor, cash_out_minor, closed_at, counted_minor,
         variance_minor, closed_by, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (id) do update set status = excluded.status,
         cash_in_minor = excluded.cash_in_minor, cash_out_minor = excluded.cash_out_minor,
         closed_at = excluded.closed_at, counted_minor = excluded.counted_minor,
         variance_minor = excluded.variance_minor, closed_by = excluded.closed_by,
         notes = excluded.notes`,
      [
        s.id,
        s.branchId,
        s.cashierId,
        s.status,
        s.openedAt,
        s.openingFloatMinor,
        s.cashInMinor,
        s.cashOutMinor,
        s.closedAt,
        s.countedMinor,
        s.varianceMinor,
        s.closedBy,
        s.notes,
      ],
    );
  }
}

// --- reads ---

/** Lists of financial documents in the tenant database. */
export class PostgresFinanceQueries implements IFinanceQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async invoices(filter: InvoiceListFilter): Promise<InvoiceProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["true"];
    if (filter.branchIds !== "all")
      where.push(`branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.branchId !== undefined) where.push(`branch_id = ${param(filter.branchId)}`);
    if (filter.statuses !== undefined)
      where.push(`status = any(${param(filter.statuses)}::text[])`);
    if (filter.party !== undefined)
      where.push(
        `party_type = ${param(filter.party.type)} and party_id = ${param(filter.party.id)}`,
      );
    if (filter.from !== undefined) where.push(`issue_date >= ${param(filter.from)}`);
    if (filter.to !== undefined) where.push(`issue_date <= ${param(filter.to)}`);
    if (filter.overdueOn !== undefined)
      where.push(
        `status in ('issued', 'partially_paid') and due_date < ${param(filter.overdueOn)}`,
      );
    if (filter.after !== undefined)
      where.push(
        `(created_at, id) < (${param(filter.after.createdAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<InvoiceRow>(
      `select ${INVOICE_COLUMNS} from invoices where ${where.join(" and ")}
        order by created_at desc, id desc limit ${param(filter.limit)}`,
      params,
    );
    return withLines(this.tx, rows);
  }

  async payments(filter: PaymentListFilter): Promise<PaymentProps[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["true"];
    if (filter.branchIds !== "all")
      where.push(`branch_id = any(${param(filter.branchIds)}::uuid[])`);
    if (filter.branchId !== undefined) where.push(`branch_id = ${param(filter.branchId)}`);
    if (filter.direction !== undefined) where.push(`direction = ${param(filter.direction)}`);
    if (filter.party !== undefined)
      where.push(
        `party_type = ${param(filter.party.type)} and party_id = ${param(filter.party.id)}`,
      );
    if (filter.cashSessionId !== undefined)
      where.push(`cash_session_id = ${param(filter.cashSessionId)}`);
    if (filter.from !== undefined) where.push(`paid_on >= ${param(filter.from)}`);
    if (filter.to !== undefined) where.push(`paid_on <= ${param(filter.to)}`);
    if (filter.withCredit === true)
      where.push("direction = 'in' and status = 'recorded' and allocated_minor < amount_minor");
    if (filter.after !== undefined)
      where.push(
        `(recorded_at, id) < (${param(filter.after.recordedAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<PaymentRow>(
      `select ${PAYMENT_COLUMNS} from payments where ${where.join(" and ")}
        order by recorded_at desc, id desc limit ${param(filter.limit)}`,
      params,
    );
    return rows.map(toPayment);
  }

  async cashSessions(filter: CashSessionListFilter): Promise<CashSessionProps[]> {
    const { rows } = await this.tx.query<SessionRow>(
      `select * from cash_sessions
        where ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)
          and ($3::uuid is null or cashier_id = $3)
          and ($4::text is null or status = $4)
        order by opened_at desc limit $5`,
      [
        filter.branchIds === "all" ? null : filter.branchIds,
        filter.branchId ?? null,
        filter.cashierId ?? null,
        filter.status ?? null,
        filter.limit,
      ],
    );
    return rows.map(toSession);
  }
}

/** Names of customers, drivers and suppliers for financial documents. */
export class PostgresPartyDirectory implements IPartyDirectory {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async find(
    type: LedgerPartyType,
    id: string,
  ): Promise<Readonly<{ name: string; branchId: string | null }> | null> {
    if (!UUID.test(id)) return null;
    const sql = {
      customer:
        "select name, null::uuid as branch_id from customers where id = $1 and deleted_at is null",
      driver:
        "select first_name || ' ' || last_name as name, branch_id from drivers where id = $1 and deleted_at is null",
      supplier:
        "select name, null::uuid as branch_id from suppliers where id = $1 and deleted_at is null",
    }[type];
    const { rows } = await this.transactions
      .current()
      .query<{ name: string; branch_id: string | null }>(sql, [id]);
    return rows[0] === undefined ? null : { name: rows[0].name, branchId: rows[0].branch_id };
  }
}

/** Finance settings in `organisation.settings->'finance'`, over the defaults. */
export class PostgresFinanceSettingsStore implements IFinanceSettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<FinanceSettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ finance: Partial<FinanceSettings> | null }>(
        "select settings->'finance' as finance from organisation",
      );
    return { ...DEFAULT_FINANCE_SETTINGS, ...(rows[0]?.finance ?? {}) };
  }

  async set(settings: FinanceSettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{finance}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}
