import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ITotp } from "../../application/ports/ITotp.js";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next step too (clock drift between phone and server). */
const DRIFT_STEPS = 1;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE = /^\d{6}$/;

/**
 * RFC 6238 TOTP with the parameters every authenticator app supports: HMAC-SHA1, 30-second steps,
 * 6 digits, 160-bit secrets. Codes are compared in constant time and a step that was already used
 * (or an earlier one) is refused, so a code cannot be replayed.
 */
export class TotpService implements ITotp {
  constructor(private readonly issuer = "Autoforce Manager") {}

  generateSecret(): string {
    return base32Encode(randomBytes(20));
  }

  provisioningUri(secret: string, accountName: string): string {
    const label = encodeURIComponent(`${this.issuer}:${accountName}`);
    const params = new URLSearchParams({
      secret,
      issuer: this.issuer,
      algorithm: "SHA1",
      digits: String(DIGITS),
      period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  verify(secret: string, code: string, lastUsedStep: number | null, now: Date): number | null {
    if (!CODE.test(code)) return null;
    const key = base32Decode(secret);
    const current = Math.floor(now.getTime() / 1000 / STEP_SECONDS);
    let matched: number | null = null;
    for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
      // Check every candidate (no early exit) to keep timing independent of which one matches.
      if (equal(hotp(key, step), code) && matched === null) matched = step;
    }
    if (matched === null || (lastUsedStep !== null && matched <= lastUsedStep)) return null;
    return matched;
  }

  /** The code for a moment in time (tests, and showing a sample code is never needed in production). */
  codeAt(secret: string, at: Date): string {
    return hotp(base32Decode(secret), Math.floor(at.getTime() / 1000 / STEP_SECONDS));
  }
}

function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return binary.toString().padStart(DIGITS, "0");
}

function equal(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
