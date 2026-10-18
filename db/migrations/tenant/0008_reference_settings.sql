-- Reference data and settings (P2-1, docs/20, docs/13 §6, docs/12): manual FX rates, the
-- tenant's own tax codes, default expense categories and the base-currency lock.

-- Set by the first financial transaction (finance modules); the base currency is fixed after.
alter table organisation add column base_currency_locked_at timestamptz;

create table fx_rates (
  id          uuid primary key default uuidv7(),
  base        char(3) not null check (base ~ '^[A-Z]{3}$'),
  quote       char(3) not null check (quote ~ '^[A-Z]{3}$' and quote <> base),
  -- 1 unit of `quote` = `rate` units of `base` (e.g. 1 USD = 15.42 GHS).
  rate        numeric(20, 10) not null check (rate > 0),
  rate_date   date not null,
  source      text not null default 'manual' check (source in ('manual', 'provider')),
  entered_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  unique (base, quote, rate_date)
);

create index fx_rates_lookup_idx on fx_rates (quote, rate_date desc);

-- Tax codes (decision 100, refined): the business's own codes, now with a kind and dated rate
-- components (docs/13 §6). Seeded placeholders stay inactive until rates are entered.
alter table tax_codes
  add column kind       text not null default 'standard'
                        check (kind in ('standard', 'flat_rate', 'exempt', 'zero_rated', 'custom')),
  add column applies_to text[] not null default array['sales', 'purchases']
                        check (applies_to <@ array['sales', 'purchases'] and cardinality(applies_to) > 0),
  -- [{ id, key, name, rate, base, effectiveFrom, effectiveTo }], validated by the application.
  add column components jsonb not null default '[]'::jsonb,
  -- Replaced by dated components (its constraints go with it).
  drop column rate;

-- Expense categories become a tree (docs/12): optional parent, ordering.
alter table expense_categories
  add column parent_id  uuid references expense_categories (id),
  add column sort       integer not null default 0,
  add column updated_at timestamptz not null default now(),
  add constraint expense_categories_not_own_parent check (parent_id is null or parent_id <> id);

create index expense_categories_parent_idx on expense_categories (parent_id, sort);
