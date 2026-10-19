const SQLSTATE = /^[0-9A-Z]{5}$/;

/** PostgreSQL SQLSTATE of an error thrown by node-postgres, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = error.code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
  }
  return undefined;
}

export const PgErrorCodes = Object.freeze({
  duplicateDatabase: "42P04",
  invalidCatalogName: "3D000",
  undefinedTable: "42P01",
  objectInUse: "55006",
  insufficientPrivilege: "42501",
  uniqueViolation: "23505",
  exclusionViolation: "23P01",
  queryCanceled: "57014",
});
