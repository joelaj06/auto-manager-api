import { describe, expect, it } from "vitest";
import { OwnerProtectedError, TenantUser, UserDisabledError } from "./TenantUser.js";

const now = new Date("2026-10-16T10:00:00Z");
const policy = { maxFailedAttempts: 3, lockMs: 60_000 };

describe("TenantUser", () => {
  it("activates on the first password and bumps the version on later changes", () => {
    const user = TenantUser.invite({
      id: "u1",
      name: " Ama ",
      email: " Ama@Example.com ",
      phone: null,
    });
    expect([user.status, user.email, user.name]).toEqual(["invited", "ama@example.com", "Ama"]);
    user.setPassword("h1");
    expect([user.status, user.permissionVersion]).toEqual(["active", 1]);
    user.setPassword("h2");
    expect(user.permissionVersion).toBe(2);
  });

  it("locks after repeated failures", () => {
    const user = TenantUser.invite({ id: "u1", name: "Ama", email: "a@b.co", phone: null });
    user.setPassword("h");
    user.recordFailedAttempt(now, policy);
    user.recordFailedAttempt(now, policy);
    expect(user.recordFailedAttempt(now, policy)).toBe(true);
    expect(user.isLocked(new Date(now.getTime() + 59_000))).toBe(true);
    expect(user.isLocked(new Date(now.getTime() + 60_000))).toBe(false);
  });

  it("protects the owner and blocks disabled users from setting passwords", () => {
    const owner = TenantUser.restore({
      ...TenantUser.invite({ id: "o", name: "O", email: "o@b.co", phone: null }).snapshot(),
      isOwner: true,
    });
    expect(() => owner.disable()).toThrow(OwnerProtectedError);
    const user = TenantUser.invite({ id: "u", name: "U", email: "u@b.co", phone: null });
    user.disable();
    expect(user.permissionVersion).toBe(2);
    expect(() => user.setPassword("h")).toThrow(UserDisabledError);
    user.enable();
    expect(user.status).toBe("invited");
  });
});
