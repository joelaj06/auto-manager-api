import type { ReadableType, ReceiptFields } from "../../domain/expenses/ReceiptReading.js";

/** Reading failed; `permanent` ones (a refusal, a bad key) are not tried again. */
export class ReceiptReaderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export type ReceiptRead = ReceiptFields &
  Readonly<{ model: string; inputTokens: number; outputTokens: number }>;

/** Reads a receipt's image or PDF; a suggestion for a person to check, never a posted figure. */
export interface IReceiptReader {
  /** False when no provider is configured: reading is then not offered at all. */
  readonly configured: boolean;
  read(file: Readonly<{ bytes: Uint8Array; contentType: ReadableType }>): Promise<ReceiptRead>;
}
