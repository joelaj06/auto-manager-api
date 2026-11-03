-- Accounting export and bank reconciliation (P9-5, docs/13 §2.4, §4): journals exported for
-- QuickBooks, Xero or as plain CSV with the accounts mapped to the package's own, and bank or
-- mobile money statements imported and matched to the ledger lines of their account
-- (decisions 510–514).

-- What an account is called in the accounting package; unmapped accounts export as they are.
create table accounting_account_mappings (
  account_id uuid not null references ledger_accounts (id),
  target     text not null check (target in ('quickbooks', 'xero')),
  external   text not null check (length(external) between 1 and 120),
  updated_by uuid references users (id),
  updated_at timestamptz not null default now(),
  primary key (account_id, target)
);
create index accounting_account_mappings_target_idx on accounting_account_mappings (target);

-- Every export, so that one taken twice or overtaken by later postings can be told.
create table accounting_exports (
  id                uuid primary key default uuidv7(),
  format            text not null check (format in ('quickbooks', 'xero', 'csv')),
  detail            text not null check (detail in ('entry', 'day', 'month')),
  from_date         date not null,
  to_date           date not null,
  entries           integer not null,
  lines             integer not null,
  total_debit_minor bigint not null,
  exported_by       uuid references users (id),
  exported_at       timestamptz not null default now(),
  check (to_date >= from_date)
);
create index accounting_exports_time_idx on accounting_exports (exported_at desc);

-- A statement file imported for a ledger account.
create table statement_imports (
  id            uuid primary key default uuidv7(),
  account_id    uuid not null references ledger_accounts (id),
  file_name     text not null check (length(file_name) between 1 and 200),
  from_date     date not null,
  to_date       date not null,
  lines         integer not null,
  duplicates    integer not null default 0,
  auto_matched  integer not null default 0,
  status        text not null default 'active' check (status in ('active', 'voided')),
  imported_by   uuid references users (id),
  imported_at   timestamptz not null default now(),
  voided_by     uuid references users (id),
  voided_at     timestamptz,
  check ((status = 'voided') = (voided_at is not null))
);
create index statement_imports_account_idx on statement_imports (account_id, imported_at desc);

-- One movement on a statement: positive is money in. The fingerprint keeps a line that overlapping
-- statements both carry to one row.
create table statement_lines (
  id               uuid primary key default uuidv7(),
  import_id        uuid not null references statement_imports (id),
  account_id       uuid not null references ledger_accounts (id),
  line_no          integer not null,
  value_date       date not null,
  description      text not null check (length(description) <= 500),
  reference        text check (length(reference) <= 120),
  amount_minor     bigint not null check (amount_minor <> 0),
  balance_minor    bigint,
  fingerprint      text not null,
  status           text not null default 'unmatched'
                     check (status in ('unmatched', 'matched', 'ignored')),
  match_kind       text check (match_kind in ('auto', 'manual', 'posted')),
  -- The entry posted for this line (bank charges, a banked deposit …).
  journal_entry_id uuid references journal_entries (id),
  note             text check (length(note) <= 500),
  matched_by       uuid references users (id),
  matched_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (account_id, fingerprint),
  check ((status = 'matched') = (match_kind is not null))
);
create index statement_lines_import_idx on statement_lines (import_id);
create index statement_lines_status_idx on statement_lines (account_id, status, value_date, id);
create index statement_lines_entry_idx on statement_lines (journal_entry_id)
  where journal_entry_id is not null;

-- The ledger lines a statement line stands for: a banked batch is one line for several; a ledger
-- line is matched once.
create table statement_matches (
  statement_line_id uuid not null references statement_lines (id),
  ledger_line_id    uuid not null unique references ledger_lines (id),
  primary key (statement_line_id, ledger_line_id)
);
