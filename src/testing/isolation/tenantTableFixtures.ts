import { randomUUID } from "node:crypto";

/**
 * How the isolation suite writes and finds one row of each tenant table. Every table in the
 * tenant schema must appear here or in TENANT_TABLE_EXEMPTIONS — the suite fails for a new table
 * until its author adds a fixture, so no table ships without an isolation test.
 *
 * `insert(marker)` returns SQL that stores a row identifiable by `marker`; `find` returns SQL
 * with `$1` = marker that selects it.
 */
export type TableFixture = Readonly<{
  insert: (marker: string) => Readonly<{ sql: string; params: unknown[] }>;
  find: string;
}>;

const now = () => new Date();
const inOneDay = () => new Date(Date.now() + 86_400_000);

export const TENANT_TABLE_FIXTURES: Readonly<Record<string, TableFixture>> = {
  counters: {
    insert: (marker) => ({
      sql: "insert into counters (key, value) values ($1, 1)",
      params: [marker],
    }),
    find: "select 1 from counters where key = $1",
  },
  audit_logs: {
    insert: (marker) => ({
      sql: `insert into audit_logs (actor_type, action, entity_type, entity_id)
            values ('system', 'isolation.check', 'isolation', $1)`,
      params: [marker],
    }),
    find: "select 1 from audit_logs where entity_id = $1",
  },
  outbox: {
    insert: (marker) => ({
      sql: `insert into outbox (event_type, aggregate_id, payload, available_at)
            values ('isolation.check', $1, '{}', now() + interval '1 day')`,
      params: [marker],
    }),
    find: "select 1 from outbox where aggregate_id = $1",
  },
  auth_sessions: {
    insert: (marker) => ({
      sql: `insert into auth_sessions
              (id, user_id, refresh_token_hash, created_at, last_rotated_at, expires_at, user_agent)
            values ($1, $2, $3, $4, $4, $5, $6)`,
      params: [randomUUID(), randomUUID(), randomUUID(), now(), inOneDay(), marker],
    }),
    find: "select 1 from auth_sessions where user_agent = $1",
  },
  otp_challenges: {
    insert: (marker) => ({
      sql: `insert into otp_challenges
              (id, subject, purpose, code_hash, max_attempts, created_at, expires_at)
            values ($1, $2, 'email_verification', 'hash', 5, $3, $4)`,
      params: [randomUUID(), marker, now(), inOneDay()],
    }),
    find: "select 1 from otp_challenges where subject = $1",
  },
  processed_messages: {
    insert: (marker) => ({
      sql: "insert into processed_messages (key) values ($1)",
      params: [marker],
    }),
    find: "select 1 from processed_messages where key = $1",
  },
};

/** Tables the app does not write, with the reason and the test that covers them instead. */
export const TENANT_TABLE_EXEMPTIONS: Readonly<Record<string, string>> = {
  tenant_info:
    "identity row written at provisioning; read-only for the app; the pool verifies it on every new pool (TenantDatabases.int.test)",
  schema_migrations: "migration bookkeeping; read-only for the app (MigrationRunner tests)",
};

/** Tables whose rows may never change once written (forbid_mutation trigger). */
export const APPEND_ONLY_TENANT_TABLES: readonly string[] = ["audit_logs"];
