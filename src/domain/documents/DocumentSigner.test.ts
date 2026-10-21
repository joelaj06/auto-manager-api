import { describe, expect, it } from "vitest";
import { DocumentSigner } from "./DocumentSigner.js";
import { IssuedDocument } from "./IssuedDocument.js";

const now = new Date("2026-10-21T09:00:00Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1_000);
const signer = (overrides: Partial<Parameters<typeof DocumentSigner.add>[0]> = {}) =>
  DocumentSigner.add({
    id: "s1",
    documentId: "d1",
    position: 1,
    role: "driver",
    label: "Driver",
    partyType: "driver",
    partyId: "p1",
    name: "Kwame",
    phone: "+233241234567",
    email: null,
    required: true,
    now,
    ...overrides,
  });
const evidence = {
  method: "drawn" as const,
  signatureFileId: "f1",
  typedName: null,
  documentSha256: "a".repeat(64),
  otpVerifiedAt: now,
  ip: "1.2.3.4",
  userAgent: "Android",
  now,
};

describe("signers", () => {
  it("need a way to be reached when they are guests", () => {
    expect(() => signer({ partyType: "guest", partyId: null, phone: null })).toThrow(
      /phone number or an email/,
    );
  });

  it("wait a minute between codes", () => {
    const s = signer();
    s.otpSent("sms", now);
    expect(() => s.otpSent("sms", later(30))).toThrow(/wait a minute/);
    s.otpSent("sms", later(61));
  });

  it("sign once, with their evidence, or decline with a reason", () => {
    const s = signer();
    s.sign(evidence);
    expect(s.snapshot()).toMatchObject({ status: "signed", method: "drawn", ip: "1.2.3.4" });
    expect(s.snapshot().consentText).toMatch(/agree to sign it electronically/);
    expect(() => s.sign(evidence)).toThrow(/already given/);
    const other = signer({ id: "s2" });
    expect(() => other.decline("no", null, now)).toThrow(/Say why/);
    other.decline("Wrong vehicle", null, now);
    expect(() => other.sign(evidence)).toThrow(/declined/);
    expect(() =>
      signer({ id: "s3" }).sign({ ...evidence, method: "typed", typedName: " " }),
    ).toThrow(/Type your full name/);
  });
});

describe("documents being signed", () => {
  const doc = () =>
    IssuedDocument.issue({
      id: "d1",
      number: "HND-2026-000001",
      type: "vehicle_handover",
      language: "en",
      templateId: null,
      templateVersion: "system-1",
      templateBody: "",
      subjectType: "vehicle_assignment",
      subjectId: "a1",
      branchId: null,
      data: {},
      verificationCode: "ABCDEFGHJKMN",
      issuedBy: null,
      replacesId: null,
      signingExpiresAt: later(3_600),
      now,
    });

  it("move from pending to partially and fully signed", () => {
    const d = doc();
    expect(d.snapshot().status).toBe("pending_signatures");
    d.signatureAdded(false, now);
    expect(d.snapshot().status).toBe("partially_signed");
    d.signatureAdded(true, later(60));
    expect(d.snapshot()).toMatchObject({ status: "fully_signed", fullySignedAt: later(60) });
    expect(() => d.assertSignable(later(61))).toThrow(/already signed/);
    d.signedPdf("f9", "b".repeat(64));
    expect(() => d.signedPdf("f10", "c".repeat(64))).toThrow(/already has its signed PDF/);
  });

  it("expire after their deadline and stop when declined", () => {
    const d = doc();
    expect(() => d.assertSignable(later(3_601))).toThrow(/run out/);
    expect(d.expire(later(10))).toBe(false);
    expect(d.expire(later(3_601))).toBe(true);
    expect(d.snapshot().status).toBe("expired");
    const e = doc();
    e.declined();
    expect(() => e.assertSignable(now)).toThrow(/declined and can no longer be signed/);
  });
});
