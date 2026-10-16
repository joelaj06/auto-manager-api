import { randomBytes } from "node:crypto";
import type { IIdGenerator } from "../../application/ports/IIdGenerator.js";

/**
 * RFC 9562 UUIDv7: 48-bit Unix milliseconds, then random bits. Time-ordered, so ids created by
 * the application index as well as PostgreSQL's own uuidv7() defaults.
 */
export class UuidV7Generator implements IIdGenerator {
  constructor(private readonly nowMs: () => number = Date.now) {}

  next(): string {
    const bytes = randomBytes(16);
    const ms = this.nowMs();
    bytes.writeUIntBE(ms, 0, 6);
    bytes[6] = 0x70 | (bytes[6]! & 0x0f); // version 7
    bytes[8] = 0x80 | (bytes[8]! & 0x3f); // RFC 9562 variant
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
