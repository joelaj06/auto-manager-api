/** Group (NOLOGIN) roles that hold data-access grants; login roles are members of these. */
export const DATABASE_GROUP_ROLES = Object.freeze({
  platformReadWrite: "af_platform_rw",
  tenantReadWrite: "af_tenant_rw",
  /** Read-only access to every database, for backups (holds pg_read_all_data). */
  backupReader: "af_backup",
});
