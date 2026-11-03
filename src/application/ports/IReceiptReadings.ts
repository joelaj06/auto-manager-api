import type { Confidence, ReceiptFields } from "../../domain/expenses/ReceiptReading.js";

export type ReceiptReadingSettings = Readonly<{ enabled: boolean; monthlyLimit: number }>;

export type ReceiptReadingStatus = "uploading" | "queued" | "done" | "failed" | "skipped";

export type ReceiptReadingRecord = Readonly<{
  id: string;
  fileId: string;
  expenseId: string | null;
  status: ReceiptReadingStatus;
  merchant: string | null;
  date: string | null;
  total: string | null;
  tax: string | null;
  currency: string | null;
  isReceipt: boolean | null;
  confidence: Confidence | null;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  readAt: Date | null;
}>;

export interface IReceiptReadings {
  settings(): Promise<ReceiptReadingSettings>;
  saveSettings(settings: ReceiptReadingSettings, userId: string, now: Date): Promise<void>;
  /** A scan waiting for its upload; the id was given to the file as its owner. */
  startScan(id: string, fileId: string, createdBy: string): Promise<void>;
  /** Queues an attached receipt, reading it afresh if it was read before; returns the id. */
  queueAttached(fileId: string, expenseId: string, createdBy: string, now: Date): Promise<string>;
  queue(id: string, now: Date): Promise<void>;
  find(id: string): Promise<ReceiptReadingRecord | null>;
  findByFile(fileId: string): Promise<ReceiptReadingRecord | null>;
  /** Readings queued since `since`: what counts against the monthly limit. */
  usedSince(since: Date): Promise<number>;
  finish(
    id: string,
    read: ReceiptFields & Readonly<{ model: string; inputTokens: number; outputTokens: number }>,
    now: Date,
  ): Promise<void>;
  stop(id: string, status: "failed" | "skipped", error: string, now: Date): Promise<void>;
  attach(id: string, expenseId: string): Promise<void>;
  /** Scans never attached, started before `before`. */
  unattached(before: Date, limit: number): Promise<ReceiptReadingRecord[]>;
  remove(id: string): Promise<void>;
}
