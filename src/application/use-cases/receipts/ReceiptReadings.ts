import {
  isReadable,
  MAX_IMAGE_BYTES,
  readingWarnings,
  type ExpenseFigures,
} from "../../../domain/expenses/ReceiptReading.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IJobHandler, JobContext } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import { ReceiptReaderError, type IReceiptReader } from "../../ports/IReceiptReader.js";
import type {
  IReceiptReadings,
  ReceiptReadingRecord,
  ReceiptReadingSettings,
} from "../../ports/IReceiptReadings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FileService, FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { recordUserAction } from "../reference/userAudit.js";

export class ReceiptReadingOffError extends ApplicationError {
  readonly code = "RECEIPT_READING_OFF";
  constructor() {
    super("Reading receipts is not switched on for this business");
  }
}

export class ReceiptReadingLimitError extends ApplicationError {
  readonly code = "RECEIPT_READING_LIMIT";
  constructor(limit: number) {
    super(`This business has used its ${limit} receipt readings for the month`);
  }
}

export class ReceiptReadingNotFoundError extends ApplicationError {
  readonly code = "RECEIPT_READING_NOT_FOUND";
  constructor() {
    super("Receipt reading not found");
  }
}

/** A scan never attached to an expense is cleared away after this long. */
const SCAN_KEPT_MS = 7 * 86_400_000;
const PURGE_BATCH = 200;
/** pg-boss gives a failing job this many runs in all (the catalogue's retry limit plus one). */
const LAST_ATTEMPT = 4;

export type ReceiptReadingView = Omit<ReceiptReadingRecord, "createdBy"> &
  Readonly<{ warnings: readonly string[] }>;

/** The part of Expenses reading depends on: reaching an expense under its own rules. */
export type ReadableExpenses = Readonly<{
  forReading(
    actor: Principal,
    id: string,
    permission: "expenses.view" | "expenses.create",
  ): Promise<ExpenseFigures>;
  adoptReceipt(
    actor: Principal,
    id: string,
    fileId: string,
    from: OwnedDocuments,
    fromId: string,
  ): Promise<void>;
  receiptOf(id: string, fileId: string): Promise<FileView>;
}>;

const view = (
  { createdBy: _createdBy, ...record }: ReceiptReadingRecord,
  warnings: readonly string[] = [],
): ReceiptReadingView => ({ ...record, warnings });

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Reading receipts (docs/12, decisions 520–522), off until the business switches it on because the
 * photo leaves for an outside AI provider. A person scans a receipt first and gets the figures to
 * fill the expense in with, or a receipt already attached is read, and the approver sees where it
 * disagrees with the expense. A reading is only ever a suggestion: nothing here changes an expense
 * or the books.
 */
export class ReceiptReadings {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      readings: IReceiptReadings;
      expenses: ReadableExpenses;
      /** Scans: one file each, owned by the reading until it joins an expense. */
      scans: OwnedDocuments;
      reader: IReceiptReader;
      queue: IJobQueue;
      tenantContext: ITenantContext;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async settings(): Promise<
    ReceiptReadingSettings & Readonly<{ available: boolean; usedThisMonth: number }>
  > {
    const { deps } = this;
    return deps.unitOfWork.run(async () => ({
      ...(await deps.readings.settings()),
      available: deps.reader.configured,
      usedThisMonth: await deps.readings.usedSince(monthStart(deps.clock.now())),
    }));
  }

  async setSettings(actor: Principal, changes: Partial<ReceiptReadingSettings>) {
    const { deps } = this;
    if (changes.enabled === true && !deps.reader.configured) throw new ReceiptReadingOffError();
    await deps.unitOfWork.run(async () => {
      const before = await deps.readings.settings();
      const after = { ...before, ...changes };
      await deps.readings.saveSettings(after, actor.userId, deps.clock.now());
      await recordUserAction(deps, actor.userId, {
        action: "settings.receipt_reading_updated",
        entityType: "organisation",
        before,
        after,
      });
    });
    return this.settings();
  }

