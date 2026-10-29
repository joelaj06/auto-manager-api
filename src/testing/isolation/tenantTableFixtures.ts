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

/** A branch, vehicle, user, customer and a draft deal (number = marker); `$2` = branch code. */
const DEAL = `${VEHICLE},
                 u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation')
                       returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Buyer', $1) returning id),
                 d as (insert into dealer_deals (number, branch_id, vehicle_id, customer_id,
                         sales_executive_id, price_minor, notes)
                       select $1, b.id, v.id, c.id, u.id, 100, $1 from b, v, c, u returning id)`;

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
                         amount_minor, net_minor, currency, amount_base_minor, net_base_minor,
                         tax_base_minor)
                       select 'draft', c.id, $1, b.id, current_date, 100, 100, 'GHS', 100, 100, 0
                         from b, c returning id)`;

/** A draft work and pay agreement (number = marker) for a driver and vehicle; `$2` = branch code. */
const WORKPAY = `${DRIVER},
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $1, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 w as (insert into workpay_agreements (number, vehicle_id, driver_id, branch_id,
                         vehicle_value_minor, pricing_kind, pricing_value, total_price_minor,
                         markup_minor, deposit_minor, financed_minor, frequency, periods,
                         instalment_minor, last_instalment_minor, first_due_on, last_due_on,
                         maintenance, insurance)
                       select $1, v.id, d.id, b.id, 100, 'total', '200', 200, 100, 0, 200, 'weekly',
                              2, 100, 100, current_date, current_date + 7, 'driver', 'owner'
                         from v, d, b returning id)`;

/** The agreement above with its first instalment. */
const WORKPAY_INSTALMENT = `${WORKPAY},
                 i as (insert into workpay_instalments (agreement_id, number, due_on, amount_minor)
                       select w.id, 1, current_date, 100 from w returning id)`;

/** An issued document (number = marker; verification code from the marker). */
const DOCUMENT = `insert into documents (number, type, language, template_version, template_body,
                   subject_type, subject_id, data_snapshot, verification_code, issued_at)
                 values ($1, 'vehicle_handover', 'en', 'system-1', '<p>x</p>', 'vehicle_assignment',
                   gen_random_uuid(), '{}', lpad((abs(hashtext($1)) % 1000000000000)::text, 12, '0'),
                   now())`;

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
            insert into expense_lines (expense_id, position, amount_minor, net_minor, tax_minor,
              amount_base_minor, net_base_minor, tax_base_minor)
            select e.id, 1, 100, 100, 0, 100, 100, 0 from e`,
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
  workpay_agreements: {
    insert: (marker) => ({
      sql: `${WORKPAY} select 1`,
      params: [marker, `WP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from workpay_agreements where number = $1",
  },
  workpay_guarantors: {
    insert: (marker) => ({
      sql: `${WORKPAY}
            insert into workpay_guarantors (agreement_id, position, name, phone)
            select w.id, 1, $1, '+233200000001' from w`,
      params: [marker, `WG${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from workpay_guarantors where name = $1",
  },
  workpay_instalments: {
    insert: (marker) => ({
      sql: `${WORKPAY}
            insert into workpay_instalments (agreement_id, number, due_on, amount_minor)
            select w.id, 1, current_date, 100 from w`,
      params: [marker, `WI${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from workpay_instalments i join workpay_agreements a on a.id = i.agreement_id
            where a.number = $1`,
  },
  workpay_penalties: {
    insert: (marker) => ({
      sql: `${WORKPAY_INSTALMENT}
            insert into workpay_penalties (agreement_id, instalment_id, charged_on, amount_minor)
            select w.id, i.id, current_date, 100 from w, i`,
      params: [marker, `WN${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from workpay_penalties p join workpay_agreements a on a.id = p.agreement_id
            where a.number = $1`,
  },
  workpay_allocations: {
    insert: (marker) => ({
      sql: `${WORKPAY_INSTALMENT},
                 p as (insert into payments (number, direction, method, status, party_type, party_id,
                         party_name, branch_id, paid_on, currency, fx_rate, amount_minor, amount_base_minor)
                       select $1, 'in', 'cash', 'recorded', 'driver', d.id, 'Isolation', b.id,
                              current_date, 'GHS', 1, 100, 100 from d, b returning id)
            insert into workpay_allocations (agreement_id, payment_id, instalment_id, amount_minor)
            select w.id, p.id, i.id, 100 from w, p, i`,
      params: [marker, `WL${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from workpay_allocations l join workpay_agreements a on a.id = l.agreement_id
            where a.number = $1`,
  },
  workpay_waivers: {
    insert: (marker) => ({
      sql: `${WORKPAY_INSTALMENT}
            insert into workpay_waivers (agreement_id, instalment_id, amount_minor, reason)
            select w.id, i.id, 100, $1 from w, i`,
      params: [marker, `WV${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from workpay_waivers where reason = $1",
  },
  workpay_charges: {
    insert: (marker) => ({
      sql: `${WORKPAY},
                 c as (insert into expense_categories (code, name) values ('wc' || $3, 'Isolation')
                       returning id),
                 e as (insert into expenses (status, category_id, description, branch_id,
                         expense_date, amount_minor, net_minor, currency, amount_base_minor,
                         net_base_minor, tax_base_minor)
                       select 'draft', c.id, $1, b.id, current_date, 100, 100, 'GHS', 100, 100, 0
                         from b, c returning id)
            insert into workpay_charges (agreement_id, expense_id, description, charged_on,
              amount_minor)
            select w.id, e.id, $1, current_date, 100 from w, e`,
      params: [marker, `WC${letters(marker).toUpperCase().slice(0, 12)}`, letters(marker)],
    }),
    find: "select 1 from workpay_charges where description = $1",
  },
  workpay_reschedules: {
    insert: (marker) => ({
      sql: `${WORKPAY}
            insert into workpay_reschedules (agreement_id, kind, reason, params, moved_minor,
              moved_numbers, created_numbers)
            select w.id, 'holiday', $1, '{}', 100, '{1}', '{2}' from w`,
      params: [marker, `WR${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from workpay_reschedules where reason = $1",
  },
  workpay_settlement_quotes: {
    insert: (marker) => ({
      sql: `${WORKPAY}
            insert into workpay_settlement_quotes (agreement_id, quoted_on, valid_until,
              instalments_minor, penalties_minor, charges_minor, discount_percent, discount_minor,
              payoff_minor)
            select w.id, current_date, current_date, 100, 0, 0, '0', 0, 100 from w`,
      params: [marker, `WQ${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from workpay_settlement_quotes q join workpay_agreements a on a.id = q.agreement_id
            where a.number = $1`,
  },
  workpay_downtimes: {
    insert: (marker) => ({
      sql: `${WORKPAY}
            insert into workpay_downtimes (agreement_id, reason, owner_fault, started_on)
            select w.id, $1, true, current_date from w`,
      params: [marker, `WD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from workpay_downtimes where reason = $1",
  },
  workpay_transfers: {
    insert: (marker) => ({
      sql: `${WORKPAY},
                 doc as (${DOCUMENT} returning id),
                 u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation')
                       returning id)
            insert into workpay_transfers (agreement_id, document_id, odometer, owner_signer_id,
              issued_at)
            select w.id, doc.id, 1, u.id, now() from w, doc, u`,
      params: [marker, `WT${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from workpay_transfers t join workpay_agreements a on a.id = t.agreement_id
            where a.number = $1`,
  },
  document_templates: {
    insert: (marker) => ({
      sql: `insert into document_templates (type, name, version, body, system_version)
            values ('vehicle_handover', $1, 1 + abs(hashtext($1)) % 100000, '<p>x</p>', 1)`,
      params: [marker],
    }),
    find: "select 1 from document_templates where name = $1",
  },
  documents: {
    insert: (marker) => ({
      sql: DOCUMENT,
      params: [marker],
    }),
    find: "select 1 from documents where number = $1",
  },
  document_signers: {
    insert: (marker) => ({
      sql: `with d as (${DOCUMENT} returning id)
            insert into document_signers (document_id, position, role, label, party_type, name)
            select d.id, 1, 'owner', 'Owner', 'guest', $1 from d`,
      params: [marker],
    }),
    find: "select 1 from document_signers where name = $1",
  },
  document_signing_links: {
    insert: (marker) => ({
      sql: `with d as (${DOCUMENT} returning id),
                 s as (insert into document_signers (document_id, position, role, label, party_type, name)
                       select d.id, 1, 'owner', 'Owner', 'guest', 'Isolation' from d returning id)
            insert into document_signing_links (signer_id, token_hash, expires_at)
            select s.id, $1, now() + interval '1 day' from s`,
      params: [marker],
    }),
    find: "select 1 from document_signing_links where token_hash = $1",
  },
  document_events: {
    insert: (marker) => ({
      sql: `with d as (${DOCUMENT} returning id)
            insert into document_events (document_id, type, actor_type, metadata)
            select d.id, 'issued', 'system', jsonb_build_object('marker', $1::text) from d`,
      params: [marker],
    }),
    find: "select 1 from document_events where metadata->>'marker' = $1",
  },
  vehicle_issues: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into vehicle_issues (number, vehicle_id, branch_id, type, description, occurred_at)
            select $1, v.id, b.id, 'breakdown', 'Isolation fixture', now() from v, b`,
      params: [marker, `VI${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicle_issues where number = $1",
  },
  daily_vehicle_stats: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into daily_vehicle_stats (vehicle_id, stat_date, branch_id, status)
            select v.id, current_date, b.id, 'available' from v, b`,
      params: [marker, `DS${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from daily_vehicle_stats s join vehicles v on v.id = s.vehicle_id
            where v.code = $1`,
  },
  stats_dirty_marks: {
    insert: (marker) => ({
      sql: "insert into stats_dirty_marks (from_date, reason) values (current_date, $1)",
      params: [marker],
    }),
    find: "select 1 from stats_dirty_marks where reason = $1",
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
  notifications: {
    insert: (marker) => ({
      sql: `with u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation') returning id)
            insert into notifications (user_id, rule, title, body, dedupe_key)
            select u.id, 'expense_approvals', 'Isolation', 'Fixture', $1 from u`,
      params: [marker],
    }),
    find: "select 1 from notifications where dedupe_key = $1",
  },
  notification_deliveries: {
    insert: (marker) => ({
      sql: `insert into notification_deliveries (channel, rule, recipient_type, recipient_id, address,
              body, dedupe_key)
            values ('sms', 'remittance_due', 'driver', $2, '+233200000000', 'Fixture', $1)`,
      params: [marker, randomUUID()],
    }),
    find: "select 1 from notification_deliveries where dedupe_key = $1",
  },
  push_devices: {
    insert: (marker) => ({
      sql: `with u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation') returning id)
            insert into push_devices (user_id, token, platform) select u.id, 'token-' || $1, 'android' from u`,
      params: [marker],
    }),
    find: "select 1 from push_devices where token = 'token-' || $1",
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
  vehicle_classes: {
    insert: (marker) => ({
      sql: "insert into vehicle_classes (code, name) values ($1, $2)",
      params: [`ISO${letters(marker).toUpperCase().slice(0, 12)}`, marker],
    }),
    find: "select 1 from vehicle_classes where name = $1",
  },
  rental_rate_plans: {
    insert: (marker) => ({
      sql: `with c as (insert into vehicle_classes (code, name) values ($1, 'Isolation') returning id)
            insert into rental_rate_plans (code, name, class_id, currency, daily_minor)
            select $1, $2, c.id, 'GHS', 10000 from c`,
      params: [`ISO${letters(marker).toUpperCase().slice(0, 12)}`, marker],
    }),
    find: "select 1 from rental_rate_plans where name = $1",
  },
  rental_rate_seasons: {
    insert: (marker) => ({
      sql: `with c as (insert into vehicle_classes (code, name) values ($1, 'Isolation') returning id),
                 p as (insert into rental_rate_plans (code, name, class_id, currency, daily_minor)
                       select $1, 'Isolation', c.id, 'GHS', 10000 from c returning id)
            insert into rental_rate_seasons (plan_id, name, starts_on, ends_on, adjustment_percent)
            select p.id, $2, '2026-12-20', '2026-12-31', 25 from p`,
      params: [`ISO${letters(marker).toUpperCase().slice(0, 12)}`, marker],
    }),
    find: "select 1 from rental_rate_seasons where name = $1",
  },
  rental_extras: {
    insert: (marker) => ({
      sql: `insert into rental_extras (code, name, category, charge, price_minor)
            values ($1, $2, 'equipment', 'per_day', 2000)`,
      params: [`ISO${letters(marker).toUpperCase().slice(0, 12)}`, marker],
    }),
    find: "select 1 from rental_extras where name = $1",
  },
  rental_zones: {
    insert: (marker) => ({
      sql: "insert into rental_zones (name) values ($1)",
      params: [marker],
    }),
    find: "select 1 from rental_zones where name = $1",
  },
  rental_promo_codes: {
    insert: (marker) => ({
      sql: `insert into rental_promo_codes (code, description, discount_percent)
            values ($1, $2, 10)`,
      params: [letters(marker).toUpperCase().slice(0, 16), marker],
    }),
    find: "select 1 from rental_promo_codes where description = $1",
  },
  public_holidays: {
    insert: (marker) => ({
      sql: `insert into public_holidays (date, name)
            values (date '2030-01-01' + (abs(hashtext($1)) % 3000), $1)`,
      params: [marker],
    }),
    find: "select 1 from public_holidays where name = $1",
  },
  rental_bookings: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Renter', $1)
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'rental', 'confirmed', now(), now() + interval '1 day',
                         now() + interval '1 day' from v, b returning id),
                 r as (insert into rental_bookings (number, status, branch_id, customer_id,
                         block_id, pickup_at, return_at, currency, terms, quote, notes)
                       select $2, 'confirmed', b.id, c.id, k.id, now(), now() + interval '1 day',
                         'GHS', '{}', '{}', $1 from b, c, k returning id)
            select 1`,
      params: [marker, `RB${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from rental_bookings where notes = $1",
  },
  rental_booking_events: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Renter', $1)
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'rental', 'confirmed', now(), now() + interval '1 day',
                         now() + interval '1 day' from v, b returning id),
                 r as (insert into rental_bookings (number, status, branch_id, customer_id,
                         block_id, pickup_at, return_at, currency, terms, quote, notes)
                       select $2, 'confirmed', b.id, c.id, k.id, now(), now() + interval '1 day',
                         'GHS', '{}', '{}', $1 from b, c, k returning id)
            insert into rental_booking_events (booking_id, type, data)
            select r.id, 'reserved', jsonb_build_object('marker', $1::text) from r`,
      params: [marker, `RE${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from rental_booking_events where data->>'marker' = $1",
  },
  rental_booking_charges: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Renter', $1)
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'rental', 'confirmed', now(), now() + interval '1 day',
                         now() + interval '1 day' from v, b returning id),
                 r as (insert into rental_bookings (number, status, branch_id, customer_id,
                         block_id, pickup_at, return_at, currency, terms, quote, notes)
                       select $2, 'confirmed', b.id, c.id, k.id, now(), now() + interval '1 day',
                         'GHS', '{}', '{}', $1 from b, c, k returning id),
                 e as (insert into rental_booking_events (booking_id, type)
                       select r.id, 'reserved' from r returning id, booking_id)
            insert into rental_booking_charges (booking_id, event_id, kind, description,
              net_minor, tax_minor, total_minor)
            select e.booking_id, e.id, 'rental', $1, 100, 0, 100 from e`,
      params: [marker, `RC${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from rental_booking_charges where description = $1",
  },
  rental_inspections: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Renter', $1)
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'rental', 'confirmed', now(), now() + interval '1 day',
                         now() + interval '1 day' from v, b returning id),
                 r as (insert into rental_bookings (number, status, branch_id, customer_id,
                         block_id, pickup_at, return_at, currency, terms, quote, notes)
                       select $2, 'confirmed', b.id, c.id, k.id, now(), now() + interval '1 day',
                         'GHS', '{}', '{}', $1 from b, c, k returning id)
            insert into rental_inspections (booking_id, stage, vehicle_id, odometer, fuel,
              id_checked, notes, inspected_at)
            select r.id, 'check_out', v.id, 10, 'full', true, $1, now() from r, v`,
      params: [marker, `RI${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from rental_inspections where notes = $1",
  },
  rental_inspection_photos: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Renter', $1)
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'rental', 'confirmed', now(), now() + interval '1 day',
                         now() + interval '1 day' from v, b returning id),
                 r as (insert into rental_bookings (number, status, branch_id, customer_id,
                         block_id, pickup_at, return_at, currency, terms, quote, notes)
                       select $2, 'confirmed', b.id, c.id, k.id, now(), now() + interval '1 day',
                         'GHS', '{}', '{}', $1 from b, c, k returning id),
                 i as (insert into rental_inspections (booking_id, stage, vehicle_id, odometer,
                         fuel, id_checked, inspected_at)
                       select r.id, 'check_out', v.id, 10, 'full', true, now() from r, v
                       returning id),
                 f as (insert into files (kind, storage_key, visibility, filename, content_type,
                         size_bytes)
                       values ('rental_photo', $1, 'private', 'front.png', 'image/png', 1)
                       returning id)
            insert into rental_inspection_photos (inspection_id, file_id, view)
            select i.id, f.id, 'front' from i, f`,
      params: [marker, `RP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from rental_inspection_photos p join files f on f.id = p.file_id
            where f.storage_key = $1`,
  },
  vehicle_damages: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id)
            insert into vehicle_damages (vehicle_id, branch_id, area, severity, description,
              currency)
            select v.id, b.id, 'front', 'minor', $1, 'GHS' from v, b`,
      params: [marker, `VD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicle_damages where description = $1",
  },
  vehicle_damage_photos: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 d as (insert into vehicle_damages (vehicle_id, branch_id, area, severity,
                         description, currency)
                       select v.id, b.id, 'front', 'minor', 'Isolation dent', 'GHS' from v, b
                       returning id),
                 f as (insert into files (kind, storage_key, visibility, filename, content_type,
                         size_bytes)
                       values ('rental_photo', $1, 'private', 'dent.png', 'image/png', 1)
                       returning id)
            insert into vehicle_damage_photos (damage_id, file_id) select d.id, f.id from d, f`,
      params: [marker, `DP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from vehicle_damage_photos p join files f on f.id = p.file_id
            where f.storage_key = $1`,
  },
  service_plans: {
    insert: (marker) => ({
      sql: "insert into service_plans (name, applies_to) values ($1, 'all')",
      params: [marker],
    }),
    find: "select 1 from service_plans where name = $1",
  },
  service_plan_tasks: {
    insert: (marker) => ({
      sql: `with p as (insert into service_plans (name, applies_to) values ('Isolation', 'all')
                       returning id)
            insert into service_plan_tasks (plan_id, name, every_days) select p.id, $1, 90 from p`,
      params: [marker],
    }),
    find: "select 1 from service_plan_tasks where name = $1",
  },
  service_due: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 p as (insert into service_plans (name, applies_to) values ('Isolation', 'all')
                       returning id),
                 t as (insert into service_plan_tasks (plan_id, name, every_days)
                       select p.id, 'Isolation oil', 90 from p returning id)
            insert into service_due (vehicle_id, task_id, plan_id, branch_id, base_on, due_on,
              status)
            select v.id, t.id, p.id, b.id, current_date, current_date + 90, 'scheduled'
              from v, t, p, b`,
      params: [marker, `SD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from service_due d join vehicles v on v.id = d.vehicle_id where v.code = $1`,
  },
  service_records: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 p as (insert into service_plans (name, applies_to) values ('Isolation', 'all')
                       returning id),
                 t as (insert into service_plan_tasks (plan_id, name, every_days)
                       select p.id, 'Isolation oil', 90 from p returning id)
            insert into service_records (vehicle_id, task_id, done_on, note)
            select v.id, t.id, current_date, $1 from v, t`,
      params: [marker, `SR${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from service_records where note = $1",
  },
  parts: {
    insert: (marker) => ({
      sql: "insert into parts (sku, name) values ($2, $1)",
      params: [marker, `P${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from parts where name = $1",
  },
  part_stock: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 p as (insert into parts (sku, name) values ($2, $1) returning id)
            insert into part_stock (part_id, branch_id, on_hand) select p.id, b.id, 1 from p, b`,
      params: [marker, `PS${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from part_stock s join parts p on p.id = s.part_id where p.name = $1",
  },
  part_moves: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 p as (insert into parts (sku, name) values ($2, $1) returning id)
            insert into part_moves (part_id, branch_id, kind, quantity, unit_cost_minor,
              value_minor, on_hand_after, avg_cost_after, reason)
            select p.id, b.id, 'adjustment', 1, 100, 100, 1, 100, $1 from p, b`,
      params: [marker, `PM${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from part_moves where reason = $1",
  },
  work_orders: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into work_orders (number, vehicle_id, branch_id, type, title, currency)
            select $1, v.id, b.id, 'corrective', 'Isolation job', 'GHS' from v, b`,
      params: [marker, `WO${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from work_orders where number = $1",
  },
  work_order_lines: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 o as (insert into work_orders (number, vehicle_id, branch_id, type, title, currency)
                       select 'WO-' || $1, v.id, b.id, 'corrective', 'Isolation job', 'GHS'
                         from v, b returning id)
            insert into work_order_lines (work_order_id, position, kind, description, quantity,
              unit_cost_minor, amount_minor)
            select o.id, 0, 'labour', 'Isolation labour', 1, 100, 100 from o`,
      params: [marker, `WL${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from work_order_lines l join work_orders o on o.id = l.work_order_id
            where o.number = 'WO-' || $1`,
  },
  work_order_allocations: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 o as (insert into work_orders (number, vehicle_id, branch_id, type, title, currency)
                       select 'WO-' || $1, v.id, b.id, 'corrective', 'Isolation job', 'GHS'
                         from v, b returning id)
            insert into work_order_allocations (work_order_id, payer, amount_minor)
            select o.id, 'company', 100 from o`,
      params: [marker, `WA${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from work_order_allocations a join work_orders o on o.id = a.work_order_id
            where o.number = 'WO-' || $1`,
  },
  purchases: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 s as (insert into suppliers (code, name, type) values ($2, $1, 'dealer') returning id)
            insert into purchases (number, type, supplier_id, branch_id, currency)
            select $1, 'local', s.id, b.id, 'GHS' from b, s`,
      params: [marker, `PU${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from purchases where number = $1",
  },
  purchase_lines: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 s as (insert into suppliers (code, name, type) values ($2, $1, 'dealer') returning id),
                 p as (insert into purchases (number, type, supplier_id, branch_id, currency)
                       select 'PUR-' || $1, 'local', s.id, b.id, 'GHS' from b, s returning id)
            insert into purchase_lines (purchase_id, position, make, model, description, price_minor)
            select p.id, 1, 'Isolation', 'Fixture', $1, 100 from p`,
      params: [marker, `PL${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from purchase_lines where description = $1",
  },
  purchase_costs: {
    insert: (marker) => ({
      sql: `${EXPENSE},
                 s as (insert into suppliers (code, name, type) values ($2, $1, 'dealer') returning id),
                 p as (insert into purchases (number, type, supplier_id, branch_id, currency)
                       select 'PUR-' || $1, 'local', s.id, b.id, 'GHS' from b, s returning id)
            insert into purchase_costs (purchase_id, kind, description, supplier_id, expense_id)
            select p.id, 'shipping', $1, s.id, e.id from p, s, e`,
      params: [marker, `PC${letters(marker).toUpperCase().slice(0, 12)}`, letters(marker)],
    }),
    find: "select 1 from purchase_costs where description = $1",
  },
  purchase_events: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 s as (insert into suppliers (code, name, type) values ($2, $1, 'dealer') returning id),
                 p as (insert into purchases (number, type, supplier_id, branch_id, currency)
                       select 'PUR-' || $1, 'local', s.id, b.id, 'GHS' from b, s returning id)
            insert into purchase_events (purchase_id, kind, occurred_on, note)
            select p.id, 'note', current_date, $1 from p`,
      params: [marker, `PE${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from purchase_events where note = $1",
  },
  dealer_stock: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into dealer_stock (vehicle_id, status, source, stocked_on, notes)
            select v.id, 'ready', 'other', current_date, $1 from v`,
      params: [marker, `DS${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_stock where notes = $1",
  },
  dealer_price_changes: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 s as (insert into dealer_stock (vehicle_id, status, source, stocked_on)
                       select v.id, 'ready', 'other', current_date from v returning vehicle_id)
            insert into dealer_price_changes (vehicle_id, asking_price_minor, reason)
            select s.vehicle_id, 100, $1 from s`,
      params: [marker, `DP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_price_changes where reason = $1",
  },
  dealer_stock_transfers: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 s as (insert into dealer_stock (vehicle_id, status, source, stocked_on)
                       select v.id, 'ready', 'other', current_date from v returning vehicle_id),
                 t as (insert into branches (code, name) values ($2 || 'T', $1) returning id)
            insert into dealer_stock_transfers (vehicle_id, from_branch_id, to_branch_id,
              transferred_on, reason)
            select s.vehicle_id, b.id, t.id, current_date, $1 from s, b, t`,
      params: [marker, `DT${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_stock_transfers where reason = $1",
  },
  dealer_leads: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id)
            insert into dealer_leads (number, branch_id, source, name, phone)
            select $1, b.id, 'walk_in', 'Isolation', '+233200000000' from b`,
      params: [marker, `DL${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_leads where number = $1",
  },
  dealer_lead_activities: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 l as (insert into dealer_leads (number, branch_id, source, name, phone)
                       select $1, b.id, 'walk_in', 'Isolation', '+233200000000' from b returning id)
            insert into dealer_lead_activities (lead_id, kind, note, occurred_at)
            select l.id, 'note', $1, now() from l`,
      params: [marker, `LA${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_lead_activities where note = $1",
  },
  dealer_lead_tasks: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 l as (insert into dealer_leads (number, branch_id, source, name, phone)
                       select $1, b.id, 'walk_in', 'Isolation', '+233200000000' from b returning id)
            insert into dealer_lead_tasks (lead_id, title, due_on)
            select l.id, $1, current_date from l`,
      params: [marker, `LT${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_lead_tasks where title = $1",
  },
  dealer_lead_matches: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 l as (insert into dealer_leads (number, branch_id, source, name, phone)
                       select $1, b.id, 'walk_in', 'Isolation', '+233200000000' from b returning id)
            insert into dealer_lead_matches (lead_id, vehicle_id) select l.id, v.id from l, v`,
      params: [marker, `LM${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from dealer_lead_matches m join dealer_leads l on l.id = m.lead_id
            where l.number = $1`,
  },
  dealer_lead_pool: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation')
                       returning id)
            insert into dealer_lead_pool (branch_id, user_id, position)
            select b.id, u.id, 1 from b, u`,
      params: [marker, `LP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from dealer_lead_pool p join users u on u.id = p.user_id
            where u.email = $1 || '@example.com'`,
  },
  dealer_test_drives: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation')
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'test_drive', 'confirmed', now() + interval '1 day',
                         now() + interval '1 day 1 hour', now() + interval '1 day 1 hour'
                         from v, b returning id)
            insert into dealer_test_drives (branch_id, vehicle_id, starts_at, ends_at,
              driver_name, driver_phone, licence_number, licence_expires_on, accompanied_by,
              block_id, notes)
            select b.id, v.id, now() + interval '1 day', now() + interval '1 day 1 hour',
              'Isolation', '+233200000000', 'GH-123', current_date + 365, u.id, k.id, $1
              from b, v, u, k`,
      params: [marker, `TD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_test_drives where notes = $1",
  },
  dealer_appraisals: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 u as (insert into users (email, name) values ($1 || '@example.com', 'Isolation')
                       returning id)
            insert into dealer_appraisals (number, branch_id, make, model, condition, value_minor,
              valid_until, appraised_by, appraised_on)
            select $1, b.id, 'Isolation', 'Fixture', 'good', 100, current_date + 14, u.id,
              current_date from b, u`,
      params: [marker, `AP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_appraisals where number = $1",
  },
  dealer_deals: {
    insert: (marker) => ({
      sql: `${DEAL}
            select 1`,
      params: [marker, `DD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_deals where number = $1",
  },
  dealer_deal_items: {
    insert: (marker) => ({
      sql: `${DEAL}
            insert into dealer_deal_items (deal_id, position, kind, description, amount_minor)
            select d.id, 1, 'tint', $1, 100 from d`,
      params: [marker, `DI${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_deal_items where description = $1",
  },
  dealer_deal_instalments: {
    insert: (marker) => ({
      sql: `${DEAL}
            insert into dealer_deal_instalments (deal_id, number, due_on, amount_minor)
            select d.id, 1, current_date, length($1) from d`,
      params: [marker, `DN${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from dealer_deal_instalments i join dealer_deals d on d.id = i.deal_id
            where d.number = $1`,
  },
  vehicle_depreciation: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 j as (insert into journal_entries (number, entry_date, description, source_type, source_id)
                       values ($1, current_date, 'Isolation', 'isolation', gen_random_uuid())
                       returning id)
            insert into vehicle_depreciation (vehicle_id, period, amount_minor, journal_id)
            select v.id, '2026-01', 100, j.id from v, j`,
      params: [marker, `VD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from vehicle_depreciation d join vehicles v on v.id = d.vehicle_id
            where v.code = $1`,
  },
  dealer_commission_plans: {
    insert: (marker) => ({
      sql: `insert into dealer_commission_plans (name, user_id, basis, tiers, active)
            values ($1, null, 'flat', '[{"fromUnits":1,"percent":null,"amountMinor":100}]', false)`,
      params: [marker],
    }),
    find: "select 1 from dealer_commission_plans where name = $1",
  },
  dealer_commission_payouts: {
    insert: (marker) => ({
      sql: `${DEAL},
                 j as (insert into journal_entries (number, entry_date, description, source_type, source_id)
                       values ($1, current_date, 'Isolation', 'isolation', gen_random_uuid())
                       returning id)
            insert into dealer_commission_payouts (number, user_id, branch_id, period,
              amount_minor, method, paid_on, journal_id)
            select $1, u.id, b.id, '2026-01', 100, 'cash', current_date, j.id from u, b, j`,
      params: [marker, `CP${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_commission_payouts where number = $1",
  },
  dealer_commissions: {
    insert: (marker) => ({
      sql: `${DEAL}
            insert into dealer_commissions (deal_id, user_id, branch_id, period, basis, rate,
              base_minor, share_percent, amount_minor, status, accrued_on, clawback_reason)
            select d.id, u.id, b.id, '2026-01', 'flat', '100', 100, 100, 100, 'accrued',
              current_date, $1 from d, u, b`,
      params: [marker, `DC${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_commissions where clawback_reason = $1",
  },
  dealer_quotes: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into dealer_quotes (number, branch_id, customer_name, vehicle_id, price_minor,
              valid_until)
            select $1, b.id, 'Isolation', v.id, 100, current_date + 14 from b, v`,
      params: [marker, `DQ${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_quotes where number = $1",
  },
  dealer_quote_items: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 q as (insert into dealer_quotes (number, branch_id, customer_name, vehicle_id,
                         price_minor, valid_until)
                       select 'Q-' || $1, b.id, 'Isolation', v.id, 100, current_date + 14
                         from b, v returning id)
            insert into dealer_quote_items (quote_id, position, kind, description, amount_minor)
            select q.id, 1, 'tint', $1, 10 from q`,
      params: [marker, `QI${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from dealer_quote_items where description = $1",
  },
  incidents: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into incidents (number, vehicle_id, branch_id, type, occurred_at, description)
            select $1, v.id, b.id, 'accident', now(), 'Isolation incident' from v, b`,
      params: [marker, `IN${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from incidents where number = $1",
  },
  insurance_claims: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 i as (insert into incidents (number, vehicle_id, branch_id, type, occurred_at,
                         description)
                       select 'INC-' || $1, v.id, b.id, 'accident', now(), 'Isolation incident'
                         from v, b returning id),
                 s as (insert into suppliers (code, name, type) values ($2, $1, 'insurer') returning id)
            insert into insurance_claims (incident_id, insurer_id, claimed_minor, submitted_on, notes)
            select i.id, s.id, 100, current_date, $1 from i, s`,
      params: [marker, `IC${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from insurance_claims where notes = $1",
  },
  traffic_offences: {
    insert: (marker) => ({
      sql: `${VEHICLE}
            insert into traffic_offences (vehicle_id, branch_id, type, offence_at, authority,
              fine_minor, notes)
            select v.id, b.id, 'speeding', now(), 'Isolation MTTD', 100, $1 from v, b`,
      params: [marker, `TO${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from traffic_offences where notes = $1",
  },
  fuel_anomalies: {
    insert: (marker) => ({
      sql: `${VEHICLE},
                 f as (insert into fuel_logs (vehicle_id, filled_at, litres, amount_minor,
                         odometer, notes)
                       select v.id, now(), 10, 100, 1000, 'Isolation fill' from v returning id)
            insert into fuel_anomalies (fuel_log_id, vehicle_id, branch_id, kind, litres,
              distance, note)
            select f.id, v.id, b.id, 'no_distance', 10, 0, $1 from f, v, b`,
      params: [marker, `FA${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from fuel_anomalies where note = $1",
  },
  customer_authorised_drivers: {
    insert: (marker) => ({
      sql: `with co as (insert into customers (code, type, company_name, name)
                        values ($1, 'corporate', 'Isolation Ltd', 'Isolation Ltd') returning id),
                 d as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Driver', 'Isolation Driver')
                       returning id)
            insert into customer_authorised_drivers (corporate_id, driver_id)
            select co.id, d.id from co, d`,
      params: [marker, `AD${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from customer_authorised_drivers a join customers c on c.id = a.corporate_id
            where c.code = $1`,
  },
  rental_deposits: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id),
                 c as (insert into customers (code, type, first_name, last_name, name)
                       values ($2, 'individual', 'Isolation', 'Renter', $1)
                       returning id),
                 k as (insert into vehicle_blocks (vehicle_id, branch_id, reason, status,
                         starts_at, ends_at, blocked_until)
                       select v.id, b.id, 'rental', 'confirmed', now(), now() + interval '1 day',
                         now() + interval '1 day' from v, b returning id),
                 r as (insert into rental_bookings (number, status, branch_id, customer_id,
                         block_id, pickup_at, return_at, currency, terms, quote)
                       select $2, 'confirmed', b.id, c.id, k.id, now(), now() + interval '1 day',
                         'GHS', '{}', '{}' from b, c, k returning id),
                 p as (insert into payments (number, direction, method, status, party_type,
                         party_id, party_name, branch_id, paid_on, currency, fx_rate,
                         amount_minor, amount_base_minor)
                       select $1, 'in', 'cash', 'recorded', 'customer', c.id, 'Isolation', b.id,
                         current_date, 'GHS', 1, 100, 100 from b, c returning id)
            insert into rental_deposits (booking_id, payment_id, currency, amount_minor, status,
              held_at, updated_at)
            select r.id, p.id, 'GHS', 100, 'held', now(), now() from r, p`,
      params: [marker, `DE${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: `select 1 from rental_deposits d join payments p on p.id = d.payment_id
            where p.number = $1`,
  },
  vehicle_blocks: {
    insert: (marker) => ({
      sql: `with b as (insert into branches (code, name) values ($2, $1) returning id),
                 v as (insert into vehicles (code, make, model, status, branch_id)
                       select $2, 'Isolation', 'Fixture', 'available', b.id from b returning id)
            insert into vehicle_blocks (vehicle_id, branch_id, reason, status, starts_at,
              ends_at, blocked_until, note)
            select v.id, b.id, 'maintenance', 'confirmed', now(), now() + interval '1 day',
              now() + interval '1 day', $1 from v, b`,
      params: [marker, `VB${letters(marker).toUpperCase().slice(0, 12)}`],
    }),
    find: "select 1 from vehicle_blocks where note = $1",
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
export const APPEND_ONLY_TENANT_TABLES: readonly string[] = ["audit_logs", "document_events"];
