import { loadConfig } from "../../infrastructure/config/config.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { MigrationRunner } from "../../infrastructure/database/migrations/MigrationRunner.js";
import { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { runCommand } from "./runCommand.js";

type StatusRow = { status: string | null; schema_version: string | null; tenants: string };

/** yarn db:status — schema versions of the platform DB, the template and tenant databases. */
runCommand("db:status", async () => {
  const config = loadConfig();
  const db = config.database;
  const migrations = await MigrationSets.load(db.migrationsDir);
  const connections = new PostgresConnectionFactory(db);

  const platform = await connections.connect("migrator", db.platformDatabase);
  const template = await connections.connect("migrator", db.tenantTemplateDatabase);
  try {
    const platformVersion = await MigrationRunner.readSchemaVersion(platform);
    const templateVersion = await MigrationRunner.readSchemaVersion(template);
    const { rows } = await platform.query<StatusRow>(
      `select s.status, s.schema_version, count(*)::text as tenants
       from tenants t left join tenant_schema_status s on s.tenant_id = t.id
       where t.database_name is not null
       group by s.status, s.schema_version
       order by s.schema_version nulls first, s.status`,
    );

    console.info(
      `platform  ${db.platformDatabase}: ${platformVersion ?? "(none)"} (latest ${migrations.platform.latestVersion ?? "none"})`,
    );
    console.info(
      `template  ${db.tenantTemplateDatabase}: ${templateVersion ?? "(none)"} (latest ${migrations.tenant.latestVersion ?? "none"})`,
    );
    if (rows.length === 0) console.info("tenants   none");
    for (const row of rows) {
      console.info(
        `tenants   ${row.tenants} at ${row.schema_version ?? "(unknown)"} — ${row.status ?? "never migrated"}`,
      );
    }
    return 0;
  } finally {
    await Promise.allSettled([platform.end(), template.end()]);
  }
});
