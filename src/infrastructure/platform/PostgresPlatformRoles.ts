import type { PlatformPermissionKey } from "../../application/authorization/platformPermissionCatalog.js";
import type {
  CustomRoleInput,
  IPlatformRoles,
  PlatformRoleView,
} from "../../application/ports/IPlatformRoles.js";
import type { PlatformDb } from "./PlatformDb.js";

type Row = {
  id: string;
  system_key: string | null;
  name: string;
  description: string;
  permissions: PlatformPermissionKey[] | null;
};

const SELECT = `
  select r.id, r.system_key, r.name, r.description,
         array_agg(rp.permission_key order by rp.permission_key)
           filter (where rp.permission_key is not null) as permissions
    from platform_roles r
    left join platform_role_permissions rp on rp.role_id = r.id`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toView = (row: Row): PlatformRoleView => ({
  id: row.id,
  systemKey: row.system_key,
  name: row.name,
  description: row.description,
  permissions: row.permissions ?? [],
});

export class PostgresPlatformRoles implements IPlatformRoles {
  constructor(private readonly db: PlatformDb) {}

  async list(): Promise<PlatformRoleView[]> {
    const { rows } = await this.db.query<Row>(
      `${SELECT} group by r.id order by r.system_key is null, r.name`,
    );
    return rows.map(toView);
  }

  async findById(id: string): Promise<PlatformRoleView | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(`${SELECT} where r.id = $1 group by r.id`, [id]);
    return rows[0] === undefined ? null : toView(rows[0]);
  }

  async findBySystemKey(systemKey: string): Promise<PlatformRoleView | null> {
    const { rows } = await this.db.query<Row>(`${SELECT} where r.system_key = $1 group by r.id`, [
      systemKey,
    ]);
    return rows[0] === undefined ? null : toView(rows[0]);
  }

  async createCustom(input: CustomRoleInput, createdBy: string): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      "insert into platform_roles (name, description, created_by) values ($1, $2, $3) returning id",
      [input.name.trim(), input.description, createdBy],
    );
    const id = rows[0]!.id;
    await this.setPermissions(id, input.permissions);
    return id;
  }

  async updateCustom(id: string, input: CustomRoleInput): Promise<void> {
    await this.db.query(
      `update platform_roles set name = $2, description = $3, updated_at = now()
        where id = $1 and system_key is null`,
      [id, input.name.trim(), input.description],
    );
    await this.setPermissions(id, input.permissions);
  }

  async rolesOfUser(userId: string): Promise<PlatformRoleView[]> {
    if (!UUID.test(userId)) return [];
    const { rows } = await this.db.query<Row>(
      `${SELECT} where r.id in (select role_id from platform_user_roles where user_id = $1)
        group by r.id order by r.name`,
      [userId],
    );
    return rows.map(toView);
  }

  async setUserRoles(
    userId: string,
    roleIds: readonly string[],
    assignedBy: string | null,
  ): Promise<void> {
    await this.db.query("delete from platform_user_roles where user_id = $1", [userId]);
    if (roleIds.length === 0) return;
    await this.db.query(
      `insert into platform_user_roles (user_id, role_id, assigned_by)
       select $1, unnest($2::uuid[]), $3`,
      [userId, roleIds, assignedBy],
    );
  }

  async userIdsWithRole(roleId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string }>(
      "select user_id from platform_user_roles where role_id = $1",
      [roleId],
    );
    return rows.map((r) => r.user_id);
  }

  async activeUsersWithSystemRole(systemKey: string) {
    const { rows } = await this.db.query<{ id: string; email: string }>(
      `select u.id, u.email::text as email
         from platform_users u
         join platform_user_roles ur on ur.user_id = u.id
         join platform_roles r on r.id = ur.role_id
        where r.system_key = $1 and u.status = 'active'
        order by u.email`,
      [systemKey],
    );
    return rows;
  }

  private async setPermissions(roleId: string, keys: readonly string[]): Promise<void> {
    await this.db.query("delete from platform_role_permissions where role_id = $1", [roleId]);
    if (keys.length === 0) return;
    await this.db.query(
      `insert into platform_role_permissions (role_id, permission_key)
       select $1, unnest($2::text[])`,
      [roleId, [...new Set(keys)]],
    );
  }
}
