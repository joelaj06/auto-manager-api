import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type {
  ConnectPublicKey,
  IConnectLinkSigner,
} from "../../application/ports/IConnectLinkSigner.js";

/** PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Development only: a fixed, publicly known key so links stay valid across restarts and dev
 * builds of the app can embed it. Refused in production (config requires a key file there).
 */
export const DEVELOPMENT_KEY_SEED = createHash("sha256")
  .update("autoforce-development-only-mobile-connect-key")
  .digest();

/**
 * Ed25519 signatures for mobile connect links (docs/23 §4). The key id is derived from the
 * public key, so the app can hold several trusted keys while one is being rotated.
 */
export class Ed25519ConnectLinkSigner implements IConnectLinkSigner {
  readonly keyId: string;
  private readonly publicKey: KeyObject;
  private readonly rawPublicKey: Buffer;

  private constructor(private readonly privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("The mobile connect key must be an Ed25519 private key");
    this.publicKey = createPublicKey(privateKey);
    // SPKI DER of Ed25519: 12-byte header + 32-byte key.
    this.rawPublicKey = this.publicKey.export({ format: "der", type: "spki" }).subarray(12);
    this.keyId = `k-${createHash("sha256").update(this.rawPublicKey).digest("hex").slice(0, 12)}`;
  }

  /** From a PEM-encoded PKCS#8 private key (e.g. `openssl genpkey -algorithm ed25519`). */
  static fromPem(pem: string): Ed25519ConnectLinkSigner {
    return new Ed25519ConnectLinkSigner(createPrivateKey(pem));
  }

  static fromSeed(seed: Buffer): Ed25519ConnectLinkSigner {
    if (seed.length !== 32) throw new Error("An Ed25519 seed has 32 bytes");
    return new Ed25519ConnectLinkSigner(
      createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
      }),
    );
  }

  sign(message: string): string {
    return sign(null, Buffer.from(message, "utf8"), this.privateKey).toString("base64url");
  }

  verify(message: string, signature: string, keyId: string): boolean {
    if (keyId !== this.keyId) return false;
    try {
      return verify(
        null,
        Buffer.from(message, "utf8"),
        this.publicKey,
        Buffer.from(signature, "base64url"),
      );
    } catch {
      return false;
    }
  }

  knowsKey(keyId: string): boolean {
    return keyId === this.keyId;
  }

  publicKeys(): readonly ConnectPublicKey[] {
    return [
      {
        keyId: this.keyId,
        algorithm: "Ed25519",
        publicKey: this.rawPublicKey.toString("base64url"),
      },
    ];
  }
}
