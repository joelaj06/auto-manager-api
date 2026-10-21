import { describe, expect, it } from "vitest";
import { signaturePng } from "../../../testing/fixtures/signaturePng.js";
import { signaturePng as checkPng } from "./DocumentSigning.js";

describe("drawn signatures", () => {
  it("are PNG images of a sensible size", () => {
    expect(checkPng(`data:image/png;base64,${signaturePng()}`).subarray(1, 4).toString()).toBe(
      "PNG",
    );
    expect(() => checkPng(Buffer.from("not an image at all").toString("base64"))).toThrow(
      /not a PNG/,
    );
    expect(() => checkPng(signaturePng(4100, 60))).toThrow(/signing box/);
  });
});
