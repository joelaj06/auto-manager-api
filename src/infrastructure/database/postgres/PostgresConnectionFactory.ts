import { readFileSync } from "node:fs";
import pg from "pg";
import type { DatabaseConfig, DatabaseRoleCredentials, SslMode } from "../../config/config.js";

export type ConnectionSettings = Readonly<{
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: SslMode;
  sslCaFile?: string | undefined;
}>;

export type DatabaseRole = "platform" | "tenant" | "migrator";

const APPLICATION_NAME = "autoforce-api";

/**
 * Builds node-postgres connections and pools for a given role and database from configuration.
 * Only transaction-scoped settings are used elsewhere, so these options also work through
 * PgBouncer in transaction-pooling mode.
 */
export class PostgresConnectionFactory {
  constructor(private readonly config: DatabaseConfig) {}

  settings(role: DatabaseRole, database: string): ConnectionSettings {
    const credentials: DatabaseRoleCredentials = this.config.roles[role];
    return {
      host: this.config.host,
      port: this.config.port,
      user: credentials.user,
      password: credentials.password,
      database,
      ssl: this.config.ssl,
      sslCaFile: this.config.sslCaFile,
    };
  }

  clientConfig(role: DatabaseRole, database: string): pg.ClientConfig {
    return PostgresConnectionFactory.toClientConfig(this.settings(role, database));
  }

  /** A single dedicated connection (migrations, provisioning, admin tasks). Caller ends it. */
  async connect(role: DatabaseRole, database: string): Promise<pg.Client> {
    const client = new pg.Client(this.clientConfig(role, database));
    await client.connect();
    return client;
  }

  createPool(role: DatabaseRole, database: string, options: pg.PoolConfig = {}): pg.Pool {
    return new pg.Pool({ ...this.clientConfig(role, database), ...options });
  }

  static toClientConfig(settings: ConnectionSettings): pg.ClientConfig {
    return {
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      database: settings.database,
      ssl: PostgresConnectionFactory.sslOption(settings),
      application_name: APPLICATION_NAME,
    };
  }

  private static sslOption(settings: ConnectionSettings): pg.ClientConfig["ssl"] {
    switch (settings.ssl) {
      case "disable":
        return false;
      case "require":
        // Encrypted, certificate not verified (libpq "require" semantics).
        return { rejectUnauthorized: false };
      case "verify-full":
        if (settings.sslCaFile === undefined) {
          throw new Error("DATABASE_SSL_CA_FILE is required for verify-full");
        }
        return { rejectUnauthorized: true, ca: readFileSync(settings.sslCaFile, "utf8") };
    }
  }
}
