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
/** A code-safe form of the marker (letters only) for columns with strict formats. */
const letters = (marker: string) =>
  marker
    .replace(/[^0-9a-f]/g, "")
    .replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)
    .slice(0, 16);
const inOneDay = () => new Date(Date.now() + 86_400_000);

/** A branch and a vehicle (code = marker) for tables that hang off a vehicle; `$2` = branch code. */
const VEHICLE = `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $1, 'Isolation', 'Fixture', 'available', b.id from b returning id)`;

export const TENANT_TABLE_FIXTURES: Readonly<Record<string, TableFixture>> = {
  vehicle_groups: {
    insert: (marker) => ({
      sql: "insert into vehicle_groups (name) values ($1)",
      params: [marker],
    }),
    find: "select 1 from vehicle_groups where name = $1",
  },
  vehicles: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id)
            insert into vehicles (code, make, model, status, branch_id)
            select $1, 'Isolation', 'Fixture', 'available', b.id from b`,
      params: [marker, `VH${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicles where code = $1",
  },
  vehicle_group_members: {
    insert: (marker) => ({
      sql: `${VEHICLE}, g as (insert into vehicle_groups (name) values ($1) returning id)
            insert into vehicle_group_members (vehicle_id, group_id) select v.id, g.id from v, g`,
      params: [marker, `GM${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from vehicle_group_members m join vehicles v on v.id = m.vehicle_id
            where v.code = $1`,
  },
  vehicle_status_history: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into vehicle_status_history (vehicle_id, to_status, reason)
            select v.id, 'available', $1 from v`,
      params: [marker, `SH${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicle_status_history where reason = $1",
  },
  vehicle_documents: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into vehicle_documents (vehicle_id, type, number) select v.id, 'insurance', $1 from v`,
      params: [marker, `VD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicle_documents where number = $1",
  },
  odometer_readings: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into odometer_readings (vehicle_id, value, read_at, note)
            select v.id, 100, now(), $1 from v`,
      params: [marker, `OR${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from odometer_readings where note = $1",
  },
  fx_rates: {
    insert: (marker) => ({
      sql: `insert into fx_rates (base, quote, rate, rate_date, source)
            values ('GHS', 'USD', 15.42, current_date - (abs(hashtext($1)) % 3650), 'manual')`,
      params: [marker],
    }),
    find: "select 1 from fx_rates where rate_date = current_date - (abs(hashtext($1)) % 3650)",
  },
  files: {
    insert: (marker) => ({
      sql: `insert into files (kind, storage_key, visibility, filename, content_type, size_bytes)
            values ('organisation_logo', $1, 'public', 'isolation.png', 'image/png', 1)`,
      params: [marker],
    }),
    find: "select 1 from files where storage_key = $1",
  },
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
  organisation: {
    // Singleton: the fixture tenants are not seeded, so the row is free to create.
    insert: (marker) => ({
      sql: "insert into organisation (name) values ($1) on conflict (singleton) do update set name = excluded.name",
      params: [marker],
    }),
    find: "select 1 from organisation where name = $1",
  },
  branches: {
    insert: (marker) => ({
      sql: "insert into branches (code, name) values ($1, $2)",
      params: [`ISO${letters(marker).toUpperCase().slice(0, 12)}`, marker],
    }),
    find: "select 1 from branches where name = $1",
  },
  permissions: {
    insert: (marker) => ({
      sql: `insert into permissions (key, module, description, scopes, catalogue_version)
            values ($1, 'isolation', $2, '{all}', 0)`,
      params: [`isolation.${letters(marker)}`, marker],
    }),
    find: "select 1 from permissions where description = $1",
  },
  roles: {
    insert: (marker) => ({ sql: "insert into roles (name) values ($1)", params: [marker] }),
    find: "select 1 from roles where name = $1",
  },
  role_permissions: {
    insert: (marker) => ({
      sql: `with p as (insert into permissions (key, module, description, scopes, catalogue_version)
                       values ($1, 'isolation', 'rp', '{all}', 0) returning key),
                 r as (insert into roles (name) values ($2) returning id)
            insert into role_permissions (role_id, permission_key, scope)
            select r.id, p.key, 'all' from r, p`,
      params: [`isolation.${letters(marker)}`, marker],
    }),
    find: `select 1 from role_permissions rp join roles r on r.id = rp.role_id where r.name = $1`,
  },
  users: {
    insert: (marker) => ({
      sql: "insert into users (email, name) values ($1, 'Isolation')",
      params: [`${marker}@example.com`],
    }),
    find: "select 1 from users where email = $1 || '@example.com'",
  },
  user_branches: {
    insert: (marker) => ({
      sql: `with u as (insert into users (email, name) values ($1, 'Isolation') returning id),
                 b as (insert into branches (code, name) values ($2, $3) returning id)
            insert into user_branches (user_id, branch_id) select u.id, b.id from u, b`,
      params: [`${marker}@example.com`, `UB${letters(marker).toUpperCase().slice(0, 12)}`, marker],
    }),
    find: `select 1 from user_branches ub join branches b on b.id = ub.branch_id where b.name = $1`,
  },
  user_roles: {
    insert: (marker) => ({
      sql: `with u as (insert into users (email, name) values ($1, 'Isolation') returning id),
                 r as (insert into roles (name) values ($2) returning id)
            insert into user_roles (user_id, role_id) select u.id, r.id from u, r`,
      params: [`${marker}@example.com`, marker],
    }),
    find: `select 1 from user_roles ur join roles r on r.id = ur.role_id where r.name = $1`,
  },
  user_invitations: {
    insert: (marker) => ({
      sql: `with u as (insert into users (email, name) values ($1, 'Isolation') returning id)
            insert into user_invitations (user_id, token_hash, expires_at)
            select u.id, $2, now() + interval '1 day' from u`,
      params: [`${marker}@example.com`, marker],
    }),
    find: "select 1 from user_invitations where token_hash = $1",
  },
  expense_categories: {
    insert: (marker) => ({
      sql: "insert into expense_categories (code, name) values ($1, $2)",
      params: [`iso_${letters(marker)}`, marker],
    }),
    find: "select 1 from expense_categories where name = $1",
  },
  tax_codes: {
    insert: (marker) => ({
      sql: "insert into tax_codes (code, name) values ($1, $2)",
      params: [`ISO_${letters(marker).toUpperCase().slice(0, 15)}`, marker],
    }),
    find: "select 1 from tax_codes where name = $1",
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
