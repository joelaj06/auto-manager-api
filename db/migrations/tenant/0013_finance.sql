-- Finance recording core (P2-5, docs/13, decision 16: record only). A balanced journal in the
-- base currency, a small chart of accounts, invoices with tax lines, recorded payments with
-- allocations (unallocated money is the party's credit), cash sessions and a period lock.

-- Postings dated on or before this day are refused (corrections go into an open period).
alter table organisation add column books_locked_until date;

create table ledger_accounts (
  id          uuid primary key default uuidv7(),
  code        text not null unique check (code ~ '^[0-9]{3,6}$'),
  name        text not null check (length(name) between 1 and 120),
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  -- Accounts postings look up by role (cash, receivables, tax payable per levy …).
  system_key  text unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into ledger_accounts (code, name, type, system_key) values
  ('1000', 'Cash on hand', 'asset', 'cash'),
  ('1010', 'Mobile money', 'asset', 'momo'),
  ('1020', 'Bank', 'asset', 'bank'),
  ('1030', 'Cheques and cards to be banked', 'asset', 'undeposited'),
  ('1100', 'Accounts receivable', 'asset', 'receivables'),
  ('1200', 'Driver receivables', 'asset', 'driver_receivables'),
  ('1300', 'Input tax recoverable', 'asset', 'input_tax'),
  ('1500', 'Vehicles', 'asset', 'vehicles'),
  ('1510', 'Accumulated depreciation', 'asset', 'accumulated_depreciation'),
  ('2000', 'Accounts payable', 'liability', 'payables'),
  ('2100', 'Customer and driver credit', 'liability', 'party_credit'),
  ('2200', 'VAT payable', 'liability', 'tax_payable:vat'),
  ('2210', 'NHIL payable', 'liability', 'tax_payable:nhil'),
  ('2220', 'GETFund Levy payable', 'liability', 'tax_payable:getfund'),
  ('2290', 'Other taxes payable', 'liability', 'tax_payable:other'),
  ('3000', 'Owner''s equity', 'equity', 'equity'),
  ('4000', 'Rental income', 'income', 'rental_income'),
  ('4100', 'Remittance income', 'income', 'remittance_income'),
  ('4200', 'Work and pay income', 'income', 'workpay_income'),
  ('4300', 'Vehicle sales', 'income', 'vehicle_sales'),
  ('4900', 'Other income', 'income', 'other_income'),
  ('4950', 'Exchange differences', 'income', 'fx_difference'),
  ('5000', 'Vehicle expenses', 'expense', 'vehicle_expenses'),
  ('5900', 'Other expenses', 'expense', 'other_expenses'),
  ('5950', 'Cash over and short', 'expense', 'cash_over_short'),
  ('6000', 'Depreciation', 'expense', 'depreciation');

create table journal_entries (
  id           uuid primary key default uuidv7(),
  number       text not null unique,
  entry_date   date not null,
  description  text not null,
  -- What caused it: invoice, payment, allocation, cash_session …
  source_type  text not null,
  source_id    uuid not null,
  -- A reversal points at the entry it cancels (once).
  reverses_id  uuid unique references journal_entries (id),
  created_by   uuid references users (id),
  created_at   timestamptz not null default now()
);

create index journal_entries_source_idx on journal_entries (source_type, source_id);
create index journal_entries_date_idx on journal_entries (entry_date desc, created_at desc);

create table ledger_lines (
  id           uuid primary key default uuidv7(),
  entry_id     uuid not null references journal_entries (id),
  account_id   uuid not null references ledger_accounts (id),
  -- Minor units of the base currency; exactly one side per line.
  debit_minor  bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  branch_id    uuid references branches (id),
  vehicle_id   uuid references vehicles (id),
  party_type   text check (party_type in ('customer', 'driver', 'supplier')),
  party_id     uuid,
  memo         text,
  check ((debit_minor > 0) <> (credit_minor > 0)),
  check ((party_type is null) = (party_id is null))
);

create index ledger_lines_entry_idx on ledger_lines (entry_id);
create index ledger_lines_account_idx on ledger_lines (account_id);
create index ledger_lines_party_idx on ledger_lines (party_type, party_id) where party_id is not null;
create index ledger_lines_vehicle_idx on ledger_lines (vehicle_id) where vehicle_id is not null;

-- The ledger never goes out of balance: checked at commit for every entry touched.
create function ledger_entry_balanced() returns trigger language plpgsql as $$
declare
  entry uuid := coalesce(new.entry_id, old.entry_id);
  debits bigint;
  credits bigint;
  lines integer;
begin
  select coalesce(sum(debit_minor), 0), coalesce(sum(credit_minor), 0), count(*)
    into debits, credits, lines
    from ledger_lines where entry_id = entry;
  if lines > 0 and (lines < 2 or debits <> credits) then
    raise exception 'journal entry % is not balanced (debits %, credits %)', entry, debits, credits
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger ledger_lines_balanced
  after insert or update or delete on ledger_lines
  deferrable initially deferred
  for each row execute function ledger_entry_balanced();

-- Posted entries and lines are never changed or deleted (corrections are reversals).
create function ledger_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'posted ledger records cannot be changed' using errcode = '55000';
end $$;

create trigger journal_entries_immutable before update or delete on journal_entries
  for each row execute function ledger_immutable();
create trigger ledger_lines_immutable before update or delete on ledger_lines
  for each row execute function ledger_immutable();

-- Nothing is posted into a locked period.
create function journal_entry_period_open() returns trigger language plpgsql as $$
declare
  locked date;
begin
  select books_locked_until into locked from organisation;
  if locked is not null and new.entry_date <= locked then
    raise exception 'the books are locked until %', locked using errcode = '55000';
  end if;
  return new;
end $$;

create trigger journal_entries_period_open before insert on journal_entries
  for each row execute function journal_entry_period_open();

create table invoices (
  id                 uuid primary key default uuidv7(),
  -- Given when issued (drafts have none).
  number             text unique,
  status             text not null check (status in ('draft', 'issued', 'partially_paid', 'paid', 'void')),
  party_type         text not null check (party_type in ('customer', 'driver')),
  party_id           uuid not null,
  party_name         text not null,
  branch_id          uuid not null references branches (id),
  vehicle_id         uuid references vehicles (id),
  issue_date         date not null,
  due_date           date not null,
  currency           char(3) not null,
  -- Base-currency units per 1 unit of `currency` (1 for the base currency).
  fx_rate            numeric(20, 10) not null check (fx_rate > 0),
  prices_include_tax boolean not null,
  subtotal_minor     bigint not null default 0,
  tax_minor          bigint not null default 0,
  total_minor        bigint not null default 0 check (total_minor >= 0),
  paid_minor         bigint not null default 0 check (paid_minor >= 0 and paid_minor <= total_minor),
  -- Base-currency total as posted.
  total_base_minor   bigint,
  -- Who or what it is for (rental, deal …); ad-hoc invoices have none.
  source_type        text,
  source_id          uuid,
  notes              text,
  issued_at          timestamptz,
  issued_by          uuid references users (id),
  void_reason        text,
  voided_at          timestamptz,
  voided_by          uuid references users (id),
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (due_date >= issue_date),
  check ((status = 'draft') = (number is null)),
  check ((status = 'void') = (voided_at is not null))
);

create index invoices_party_idx on invoices (party_type, party_id, issue_date desc);
create index invoices_listing_idx on invoices (created_at desc, id desc);
create index invoices_open_idx on invoices (due_date) where status in ('issued', 'partially_paid');

create table invoice_lines (
  id                uuid primary key default uuidv7(),
  invoice_id        uuid not null references invoices (id) on delete cascade,
  position          smallint not null,
  description       text not null check (length(description) between 1 and 300),
  quantity          integer not null check (quantity between 1 and 100000),
  unit_price_minor  bigint not null check (unit_price_minor >= 0),
  discount_minor    bigint not null default 0 check (discount_minor >= 0),
  tax_code          text,
  -- The rates and amounts applied, snapshotted at issue: [{ key, name, rate, amountMinor }].
  tax_components    jsonb not null default '[]'::jsonb,
  net_minor         bigint not null,
  tax_minor         bigint not null,
  gross_minor       bigint not null,
  account_id        uuid not null references ledger_accounts (id),
  vehicle_id        uuid references vehicles (id),
  unique (invoice_id, position)
);

create table cash_sessions (
  id                   uuid primary key default uuidv7(),
  branch_id            uuid not null references branches (id),
  cashier_id           uuid not null references users (id),
  status               text not null check (status in ('open', 'closed')),
  opened_at            timestamptz not null,
  opening_float_minor  bigint not null check (opening_float_minor >= 0),
  cash_in_minor        bigint not null default 0 check (cash_in_minor >= 0),
  cash_out_minor       bigint not null default 0 check (cash_out_minor >= 0),
  closed_at            timestamptz,
  counted_minor        bigint check (counted_minor >= 0),
  variance_minor       bigint,
  closed_by            uuid references users (id),
  notes                text,
  check ((status = 'closed') = (closed_at is not null and counted_minor is not null))
);

-- One open session per cashier.
create unique index cash_sessions_open_idx on cash_sessions (cashier_id) where status = 'open';
create index cash_sessions_branch_idx on cash_sessions (branch_id, opened_at desc);

create table payments (
  id                 uuid primary key default uuidv7(),
  -- RCT-… for money in, PAY-… for money out.
  number             text not null unique,
  direction          text not null check (direction in ('in', 'out')),
  method             text not null check (method in ('cash', 'momo', 'bank_transfer', 'cheque', 'card')),
  status             text not null check (status in ('recorded', 'reversed')),
  party_type         text check (party_type in ('customer', 'driver', 'supplier')),
  party_id           uuid,
  party_name         text not null,
  branch_id          uuid not null references branches (id),
  paid_on            date not null,
  currency           char(3) not null,
  fx_rate            numeric(20, 10) not null check (fx_rate > 0),
  amount_minor       bigint not null check (amount_minor > 0),
  amount_base_minor  bigint not null check (amount_base_minor > 0),
  allocated_minor    bigint not null default 0 check (allocated_minor >= 0 and allocated_minor <= amount_minor),
  -- Money out: what it was for (the counter account); money in: always the party's credit.
  counter_account_id uuid references ledger_accounts (id),
  -- MoMo transaction id, bank reference, cheque number …
  reference          text,
  momo_network       text check (momo_network in ('mtn', 'telecel', 'at')),
  cash_session_id    uuid references cash_sessions (id),
  vehicle_id         uuid references vehicles (id),
  notes              text,
  recorded_by        uuid references users (id),
  recorded_at        timestamptz not null default now(),
  reversed_at        timestamptz,
  reversed_by        uuid references users (id),
  reverse_reason     text,
  check ((party_type is null) = (party_id is null)),
  check (direction = 'out' or party_id is not null),
  check ((status = 'reversed') = (reversed_at is not null)),
  check ((method = 'cash') or cash_session_id is null)
);

create index payments_party_idx on payments (party_type, party_id, paid_on desc);
create index payments_listing_idx on payments (recorded_at desc, id desc);
create index payments_session_idx on payments (cash_session_id) where cash_session_id is not null;

create table payment_allocations (
  id            uuid primary key default uuidv7(),
  payment_id    uuid not null references payments (id),
  invoice_id    uuid not null references invoices (id),
  amount_minor  bigint not null check (amount_minor > 0),
  allocated_at  timestamptz not null,
  allocated_by  uuid references users (id),
  released_at   timestamptz,
  released_by   uuid references users (id),
  release_reason text,
  check ((released_at is null) = (release_reason is null))
);

create index payment_allocations_payment_idx on payment_allocations (payment_id);
create index payment_allocations_invoice_idx on payment_allocations (invoice_id);
