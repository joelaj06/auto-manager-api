import { describe, expect, it } from "vitest";
import { DocumentTemplate } from "./DocumentTemplate.js";
import { DOCUMENT_TYPE_CATALOG } from "./DocumentTypes.js";
import {
  groupCode,
  IssuedDocument,
  normaliseVerificationCode,
  verificationCode,
} from "./IssuedDocument.js";

const now = new Date("2026-10-21T09:00:00Z");
const system = DOCUMENT_TYPE_CATALOG.transfer_letter.system.body;
const draft = (body: string) =>
  DocumentTemplate.draft({
    id: "t1",
    type: "transfer_letter",
    language: "en",
    name: "Our transfer letter",
    version: 1,
    body,
    createdBy: "u1",
    now,
  });

describe("document templates", () => {
  it("accepts a business's own wording around the locked clauses", () => {
    const t = draft(
      system.replace("<h2>Agreement</h2>", "<h2>The agreement</h2><p>Thank you.</p>"),
    );
    expect(t.snapshot()).toMatchObject({ status: "draft", systemVersion: 1 });
  });

  it("keeps the locked clauses exactly as the system has them", () => {
    expect(() =>
      draft(system.replace("full ownership of the vehicle", "ownership of the vehicle")),
    ).toThrow(/locked clause "Transfer of ownership" cannot be changed/);
    expect(() =>
      draft(system.replace(/<section data-clause="dvla_responsibility"[\s\S]*?<\/section>/, "")),
    ).toThrow(/"Change of ownership at the DVLA" must stay/);
    expect(() =>
      draft(
        system.replace(
          'data-clause="no_further_amount" data-title="No further amount owed" data-locked',
          'data-clause="no_further_amount" data-title="No further amount owed"',
        ),
      ),
    ).toThrow(/cannot be changed/);
  });

  it("can be edited only as a draft", () => {
    const t = draft(system);
    t.edit({ name: "Renamed" }, now);
    t.activate("u2", now);
    expect(t.snapshot()).toMatchObject({ status: "active", activatedBy: "u2", name: "Renamed" });
    expect(() => t.edit({ name: "Again" }, now)).toThrow(/Only a draft/);
    t.archive(now);
    expect(t.snapshot().status).toBe("archived");
  });
});

describe("verification codes", () => {
  it("are 12 readable characters that survive how people type them", () => {
    const code = verificationCode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(normaliseVerificationCode(groupCode(code).toLowerCase())).toBe(code);
    expect(normaliseVerificationCode("o1i1-L000-0000")).toBe("011110000000");
    expect(normaliseVerificationCode("too-short")).toBeNull();
    expect(groupCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });
});

describe("issued documents", () => {
  const issued = () =>
    IssuedDocument.issue({
      id: "d1",
      number: "TRL-2026-000001",
      type: "transfer_letter",
      language: "en",
      templateId: null,
      templateVersion: "system-1",
      templateBody: system,
      subjectType: "workpay_agreement",
      subjectId: "a1",
      branchId: null,
      data: {},
      verificationCode: "ABCDEFGHJKMN",
      issuedBy: "u1",
      replacesId: null,
      now,
    });

  it("take their PDF once and can be voided once", () => {
    const d = issued();
    d.rendered("f1", "a".repeat(64), now);
    expect(() => d.rendered("f2", "b".repeat(64), now)).toThrow(/already has its PDF/);
    expect(() => d.void("u1", "", now)).toThrow(/Say why/);
    d.void("u1", "Wrong vehicle", now);
    expect(d.snapshot()).toMatchObject({ status: "void", voidReason: "Wrong vehicle" });
    expect(() => d.void("u1", "Again", now)).toThrow(/already void/);
  });
});
