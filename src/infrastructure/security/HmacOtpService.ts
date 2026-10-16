import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { IOtpService } from "../../application/ports/IOtpService.js";
import type { OtpPurpose } from "../../domain/enums/OtpPurpose.js";

const CODE = /^\d{6}$/;

/**
 * Six-digit codes from the CSPRNG, stored as HMAC-SHA256 keyed with OTP_SECRET and bound to
 * purpose and subject: a code for one purpose or person never verifies another, and a database
 * leak alone does not allow brute-forcing the million possible codes offline.
 */
export class HmacOtpService implements IOtpService {
  constructor(private readonly secret: string) {}

  generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  hash(subject: string, purpose: OtpPurpose, code: string): string {
    return createHmac("sha256", this.secret)
      .update(`${purpose}\n${subject}\n${code}`)
      .digest("hex");
  }

  matches(hash: string, subject: string, purpose: OtpPurpose, code: string): boolean {
    if (!CODE.test(code)) return false;
    const expected = Buffer.from(hash, "hex");
    const actual = Buffer.from(this.hash(subject, purpose, code), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
