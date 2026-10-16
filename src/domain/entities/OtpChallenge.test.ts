import { describe, expect, it } from "vitest";
import { OtpChallengeClosedError } from "../errors/AuthErrors.js";
import { OtpChallenge } from "./OtpChallenge.js";

const now = new Date("2026-10-14T10:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

const issue = (maxAttempts = 3) =>
  OtpChallenge.issue({
    id: "c1",
    subject: "user-1",
    purpose: "password_reset",
    codeHash: "hash",
    now,
    ttlMs: 600_000,
    maxAttempts,
  });

describe("OtpChallenge", () => {
  it("verifies once with the right code", () => {
    const challenge = issue();
    expect(challenge.attempt(true, later(1_000))).toBe("verified");
    expect(() => challenge.attempt(true, later(2_000))).toThrow(OtpChallengeClosedError);
  });

  it("counts wrong guesses and locks at the limit", () => {
    const challenge = issue(3);
    expect(challenge.attempt(false, later(1))).toBe("invalid");
    expect(challenge.remainingAttempts).toBe(2);
    expect(challenge.attempt(false, later(2))).toBe("invalid");
    expect(challenge.attempt(false, later(3))).toBe("locked");
    // Even the right code is refused once locked.
    expect(challenge.attempt(true, later(4))).toBe("locked");
  });

  it("expires", () => {
    expect(issue().attempt(true, later(600_000))).toBe("expired");
  });

  it("cannot be used after being invalidated by a newer code", () => {
    const challenge = issue();
    challenge.invalidate(later(1));
    expect(() => challenge.attempt(true, later(2))).toThrow(OtpChallengeClosedError);
  });
});
