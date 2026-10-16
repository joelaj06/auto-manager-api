import { createHash } from "node:crypto";
import type pg from "pg";
import {
  PERMISSION_CATALOG,
  type PermissionKey,
} from "../../application/authorization/permissionCatalog.js";
import { TENANT_ROLE_TEMPLATES } from "../../application/authorization/tenantRoleTemplates.js";

export type TenantCatalogueSyncResult = Readonly<{ version: number; released: boolean }>;

/**
 * Publishes the tenant permission catalogue and role templates from code into the platform
 * database (docs/28 §3), in `yarn db:migrate`. A content checksum decides whether this is a new
 * catalogue version; tenants are then brought up to date by the `catalogue.sweep` job.
 */
export class TenantCatalogueSync {
  async sync(client: pg.ClientBase): Promise<TenantCatalogueSyncResult> {
    const keys = Object.keys(PERMISSION_CATALOG) as PermissionKey[];
    const content = {
      permissions: keys.map((key) => {
        const d = PERMISSION_CATALOG[key];
        return [key, d.description, [...d.scopes], d.sensitive === true];
      }),
      templates: TENANT_ROLE_TEMPLATES.map((t) => [
        t.systemKey,
        t.name,
        t.description,
        [...t.grants].map((g) => `${g.key}:${g.scope}`).sort(),
      ]),
    };
    const checksum = createHash("sha256").update(JSON.stringify(content)).digest("hex");

    await client.query("begin");
    try {
      const existing = await client.query<{ version: number }>(
        "select version from catalogue_versions where checksum = $1",
        [checksum],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("commit");
        return { version: existing.rows[0].version, released: false };
      }

      for (const key of keys) {
        const d = PERMISSION_CATALOG[key];
        await client.query(
          `insert into permission_catalog (key, module, description, scopes, sensitive, deprecated, synced_at)
           values ($1, $2, $3, $4, $5, false, now())
           on conflict (key) do update set module = excluded.module, description = excluded.description,
             scopes = excluded.scopes, sensitive = excluded.sensitive, deprecated = false, synced_at = now()`,
          [key, key.split(".")[0], d.description, [...d.scopes], d.sensitive === true],
        );
      }
      await client.query(
        "update permission_catalog set deprecated = true where not (key = any($1)) and not deprecated",
        [keys],
      );

      await client.query("delete from role_template_permissions");
      await client.query("delete from role_templates where not (system_key = any($1))", [
        TENANT_ROLE_TEMPLATES.map((t) => t.systemKey),
      ]);
      for (const [index, template] of TENANT_ROLE_TEMPLATES.entries()) {
        await client.query(
          `insert into role_templates (system_key, name, description, sort_order) values ($1, $2, $3, $4)
           on conflict (system_key) do update set name = excluded.name,
             description = excluded.description, sort_order = excluded.sort_order`,
          [template.systemKey, template.name, template.description, index],
        );
        for (const grant of template.grants) {
          await client.query(
            "insert into role_template_permissions (system_key, permission_key, scope) values ($1, $2, $3)",
            [template.systemKey, grant.key, grant.scope],
          );
        }
      }

      const { rows } = await client.query<{ version: number }>(
        `insert into catalogue_versions (version, checksum, summary)
         select coalesce(max(version), 0) + 1, $1, $2 from catalogue_versions
         returning version`,
        [
          checksum,
          JSON.stringify({ permissions: keys.length, roleTemplates: TENANT_ROLE_TEMPLATES.length }),
        ],
      );
      await client.query("commit");
      return { version: rows[0]!.version, released: true };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
}
