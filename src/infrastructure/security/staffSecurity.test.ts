import { describe, expect, it } from "vitest";
import { InvalidChallengeError } from "../../application/errors/StaffErrors.js";
import { assertAcceptablePassword } from "../../application/services/PasswordPolicy.js";
import { AesGcmSecretBox } from "./AesGcmSecretBox.js";
import { JwtStaffChallenges } from "./JwtStaffChallenges.js";
import { base32Decode, base32Encode, TotpService } from "./TotpService.js";

/** RFC 6238 appendix B secret ("12345678901234567890", SHA-1). */
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TotpService", () => {
  const totp = new TotpService();

  it("matches the RFC 6238 test vectors (last 6 digits)", () => {
    const vectors: [number, string][] = [
      [59, "287082"],
      [1_111_111_109, "081804"],
      [1_111_111_111, "050471"],
      [1_234_567_890, "005924"],
      [2_000_000_000, "279037"],
    ];
    for (const [seconds, code] of vectors) {
      expect(totp.codeAt(RFC_SECRET, new Date(seconds * 1000)), String(seconds)).toBe(code);
    }
  });

  it("accepts one step of drift and refuses replays", () => {
    const now = new Date(1_234_567_890_000);
    const step = Math.floor(1_234_567_890 / 30);
    const previous = totp.codeAt(RFC_SECRET, new Date(now.getTime() - 30_000));
    expect(totp.verify(RFC_SECRET, previous, null, now)).toBe(step - 1);
    expect(totp.verify(RFC_SECRET, "005924", null, now)).toBe(step);
    expect(totp.verify(RFC_SECRET, "005924", step, now)).toBeNull();
    expect(totp.verify(RFC_SECRET, previous, step, now)).toBeNull();
    const tooOld = totp.codeAt(RFC_SECRET, new Date(now.getTime() - 90_000));
    expect(totp.verify(RFC_SECRET, tooOld, null, now)).toBeNull();
    expect(totp.verify(RFC_SECRET, "12345", null, now)).toBeNull();
  });

  it("generates 160-bit secrets and otpauth URIs", () => {
    const secret = totp.generateSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(totp.provisioningUri(secret, "ama@example.com")).toMatch(
      /^otpauth:\/\/totp\/Autoforce%20Manager%3Aama%40example\.com\?secret=[A-Z2-7]+&issuer=Autoforce\+Manager/,
    );
  });
});

describe("AesGcmSecretBox", () => {
  const box = new AesGcmSecretBox("m".repeat(40));

  it("round-trips and never repeats ciphertext", () => {
    const sealed = box.seal("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(box.open(sealed)).toBe("JBSWY3DPEHPK3PXP");
    expect(box.seal("JBSWY3DPEHPK3PXP")).not.toBe(sealed);
  });

  it("rejects tampering and other keys", () => {
    const sealed = box.seal("secret");
    const parts = sealed.split(".");
    parts[2] = Buffer.from("other!").toString("base64url");
    expect(() => box.open(parts.join("."))).toThrow();
    expect(() => new AesGcmSecretBox("k".repeat(40)).open(sealed)).toThrow();
  });
});

describe("JwtStaffChallenges", () => {
  const clock = { now: () => new Date("2026-10-16T10:00:00Z") };
  const challenges = new JwtStaffChallenges("p".repeat(40), "autoforce-test", clock);

  it("round-trips the user for the right step only", async () => {
    const { token } = await challenges.issue("user-1", "mfa");
    await expect(challenges.verify(token, "mfa")).resolves.toBe("user-1");
    await expect(challenges.verify(token, "enrol")).rejects.toBeInstanceOf(InvalidChallengeError);
    await expect(challenges.verify("garbage", "mfa")).rejects.toBeInstanceOf(InvalidChallengeError);
  });

  it("expires after five minutes", async () => {
    const { token } = await challenges.issue("user-1", "mfa");
    const later = new JwtStaffChallenges("p".repeat(40), "autoforce-test", {
      now: () => new Date("2026-10-16T10:05:01Z"),
    });
    await expect(later.verify(token, "mfa")).rejects.toBeInstanceOf(InvalidChallengeError);
  });
});

describe("PasswordPolicy", () => {
  it("requires long, uncommon passwords unrelated to the email", () => {
    expect(() => assertAcceptablePassword("short", "a@b.co")).toThrow(/at least 12/);
    expect(() => assertAcceptablePassword("password1234", "a@b.co")).toThrow(/harder/);
    expect(() => assertAcceptablePassword("kwame.mensah-2026", "kwame.mensah@x.com")).toThrow(
      /harder/,
    );
    expect(() => assertAcceptablePassword("aaaaaaaaaaaaaa", "a@b.co")).toThrow(/harder/);
    expect(() => assertAcceptablePassword("correct horse battery staple", "a@b.co")).not.toThrow();
  });
});