  /** Scan first: the upload for a receipt that has no expense yet. */
  async startScan(
    actor: Principal,
    input: DocumentUploadInput,
  ): Promise<UploadStarted & Readonly<{ readingId: string }>> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.assertAvailable());
    const id = deps.ids.next();
    const started = await deps.scans.start(id, input, actor.userId);
    await deps.unitOfWork.run(() => deps.readings.startScan(id, started.file.id, actor.userId));
    return { ...started, readingId: id };
  }

  async completeScan(actor: Principal, id: string): Promise<ReceiptReadingView> {
    const { deps } = this;
    const scan = await this.ownScan(actor, id);
    await deps.scans.complete(id, scan.fileId);
    if (scan.status === "uploading")
      await deps.unitOfWork.run(async () => {
        await this.assertAvailable();
        await deps.readings.queue(id, deps.clock.now());
      });
    await this.enqueue(id);
    return this.scan(actor, id);
  }

  async scan(actor: Principal, id: string): Promise<ReceiptReadingView> {
    return view(await this.ownScan(actor, id));
  }

  /** Attaches the scanned receipt to the expense filled in from it. */
  async attachScan(actor: Principal, id: string, expenseId: string): Promise<ReceiptReadingView> {
    const { deps } = this;
    const scan = await this.ownScan(actor, id);
    await deps.expenses.adoptReceipt(actor, expenseId, scan.fileId, deps.scans, id);
    await deps.unitOfWork.run(() => deps.readings.attach(id, expenseId));
    return this.attached(actor, expenseId, scan.fileId);
  }

  /** Reads a receipt already attached (again, if it was read before). */
  async readAttached(
    actor: Principal,
    expenseId: string,
    fileId: string,
  ): Promise<ReceiptReadingView> {
    const { deps } = this;
    await deps.expenses.forReading(actor, expenseId, "expenses.create");
    await deps.expenses.receiptOf(expenseId, fileId);
    const id = await deps.unitOfWork.run(async () => {
      await this.assertAvailable();
      return deps.readings.queueAttached(fileId, expenseId, actor.userId, deps.clock.now());
    });
    await this.enqueue(id);
    return this.attached(actor, expenseId, fileId);
  }

  /** After a receipt is uploaded to an expense: read it if the business reads receipts. */
  async afterUpload(actor: Principal, expenseId: string, fileId: string): Promise<void> {
    try {
      await this.readAttached(actor, expenseId, fileId);
    } catch (error) {
      // The receipt is attached either way; reading is a help, not part of the upload.
      if (error instanceof ReceiptReadingOffError || error instanceof ReceiptReadingLimitError)
        return;
      throw error;
    }
  }

  async attached(actor: Principal, expenseId: string, fileId: string): Promise<ReceiptReadingView> {
    const { deps } = this;
    const expense = await deps.expenses.forReading(actor, expenseId, "expenses.view");
    const reading = await deps.unitOfWork.run(() => deps.readings.findByFile(fileId));
    if (reading === null || reading.expenseId !== expenseId)
      throw new ReceiptReadingNotFoundError();
    const read = reading.status === "done" && reading.isReceipt !== null;
    return view(
      reading,
      read ? readingWarnings({ ...reading, isReceipt: reading.isReceipt }, expense) : [],
    );
  }

  private async ownScan(actor: Principal, id: string): Promise<ReceiptReadingRecord> {
    const { deps } = this;
    const scan = await deps.unitOfWork.run(() => deps.readings.find(id));
    if (scan === null || scan.createdBy !== actor.userId || scan.expenseId !== null)
      throw new ReceiptReadingNotFoundError();
    return scan;
  }

  private async assertAvailable(): Promise<void> {
    const { deps } = this;
    const settings = await deps.readings.settings();
    if (!settings.enabled || !deps.reader.configured) throw new ReceiptReadingOffError();
    const used = await deps.readings.usedSince(monthStart(deps.clock.now()));
    if (used >= settings.monthlyLimit) throw new ReceiptReadingLimitError(settings.monthlyLimit);
  }

  private async enqueue(id: string): Promise<void> {
    const { deps } = this;
    await deps.queue.enqueue(
      "tenant.receipt_read",
      { tenantId: deps.tenantContext.currentTenantId().value, readingId: id },
      { singletonKey: id },
    );
  }
}

/**
 * Sends one queued receipt to the reader, outside any transaction: a slow provider holds no
 * connection. Runs again safely: only a queued reading is read.
 */
export class ReadReceipt implements IJobHandler<"tenant.receipt_read"> {
  readonly job = "tenant.receipt_read" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      readings: IReceiptReadings;
      files: FileService;
      reader: IReceiptReader;
      clock: IClock;
    }>,
  ) {}

  async handle(
    { readingId }: JobPayloads["tenant.receipt_read"],
    context: JobContext,
  ): Promise<void> {
    const { deps } = this;
    const reading = await deps.unitOfWork.run(() => deps.readings.find(readingId));
    if (reading === null || reading.status !== "queued") return;
    const stop = (status: "failed" | "skipped", why: string) =>
      deps.unitOfWork.run(() => deps.readings.stop(readingId, status, why, deps.clock.now()));
    if (!deps.reader.configured) return stop("skipped", "Reading is not set up");
    const file = await deps.files.get(reading.fileId);
    const { contentType } = file;
    if (!isReadable(contentType)) return stop("skipped", "This kind of file cannot be read");
    if (contentType !== "application/pdf" && file.sizeBytes > MAX_IMAGE_BYTES)
      return stop("skipped", "This photo is too large to read (over 5 MB)");
    try {
      const read = await deps.reader.read({
        bytes: await deps.files.read(reading.fileId),
        contentType,
      });
      await deps.unitOfWork.run(() => deps.readings.finish(readingId, read, deps.clock.now()));
    } catch (error) {
      if (!(error instanceof ReceiptReaderError)) throw error;
      if (!error.permanent && context.attempt < LAST_ATTEMPT) throw error;
      await stop("failed", error.message);
    }
  }
}

/** Clears away scans nobody attached to an expense. */
export class PurgeUnattachedScans implements ITenantDailyTask {
  readonly name = "receipt_scans";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      readings: IReceiptReadings;
      scans: OwnedDocuments;
      clock: IClock;
    }>,
  ) {}

  async run(): Promise<void> {
    const { deps } = this;
    const before = new Date(deps.clock.now().getTime() - SCAN_KEPT_MS);
    const scans = await deps.unitOfWork.run(() => deps.readings.unattached(before, PURGE_BATCH));
    for (const scan of scans) {
      await deps.unitOfWork.run(() => deps.readings.remove(scan.id));
      await deps.scans.remove(scan.id, scan.fileId);
    }
  }
}
