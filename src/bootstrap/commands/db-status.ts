import { loadConfig } from "../../shared/config/config.js";
import { latestVersion, loadMigrationSets } from "../../shared/db/migrations/migration-files.js";
import { readSchemaVersion } from "../../shared/db/migrations/migrator.js";
import { databaseServices } from "../database.js";
import { runCommand } from "./run-command.js";

type StatusRow = { status: string | null; schema_version: string | null; tenants: string };

/** yarn db:status — schema versions of the platform DB, the template and tenant databases. */
runCommand("db:status", async () => {
  const config = loadConfig();
  const migrations = await loadMigrationSets(config.database.migrationsDir);
  const { connectAsMigrator } = databaseServices(config);

  const platform = await connectAsMigrator(config.database.platformDatabase);
  const template = await connectAsMigrator(config.database.tenantTemplateDatabase);
  try {
    const platformVersion = await readSchemaVersion(platform);
    const templateVersion = await readSchemaVersion(template);
    const { rows } = await platform.query<StatusRow>(
      `select s.status, s.schema_version, count(*)::text as tenants
       from tenants t left join tenant_schema_status s on s.tenant_id = t.id
       where t.database_name is not null
       group by s.status, s.schema_version
       order by s.schema_version nulls first, s.status`,
    );

    console.info(
      `platform  ${config.database.platformDatabase}: ${platformVersion ?? "(none)"} (latest ${latestVersion(migrations.platform) ?? "none"})`,
    );
    console.info(
      `template  ${config.database.tenantTemplateDatabase}: ${templateVersion ?? "(none)"} (latest ${latestVersion(migrations.tenant) ?? "none"})`,
    );
    if (rows.length === 0) console.info("tenants   none");
    for (const row of rows) {
      console.info(
        `tenants   ${row.tenants} at ${row.schema_version ?? "(unknown)"} — ${row.status ?? "never migrated"}`,
      );
    }
  } finally {
    await Promise.allSettled([platform.end(), template.end()]);
  }
});
