import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminClientConfig, connectAdmin } from "../../../testing/testDatabase.js";
import { MigrationCatalog } from "./MigrationCatalog.js";
import { MigrationFile } from "./MigrationFile.js";
import {
  MigrationChecksumMismatchError,
  MigrationFailedError,
  MigrationOrderError,
} from "./migrationErrors.js";
import { MigrationRunner } from "./MigrationRunner.js";

const m1 = MigrationFile.parse("0001_create_a.sql", "create table a (id int primary key);");
const m2 = MigrationFile.parse("0002_create_b.sql", "create table b (id int primary key);");
const m3 = MigrationFile.parse("0003_insert_a.sql", "insert into a values (1);");
const catalog = (...files: MigrationFile[]) => new MigrationCatalog(files);

const runner = new MigrationRunner();
let databaseName: string;
let client: pg.Client;

beforeEach(async () => {
  databaseName = `tt_migrator_${randomBytes(4).toString("hex")}`;
  const admin = await connectAdmin();
  await admin.query(`create database ${pg.escapeIdentifier(databaseName)}`);
  await admin.end();
  client = new pg.Client(adminClientConfig(databaseName));
  await client.connect();
});

afterEach(async () => {
  await client.end();
  const admin = await connectAdmin();
  await admin.query(`drop database if exists ${pg.escapeIdentifier(databaseName)} with (force)`);
  await admin.end();
});

const tables = async () =>
  (
    await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    )
  ).rows.map((r) => r.tablename);

describe("MigrationRunner", () => {
  it("applies pending migrations in order and records them", async () => {
    expect(await MigrationRunner.readSchemaVersion(client)).toBeNull();

    const result = await runner.migrate(client, catalog(m1, m2));

    expect(result).toEqual({
      applied: ["0001", "0002"],
      currentVersion: "0002",
      unknownApplied: [],
    });
    expect(await tables()).toEqual(["a", "b", "schema_migrations"]);
    expect(await MigrationRunner.readSchemaVersion(client)).toBe("0002");
  });

  it("is idempotent", async () => {
    await runner.migrate(client, catalog(m1, m2));
    const second = await runner.migrate(client, catalog(m1, m2));
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe("0002");
  });

  it("applies only new migrations on later runs", async () => {
    await runner.migrate(client, catalog(m1));
    const result = await runner.migrate(client, catalog(m1, m2, m3));
    expect(result.applied).toEqual(["0002", "0003"]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    await runner.migrate(client, catalog(m1));
    const edited = MigrationFile.parse(
      "0001_create_a.sql",
      "create table a (id bigint primary key);",
    );

    await expect(runner.migrate(client, catalog(edited, m2))).rejects.toBeInstanceOf(
      MigrationChecksumMismatchError,
    );
    expect(await tables()).not.toContain("b");
  });

  it("refuses a new migration numbered below an applied one", async () => {
    await runner.migrate(client, catalog(m1, m3));
    await expect(runner.migrate(client, catalog(m1, m2, m3))).rejects.toBeInstanceOf(
      MigrationOrderError,
    );
  });

  it("rolls back a failing migration completely and records nothing", async () => {
    const failing = MigrationFile.parse(
      "0002_half_done.sql",
      "create table c (id int); select * from table_that_does_not_exist;",
    );

    await expect(runner.migrate(client, catalog(m1, failing))).rejects.toBeInstanceOf(
      MigrationFailedError,
    );
    expect(await tables()).toEqual(["a", "schema_migrations"]);
    expect(await MigrationRunner.readSchemaVersion(client)).toBe("0001");
  });

  it("runs no-transaction migrations outside a transaction", async () => {
    const concurrently = MigrationFile.parse(
      "0002_index_a.sql",
      "-- migrate:no-transaction\ncreate index concurrently a_id_idx on a (id);",
    );
    const result = await runner.migrate(client, catalog(m1, concurrently));
    expect(result.applied).toEqual(["0001", "0002"]);
  });

  it("serialises concurrent runners on the same database", async () => {
    const other = new pg.Client(adminClientConfig(databaseName));
    await other.connect();
    try {
      const [first, second] = await Promise.all([
        runner.migrate(client, catalog(m1, m2, m3)),
        runner.migrate(other, catalog(m1, m2, m3)),
      ]);
      expect([...first.applied, ...second.applied].sort()).toEqual(["0001", "0002", "0003"]);
      const { rows } = await client.query<{ n: string }>("select count(*)::text as n from a");
      expect(rows[0]?.n).toBe("1");
    } finally {
      await other.end();
    }
  });

  it("reports versions applied by a newer build", async () => {
    await runner.migrate(client, catalog(m1, m2));
    const result = await runner.migrate(client, catalog(m1));
    expect(result.unknownApplied).toEqual(["0002"]);
    expect(result.currentVersion).toBe("0002");
  });
});
