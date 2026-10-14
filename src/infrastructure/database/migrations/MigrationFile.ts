import { createHash } from "node:crypto";
import { MigrationFileError } from "./migrationErrors.js";

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const NO_TRANSACTION = /^\s*--\s*migrate:no-transaction\s*$/m;

/** One SQL migration file, e.g. `0003_add_vehicles.sql`. */
export class MigrationFile {
  private constructor(
    /** Four-digit, zero-padded; compared as text, so ordering is lexicographic and numeric. */
    readonly version: string,
    readonly name: string,
    readonly fileName: string,
    readonly sql: string,
    /** SHA-256 of the file with line endings normalised; editing an applied file is detected. */
    readonly checksum: string,
    /** False when the file starts with `-- migrate:no-transaction` (e.g. CREATE INDEX CONCURRENTLY). */
    readonly transactional: boolean,
  ) {}

  static parse(fileName: string, content: string): MigrationFile {
    const match = FILE_NAME.exec(fileName);
    if (match === null) {
      throw new MigrationFileError(
        `Migration file name "${fileName}" must look like 0001_snake_case_name.sql`,
      );
    }
    const [, version, name] = match as unknown as [string, string, string];
    const sql = content.replace(/\r\n/g, "\n");
    if (sql.trim().length === 0) throw new MigrationFileError(`Migration ${fileName} is empty`);

    return new MigrationFile(
      version,
      name,
      fileName,
      sql,
      createHash("sha256").update(sql).digest("hex"),
      !NO_TRANSACTION.test(MigrationFile.leadingComments(sql)),
    );
  }

  /** The comment block at the top of the file; directives only count there. */
  private static leadingComments(sql: string): string {
    const header: string[] = [];
    for (const line of sql.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "" && !trimmed.startsWith("--")) break;
      header.push(line);
    }
    return header.join("\n");
  }
}
