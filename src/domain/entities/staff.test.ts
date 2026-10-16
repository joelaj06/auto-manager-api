import { describe, expect, it } from "vitest";
import {
  ApprovalNotPendingError,
  ApprovalReasonRequiredError,
  ApprovalRequest,
  SelfApprovalError,
} from "./ApprovalRequest.js";
import { StaffAccount, StaffAccountDisabledError } from "./StaffAccount.js";

const now = new Date("2026-10-16T10:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
const policy = { maxFailedAttempts: 3, lockMs: 900_000 };

const activeAccount = () => {
  const account = StaffAccount.invite({ id: "s1", email: " Ama@Example.COM ", name: " Ama " });
  account.setPassword("hash");
  account.startTotpEnrolment("sealed");
  account.confirmTotpEnrolment(100, now);
  return account;
};

describe("StaffAccount", () => {
  it("starts invited and becomes active after password and TOTP enrolment", () => {
    const account = StaffAccount.invite({ id: "s1", email: " Ama@Example.COM ", name: " Ama " });
    expect([account.status, account.email, account.name]).toEqual([
      "invited",
      "ama@example.com",
      "Ama",
    ]);
    expect(activeAccount().status).toBe("active");
    expect(activeAccount().totpLastStep).toBe(100);
  });

  it("locks after repeated failures and unlocks with time", () => {
    const account = activeAccount();
    expect(account.recordFailedAttempt(now, policy)).toBe(false);
    expect(account.recordFailedAttempt(now, policy)).toBe(false);
    expect(account.recordFailedAttempt(now, policy)).toBe(true);
    expect(account.isLocked(later(1))).toBe(true);
    expect(account.isLocked(later(900_000))).toBe(false);
    account.recordSuccessfulLogin(later(900_000));
    expect(account.snapshot()).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it("invalidates tokens when disabled or MFA is reset", () => {
    const account = activeAccount();
    account.disable();
    expect([account.status, account.permissionVersion]).toEqual(["disabled", 2]);
    expect(() => account.setPassword("x")).toThrow(StaffAccountDisabledError);
    account.enable();
    expect(account.status).toBe("active");

    account.resetMfa();
    expect([account.status, account.mfaEnrolled, account.permissionVersion]).toEqual([
      "invited",
      false,
      3,
    ]);
  });
});

describe("ApprovalRequest", () => {
  const open = () =>
    ApprovalRequest.open({
      id: "a1",
      action: "platform.staff.grant_role",
      payload: { userId: "s2" },
      summary: "Grant Super Admin to Kofi",
      reason: "New CTO joined",
      requestedBy: "s1",
      now,
      ttlMs: 86_400_000,
    });

  it("needs a reason", () => {
    expect(() =>
      ApprovalRequest.open({
        id: "a",
        action: "x.y",
        payload: {},
        summary: "s",
        reason: " ok ",
        requestedBy: "s1",
        now,
        ttlMs: 1,
      }),
    ).toThrow(ApprovalReasonRequiredError);
  });

  it("cannot be decided by the requester", () => {
    expect(() => open().reject("s1", null, later(1))).toThrow(SelfApprovalError);
  });

  it("records approval with the action's outcome", () => {
    const approved = open();
    approved.approveAndRecord("s2", "ok", later(1), { ok: true, result: { done: true } });
    expect(approved.snapshot()).toMatchObject({
      status: "approved",
      decidedBy: "s2",
      result: { done: true },
    });
    expect(() => approved.reject("s3", null, later(2))).toThrow(ApprovalNotPendingError);

    const failed = open();
    failed.approveAndRecord("s2", null, later(1), { ok: false, error: "boom" });
    expect(failed.snapshot()).toMatchObject({ status: "failed", error: "boom", executedAt: null });
  });

  it("expires", () => {
    const request = open();
    expect(() => request.reject("s2", null, later(86_400_000))).toThrow(ApprovalNotPendingError);
    expect(request.status).toBe("expired");
  });
});
