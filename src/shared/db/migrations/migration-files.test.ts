import { describe, expect, it } from "vitest";
import {
  latestVersion,
  loadMigrationSets,
  MigrationFileError,
  parseMigration,
  sortMigrations,
} from "./migration-files.js";

describe("parseMigration", () => {
  it("parses version, name and checksum", () => {
    const migration = parseMigration("0003_add_vehicles.sql", "create table vehicles ();\n");

    expect(migration).toMatchObject({
      version: "0003",
      name: "add_vehicles",
      fileName: "0003_add_vehicles.sql",
      transactional: true,
    });
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same checksum regardless of line endings", () => {
    const unix = parseMigration("0001_a.sql", "select 1;\nselect 2;\n");
    const windows = parseMigration("0001_a.sql", "select 1;\r\nselect 2;\r\n");
    expect(windows.checksum).toBe(unix.checksum);
  });

  it("detects the no-transaction directive only in the leading comments", () => {
    const header = parseMigration(
      "0002_idx.sql",
      "-- Adds an index\n-- migrate:no-transaction\ncreate index concurrently x on t (a);",
    );
    const body = parseMigration(
      "0002_idx.sql",
      "create table t (a int);\n-- migrate:no-transaction\n",
    );

    expect(header.transactional).toBe(false);
    expect(body.transactional).toBe(true);
  });

  it.each(["1_short.sql", "0001-dash.sql", "0001_Upper.sql", "0001_.sql", "0001_a.txt"])(
    "rejects badly named file %s",
    (fileName) => {
      expect(() => parseMigration(fileName, "select 1;")).toThrow(MigrationFileError);
    },
  );

  it("rejects empty files", () => {
    expect(() => parseMigration("0001_empty.sql", "  \n ")).toThrow(MigrationFileError);
  });
});

describe("sortMigrations", () => {
  it("sorts by version", () => {
    const sorted = sortMigrations([
      parseMigration("0010_c.sql", "select 3;"),
      parseMigration("0002_b.sql", "select 2;"),
      parseMigration("0001_a.sql", "select 1;"),
    ]);
    expect(sorted.map((m) => m.version)).toEqual(["0001", "0002", "0010"]);
    expect(latestVersion(sorted)).toBe("0010");
  });

  it("rejects duplicate versions", () => {
    expect(() =>
      sortMigrations([
        parseMigration("0001_a.sql", "select 1;"),
        parseMigration("0001_b.sql", "select 2;"),
      ]),
    ).toThrow(/Duplicate migration version 0001/);
  });

  it("returns null as the latest version of an empty set", () => {
    expect(latestVersion([])).toBeNull();
  });
});

describe("loadMigrationSets", () => {
  it("loads the repository's platform and tenant migrations", async () => {
    const sets = await loadMigrationSets("db/migrations");

    expect(sets.platform[0]?.fileName).toBe("0001_platform_foundation.sql");
    expect(sets.tenant[0]?.fileName).toBe("0001_tenant_foundation.sql");
  });
});
