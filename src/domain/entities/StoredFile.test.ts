import { describe, expect, it } from "vitest";
import { sniffContentType } from "../files/FileKinds.js";
import { FileRejectedError, FileStateError, StoredFile } from "./StoredFile.js";

const now = new Date("2026-10-18T10:00:00Z");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.7\n");

const logo = (overrides: Partial<Parameters<typeof StoredFile.start>[0]> = {}) =>
  StoredFile.start({
    id: "f1",
    kind: "organisation_logo",
    keyPrefix: "tenants/t1",
    filename: "../../Logo Final.png",
    contentType: "IMAGE/PNG",
    sizeBytes: 1000,
    uploadedBy: "u1",
    now,
    ...overrides,
  });

describe("StoredFile", () => {
  it("starts pending with a safe key and file name", () => {
    const s = logo().snapshot();
    expect(s).toMatchObject({
      status: "pending",
      visibility: "public",
      contentType: "image/png",
      filename: "Logo Final.png",
      storageKey: "tenants/t1/organisation_logo/f1.png",
    });
  });

  it("refuses types, sizes and names the kind does not allow", () => {
    expect(() => logo({ contentType: "image/svg+xml" })).toThrow(FileRejectedError);
    expect(() => logo({ contentType: "application/pdf" })).toThrow(FileRejectedError);
    expect(() => logo({ sizeBytes: 3 * 1024 * 1024 })).toThrow(FileRejectedError);
    expect(() => logo({ sizeBytes: 0 })).toThrow(FileRejectedError);
    expect(() => logo({ filename: "///" })).toThrow(FileRejectedError);
  });

  it("completes only when size and real type match", () => {
    const f = logo();
    expect(() => f.complete({ sizeBytes: 999, sniffedType: "image/png" }, now)).toThrow(
      FileRejectedError,
    );
    expect(() => f.complete({ sizeBytes: 1000, sniffedType: "application/pdf" }, now)).toThrow(
      FileRejectedError,
    );
    expect(() => f.assertUsableAs("organisation_logo")).toThrow(FileStateError);
    f.complete({ sizeBytes: 1000, sniffedType: "image/png" }, now);
    f.assertUsableAs("organisation_logo");
    expect(() => f.assertUsableAs("partner_document")).toThrow(FileStateError);
    f.delete(now);
    expect(() => f.complete({ sizeBytes: 1000, sniffedType: "image/png" }, now)).toThrow(
      FileStateError,
    );
  });

  it("checks the owner of a file", () => {
    const f = StoredFile.start({
      id: "f2",
      kind: "application_document",
      keyPrefix: "platform",
      filename: "certificate.pdf",
      contentType: "application/pdf",
      sizeBytes: 9,
      ownerType: "tenant_application",
      ownerId: "a1",
      uploadedBy: null,
      now,
    });
    f.complete({ sizeBytes: 9, sniffedType: "application/pdf" }, now);
    f.assertUsableAs("application_document", { type: "tenant_application", id: "a1" });
    expect(() =>
      f.assertUsableAs("application_document", { type: "tenant_application", id: "a2" }),
    ).toThrow(FileStateError);
  });
});

describe("sniffContentType", () => {
  it("recognises accepted types by their first bytes", () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffContentType(PDF)).toBe("application/pdf");
    expect(sniffContentType(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});
