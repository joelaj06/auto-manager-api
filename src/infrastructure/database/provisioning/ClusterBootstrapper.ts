import pg from "pg";
import type { DatabaseRoleCredentials } from "../../config/config.js";
import { DATABASE_GROUP_ROLES } from "../postgres/databaseRoles.js";

export type ClusterBootstrapOptions = Readonly<{
  roles: Readonly<{
    platform: DatabaseRoleCredentials;
    tenant: DatabaseRoleCredentials;
    migrator: DatabaseRoleCredentials;
  }>;
  platformDatabase: string;
  tenantTemplateDatabase: string;
}>;

const ident = (name: string) => pg.escapeIdentifier(name);
const RESTRICTED = "nosuperuser nocreaterole noreplication nobypassrls";

/**
 * Idempotent cluster bootstrap, run with a superuser connection (setup only, never by the app):
 * group roles, login roles (passwords re-synced from config), the platform database and the
 * tenant template database, with CONNECT locked down.
 *
 * Role model:
 *  - migrator: owns every application database and runs DDL; may create databases.
 *  - platform app user ∈ af_platform_rw: data access to the platform database only.
 *  - tenant app user ∈ af_tenant_rw: data access to tenant databases only.
 */
export class ClusterBootstrapper {
  constructor(
    private readonly admin: pg.ClientBase,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async bootstrap(options: ClusterBootstrapOptions): Promise<void> {
    const { roles } = options;
    const { platformReadWrite, tenantReadWrite } = DATABASE_GROUP_ROLES;

    await this.ensureGroupRole(platformReadWrite);
    await this.ensureGroupRole(tenantReadWrite);
    await this.ensureLoginRole(roles.migrator, `${RESTRICTED} createdb`);
    await this.ensureLoginRole(roles.platform, `${RESTRICTED} nocreatedb`);
    await this.ensureLoginRole(roles.tenant, `${RESTRICTED} nocreatedb`);
    await this.admin.query(`grant ${ident(platformReadWrite)} to ${ident(roles.platform.user)}`);
    await this.admin.query(`grant ${ident(tenantReadWrite)} to ${ident(roles.tenant.user)}`);
    this.log("roles ready");

    const platform = options.platformDatabase;
    const platformCreated = await this.ensureDatabase(platform, roles.migrator.user);
    await this.admin.query(`revoke connect, temporary on database ${ident(platform)} from public`);
    await this.admin.query(
      `grant connect on database ${ident(platform)} to ${ident(platformReadWrite)}`,
    );
    this.log(`platform database ${platform} ${platformCreated ? "created" : "exists"}`);

    const template = options.tenantTemplateDatabase;
    const templateCreated = await this.ensureDatabase(template, roles.migrator.user);
    await this.admin.query(`revoke connect, temporary on database ${ident(template)} from public`);
    // Marked as a template so the migrator may clone it; only the migrator can connect to it.
    await this.admin.query(`alter database ${ident(template)} is_template true`);
    this.log(`tenant template database ${template} ${templateCreated ? "created" : "exists"}`);
  }

  private async roleExists(role: string): Promise<boolean> {
    const { rowCount } = await this.admin.query("select 1 from pg_roles where rolname = $1", [
      role,
    ]);
    return rowCount === 1;
  }

  private async ensureGroupRole(role: string): Promise<void> {
    if (!(await this.roleExists(role)))
      await this.admin.query(`create role ${ident(role)} nologin`);
  }

  private async ensureLoginRole(
    credentials: DatabaseRoleCredentials,
    attributes: string,
  ): Promise<void> {
    // Passwords cannot be bound as parameters in role DDL; escapeLiteral quotes them safely.
    const verb = (await this.roleExists(credentials.user)) ? "alter" : "create";
    await this.admin.query(
      `${verb} role ${ident(credentials.user)} login ${attributes} password ${pg.escapeLiteral(credentials.password)}`,
    );
  }

  private async ensureDatabase(database: string, owner: string): Promise<boolean> {
    const { rowCount } = await this.admin.query("select 1 from pg_database where datname = $1", [
      database,
    ]);
    if (rowCount === 1) {
      await this.admin.query(`alter database ${ident(database)} owner to ${ident(owner)}`);
      return false;
    }
    await this.admin.query(`create database ${ident(database)} owner ${ident(owner)}`);
    return true;
  }
}
