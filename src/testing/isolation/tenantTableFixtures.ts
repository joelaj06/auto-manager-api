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

/** A branch and a driver (code = marker) for tables that hang off a driver; `$2` = branch code. */
const DRIVER = `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 d as (insert into drivers (code, first_name, last_name, phone, branch_id)
                       select $1, 'Isolation', 'Driver',
                              '+233' || (200000000 + abs(hashtext($1)) % 99999999)::text, b.id
                         from b returning id)`;

/** A branch, a category and a draft expense (description = marker); `$2` branch code, `$3` letters. */
const EXPENSE = `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 c as (insert into expense_categories (code, name) values ('ex' || $3, 'Isolation') returning id),
                 e as (insert into expenses (status, category_id, description, branch_id, expense_date,
                         amount_minor, net_minor)
                       select 'draft', c.id, $1, b.id, current_date, 100, 100 from b, c returning id)`;

/** A driver's assignment and its remittance (number = marker); `$2` = branch code. */
const REMITTANCE = `${DRIVER},
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $1, 'Isolation', 'Fixture', 'assigned', b.id from b returning id),
                 a as (insert into vehicle_assignments (vehicle_id, driver_id, branch_id, type,
                         remittance_mode, target_minor, target_frequency, started_at,
                         start_odometer, start_checklist)
                       select v.id, d.id, b.id, 'remittance', 'fixed_target', 100, 'daily', now(), 0,
                              '{"items": []}' from v, d, b returning id),
                 r as (insert into remittances (number, assignment_id, driver_id, vehicle_id, branch_id,
                         mode, period_start, period_end, expected_minor, status)
                       select $1, a.id, d.id, v.id, b.id, 'fixed_target', current_date, current_date,
                              100, 'pending' from a, d, v, b returning id)`;

