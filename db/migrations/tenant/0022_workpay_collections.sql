-- Work & Pay collections (P3-4, docs/08 §3–4): late-payment penalties, payments allocated to
-- penalties and instalments, waivers, and the ledger accounts of hire purchase.

-- Hire purchase in the books: the price owed is a receivable, earned as it is paid.
insert into ledger_accounts (code, name, type, system_key)
select v.code, v.name, v.type, v.system_key
  from (values
    ('1210', '12100', 'Work and pay receivables', 'asset', 'workpay_receivables'),
    ('2300', '23000', 'Unearned work and pay income', 'liability', 'workpay_unearned'),
    ('4210', '42100', 'Work and pay late-payment fees', 'income', 'workpay_penalties')
  ) as wanted (preferred, fallback, name, type, system_key)
  cross join lateral (
    select case when exists (select 1 from ledger_accounts a where a.code = wanted.preferred)
                then wanted.fallback else wanted.preferred end as code,
           wanted.name, wanted.type, wanted.system_key
  ) as v
 where not exists (select 1 from ledger_accounts a where a.system_key = v.system_key);

alter table workpay_agreements
  add column penalty_kind text not null default 'none'
    check (penalty_kind in ('none', 'flat', 'percent', 'daily')),
  -- Minor units (flat, daily) or a percentage ("5").
  add column penalty_value text,
  add column penalty_cap_minor bigint check (penalty_cap_minor > 0),
  add column arrears_since date,
  add column completed_at timestamptz,
  add check ((penalty_kind = 'none') = (penalty_value is null)),
  add check ((status = 'completed') = (completed_at is not null));

create table workpay_penalties (
  id              uuid primary key default uuidv7(),
  agreement_id    uuid not null references workpay_agreements (id),
  instalment_id   uuid not null references workpay_instalments (id),
  charged_on      date not null,
  amount_minor    bigint not null check (amount_minor > 0),
  paid_minor      bigint not null default 0 check (paid_minor >= 0),
  waived_minor    bigint not null default 0 check (waived_minor >= 0),
  created_at      timestamptz not null default now(),
  -- One charge per instalment and day (a daily fee), so a rerun never charges twice.
  unique (instalment_id, charged_on),
  check (paid_minor + waived_minor <= amount_minor)
);

create index workpay_penalties_agreement_idx on workpay_penalties (agreement_id, charged_on);

-- Each payment's split over penalties and instalments (released if the payment is reversed).
create table workpay_allocations (
  id              uuid primary key default uuidv7(),
  agreement_id    uuid not null references workpay_agreements (id),
  payment_id      uuid not null references payments (id),
  instalment_id   uuid references workpay_instalments (id),
  penalty_id      uuid references workpay_penalties (id),
  amount_minor    bigint not null check (amount_minor > 0),
  released_at     timestamptz,
  created_at      timestamptz not null default now(),
  check ((instalment_id is null) <> (penalty_id is null))
);

create index workpay_allocations_payment_idx on workpay_allocations (payment_id);
create index workpay_allocations_agreement_idx on workpay_allocations (agreement_id, id);

-- Forgiven instalments and penalties, with who and why.
create table workpay_waivers (
  id              uuid primary key default uuidv7(),
  agreement_id    uuid not null references workpay_agreements (id),
  instalment_id   uuid references workpay_instalments (id),
  penalty_id      uuid references workpay_penalties (id),
  amount_minor    bigint not null check (amount_minor > 0),
  reason          text not null check (length(reason) between 3 and 500),
  waived_by       uuid references users (id),
  waived_at       timestamptz not null default now(),
  check ((instalment_id is null) <> (penalty_id is null))
);

create index workpay_waivers_agreement_idx on workpay_waivers (agreement_id, id);
