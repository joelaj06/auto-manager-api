import type { IDeferredConnectLinks } from "../../application/ports/IDeferredConnectLinks.js";
import type { Queryable } from "../database/postgres/Queryable.js";

const DAY_MS = 86_400_000;

export class PostgresDeferredConnectLinks implements IDeferredConnectLinks {
  constructor(private readonly db: Queryable) {}

  async hold(link: Parameters<IDeferredConnectLinks["hold"]>[0]): Promise<void> {
    await this.db.query("delete from deferred_connect_links where expires_at < $1", [
      new Date(link.now.getTime() - DAY_MS),
    ]);
    await this.db.query(
      `insert into deferred_connect_links (code_hash, sealed_query, tenant_slug, expires_at)
       values ($1, $2, $3, $4)`,
      [link.codeHash, link.sealedQuery, link.tenantSlug, link.expiresAt],
    );
  }

  async claim(codeHash: string, now: Date) {
    // The sealed link goes with the claim: an invitation token is not kept once it has been used.
    const { rows } = await this.db.query<{ sealed_query: string; tenant_slug: string }>(
      `with taken as (
         select id, sealed_query, tenant_slug from deferred_connect_links
          where code_hash = $1 and claimed_at is null and expires_at > $2
          for update
       ), used as (
         update deferred_connect_links d set claimed_at = $2, sealed_query = ''
           from taken where d.id = taken.id
       )
       select sealed_query, tenant_slug from taken`,
      [codeHash, now],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { sealedQuery: row.sealed_query, tenantSlug: row.tenant_slug };
  }
}