export const TENANT_TABLE_FIXTURES: Readonly<Record<string, TableFixture>> = {
  remittances: {
    insert: (marker) => ({
      sql: `${REMITTANCE}
            select 1`,
      params: [marker, `RM${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from remittances where number = $1",
  },
  remittance_submissions: {
    insert: (marker) => ({
      sql: `${REMITTANCE}
            insert into remittance_submissions (remittance_id, declared_minor, method, status,
              submitted_at, notes)
            select r.id, 100, 'cash', 'submitted', now(), $1 from r`,
      params: [marker, `RS${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from remittance_submissions where notes = $1",
  },
  remittance_payments: {
    insert: (marker) => ({
      sql: `${REMITTANCE},
                 p as (insert into payments (number, direction, method, status, party_type, party_id,
                         party_name, branch_id, paid_on, currency, fx_rate, amount_minor, amount_base_minor)
                       select $1 || '-p', 'in', 'cash', 'recorded', 'driver', d.id, 'Isolation', b.id,
                              current_date, 'GHS', 1, 100, 100 from d, b returning id)
            insert into remittance_payments (remittance_id, payment_id, amount_minor, settled_minor)
            select r.id, p.id, 100, 100 from r, p`,
      params: [marker, `RP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from remittance_payments rp join payments p on p.id = rp.payment_id
            where p.number = $1 || '-p'`,
  },
  expense_approval_rules: {
    insert: (marker) => ({
      sql: "insert into expense_approval_rules (name, action) values ($1, 'auto_approve')",
      params: [marker],
    }),
    find: "select 1 from expense_approval_rules where name = $1",
  },
  expenses: {
    insert: (marker) => ({
      sql: `${EXPENSE}
            select 1`,
      params: [marker, `EX${letters(marker).toUpperCase().slice(0, 12)}`, letters(marker)],
    }),
    find: "select 1 from expenses where description = $1",
  },
  expense_lines: {
    insert: (marker) => ({
      sql: `${EXPENSE}
            insert into expense_lines (expense_id, position, amount_minor, net_minor, tax_minor)
            select e.id, 1, 100, 100, 0 from e`,
      params: [marker, `EL${letters(marker).toUpperCase().slice(0, 12)}`, letters(marker)],
    }),
    find: `select 1 from expense_lines l join expenses e on e.id = l.expense_id
            where e.description = $1`,
  },
  recurring_expenses: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 c as (insert into expense_categories (code, name) values ('rc' || $3, 'Isolation') returning id)
            insert into recurring_expenses (name, category_id, branch_id, description, amount_minor,
              frequency, next_run_on)
            select $1, c.id, b.id, 'Isolation', 100, 'monthly', current_date from b, c`,
      params: [marker, `RE${letters(marker).toUpperCase().slice(0, 12)}`, letters(marker)],
    }),
    find: "select 1 from recurring_expenses where name = $1",
  },
  budgets: {
    insert: (marker) => ({
      sql: "insert into budgets (name, monthly_amount_minor) values ($1, 100)",
      params: [marker],
    }),
    find: "select 1 from budgets where name = $1",
  },
  fuel_logs: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into fuel_logs (vehicle_id, filled_at, litres, amount_minor, odometer, notes)
            select v.id, now(), 10, 100, 1000, $1 from v`,
      params: [marker, `FL${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from fuel_logs where notes = $1",
  },
  ledger_accounts: {
    insert: (marker) => ({
      sql: "insert into ledger_accounts (code, name, type) values ((100000 + abs(hashtext($1)) % 899999)::text, $1, 'income')",
      params: [marker],
    }),
    find: "select 1 from ledger_accounts where name = $1",
  },
  journal_entries: {
    insert: (marker) => ({
      sql: `insert into journal_entries (number, entry_date, description, source_type, source_id)
            values ($1, current_date, 'Isolation', 'isolation', gen_random_uuid())`,
      params: [marker],
    }),
    find: "select 1 from journal_entries where number = $1",
  },
  ledger_lines: {
    insert: (marker) => ({
      sql: `with e as (insert into journal_entries (number, entry_date, description, source_type, source_id)
                       values ($1, current_date, 'Isolation', 'isolation', gen_random_uuid()) returning id)
            insert into ledger_lines (entry_id, account_id, debit_minor, credit_minor, memo)
            select e.id, a.id, case when a.code = '1000' then 100 else 0 end,
                   case when a.code = '4900' then 100 else 0 end,
                   case when a.code = '1000' then $1 end
              from e, ledger_accounts a where a.code in ('1000', '4900')`,
      params: [marker],
    }),
    find: "select 1 from ledger_lines where memo = $1",
  },
  invoices: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id)
            insert into invoices (status, party_type, party_id, party_name, branch_id, issue_date,
              due_date, currency, fx_rate, prices_include_tax)
            select 'draft', 'customer', gen_random_uuid(), $1, b.id, current_date, current_date, 'GHS', 1, false from b`,
      params: [marker, `IN${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from invoices where party_name = $1",
  },
  invoice_lines: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 i as (insert into invoices (status, party_type, party_id, party_name, branch_id,
                         issue_date, due_date, currency, fx_rate, prices_include_tax)
                       select 'draft', 'customer', gen_random_uuid(), 'Isolation', b.id,
                              current_date, current_date, 'GHS', 1, false from b returning id)
            insert into invoice_lines (invoice_id, position, description, quantity, unit_price_minor,
              net_minor, tax_minor, gross_minor, account_id)
            select i.id, 1, $1, 1, 100, 100, 0, 100, a.id from i, ledger_accounts a where a.code = '4900'`,
      params: [marker, `IL${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from invoice_lines where description = $1",
  },
  cash_sessions: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation') returning id)
            insert into cash_sessions (branch_id, cashier_id, status, opened_at, opening_float_minor, notes)
            select b.id, u.id, 'open', now(), 0, $1 from b, u`,
      params: [marker, `CS${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from cash_sessions where notes = $1",
  },
  payments: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id)
            insert into payments (number, direction, method, status, party_type, party_id, party_name,
              branch_id, paid_on, currency, fx_rate, amount_minor, amount_base_minor)
            select $1, 'in', 'bank_transfer', 'recorded', 'customer', gen_random_uuid(), 'Isolation',
                   b.id, current_date, 'GHS', 1, 100, 100 from b`,
      params: [marker, `PY${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from payments where number = $1",
  },
  payment_allocations: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 p as (insert into payments (number, direction, method, status, party_type, party_id,
                         party_name, branch_id, paid_on, currency, fx_rate, amount_minor, amount_base_minor)
                       select $1, 'in', 'bank_transfer', 'recorded', 'customer', gen_random_uuid(),
                              'Isolation', b.id, current_date, 'GHS', 1, 100, 100 from b returning id),
                 i as (insert into invoices (status, party_type, party_id, party_name, branch_id,
                         issue_date, due_date, currency, fx_rate, prices_include_tax)
                       select 'draft', 'customer', gen_random_uuid(), 'Isolation', b.id,
                              current_date, current_date, 'GHS', 1, false from b returning id)
            insert into payment_allocations (payment_id, invoice_id, amount_minor, allocated_at)
            select p.id, i.id, 100, now() from p, i`,
      params: [marker, `PA${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from payment_allocations a join payments p on p.id = a.payment_id
            where p.number = $1`,
  },
  vehicle_assignments: {
    insert: (marker) => ({
      sql: `${DRIVER},
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $1, 'Isolation', 'Fixture', 'assigned', b.id from b returning id)
            insert into vehicle_assignments (vehicle_id, driver_id, branch_id, type,
              remittance_mode, started_at, start_odometer, start_checklist, notes)
            select v.id, d.id, b.id, 'salary', 'none', now(), 0, '{"items": []}', $1
              from v, d, b`,
      params: [marker, `VA${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicle_assignments where notes = $1",
  },
  drivers: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id)
            insert into drivers (code, first_name, last_name, phone, branch_id)
            select $1, 'Isolation', 'Driver', '+233' || (200000000 + abs(hashtext($1)) % 99999999)::text, b.id from b`,
      params: [marker, `DR${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from drivers where code = $1",
  },
  driver_guarantors: {
    insert: (marker) => ({
      sql: `${DRIVER}
            insert into driver_guarantors (driver_id, name, phone) select d.id, $1, '+233241234567' from d`,
      params: [marker, `DG${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from driver_guarantors where name = $1",
  },
  customers: {
    insert: (marker) => ({
      sql: `insert into customers (code, type, first_name, last_name, name, email)
            values ($1, 'individual', 'Isolation', 'Customer', 'Isolation Customer', $1 || '@example.com')`,
      params: [marker],
    }),
    find: "select 1 from customers where code = $1",
  },
  suppliers: {
    insert: (marker) => ({
      sql: "insert into suppliers (code, name, type) values ($1, $1, 'parts')",
      params: [marker],
    }),
    find: "select 1 from suppliers where code = $1",
  },
  party_documents: {
    insert: (marker) => ({
      sql: `insert into party_documents (party_type, party_id, type, number)
            values ('customer', gen_random_uuid(), 'passport', $1)`,
      params: [marker],
    }),
    find: "select 1 from party_documents where number = $1",
  },
  party_status_history: {
    insert: (marker) => ({
      sql: `insert into party_status_history (party_type, party_id, to_status, reason)
            values ('customer', gen_random_uuid(), 'watch', $1)`,
      params: [marker],
    }),
    find: "select 1 from party_status_history where reason = $1",
  },
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
