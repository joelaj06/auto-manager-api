import { describe, expect, it } from "vitest";
import { DEVELOPMENT_KEY_SEED, Ed25519ConnectLinkSigner } from "./Ed25519ConnectLinkSigner.js";
import { QrcodeSvgRenderer } from "./QrcodeSvgRenderer.js";
import { generateKeyPairSync } from "node:crypto";

describe("Ed25519ConnectLinkSigner", () => {
  it("signs and verifies, and rejects changed messages, signatures and keys", () => {
    const signer = Ed25519ConnectLinkSigner.fromSeed(DEVELOPMENT_KEY_SEED);
    const signature = signer.sign("hello");
    expect(signer.verify("hello", signature, signer.keyId)).toBe(true);
    expect(signer.verify("hello!", signature, signer.keyId)).toBe(false);
    expect(signer.verify("hello", `${signature.slice(0, -2)}AA`, signer.keyId)).toBe(false);
    expect(signer.verify("hello", "not-base64-at-all", signer.keyId)).toBe(false);
    expect(signer.verify("hello", signature, "k-other")).toBe(false);
    expect(signer.keyId).toMatch(/^k-[0-9a-f]{12}$/);
    // The development key is stable.
    expect(Ed25519ConnectLinkSigner.fromSeed(DEVELOPMENT_KEY_SEED).keyId).toBe(signer.keyId);
    const [key] = signer.publicKeys();
    expect(Buffer.from(key!.publicKey, "base64url")).toHaveLength(32);
  });

  it("loads a PEM key and refuses other key types", () => {
    const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    const signer = Ed25519ConnectLinkSigner.fromPem(String(ed));
    expect(signer.verify("x", signer.sign("x"), signer.keyId)).toBe(true);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    expect(() => Ed25519ConnectLinkSigner.fromPem(String(rsa))).toThrow(/Ed25519/);
  });
});

describe("QrcodeSvgRenderer", () => {
  it("renders an SVG QR code", async () => {
    const svg = await new QrcodeSvgRenderer().svg("https://link.example/connect?v=1");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
  });
});
