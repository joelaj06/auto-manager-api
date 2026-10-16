import { describe, expect, it } from "vitest";
import {
  TenantLifecycle,
  TenantStateError,
  type TenantLifecycleStatus,
} from "./TenantLifecycle.js";

const now = new Date("2026-10-16T10:00:00Z");
const tenant = (status: TenantLifecycleStatus) =>
  TenantLifecycle.restore({
    id: "t1",
    slug: "alpha",
    name: "Alpha",
    status,
    previousStatus: null,
    deactivationReason: null,
    statusMessage: null,
    autoRestoreLocked: false,
    statusChangedAt: null,
  });

describe("TenantLifecycle", () => {
  it("deactivates and restores to the previous status", () => {
    const t = tenant("trialing");
    expect(t.deactivate("requested_pause", "Paused at your request", true, now)).toEqual({
      from: "trialing",
      to: "deactivated",
      reasonCategory: "requested_pause",
      message: "Paused at your request",
    });
    expect(t.snapshot()).toMatchObject({ autoRestoreLocked: true, previousStatus: "trialing" });
    expect(t.reactivate(now).to).toBe("trialing");
    expect(t.snapshot()).toMatchObject({
      deactivationReason: null,
      statusMessage: null,
      autoRestoreLocked: false,
    });
  });

  it("remembers the status before read-only across a deactivation", () => {
    const t = tenant("past_due");
    t.setReadOnly("Writes paused", now);
    t.deactivate("abuse", null, true, now);
    expect(t.reactivate(now).to).toBe("past_due");
  });

  it("clears read-only back to the previous status", () => {
    const t = tenant("active");
    t.setReadOnly(null, now);
    expect(t.clearReadOnly(now)).toMatchObject({ from: "read_only", to: "active" });
  });

  it("refuses impossible transitions", () => {
    expect(() => tenant("provisioning").deactivate("other", null, true, now)).toThrow(
      TenantStateError,
    );
    expect(() => tenant("active").reactivate(now)).toThrow(TenantStateError);
    expect(() => tenant("deactivated").setReadOnly(null, now)).toThrow(TenantStateError);
    expect(() => tenant("active").clearReadOnly(now)).toThrow(TenantStateError);
  });
});
