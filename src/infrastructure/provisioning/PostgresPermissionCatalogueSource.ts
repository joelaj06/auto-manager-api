import type { PermissionScope } from "../../application/authorization/permissionCatalog.js";
import type {
  CatalogueSnapshot,
  IPermissionCatalogueSource,
} from "../../application/ports/IPermissionCatalogueSource.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

/** The current catalogue version from the platform database (non-deprecated permissions only). */
export class PostgresPermissionCatalogueSource implements IPermissionCatalogueSource {
  constructor(private readonly db: PlatformDb) {}

  async current(): Promise<CatalogueSnapshot> {
    const version = await this.db.query<{ version: number | null }>(
      "select max(version) as version from catalogue_versions",
    );
    const current = version.rows[0]?.version ?? null;
    if (current === null)
      throw new Error("No permission catalogue published; run `yarn db:migrate`");

    const permissions = await this.db.query<{
      key: string;
      module: string;
      description: string;
      scopes: PermissionScope[];
      sensitive: boolean;
    }>(
      `select key, module, description, scopes, sensitive
         from permission_catalog where not deprecated order by key`,
    );
    const templates = await this.db.query<{
      system_key: string;
      name: string;
      description: string;
      grants: { key: string; scope: PermissionScope }[] | null;
    }>(
      `select t.system_key, t.name, t.description,
              json_agg(json_build_object('key', p.permission_key, 'scope', p.scope) order by p.permission_key)
                filter (where p.permission_key is not null) as grants
         from role_templates t
         left join role_template_permissions p on p.system_key = t.system_key
        group by t.system_key
        order by t.sort_order`,
    );
    return {
      version: current,
      permissions: permissions.rows,
      templates: templates.rows.map((t) => ({
        systemKey: t.system_key,
        name: t.name,
        description: t.description,
        grants: t.grants ?? [],
      })),
    };
  }
}
