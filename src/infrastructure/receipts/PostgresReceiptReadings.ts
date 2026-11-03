import type {
  IReceiptReadings,
  ReceiptReadingRecord,
  ReceiptReadingSettings,
} from "../../application/ports/IReceiptReadings.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  file_id: string;
  expense_id: string | null;
  status: ReceiptReadingRecord["status"];
  merchant: string | null;
  receipt_date: string | null;
  total: string | null;
  tax: string | null;
  currency: string | null;
  is_receipt: boolean | null;
  confidence: ReceiptReadingRecord["confidence"];
  error: string | null;
  created_by: string | null;
  created_at: Date;
  read_at: Date | null;
};

const COLUMNS = `id, file_id, expense_id, status, merchant, receipt_date::text as receipt_date,
  total::text as total, tax::text as tax, currency, is_receipt, confidence, error, created_by,
  created_at, read_at`;

const toRecord = (r: Row): ReceiptReadingRecord => ({
  id: r.id,
  fileId: r.file_id,
  expenseId: r.expense_id,
  status: r.status,
  merchant: r.merchant,
  date: r.receipt_date,
  total: r.total,
  tax: r.tax,
  currency: r.currency,
  isReceipt: r.is_receipt,
  confidence: r.confidence,
  error: r.error,
  createdBy: r.created_by,
  createdAt: r.created_at,
  readAt: r.read_at,
});

export class PostgresReceiptReadings implements IReceiptReadings {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async settings(): Promise<ReceiptReadingSettings> {
    const { rows } = await this.tx.query<{ enabled: boolean; monthly_limit: number }>(
      "select enabled, monthly_limit from receipt_reading_settings",
    );
    return { enabled: rows[0]!.enabled, monthlyLimit: rows[0]!.monthly_limit };
  }

  async saveSettings(settings: ReceiptReadingSettings, userId: string, now: Date): Promise<void> {
    await this.tx.query(
      `update receipt_reading_settings
          set enabled = $1, monthly_limit = $2, updated_by = $3, updated_at = $4`,
      [settings.enabled, settings.monthlyLimit, userId, now],
    );
  }

  async startScan(id: string, fileId: string, createdBy: string): Promise<void> {
    await this.tx.query(
      "insert into receipt_readings (id, file_id, created_by) values ($1, $2, $3)",
      [id, fileId, createdBy],
    );
  }

  async queueAttached(
    fileId: string,
    expenseId: string,
    createdBy: string,
    now: Date,
  ): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into receipt_readings (file_id, expense_id, status, created_by, queued_at)
       values ($1, $2, 'queued', $3, $4)
       on conflict (file_id) do update
         set status = 'queued', queued_at = excluded.queued_at, error = null,
             expense_id = excluded.expense_id
       returning id`,
      [fileId, expenseId, createdBy, now],
    );
    return rows[0]!.id;
  }

  async queue(id: string, now: Date): Promise<void> {
    await this.tx.query(
      "update receipt_readings set status = 'queued', queued_at = $2, error = null where id = $1",
      [id, now],
    );
  }

  async find(id: string): Promise<ReceiptReadingRecord | null> {
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from receipt_readings where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async findByFile(fileId: string): Promise<ReceiptReadingRecord | null> {
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from receipt_readings where file_id = $1`,
      [fileId],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async usedSince(since: Date): Promise<number> {
    const { rows } = await this.tx.query<{ used: string }>(
      "select count(*) as used from receipt_readings where queued_at >= $1",
      [since],
    );
    return Number(rows[0]!.used);
  }

  async finish(id: string, read: Parameters<IReceiptReadings["finish"]>[1], now: Date) {
    await this.tx.query(
      `update receipt_readings
          set status = 'done', merchant = $2, receipt_date = $3, total = $4, tax = $5,
              currency = $6, is_receipt = $7, confidence = $8, model = $9, input_tokens = $10,
              output_tokens = $11, error = null, read_at = $12
        where id = $1`,
      [
        id,
        read.merchant,
        read.date,
        read.total,
        read.tax,
        read.currency,
        read.isReceipt,
        read.confidence,
        read.model,
        read.inputTokens,
        read.outputTokens,
        now,
      ],
    );
  }

  async stop(id: string, status: "failed" | "skipped", error: string, now: Date) {
    await this.tx.query(
      "update receipt_readings set status = $2, error = $3, read_at = $4 where id = $1",
      [id, status, error.slice(0, 1_000), now],
    );
  }

  async attach(id: string, expenseId: string): Promise<void> {
    await this.tx.query("update receipt_readings set expense_id = $2 where id = $1", [
      id,
      expenseId,
    ]);
  }

  async unattached(before: Date, limit: number): Promise<ReceiptReadingRecord[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from receipt_readings
        where expense_id is null and created_at < $1
        order by created_at
        limit $2`,
      [before, limit],
    );
    return rows.map(toRecord);
  }

  async remove(id: string): Promise<void> {
    await this.tx.query("delete from receipt_readings where id = $1", [id]);
  }
}
