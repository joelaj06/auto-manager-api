import type pg from "pg";
import {
  PLATFORM_PERMISSION_CATALOG,
  PLATFORM_PERMISSION_KEYS,
  PLATFORM_ROLE_TEMPLATES,
} from "../../application/authorization/platformPermissionCatalog.js";

export type CatalogueSyncResult = Readonly<{
  permissions: number;
  deprecated: number;
  systemRoles: number;
  changedRoles: readonly string[];
}>;

/**
 * Writes the platform permission catalogue and the system staff roles from code into the platform
 * database (docs/28 §12). Runs in `yarn db:migrate`, in one transaction, idempotently:
 * - permissions are upserted; keys no longer in code are marked deprecated (never deleted, so
 *   history and audit references stay valid) and stop granting anything;
 * - each system role gets exactly its template's permissions; custom roles are untouched;
 * - staff holding a system role whose permissions changed get a new permission version, so their
 *   tokens are re-issued with the new rights.
 */
export class PlatformCatalogueSync {
  async sync(client: pg.ClientBase): Promise<CatalogueSyncResult> {
    await client.query("begin");
    try {
      for (const key of PLATFORM_PERMISSION_KEYS) {
        const definition = PLATFORM_PERMISSION_CATALOG[key];
        await client.query(
          `insert into platform_permissions (key, description, sensitive, four_eyes, deprecated, synced_at)
           values ($1, $2, $3, $4, false, now())
           on conflict (key) do update set
             description = excluded.description, sensitive = excluded.sensitive,
             four_eyes = excluded.four_eyes, deprecated = false, synced_at = now()`,
          [
            key,
            definition.description,
            definition.sensitive === true,
            definition.fourEyes === true,
          ],
        );
      }
      const deprecated = await client.query(
        "update platform_permissions set deprecated = true where not (key = any($1)) and not deprecated",
        [PLATFORM_PERMISSION_KEYS],
      );

      const changedRoles: string[] = [];
      for (const template of PLATFORM_ROLE_TEMPLATES) {
        const { rows } = await client.query<{ id: string }>(
          `insert into platform_roles (system_key, name, description)
           values ($1, $2, $3)
           on conflict (system_key) do update set
             name = excluded.name, description = excluded.description, updated_at = now()
           returning id`,
          [template.systemKey, template.name, template.description],
        );
        const roleId = rows[0]!.id;
        const wanted = [
          ...new Set(
            template.permissions === "all" ? PLATFORM_PERMISSION_KEYS : template.permissions,
          ),
        ].sort();
        const current = await client.query<{ permission_key: string }>(
          "select permission_key from platform_role_permissions where role_id = $1 order by permission_key",
          [roleId],
        );
        const have = current.rows.map((r) => r.permission_key);
        if (have.join(",") === wanted.join(",")) continue;

        await client.query("delete from platform_role_permissions where role_id = $1", [roleId]);
        await client.query(
          "insert into platform_role_permissions (role_id, permission_key) select $1, unnest($2::text[])",
          [roleId, wanted],
        );
        await client.query(
          `update platform_users set permission_version = permission_version + 1, updated_at = now()
            where id in (select user_id from platform_user_roles where role_id = $1)`,
          [roleId],
        );
        changedRoles.push(template.systemKey);
      }
      await client.query("commit");
      return {
        permissions: PLATFORM_PERMISSION_KEYS.length,
        deprecated: deprecated.rowCount ?? 0,
        systemRoles: PLATFORM_ROLE_TEMPLATES.length,
        changedRoles,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
}
