-- Dealer stock (P7-4, docs/10 §2): a vehicle held for sale (usage stock) with its stock status,
-- source, the day it entered stock, asking and minimum prices in the base currency with their
-- history, holding cost per day, consignment terms, and branch-to-branch transfer records.

create table dealer_stock (
  vehicle_id                  uuid primary key references vehicles (id),
  status                      text not null check (status in ('incoming', 'reconditioning',
                                'ready', 'listed', 'reserved', 'sold', 'delivered', 'withdrawn',
                                'returned')),
  source                      text not null check (source in ('purchase', 'trade_in',
                                'consignment', 'repossession', 'other')),
  stocked_on                  date not null,
  asking_price_minor          bigint check (asking_price_minor >= 0),
  minimum_price_minor         bigint check (minimum_price_minor >= 0),
  holding_cost_per_day_minor  bigint not null default 0 check (holding_cost_per_day_minor >= 0),
  -- Consignment: a customer's vehicle sold for them, for a fixed payout or less a commission.
  consignor_id                uuid references customers (id),
  consignment_terms           text check (consignment_terms in ('fixed', 'commission')),
  consignor_payout_minor      bigint check (consignor_payout_minor >= 0),
  commission_rate             numeric(5, 2) check (commission_rate between 0 and 100),
  listed_on                   date,
  withdrawn_on                date,
  withdraw_reason             text check (length(withdraw_reason) <= 500),
  sold_on                     date,
  delivered_on                date,
  notes                       text check (length(notes) <= 2000),
  created_by                  uuid references users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  check (minimum_price_minor is null or asking_price_minor is null
         or minimum_price_minor <= asking_price_minor),
  check ((source = 'consignment') = (consignor_id is not null)),
  check ((consignor_id is null) = (consignment_terms is null)),
  check (consignment_terms is distinct from 'fixed' or consignor_payout_minor is not null),
  check (consignment_terms is distinct from 'commission' or commission_rate is not null),
  check ((status = 'withdrawn') = (withdrawn_on is not null)),
  check (status <> 'listed' or asking_price_minor is not null)
);

create index dealer_stock_status_idx on dealer_stock (status, stocked_on);
create index dealer_stock_consignor_idx on dealer_stock (consignor_id) where consignor_id is not null;

-- Every change of the prices (reductions are what dealers watch).
create table dealer_price_changes (
  id                       uuid primary key default uuidv7(),
  vehicle_id               uuid not null references dealer_stock (vehicle_id),
  asking_price_minor       bigint check (asking_price_minor >= 0),
  minimum_price_minor      bigint check (minimum_price_minor >= 0),
  previous_asking_minor    bigint,
  previous_minimum_minor   bigint,
  reason                   text check (length(reason) <= 500),
  changed_by               uuid references users (id),
  changed_at               timestamptz not null default now()
);

create index dealer_price_changes_vehicle_idx on dealer_price_changes (vehicle_id, changed_at);

create table dealer_stock_transfers (
  id               uuid primary key default uuidv7(),
  vehicle_id       uuid not null references dealer_stock (vehicle_id),
  from_branch_id   uuid not null references branches (id),
  to_branch_id     uuid not null references branches (id),
  transferred_on   date not null,
  reason           text not null check (length(reason) between 3 and 500),
  transferred_by   uuid references users (id),
  created_at       timestamptz not null default now(),
  check (from_branch_id <> to_branch_id)
);

create index dealer_stock_transfers_vehicle_idx on dealer_stock_transfers (vehicle_id, created_at);
