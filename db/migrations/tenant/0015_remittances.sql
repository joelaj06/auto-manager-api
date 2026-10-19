-- Remittances and the driver ledger (P2-7, docs/09). Expected rows per period of a fixed-target
-- assignment (decision 8), declared submissions, confirmed money through finance, shortfalls on
-- the driver's ledger (driver receivables and driver credit, tagged with the driver).

create table remittances (
  id               uuid primary key default uuidv7(),
  -- Given when money is first confirmed (the reference on receipts and statements).
  number           text unique,
  assignment_id    uuid not null references vehicle_assignments (id),
  driver_id        uuid not null references drivers (id),
  vehicle_id       uuid not null references vehicles (id),
  branch_id        uuid not null references branches (id),
  mode             text not null check (mode in ('fixed_target', 'variable')),
  period_start     date not null,
  period_end       date not null,
  -- Fixed target: what is owed for the period; variable: none (what is declared is income).
  expected_minor   bigint check (expected_minor > 0),
  received_minor   bigint not null default 0 check (received_minor >= 0),
  waived_minor     bigint not null default 0 check (waived_minor >= 0),
  -- Income posted so far (the target when it falls due, or what a variable period brought).
  accrued_minor    bigint not null default 0 check (accrued_minor >= 0),
  status           text not null check (status in ('pending', 'submitted', 'partially_paid', 'paid',
                     'overdue', 'waived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (period_end >= period_start),
  check ((mode = 'fixed_target') = (expected_minor is not null)),
  unique (assignment_id, period_start)
);

create index remittances_driver_idx on remittances (driver_id, period_start desc);
create index remittances_branch_due_idx on remittances (branch_id, period_end, status);
create index remittances_open_idx on remittances (period_end) where status in ('pending', 'submitted', 'partially_paid');

-- What a driver (or staff for them) says was paid, waiting for a supervisor.
create table remittance_submissions (
  id              uuid primary key default uuidv7(),
  remittance_id   uuid not null references remittances (id),
  declared_minor  bigint not null check (declared_minor > 0),
  method          text not null check (method in ('cash', 'momo', 'bank_transfer', 'cheque', 'card')),
  momo_network    text check (momo_network in ('mtn', 'telecel', 'at')),
  reference       text,
  -- Ride-hailing breakdown (optional): { uber, bolt, yango, trips } as the driver reports it.
  earnings        jsonb,
  notes           text,
  status          text not null check (status in ('submitted', 'approved', 'rejected')),
  submitted_by    uuid references users (id),
  submitted_at    timestamptz not null,
  decided_by      uuid references users (id),
  decided_at      timestamptz,
  reject_reason   text,
  payment_id      uuid references payments (id),
  check ((status = 'rejected') = (reject_reason is not null)),
  check ((status = 'approved') = (payment_id is not null))
);

create index remittance_submissions_remittance_idx on remittance_submissions (remittance_id);
create unique index remittance_submissions_open_idx on remittance_submissions (remittance_id)
  where status = 'submitted';

-- Payments confirmed against a remittance (one per approval or direct recording).
create table remittance_payments (
  id              uuid primary key default uuidv7(),
  remittance_id   uuid not null references remittances (id),
  payment_id      uuid not null unique references payments (id),
  amount_minor    bigint not null check (amount_minor > 0),
  -- The part that settled what the driver owed for this period (the rest is driver credit).
  settled_minor   bigint not null check (settled_minor >= 0 and settled_minor <= amount_minor),
  released_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index remittance_payments_remittance_idx on remittance_payments (remittance_id);
