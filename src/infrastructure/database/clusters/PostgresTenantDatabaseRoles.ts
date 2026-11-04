import pg from "pg";
import type { ITenantDatabaseRoles } from "../../../application/ports/ITenantDatabaseCredentials.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { DATABASE_GROUP_ROLES, tenantRoleOf } from "../postgres/databaseRoles.js";
import type { TenantDatabaseNaming } from "../postgres/TenantDatabaseNaming.js";
import type { ClusterConnections } from "./ClusterConnections.js";

const ident = (name: string) => pg.escapeIdentifier(name);
type Client = Pick<pg.ClientBase, "query">;

export async function roleExists(client: Client, role: string): Promise<boolean> {
  const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [role]);
  return rowCount === 1;
}

/**
 * Opens a tenant database to the app and backups: to the tenant's own login when it has one on
 * this server, otherwise to the shared login's group.
 */
export async function openTenantDatabase(client: Client, database: string): Promise<void> {
  const own = tenantRoleOf(database);
  const app = (await roleExists(client, own)) ? own : DATABASE_GROUP_ROLES.tenantReadWrite;
  await client.query(`revoke connect, temporary on database ${ident(database)} from public`);
  await client.query(
    `grant connect on database ${ident(database)} to ${ident(app)}, ${ident(DATABASE_GROUP_ROLES.backupReader)}`,
  );
}

/**
 * A tenant's own PostgreSQL login. Table rights are all granted to af_tenant_rw, which also holds
 * CONNECT on every other tenant's database, so the login is a NOINHERIT member: it gets none of
 * the group's rights by itself, so no other database lets it in, and it takes the group's role
 * only on sign-in to its own database (ALTER ROLE … IN DATABASE … SET role). Every migration's
 * grants and revokes keep applying, with nothing per tenant to keep in step.
 */
export class PostgresTenantDatabaseRoles implements ITenantDatabaseRoles {
  constructor(
    private readonly deps: Readonly<{
      clusters: ClusterConnections;
      naming: TenantDatabaseNaming;
      maintenanceDatabase: string;
      tenantUser: string;
    }>,
  ) {}

  roleNameOf(tenantId: string): string {
    return tenantRoleOf(this.nameOf(tenantId));
  }

  async ensure(tenantId: string, clusterId: string, password: string): Promise<void> {
    const database = this.nameOf(tenantId);
    const role = tenantRoleOf(database);
    const group = DATABASE_GROUP_ROLES.tenantReadWrite;
    await this.onMaintenance(clusterId, async (client) => {
      // A role with CREATEROLE may only change a password on a role, not its other attributes.
      await client.query(
        (await roleExists(client, role))
          ? `alter role ${ident(role)} password ${pg.escapeLiteral(password)}`
          : `create role ${ident(role)} login noinherit nosuperuser nocreatedb nocreaterole
               noreplication nobypassrls password ${pg.escapeLiteral(password)}`,
      );
      await client.query(`grant ${ident(group)} to ${ident(role)}`);
      await client.query(
        `alter role ${ident(role)} in database ${ident(database)} set role = ${pg.escapeLiteral(group)}`,
      );
      await client.query(`grant connect on database ${ident(database)} to ${ident(role)}`);
    });
  }

  async closeShared(tenantId: string, clusterId: string): Promise<void> {
    const database = this.nameOf(tenantId);
    await this.onMaintenance(clusterId, async (client) => {
      await client.query(
        `revoke connect on database ${ident(database)} from ${ident(DATABASE_GROUP_ROLES.tenantReadWrite)}`,
      );
      await client.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and usename = $2 and pid <> pg_backend_pid()`,
        [database, this.deps.tenantUser],
      );
    });
  }

  async openShared(tenantId: string, clusterId: string): Promise<void> {
    const database = this.nameOf(tenantId);
    await this.onMaintenance(clusterId, async (client) => {
      await client.query(
        `grant connect on database ${ident(database)} to ${ident(DATABASE_GROUP_ROLES.tenantReadWrite)}`,
      );
    });
  }

  async drop(tenantId: string, clusterId: string): Promise<void> {
    const database = this.nameOf(tenantId);
    const role = tenantRoleOf(database);
    await this.onMaintenance(clusterId, async (client) => {
      if (!(await roleExists(client, role))) return;
      await client.query(`alter role ${ident(role)} nologin`);
      await client.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where usename = $1 and pid <> pg_backend_pid()`,
        [role],
      );
      const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [
        database,
      ]);
      if (rowCount === 1)
        await client.query(`revoke all on database ${ident(database)} from ${ident(role)}`);
      await client.query(`drop role ${ident(role)}`);
    });
  }

  private nameOf(tenantId: string): string {
    return this.deps.naming.databaseNameFor(TenantId.from(tenantId));
  }

  private async onMaintenance(
    clusterId: string,
    fn: (client: pg.ClientBase) => Promise<void>,
  ): Promise<void> {
    const server = await this.deps.clusters.on(clusterId);
    const client = await server.connect("migrator", this.deps.maintenanceDatabase);
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  }
}
