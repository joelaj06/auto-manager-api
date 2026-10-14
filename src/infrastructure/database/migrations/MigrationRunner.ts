import { performance } from "node:perf_hooks";
import type pg from "pg";
import { PgErrorCodes, pgErrorCode } from "../postgres/pgErrors.js";
import type { Queryable } from "../postgres/Queryable.js";
import type { MigrationCatalog } from "./MigrationCatalog.js";
import type { MigrationFile } from "./MigrationFile.js";
import {
  MigrationChecksumMismatchError,
  MigrationFailedError,
  MigrationOrderError,
} from "./migrationErrors.js";

export type MigrateResult = Readonly<{
  applied: string[];
  currentVersion: string | null;
  /** Versions recorded in the database but unknown to this build (a newer build migrated it). */
  unknownApplied: string[];
}>;

type AppliedRow = { version: string; checksum: string };

const LOCK_KEY = "autoforce:schema-migrations";

/**
 * Applies pending migrations to the database a client is connected to.
 *
 * - Serialised per database with an advisory lock, so concurrent runners are safe.
 * - Each migration runs in its own transaction (unless marked no-transaction) together with its
 *   bookkeeping row, so a failed migration leaves nothing behind.
 * - Refuses to run if an applied migration was edited, or if a new migration is numbered below
 *   one already applied.
 */
export class MigrationRunner {
  constructor(private readonly log: (message: string) => void = () => undefined) {}

  async migrate(client: pg.ClientBase, catalog: MigrationCatalog): Promise<MigrateResult> {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          version      text primary key,
          name         text not null,
          checksum     text not null,
          applied_at   timestamptz not null default now(),
          execution_ms integer not null
        )`);

      const { rows } = await client.query<AppliedRow>(
        "select version, checksum from schema_migrations order by version",
      );
      const applied = new Map(rows.map((row) => [row.version, row.checksum]));
      const known = new Set(catalog.migrations.map((m) => m.version));

      for (const migration of catalog.migrations) {
        const checksum = applied.get(migration.version);
        if (checksum !== undefined && checksum !== migration.checksum) {
          throw new MigrationChecksumMismatchError(migration.version);
        }
      }

      const latestApplied = rows.at(-1)?.version ?? null;
      const pending = catalog.migrations.filter((m) => !applied.has(m.version));
      for (const migration of pending) {
        if (latestApplied !== null && migration.version < latestApplied) {
          throw new MigrationOrderError(migration.version, latestApplied);
        }
      }

      const appliedNow: string[] = [];
      for (const migration of pending) {
        await this.apply(client, migration);
        appliedNow.push(migration.version);
        this.log(`applied ${migration.fileName}`);
      }

      return {
        applied: appliedNow,
        currentVersion: appliedNow.at(-1) ?? latestApplied,
        unknownApplied: rows.map((r) => r.version).filter((v) => !known.has(v)),
      };
    } finally {
      // Best effort: the lock is released with the session anyway, and a failure here must not
      // hide the original error.
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY])
        .catch(() => undefined);
    }
  }

  /** Latest applied version, or null when the database has never been migrated. */
  static async readSchemaVersion(db: Queryable): Promise<string | null> {
    try {
      const { rows } = await db.query<{ version: string | null }>(
        "select max(version) as version from schema_migrations",
      );
      return rows[0]?.version ?? null;
    } catch (error) {
      if (pgErrorCode(error) === PgErrorCodes.undefinedTable) return null;
      throw error;
    }
  }

  private async apply(client: pg.ClientBase, migration: MigrationFile): Promise<void> {
    const record = (elapsedMs: number) =>
      client.query(
        "insert into schema_migrations (version, name, checksum, execution_ms) values ($1, $2, $3, $4)",
        [migration.version, migration.name, migration.checksum, Math.round(elapsedMs)],
      );

    const started = performance.now();
    if (!migration.transactional) {
      try {
        await client.query(migration.sql);
      } catch (error) {
        throw new MigrationFailedError(migration.version, migration.fileName, error);
      }
      await record(performance.now() - started);
      return;
    }

    await client.query("begin");
    try {
      await client.query(migration.sql);
      await record(performance.now() - started);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw new MigrationFailedError(migration.version, migration.fileName, error);
    }
  }
}
