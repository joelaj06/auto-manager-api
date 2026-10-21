-- Work & Pay agreements (P3-3, docs/08): hire purchase of a vehicle by a driver — terms,
-- guarantors, the signed agreement document and, once active, the instalment schedule.

create table workpay_agreements (
  id                     uuid primary key default uuidv7(),
  number                 text not null unique,
  vehicle_id             uuid not null references vehicles (id),
  driver_id              uuid not null references drivers (id),
  branch_id              uuid not null references branches (id),
  status                 text not null default 'draft' check (status in ('draft',
                           'awaiting_signatures', 'active', 'in_arrears', 'defaulted',
                           'restructured', 'completed', 'terminated', 'repossessed', 'cancelled')),
  -- Terms (minor units of the base currency).
  vehicle_value_minor    bigint not null check (vehicle_value_minor > 0),
  pricing_kind           text not null check (pricing_kind in ('multiplier', 'markup_percent', 'total')),
  pricing_value          text not null,
  total_price_minor      bigint not null check (total_price_minor > 0),
  markup_minor           bigint not null,
  deposit_minor          bigint not null check (deposit_minor >= 0),
  financed_minor         bigint not null check (financed_minor > 0),
  frequency              text not null check (frequency in ('daily', 'weekly', 'monthly')),
  periods                integer not null check (periods between 1 and 2000),
  instalment_minor       bigint not null check (instalment_minor > 0),
  last_instalment_minor  bigint not null check (last_instalment_minor > 0),
  first_due_on           date not null,
  last_due_on            date not null,
  days_off               smallint[] not null default '{}',
  round_to_minor         integer not null default 1,
  grace_days             integer not null default 0 check (grace_days between 0 and 60),
  maintenance            text not null check (maintenance in ('driver', 'owner', 'shared')),
  insurance              text not null check (insurance in ('driver', 'owner', 'shared')),
  deposit_paid_minor     bigint not null default 0,
  notes                  text,
  -- The agreement document the parties sign.
  document_id            uuid references documents (id),
  -- The vehicle assignment created when the agreement starts.
  assignment_id          uuid references vehicle_assignments (id),
  started_on             date,
  activated_by           uuid references users (id),
  activated_at           timestamptz,
  cancelled_at           timestamptz,
  cancel_reason          text,
  created_by             uuid references users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (financed_minor = total_price_minor - deposit_minor),
  check (instalment_minor * (periods - 1) + last_instalment_minor = financed_minor),
  check (last_due_on >= first_due_on),
  check (deposit_paid_minor between 0 and deposit_minor),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (status in ('draft', 'awaiting_signatures', 'cancelled') or activated_at is not null)
);

-- One live agreement per vehicle and per driver (docs/08 §5); finished ones stay on record.
create unique index workpay_agreements_live_vehicle_idx on workpay_agreements (vehicle_id)
  where status in ('awaiting_signatures', 'active', 'in_arrears', 'defaulted');
create unique index workpay_agreements_live_driver_idx on workpay_agreements (driver_id)
  where status in ('awaiting_signatures', 'active', 'in_arrears', 'defaulted');
create index workpay_agreements_branch_idx on workpay_agreements (branch_id, status, id desc);

create table workpay_guarantors (
  id                 uuid primary key default uuidv7(),
  agreement_id       uuid not null references workpay_agreements (id) on delete cascade,
  position           smallint not null,
  name               text not null check (length(name) between 2 and 160),
  phone              text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  ghana_card_number  text check (ghana_card_number is null or ghana_card_number ~ '^GHA-[0-9]{9}-[0-9]$'),
  relationship       text,
  address            text,
  -- Asked to sign the agreement (by link).
  signs              boolean not null default false,
  unique (agreement_id, position)
);

create table workpay_instalments (
  id            uuid primary key default uuidv7(),
  agreement_id  uuid not null references workpay_agreements (id),
  number        integer not null check (number > 0),
  due_on        date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  paid_minor    bigint not null default 0 check (paid_minor >= 0),
  waived_minor  bigint not null default 0 check (waived_minor >= 0),
  status        text not null default 'upcoming' check (status in ('upcoming', 'due',
                  'partially_paid', 'paid', 'overdue', 'waived')),
  unique (agreement_id, number),
  check (paid_minor + waived_minor <= amount_minor)
);

create index workpay_instalments_due_idx on workpay_instalments (due_on)
  where status in ('upcoming', 'due', 'partially_paid', 'overdue');

-- Numbered guarantor places in signature blocks (guarantor_1, guarantor_2 …).
alter table document_signers drop constraint document_signers_role_check;
alter table document_signers add constraint document_signers_role_check
  check (role ~ '^[a-z][a-z0-9_]{1,39}$');
