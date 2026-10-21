import type { ILogger } from "../ports/ILogger.js";
import type { IObjectStorage } from "../ports/IObjectStorage.js";

/** Logos larger than this are left off (a letterhead does not need more). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The business logo's bytes for letterheads; null when there is none or it cannot be read. */
export class BusinessLogo {
  constructor(private readonly deps: Readonly<{ storage: IObjectStorage; logger: ILogger }>) {}

  async bytes(storageKey: string | null): Promise<Uint8Array | null> {
    if (storageKey === null) return null;
    try {
      const stat = await this.deps.storage.stat("public", storageKey);
      if (stat === null || stat.sizeBytes > MAX_LOGO_BYTES) return null;
      return await this.deps.storage.readStart("public", storageKey, stat.sizeBytes);
    } catch (error) {
      this.deps.logger.warn("Logo left off a document", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
