import { describe, expect, it } from "vitest";
import { InvalidReferralCodeError, ReferralCode } from "../value-objects/ReferralCode.js";
import { Partner, PartnerInactiveError, PartnerStateError } from "./Partner.js";

const now = new Date("2026-10-16T10:00:00Z");
const partner = () =>
  Partner.create({
    id: "p1",
    profile: {
      name: " Kofi Sales ",
      kind: "individual",
      contactName: "Kofi",
      email: "KOFI@Example.com",
      phone: "+233241234567",
      region: " ",
      address: null,
      tin: null,
    },
    referralCode: ReferralCode.parse("kofi1234"),
    capabilities: ["b", "a", "a"],
    now,
  });

describe("Partner", () => {
  it("starts active with a clean profile and sorted capabilities", () => {
    const p = partner().snapshot();
    expect(p).toMatchObject({ status: "active", trusted: false, referralCode: "KOFI1234" });
    expect(p.profile).toMatchObject({
      name: "Kofi Sales",
      email: "kofi@example.com",
      region: null,
    });
    expect(p.capabilities).toEqual(["a", "b"]);
  });

  it("pauses, resumes and terminates; paused and terminated partners cannot onboard", () => {
    const p = partner();
    p.pause("Investigating complaints", now);
    expect(() => p.assertCanOnboard()).toThrow(PartnerInactiveError);
    expect(() => p.pause("again", now)).toThrow(PartnerStateError);
    p.resume("Resolved", now);
    p.assertCanOnboard();
    p.terminate("Contract ended", now);
    expect(() => p.resume("x", now)).toThrow(PartnerStateError);
    expect(() => p.update({ trusted: true })).toThrow(PartnerStateError);
    expect(() => p.setCapabilities([])).toThrow(PartnerStateError);
  });

  it("reports whether capabilities changed", () => {
    const p = partner();
    expect(p.setCapabilities(["a", "b"])).toBe(false);
    expect(p.setCapabilities(["a"])).toBe(true);
  });
});

describe("ReferralCode", () => {
  it("parses any case and refuses bad codes", () => {
    expect(ReferralCode.parse(" kofi7q2m ").value).toBe("KOFI7Q2M");
    for (const bad of ["abc", "TOO-LONG", "X".repeat(17)])
      expect(() => ReferralCode.parse(bad)).toThrow(InvalidReferralCodeError);
    expect(ReferralCode.tryParse("not a code")).toBeNull();
  });

  it("generates codes from the name with readable random characters", () => {
    const bytes = (n: number) => new Uint8Array(n).fill(0);
    expect(ReferralCode.generate("Kofi Sales", bytes).value).toBe("KOFIAAAA");
    expect(ReferralCode.generate("A1", bytes).value).toBe("AAAAAAAA");
    expect(ReferralCode.generate("12", bytes).value).toMatch(/^[A-Z2-9]{8}$/);
  });
});
