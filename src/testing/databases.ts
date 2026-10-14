import pg from "pg";

/**
 * Test and load-test helpers. Production code has no way to drop a database (tenants are never
 * deleted); these helpers exist only to clean up throw-away databases and refuse any prefix
 * other than the dedicated test ones.
 */
const DISPOSABLE_PREFIXES = new Set(["tt_", "lt_"]);

function assertDisposablePrefix(prefix: string): void {
  if (!DISPOSABLE_PREFIXES.has(prefix)) {
    throw new Error(`Refusing to drop databases with prefix "${prefix}"`);
  }
}

export async function listDatabasesWithPrefix(
  admin: pg.ClientBase,
  prefix: string,
): Promise<string[]> {
  assertDisposablePrefix(prefix);
  const { rows } = await admin.query<{ datname: string }>(
    "select datname from pg_database where starts_with(datname, $1) order by datname",
    [prefix],
  );
  return rows.map((row) => row.datname);
}

export async function dropDatabasesWithPrefix(
  admin: pg.ClientBase,
  prefix: string,
): Promise<number> {
  const names = await listDatabasesWithPrefix(admin, prefix);
  for (const name of names) {
    await admin.query(`drop database if exists ${pg.escapeIdentifier(name)} with (force)`);
  }
  return names.length;
}

/** Drops one of the dedicated test databases (platform/template copies used by the test suite). */
export async function dropTestDatabase(admin: pg.ClientBase, name: string): Promise<void> {
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to drop non-test database "${name}"`);
  }
  const ident = pg.escapeIdentifier(name);
  const { rowCount } = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (rowCount === 0) return;
  await admin.query(`alter database ${ident} is_template false`);
  await admin.query(`drop database ${ident} with (force)`);
}
