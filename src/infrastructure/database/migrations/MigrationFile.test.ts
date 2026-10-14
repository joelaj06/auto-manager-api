import { describe, expect, it } from "vitest";
import { MigrationCatalog, MigrationSets } from "./MigrationCatalog.js";
import { MigrationFile } from "./MigrationFile.js";
import { MigrationFileError } from "./migrationErrors.js";

describe("MigrationFile.parse", () => {
  it("parses version, name and checksum", () => {
    const migration = MigrationFile.parse("0003_add_vehicles.sql", "create table vehicles ();\n");

    expect(migration).toMatchObject({
      version: "0003",
      name: "add_vehicles",
      fileName: "0003_add_vehicles.sql",
      transactional: true,
    });
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same checksum regardless of line endings", () => {
    const unix = MigrationFile.parse("0001_a.sql", "select 1;\nselect 2;\n");
    const windows = MigrationFile.parse("0001_a.sql", "select 1;\r\nselect 2;\r\n");
    expect(windows.checksum).toBe(unix.checksum);
  });

  it("detects the no-transaction directive only in the leading comments", () => {
    const header = MigrationFile.parse(
      "0002_idx.sql",
      "-- Adds an index\n-- migrate:no-transaction\ncreate index concurrently x on t (a);",
    );
    const body = MigrationFile.parse(
      "0002_idx.sql",
      "create table t (a int);\n-- migrate:no-transaction\n",
    );

    expect(header.transactional).toBe(false);
    expect(body.transactional).toBe(true);
  });

  it.each(["1_short.sql", "0001-dash.sql", "0001_Upper.sql", "0001_.sql", "0001_a.txt"])(
    "rejects badly named file %s",
    (fileName) => {
      expect(() => MigrationFile.parse(fileName, "select 1;")).toThrow(MigrationFileError);
    },
  );

  it("rejects empty files", () => {
    expect(() => MigrationFile.parse("0001_empty.sql", "  \n ")).toThrow(MigrationFileError);
  });
});

describe("MigrationCatalog", () => {
  it("sorts by version and exposes the latest", () => {
    const catalog = new MigrationCatalog([
      MigrationFile.parse("0010_c.sql", "select 3;"),
      MigrationFile.parse("0002_b.sql", "select 2;"),
      MigrationFile.parse("0001_a.sql", "select 1;"),
    ]);
    expect(catalog.migrations.map((m) => m.version)).toEqual(["0001", "0002", "0010"]);
    expect(catalog.latestVersion).toBe("0010");
  });

  it("rejects duplicate versions", () => {
    expect(
      () =>
        new MigrationCatalog([
          MigrationFile.parse("0001_a.sql", "select 1;"),
          MigrationFile.parse("0001_b.sql", "select 2;"),
        ]),
    ).toThrow(/Duplicate migration version 0001/);
  });

  it("has no latest version when empty", () => {
    expect(new MigrationCatalog([]).latestVersion).toBeNull();
  });

  it("loads the repository's platform and tenant migrations", async () => {
    const sets = await MigrationSets.load("db/migrations");

    expect(sets.platform.migrations[0]?.fileName).toBe("0001_platform_foundation.sql");
    expect(sets.tenant.migrations[0]?.fileName).toBe("0001_tenant_foundation.sql");
  });
});
