import type {
  ApiKeyRecord,
  IApiKeys,
  NewApiKey,
  UsableApiKey,
} from "../../application/ports/IApiKeys.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));

const KEYS = `
  select k.*, u.name as created_by_name
    from api_keys k join users u on u.id = k.created_by`;

function toKey(r: Row): ApiKeyRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    hint: String(r.key_hint),
    scopes: r.scopes as string[],
    createdBy: String(r.created_by),
    createdByName: (r.created_by_name as string | null) ?? null,
    expiresAt: date(r.expires_at),
    lastUsedAt: date(r.last_used_at),
    requests: Number(r.requests),
    revokedAt: date(r.revoked_at),
    createdAt: r.created_at as Date,
  };
}

export class PostgresApiKeys implements IApiKeys {
  constructor(private readonly context: PostgresTransactionContext) {}

  private tx() {
    return this.context.current();
  }

  async create(key: NewApiKey): Promise<string> {
    const { rows } = await this.tx().query<{ id: string }>(
      `insert into api_keys (name, key_hash, key_hint, scopes, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [key.name, key.keyHash, key.hint, key.scopes, key.createdBy, key.expiresAt],
    );
    return rows[0]!.id;
  }

  async find(id: string): Promise<ApiKeyRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx().query<Row>(`${KEYS} where k.id = $1`, [id]);
    return rows[0] === undefined ? null : toKey(rows[0]);
  }

  async list(includeRevoked: boolean): Promise<ApiKeyRecord[]> {
    const { rows } = await this.tx().query<Row>(
      `${KEYS} where $1 or k.revoked_at is null order by k.created_at desc limit 500`,
      [includeRevoked],
    );
    return rows.map(toKey);
  }

  async countLive(now: Date): Promise<number> {
    const { rows } = await this.tx().query<{ n: string }>(
      `select count(*) as n from api_keys
        where revoked_at is null and (expires_at is null or expires_at > $1)`,
      [now],
    );
    return Number(rows[0]!.n);
  }

  async use(keyHash: string, now: Date): Promise<UsableApiKey | null> {
    const { rows } = await this.tx().query<Row>(
      `update api_keys k
          set last_used_at = $2, requests = k.requests + 1
         from users u
        where k.key_hash = $1 and u.id = k.created_by and u.status = 'active'
          and k.revoked_at is null and (k.expires_at is null or k.expires_at > $2)
        returning k.id, k.name, k.created_by, k.scopes`,
      [keyHash, now],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      id: String(r.id),
      name: String(r.name),
      userId: String(r.created_by),
      scopes: r.scopes as string[],
    };
  }

  async revoke(id: string, revokedBy: string | null, now: Date): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.tx().query(
      `update api_keys set revoked_at = $2, revoked_by = $3
        where id = $1 and revoked_at is null`,
      [id, now, revokedBy],
    );
    return rowCount === 1;
  }
}
