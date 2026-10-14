import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MigrationFile } from "./MigrationFile.js";
import { MigrationFileError } from "./migrationErrors.js";

/** An ordered, validated set of migrations (no duplicate versions). */
export class MigrationCatalog {
  readonly migrations: readonly MigrationFile[];

  constructor(migrations: readonly MigrationFile[]) {
    const sorted = [...migrations].sort((a, b) => a.version.localeCompare(b.version));
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (previous !== undefined && current !== undefined && previous.version === current.version) {
        throw new MigrationFileError(
          `Duplicate migration version ${current.version}: ${previous.fileName}, ${current.fileName}`,
        );
      }
    }
    this.migrations = sorted;
  }

  /** Reads every `*.sql` file in `directory` (non-recursive). */
  static async fromDirectory(directory: string): Promise<MigrationCatalog> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
    const migrations = await Promise.all(
      files.map(async (file) =>
        MigrationFile.parse(file.name, await readFile(path.join(directory, file.name), "utf8")),
      ),
    );
    return new MigrationCatalog(migrations);
  }

  get latestVersion(): string | null {
    return this.migrations.at(-1)?.version ?? null;
  }

  /** A new catalog with extra migrations appended (used by tests and tooling). */
  with(...extra: MigrationFile[]): MigrationCatalog {
    return new MigrationCatalog([...this.migrations, ...extra]);
  }
}

/** The two migration sets: `<root>/platform` and `<root>/tenant`. */
export class MigrationSets {
  private constructor(
    readonly platform: MigrationCatalog,
    readonly tenant: MigrationCatalog,
  ) {}

  /** Loads both sets, resolving `root` against the working directory. */
  static async load(root: string): Promise<MigrationSets> {
    const directory = path.resolve(root);
    const [platform, tenant] = await Promise.all([
      MigrationCatalog.fromDirectory(path.join(directory, "platform")),
      MigrationCatalog.fromDirectory(path.join(directory, "tenant")),
    ]);
    return new MigrationSets(platform, tenant);
  }
}
