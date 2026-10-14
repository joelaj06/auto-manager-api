import type pg from "pg";

/**
 * The only database surface repositories and services receive: run a parameterised query.
 * Implemented by transaction handles and pools; never exposes connection lifecycle methods.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/** Group (NOLOGIN) roles that own data-access grants; login roles are members of these. */
export const DATABASE_GROUP_ROLES = Object.freeze({
  platformReadWrite: "af_platform_rw",
  tenantReadWrite: "af_tenant_rw",
});
