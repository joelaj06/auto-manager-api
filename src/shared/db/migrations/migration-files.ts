import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Migration = Readonly<{
  /** Four-digit, zero-padded; compared as text, so ordering is lexicographic and numeric. */
  version: string;
  name: string;
  fileName: string;
  sql: string;
  /** SHA-256 of the file with line endings normalised; editing an applied file is detected. */
  checksum: string;
  /** False when the file starts with `-- migrate:no-transaction` (e.g. CREATE INDEX CONCURRENTLY). */
  transactional: boolean;
}>;

export class MigrationFileError extends Error {
  readonly code = "MIGRATION_FILE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const NO_TRANSACTION = /^\s*--\s*migrate:no-transaction\s*$/m;

/** The comment block at the top of the file; directives only count there. */
function leadingComments(sql: string): string {
  const header: string[] = [];
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("--")) break;
    header.push(line);
  }
  return header.join("\n");
}

export function parseMigration(fileName: string, content: string): Migration {
  const match = FILE_NAME.exec(fileName);
  if (match === null) {
    throw new MigrationFileError(
      `Migration file name "${fileName}" must look like 0001_snake_case_name.sql`,
    );
  }
  const [, version, name] = match as unknown as [string, string, string];
  const sql = content.replace(/\r\n/g, "\n");
  if (sql.trim().length === 0) {
    throw new MigrationFileError(`Migration ${fileName} is empty`);
  }

  return {
    version,
    name,
    fileName,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
    transactional: !NO_TRANSACTION.test(leadingComments(sql)),
  };
}

/** Parses, validates and sorts migrations. Fails on bad names or duplicate versions. */
export function sortMigrations(migrations: readonly Migration[]): Migration[] {
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
  return sorted;
}

/** Reads every `*.sql` file in `directory` (non-recursive). */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));

  const migrations = await Promise.all(
    files.map(async (file) =>
      parseMigration(file.name, await readFile(path.join(directory, file.name), "utf8")),
    ),
  );
  return sortMigrations(migrations);
}

export function latestVersion(migrations: readonly Migration[]): string | null {
  return migrations.at(-1)?.version ?? null;
}

export type MigrationSets = Readonly<{ platform: Migration[]; tenant: Migration[] }>;

/** Loads `<dir>/platform` and `<dir>/tenant`, resolving `dir` against the working directory. */
export async function loadMigrationSets(directory: string): Promise<MigrationSets> {
  const root = path.resolve(directory);
  const [platform, tenant] = await Promise.all([
    loadMigrations(path.join(root, "platform")),
    loadMigrations(path.join(root, "tenant")),
  ]);
  return { platform, tenant };
}
