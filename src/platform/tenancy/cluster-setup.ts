import pg from "pg";
import type { DatabaseRoleCredentials } from "../../shared/config/config.js";
import { DATABASE_GROUP_ROLES } from "../../shared/db/types.js";

export type ClusterSetupOptions = Readonly<{
  /** A superuser connection (any database), used only for this one-time setup. */
  admin: pg.ClientBase;
  roles: Readonly<{
    platform: DatabaseRoleCredentials;
    tenant: DatabaseRoleCredentials;
    migrator: DatabaseRoleCredentials;
  }>;
  platformDatabase: string;
  tenantTemplateDatabase: string;
  log?: (message: string) => void;
}>;

const ident = (name: string) => pg.escapeIdentifier(name);

async function roleExists(admin: pg.ClientBase, role: string): Promise<boolean> {
  const { rowCount } = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
  return rowCount === 1;
}

async function databaseExists(admin: pg.ClientBase, database: string): Promise<boolean> {
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [
    database,
  ]);
  return rowCount === 1;
}

async function ensureGroupRole(admin: pg.ClientBase, role: string): Promise<void> {
  if (!(await roleExists(admin, role))) {
    await admin.query(`create role ${ident(role)} nologin`);
  }
}

async function ensureLoginRole(
  admin: pg.ClientBase,
  credentials: DatabaseRoleCredentials,
  attributes: string,
): Promise<void> {
  // Passwords cannot be bound as parameters in role DDL; escapeLiteral quotes them safely.
  const verb = (await roleExists(admin, credentials.user)) ? "alter" : "create";
  await admin.query(
    `${verb} role ${ident(credentials.user)} login ${attributes} password ${pg.escapeLiteral(credentials.password)}`,
  );
}

async function ensureDatabase(
  admin: pg.ClientBase,
  database: string,
  owner: string,
): Promise<boolean> {
  if (await databaseExists(admin, database)) {
    await admin.query(`alter database ${ident(database)} owner to ${ident(owner)}`);
    return false;
  }
  await admin.query(`create database ${ident(database)} owner ${ident(owner)}`);
  return true;
}

/**
 * Idempotent cluster bootstrap: group roles, login roles (passwords re-synced from config),
 * the platform database and the tenant template database, with CONNECT locked down.
 *
 * Role model:
 *  - migrator: owns every application database and runs DDL; may create databases.
 *  - platform app user ∈ af_platform_rw: data access to the platform database only.
 *  - tenant app user ∈ af_tenant_rw: data access to tenant databases only.
 */
export async function setupCluster(options: ClusterSetupOptions): Promise<void> {
  const { admin, roles } = options;
  const log = options.log ?? (() => undefined);
  const { platformReadWrite, tenantReadWrite } = DATABASE_GROUP_ROLES;

  await ensureGroupRole(admin, platformReadWrite);
  await ensureGroupRole(admin, tenantReadWrite);

  const restricted = "nosuperuser nocreaterole noreplication nobypassrls";
  await ensureLoginRole(admin, roles.migrator, `${restricted} createdb`);
  await ensureLoginRole(admin, roles.platform, `${restricted} nocreatedb`);
  await ensureLoginRole(admin, roles.tenant, `${restricted} nocreatedb`);
  await admin.query(`grant ${ident(platformReadWrite)} to ${ident(roles.platform.user)}`);
  await admin.query(`grant ${ident(tenantReadWrite)} to ${ident(roles.tenant.user)}`);
  log("roles ready");

  const platformCreated = await ensureDatabase(
    admin,
    options.platformDatabase,
    roles.migrator.user,
  );
  await admin.query(
    `revoke connect, temporary on database ${ident(options.platformDatabase)} from public`,
  );
  await admin.query(
    `grant connect on database ${ident(options.platformDatabase)} to ${ident(platformReadWrite)}`,
  );
  log(`platform database ${options.platformDatabase} ${platformCreated ? "created" : "exists"}`);

  const templateCreated = await ensureDatabase(
    admin,
    options.tenantTemplateDatabase,
    roles.migrator.user,
  );
  await admin.query(
    `revoke connect, temporary on database ${ident(options.tenantTemplateDatabase)} from public`,
  );
  // Marked as a template so the migrator may clone it; only the migrator can connect to it.
  await admin.query(`alter database ${ident(options.tenantTemplateDatabase)} is_template true`);
  log(
    `tenant template database ${options.tenantTemplateDatabase} ${templateCreated ? "created" : "exists"}`,
  );
}
