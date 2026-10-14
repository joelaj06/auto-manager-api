export class MigrationFileError extends Error {
  readonly code = "MIGRATION_FILE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MigrationFileError";
  }
}

export class MigrationChecksumMismatchError extends Error {
  readonly code = "MIGRATION_CHECKSUM_MISMATCH";

  constructor(readonly version: string) {
    super(
      `Migration ${version} was changed after it was applied. Add a new migration instead of editing an applied one.`,
    );
    this.name = "MigrationChecksumMismatchError";
  }
}

export class MigrationOrderError extends Error {
  readonly code = "MIGRATION_OUT_OF_ORDER";

  constructor(
    readonly version: string,
    readonly latestApplied: string,
  ) {
    super(
      `Migration ${version} is older than the latest applied migration ${latestApplied}. Renumber it after ${latestApplied}.`,
    );
    this.name = "MigrationOrderError";
  }
}

export class MigrationFailedError extends Error {
  readonly code = "MIGRATION_FAILED";

  constructor(
    readonly version: string,
    readonly fileName: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Migration ${fileName} failed: ${detail}`, { cause });
    this.name = "MigrationFailedError";
  }
}
