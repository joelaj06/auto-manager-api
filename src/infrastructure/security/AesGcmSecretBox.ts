import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { ISecretBox } from "../../application/ports/ISecretBox.js";

const VERSION = "v1";

/**
 * AES-256-GCM for small secrets at rest (TOTP secrets). The key is derived from
 * MFA_ENCRYPTION_KEY with HKDF; format `v1.<iv>.<ciphertext>.<tag>` (base64url). A database leak
 * alone therefore does not reveal anyone's second factor.
 */
export class AesGcmSecretBox implements ISecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string, context = "autoforce-mfa-secrets") {
    this.key = Buffer.from(hkdfSync("sha256", masterKey, "autoforce-secret-box-v1", context, 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv, data, cipher.getAuthTag()]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  }

  open(sealed: string): string {
    const [version, iv, data, tag] = sealed.split(".");
    if (version !== VERSION || iv === undefined || data === undefined || tag === undefined) {
      throw new Error("Unsupported sealed secret");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
