import type { TenantStatus } from "../../application/ports/ITenantDirectory.js";
import type {
  ITenantPublicProfiles,
  TenantPublicProfile,
} from "../../application/ports/ITenantPublicProfiles.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const SLUG = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

export class PostgresTenantPublicProfiles implements ITenantPublicProfiles {
  constructor(private readonly db: PlatformDb) {}

  async findBySlug(slug: string): Promise<TenantPublicProfile | null> {
    const normalised = slug.trim().toLowerCase();
    if (!SLUG.test(normalised)) return null;
    const { rows } = await this.db.query<{
      id: string;
      slug: string;
      name: string;
      status: TenantStatus;
      deactivation_reason: string | null;
      status_message: string | null;
    }>(
      `select id, slug::text as slug, name, status, deactivation_reason, status_message
         from tenants where slug = $1`,
      [normalised],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          slug: r.slug,
          name: r.name,
          status: r.status,
          deactivationReason: r.deactivation_reason,
          statusMessage: r.status_message,
        };
  }
}
