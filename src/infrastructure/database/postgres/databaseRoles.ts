/** Group (NOLOGIN) roles that hold data-access grants; login roles are members of these. */
export const DATABASE_GROUP_ROLES = Object.freeze({
  platformReadWrite: "af_platform_rw",
  tenantReadWrite: "af_tenant_rw",
  /** Read-only access to every database, for backups (holds pg_read_all_data). */
  backupReader: "af_backup",
});

/** A tenant's own login (decision 532), named after its database, on the database's cluster. */
export const tenantRoleOf = (databaseName: string): string => `${databaseName}_app`;
