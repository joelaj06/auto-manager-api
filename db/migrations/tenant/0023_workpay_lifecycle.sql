-- Work & Pay lifecycle (P3-5, docs/08 §5): payment holidays and restructures, early settlement
-- quotes, termination and repossession with settlement figures, vehicle downtime, and costs the
-- driver bears charged to the agreement.

-- Closing early, and a schedule whose frequency a restructure changed.
alter table workpay_agreements
  add column rescheduled_frequency text check (rescheduled_frequency in ('daily', 'weekly', 'monthly')),
  add column rescheduled_days_off smallint[],
  add column close_reason text check (close_reason in ('mutual', 'death', 'write_off', 'other',
    'repossession')),
  add column closed_on date,
  add column close_notes text check (length(close_notes) <= 2000),
  add column outstanding_at_close_minor bigint check (outstanding_at_close_minor >= 0),
  add column settlement_owed_minor bigint not null default 0 check (settlement_owed_minor >= 0),
  add column settlement_refund_minor bigint not null default 0 check (settlement_refund_minor >= 0),
  add column closed_by uuid references users (id),
  add check ((rescheduled_frequency is null) = (rescheduled_days_off is null)),
  add check ((status in ('terminated', 'repossessed')) = (closed_on is not null)),
  add check ((closed_on is null) = (close_reason is null)),
  add check (status <> 'repossessed' or close_reason = 'repossession'),
  add check (status <> 'terminated' or close_reason <> 'repossession'),
  add check (settlement_owed_minor = 0 or settlement_refund_minor = 0);

-- What a holiday or restructure moved to later instalments stays on the old row as "rescheduled".
alter table workpay_instalments
  add column rescheduled_minor bigint not null default 0 check (rescheduled_minor >= 0),
  drop constraint workpay_instalments_status_check,
  add constraint workpay_instalments_status_check check (status in ('upcoming', 'due',
    'partially_paid', 'paid', 'overdue', 'waived', 'rescheduled')),
  drop constraint workpay_instalments_check,
  add constraint workpay_instalments_check
    check (paid_minor + waived_minor + rescheduled_minor <= amount_minor);

-- Costs the driver bears (approved expenses charged to them) added to the agreement.
create table workpay_charges (
  id              uuid primary key default uuidv7(),
  agreement_id    uuid not null references workpay_agreements (id),
  expense_id      uuid not null unique references expenses (id),
  description     text not null check (length(description) between 1 and 300),
  charged_on      date not null,
  amount_minor    bigint not null check (amount_minor > 0),
  paid_minor      bigint not null default 0 check (paid_minor >= 0),
  -- Cancelled with the expense.
  waived_minor    bigint not null default 0 check (waived_minor >= 0),
  created_at      timestamptz not null default now(),
  check (paid_minor + waived_minor <= amount_minor)
);

create index workpay_charges_agreement_idx on workpay_charges (agreement_id, charged_on);

alter table workpay_allocations
  add column charge_id uuid references workpay_charges (id),
  drop constraint workpay_allocations_check,
  add constraint workpay_allocations_target_check
    check (num_nonnulls(instalment_id, penalty_id, charge_id) = 1);

-- Payment holidays and restructures, with what they moved.
create table workpay_reschedules (
  id              uuid primary key default uuidv7(),
  agreement_id    uuid not null references workpay_agreements (id),
  kind            text not null check (kind in ('holiday', 'restructure')),
  reason          text not null check (length(reason) between 3 and 500),
  -- The request: holiday from/periods, or the new frequency, periods and first due date.
  params          jsonb not null,
  moved_minor     bigint not null check (moved_minor > 0),
  -- Instalment numbers moved from and created.
  moved_numbers   integer[] not null,
  created_numbers integer[] not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now()
);

create index workpay_reschedules_agreement_idx on workpay_reschedules (agreement_id, id);

-- Early settlement quotes: the payoff on a day, valid for a few days.
create table workpay_settlement_quotes (
  id                uuid primary key default uuidv7(),
  agreement_id      uuid not null references workpay_agreements (id),
  quoted_on         date not null,
  valid_until       date not null,
  instalments_minor bigint not null check (instalments_minor >= 0),
  penalties_minor   bigint not null check (penalties_minor >= 0),
  charges_minor     bigint not null check (charges_minor >= 0),
  discount_percent  text not null,
  discount_minor    bigint not null check (discount_minor >= 0),
  payoff_minor      bigint not null check (payoff_minor >= 0),
  -- The payment that settled the agreement with this quote.
  payment_id        uuid references payments (id),
  used_at           timestamptz,
  created_by        uuid references users (id),
  created_at        timestamptz not null default now(),
  check (valid_until >= quoted_on),
  check ((payment_id is null) = (used_at is null))
);

create index workpay_settlement_quotes_agreement_idx on workpay_settlement_quotes (agreement_id, id);

-- The discount of an early settlement is recorded as waivers of the instalments it covered.
alter table workpay_waivers
  add column quote_id uuid references workpay_settlement_quotes (id),
  -- The settlement payment was reversed: the discount no longer applies.
  add column reversed_at timestamptz,
  add check (reversed_at is null or quote_id is not null);

-- Time the vehicle is off the road during an agreement (workshop, accident …).
create table workpay_downtimes (
  id              uuid primary key default uuidv7(),
  agreement_id    uuid not null references workpay_agreements (id),
  reason          text not null check (length(reason) between 3 and 500),
  -- The owner is responsible (maintenance not the driver's): a payment holiday is suggested.
  owner_fault     boolean not null,
  started_on      date not null,
  ended_on        date,
  started_by      uuid references users (id),
  ended_by        uuid references users (id),
  created_at      timestamptz not null default now(),
  check (ended_on is null or ended_on >= started_on)
);

create unique index workpay_downtimes_open_idx on workpay_downtimes (agreement_id)
  where ended_on is null;
