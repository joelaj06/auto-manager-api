-- Parts inventory, basic (docs/12 §4; P6-3): a catalogue of parts with the models they fit, stock
-- per branch at average cost with reorder levels, and every move in or out (opening stock,
-- purchases, issues to work orders, counts, transfers between branches).

-- Stock is an asset until used; counts and write-offs have their own expense account.
insert into ledger_accounts (code, name, type, system_key) values
  ('1400', 'Parts inventory', 'asset', 'parts_inventory'),
  ('5010', 'Stock adjustments', 'expense', 'stock_adjustments')
on conflict (code) do nothing;

-- Purchases for stock are expenses posted to the inventory, paid like any other.
insert into expense_categories (code, name, is_system, sort, ledger_account_id)
select 'parts_stock', 'Parts for stock', true, 95, id from ledger_accounts where code = '1400'
on conflict (code) do nothing;

create table parts (
  id          uuid primary key default uuidv7(),
  -- Upper case, the business's own code.
  sku         text not null unique check (sku ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  name        text not null check (length(name) between 2 and 160),
  unit        text not null default 'each' check (unit in ('each', 'pair', 'set', 'litre', 'kg', 'metre')),
  category    text check (category is null or length(category) between 1 and 60),
  -- Makes and models it fits ([{make, model|null}]); empty: any vehicle.
  compatible  jsonb not null default '[]' check (jsonb_typeof(compatible) = 'array'),
  notes       text check (notes is null or length(notes) <= 2000),
  active      boolean not null default true,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index parts_name_idx on parts (lower(name));

create table part_stock (
  id               uuid primary key default uuidv7(),
  part_id          uuid not null references parts (id),
  branch_id        uuid not null references branches (id),
  on_hand          numeric(12, 2) not null default 0 check (on_hand >= 0),
  -- Weighted average cost of one unit, in minor units of the base currency.
  avg_cost_minor   bigint not null default 0 check (avg_cost_minor >= 0),
  -- Alert at or below this quantity (null: no alert), suggesting this much to order.
  reorder_level    numeric(12, 2) check (reorder_level >= 0),
  reorder_qty      numeric(12, 2) check (reorder_qty > 0),
  location         text check (location is null or length(location) <= 60),
  -- Since when it is at or below the reorder level (alerted once each time).
  below_since      timestamptz,
  updated_at       timestamptz not null default now(),
  unique (part_id, branch_id)
);

create index part_stock_branch_idx on part_stock (branch_id);

create table part_moves (
  id               uuid primary key default uuidv7(),
  part_id          uuid not null references parts (id),
  branch_id        uuid not null references branches (id),
  kind             text not null check (kind in ('opening', 'receipt', 'issue', 'adjustment',
                     'transfer_out', 'transfer_in')),
  -- Signed: in above 0, out below.
  quantity         numeric(12, 2) not null check (quantity <> 0),
  unit_cost_minor  bigint not null check (unit_cost_minor >= 0),
  value_minor      bigint not null,
  on_hand_after    numeric(12, 2) not null check (on_hand_after >= 0),
  avg_cost_after   bigint not null check (avg_cost_after >= 0),
  work_order_id    uuid references work_orders (id),
  supplier_id      uuid references suppliers (id),
  expense_id       uuid references expenses (id),
  -- The two halves of a transfer share it.
  transfer_id      uuid,
  reference        text check (reference is null or length(reference) <= 80),
  reason           text check (reason is null or length(reason) <= 500),
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  check ((kind = 'issue') = (work_order_id is not null)),
  check ((kind in ('transfer_out', 'transfer_in')) = (transfer_id is not null)),
  check ((quantity > 0) = (kind in ('opening', 'receipt', 'transfer_in')) or kind = 'adjustment')
);

create index part_moves_part_idx on part_moves (part_id, branch_id, created_at desc);
create index part_moves_work_order_idx on part_moves (work_order_id) where work_order_id is not null;

-- A work order's part line can come from the catalogue (issued from stock on completion).
alter table work_order_lines add column part_id uuid references parts (id);
