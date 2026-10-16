import type { PermissionScope } from "../../application/authorization/permissionCatalog.js";
import type {
  ITenantRoles,
  RoleGrant,
  TenantPermissionView,
  TenantRoleView,
} from "../../application/ports/ITenantRoles.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  system_key: string | null;
  based_on_role_id: string | null;
  grants: { key: string; scope: PermissionScope; limits: Record<string, number> | null }[] | null;
  holders: string;
};

const SELECT = `
  select r.id, r.name, r.description, r.is_system, r.system_key, r.based_on_role_id,
         (select json_agg(json_build_object('key', rp.permission_key, 'scope', rp.scope, 'limits', rp.limits)
                          order by rp.permission_key)
            from role_permissions rp join permissions p on p.key = rp.permission_key and not p.deprecated
           where rp.role_id = r.id) as grants,
         (select count(distinct user_id) from user_roles ur where ur.role_id = r.id) as holders
    from roles r
   where r.deleted_at is null`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toView = (r: Row): TenantRoleView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  isSystem: r.is_system,
  systemKey: r.system_key,
  basedOnRoleId: r.based_on_role_id,
  grants: (r.grants ?? []).map((g) => ({
    key: g.key,
    scope: g.scope,
    ...(g.limits === null ? {} : { limits: g.limits }),
  })),
  holders: Number(r.holders),
});

export class PostgresTenantRoles implements ITenantRoles {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async list(): Promise<TenantRoleView[]> {
    const { rows } = await this.transactions
      .current()
      .query<Row>(`${SELECT} order by r.is_system desc, r.name`);
    return rows.map(toView);
  }

  async findById(id: string): Promise<TenantRoleView | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.transactions.current().query<Row>(`${SELECT} and r.id = $1`, [id]);
    return rows[0] === undefined ? null : toView(rows[0]);
  }

  async nameTaken(name: string, exceptId?: string): Promise<boolean> {
    const { rows } = await this.transactions.current().query<{ taken: boolean }>(
      `select exists (select 1 from roles where lower(name) = lower($1) and deleted_at is null
                        and ($2::uuid is null or id <> $2)) as taken`,
      [name, exceptId ?? null],
    );
    return rows[0]?.taken === true;
  }

  async create(input: {
    name: string;
    description: string;
    grants: readonly RoleGrant[];
    basedOnRoleId: string | null;
    createdBy: string;
  }): Promise<string> {
    const { rows } = await this.transactions
      .current()
      .query<{ id: string }>(
        `insert into roles (name, description, based_on_role_id, created_by) values ($1, $2, $3, $4) returning id`,
        [input.name, input.description, input.basedOnRoleId, input.createdBy],
      );
    const id = rows[0]!.id;
    await this.setGrants(id, input.grants);
    return id;
  }

  async update(
    id: string,
    input: { name: string; description: string; grants: readonly RoleGrant[] },
  ) {
    await this.transactions.current().query(
      `update roles set name = $2, description = $3, perm_version = perm_version + 1, updated_at = now()
        where id = $1 and not is_system`,
      [id, input.name, input.description],
    );
    await this.setGrants(id, input.grants);
  }

  async softDelete(id: string): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update roles set deleted_at = now(), updated_at = now() where id = $1 and not is_system",
        [id],
      );
  }

  async permissions(): Promise<TenantPermissionView[]> {
    const { rows } = await this.transactions.current().query<{
      key: string;
      module: string;
      description: string;
      scopes: PermissionScope[];
      sensitive: boolean;
    }>("select key, module, description, scopes, sensitive from permissions where not deprecated order by key");
    return rows;
  }

  private async setGrants(roleId: string, grants: readonly RoleGrant[]): Promise<void> {
    const tx = this.transactions.current();
    await tx.query("delete from role_permissions where role_id = $1", [roleId]);
    for (const g of grants) {
      await tx.query(
        "insert into role_permissions (role_id, permission_key, scope, limits) values ($1, $2, $3, $4)",
        [
          roleId,
          g.key,
          g.scope,
          g.limits === undefined || g.limits === null ? null : JSON.stringify(g.limits),
        ],
      );
    }
  }
}
