import { describe, expect, it } from "vitest";
import { PhoneNumber, InvalidPhoneNumberError } from "../value-objects/PhoneNumber.js";
import { InvalidSlugError, TenantSlug } from "../value-objects/TenantSlug.js";
import {
  ApplicationMessageRequiredError,
  ApplicationStateError,
  TenantApplication,
} from "./TenantApplication.js";

const now = new Date("2026-10-16T10:00:00Z");
const details = {
  businessName: "Kofi Motors",
  businessType: "rental" as const,
  country: "GH",
  desiredSlug: "kofi-motors",
  contactName: "Kofi Mensah",
  contactEmail: "kofi@example.com",
  contactPhone: "+233241234567",
  tin: null,
  registrationNumber: null,
  expectedBranches: 2,
  expectedVehicles: 30,
  heardAbout: null,
  referralCode: null,
};
const submit = () =>
  TenantApplication.submit({
    id: "a1",
    details,
    source: "self",
    createdByStaffId: null,
    accessTokenHash: "h",
    risk: { level: "low", signals: [] },
    ip: null,
    userAgent: null,
    now,
  });
const verified = () => {
  const app = submit();
  app.markVerified("email", now);
  app.markVerified("phone", now);
  return app;
};

describe("TenantApplication", () => {
  it("enters review only when email and phone are verified", () => {
    const app = submit();
    expect(app.markVerified("email", now)).toBe(false);
    expect(app.status).toBe("pending_verification");
    expect(app.markVerified("phone", now)).toBe(true);
    expect(app.status).toBe("pending_review");
    expect(app.snapshot().submittedAt).toEqual(now);
  });

  it("goes back to review when the applicant answers an information request", () => {
    const app = verified();
    app.requestInfo("Please send your business registration number");
    expect(app.status).toBe("needs_info");
    app.reply("Here it is", { registrationNumber: "CS123456789", tin: undefined });
    expect(app.status).toBe("pending_review");
    expect(app.details.registrationNumber).toBe("CS123456789");
    expect(app.details.tin).toBeNull();
  });

  it("approves only from review and records the options", () => {
    expect(() => submit().approve("s1", { plan: "standard", trialDays: 14 }, null, now)).toThrow(
      ApplicationStateError,
    );
    const app = verified();
    app.approve("s1", { plan: "standard", trialDays: 14 }, "looks good", now);
    expect(app.snapshot()).toMatchObject({
      status: "approved",
      reviewedBy: "s1",
      approvalOptions: { trialDays: 14 },
    });
    expect(() => app.reject("s1", "changed my mind", null, now)).toThrow(ApplicationStateError);
  });

  it("rejects with a reason and an optional re-apply date", () => {
    const app = verified();
    expect(() => app.reject("s1", "no", null, now)).toThrow(ApplicationMessageRequiredError);
    const until = new Date("2026-11-15T10:00:00Z");
    app.reject("s1", "Duplicate of an existing business", until, now);
    expect(app.snapshot()).toMatchObject({ status: "rejected", reapplyAfter: until });
  });
});

describe("PhoneNumber", () => {
  it("normalises Ghana and international input to E.164", () => {
    for (const input of [
      "024 123 4567",
      "0241234567",
      "+233 24 123 4567",
      "00233241234567",
      "233241234567",
    ]) {
      expect(PhoneNumber.parse(input).value, input).toBe("+233241234567");
    }
    expect(PhoneNumber.parse("+44 20 7946 0958").value).toBe("+442079460958");
    expect(PhoneNumber.parse("024 123 4567").masked()).toBe("+23324***4567");
  });

  it("rejects malformed numbers", () => {
    for (const input of ["", "12", "024 123 456", "+233 24 123 45678", "phone"]) {
      expect(() => PhoneNumber.parse(input), input).toThrow(InvalidPhoneNumberError);
    }
  });
});

describe("TenantSlug", () => {
  it("accepts simple names and refuses reserved or malformed ones", () => {
    expect(TenantSlug.parse(" Kofi-Motors ").value).toBe("kofi-motors");
    for (const input of [
      "admin",
      "www",
      "a",
      "-abc",
      "abc-",
      "ab--cd",
      "has space",
      "x".repeat(41),
    ]) {
      expect(() => TenantSlug.parse(input), input).toThrow(InvalidSlugError);
    }
  });
});
