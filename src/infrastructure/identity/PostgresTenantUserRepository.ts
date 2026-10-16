import { TenantUser, type TenantUserStatus } from "../../domain/entities/TenantUser.js";
import type {
  ITenantUserRepository,
  UserListQuery,
} from "../../domain/repositories/ITenantUserRepository.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  status: TenantUserStatus;
  password_hash: string | null;
  is_owner: boolean;
  permission_version: number;
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
};

const COLUMNS = `id, email::text as email, phone, name, status, password_hash, is_owner,
  permission_version, failed_attempts, locked_until, last_login_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toEntity = (r: Row) =>
  TenantUser.restore({
    id: r.id,
    email: r.email,
    phone: r.phone,
    name: r.name,
    status: r.status,
    passwordHash: r.password_hash,
    isOwner: r.is_owner,
    permissionVersion: r.permission_version,
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
    lastLoginAt: r.last_login_at,
  });

/** Users of the current tenant (tenant unit of work). */
export class PostgresTenantUserRepository implements ITenantUserRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  findById(id: string) {
    return this.one("id = $1", id, "", true);
  }
  lockById(id: string) {
    return this.one("id = $1", id, " for update", true);
  }
  findByEmail(email: string) {
    return this.one("email = $1", email, "", false);
  }
  findByPhone(phone: string) {
    return this.one("phone = $1", phone, "", false);
  }

  async save(user: TenantUser, invitedBy: string | null = null): Promise<void> {
    const s = user.snapshot();
    await this.transactions.current().query(
      `insert into users (id, email, phone, name, status, password_hash, is_owner, permission_version,
                          failed_attempts, locked_until, last_login_at, invited_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (id) do update set
         phone = excluded.phone, name = excluded.name, status = excluded.status,
         password_hash = excluded.password_hash, permission_version = excluded.permission_version,
         failed_attempts = excluded.failed_attempts, locked_until = excluded.locked_until,
         last_login_at = excluded.last_login_at, updated_at = now()`,
      [
        s.id,
        s.email,
        s.phone,
        s.name,
        s.status,
        s.passwordHash,
        s.isOwner,
        s.permissionVersion,
        s.failedAttempts,
        s.lockedUntil,
        s.lastLoginAt,
        invitedBy,
      ],
    );
  }

  async list(query: UserListQuery): Promise<TenantUser[]> {
    const search = query.search?.trim();
    const { rows } = await this.transactions.current().query<Row>(
      `select ${COLUMNS} from users u
        where ($1::boolean
               or exists (select 1 from user_branches ub where ub.user_id = u.id and ub.branch_id = any($2::uuid[]))
               or u.id = $3)
          and ($4::text is null or u.status = $4)
          and ($5::text is null or u.name ilike '%' || $5 || '%' or u.email ilike '%' || $5 || '%'
               or u.phone like '%' || $5 || '%')
          and ($6::uuid is null or u.id < $6)
        order by u.id desc
        limit $7`,
      [
        query.branchIds === "all",
        query.branchIds === "all" ? [] : query.branchIds,
        query.includeUserId ?? null,
        query.status ?? null,
        search === undefined || search === "" ? null : search.replace(/[\\%_]/g, (c) => `\\${c}`),
        query.before ?? null,
        query.limit,
      ],
    );
    return rows.map(toEntity);
  }

  private async one(
    condition: string,
    value: string,
    lock: string,
    isId: boolean,
  ): Promise<TenantUser | null> {
    if (isId && !UUID.test(value)) return null;
    const { rows } = await this.transactions
      .current()
      .query<Row>(`select ${COLUMNS} from users where ${condition}${lock}`, [value]);
    return rows[0] === undefined ? null : toEntity(rows[0]);
  }
}
