import { createHmac, hkdfSync } from "node:crypto";
import type { IUserDirectory } from "../../application/ports/IUserDirectory.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

/**
 * user_directory with identifiers stored as HMAC-SHA256 (key derived from OTP_SECRET with HKDF),
 * so the platform database never holds a plain list of every tenant user's email and phone.
 * Rotating OTP_SECRET requires re-hashing the directory.
 */
export class HmacUserDirectory implements IUserDirectory {
  private readonly key: Buffer;

  constructor(
    private readonly db: PlatformDb,
    secret: string,
  ) {
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "autoforce-user-directory-v1", "user-directory", 32),
    );
  }

  hash(kind: "email" | "phone", identifier: string): string {
    const normalised = kind === "email" ? identifier.trim().toLowerCase() : identifier.trim();
    return createHmac("sha256", this.key).update(`${kind}:${normalised}`).digest("hex");
  }

  async upsert(entry: {
    tenantId: string;
    tenantUserId: string;
    email: string | null;
    phone: string | null;
    status: "active" | "disabled";
  }): Promise<void> {
    const identifiers: ["email" | "phone", string][] = [];
    if (entry.email !== null) identifiers.push(["email", entry.email]);
    if (entry.phone !== null) identifiers.push(["phone", entry.phone]);
    for (const [kind, value] of identifiers) {
      await this.db.query(
        `insert into user_directory (identifier_hash, kind, tenant_id, tenant_user_id, status, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (identifier_hash, tenant_id) do update set
           tenant_user_id = excluded.tenant_user_id, status = excluded.status, updated_at = now()`,
        [this.hash(kind, value), kind, entry.tenantId, entry.tenantUserId, entry.status],
      );
    }
  }
}
