import { readFileSync } from "node:fs";
import pg from "pg";
import type { DatabaseConfig, DatabaseRoleCredentials, SslMode } from "../config/config.js";

export type ConnectionSettings = Readonly<{
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: SslMode;
  sslCaFile?: string | undefined;
}>;

const APPLICATION_NAME = "autoforce-api";

function sslOption(settings: ConnectionSettings): pg.ClientConfig["ssl"] {
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

/** node-postgres client options. Only transaction-scoped settings are used elsewhere, so the
 * same options work through PgBouncer in transaction-pooling mode. */
export function clientConfig(settings: ConnectionSettings): pg.ClientConfig {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    ssl: sslOption(settings),
    application_name: APPLICATION_NAME,
  };
}

export function connectionSettings(
  database: DatabaseConfig,
  role: DatabaseRoleCredentials,
  databaseName: string,
): ConnectionSettings {
  return {
    host: database.host,
    port: database.port,
    user: role.user,
    password: role.password,
    database: databaseName,
    ssl: database.ssl,
    sslCaFile: database.sslCaFile,
  };
}

/** Opens a single dedicated connection (used for migrations, provisioning and admin tasks). */
export async function connectClient(settings: ConnectionSettings): Promise<pg.Client> {
  const client = new pg.Client(clientConfig(settings));
  await client.connect();
  return client;
}
