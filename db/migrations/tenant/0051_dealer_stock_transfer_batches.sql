-- Several stock vehicles sent from one branch to another under one reference (decision 542).
-- Each vehicle keeps its own row in dealer_stock_transfers, pointing at the batch.

create table dealer_stock_transfer_batches (
  id               uuid primary key default uuidv7(),
  reference        text not null unique,
  from_branch_id   uuid not null references branches (id),
  to_branch_id     uuid not null references branches (id),
  transferred_on   date not null,
  reason           text not null check (length(reason) between 3 and 500),
  vehicle_count    integer not null check (vehicle_count between 1 and 100),
  transferred_by   uuid references users (id),
  created_at       timestamptz not null default now(),
  check (from_branch_id <> to_branch_id)
);

create index dealer_stock_transfer_batches_from_idx
  on dealer_stock_transfer_batches (from_branch_id, created_at);
create index dealer_stock_transfer_batches_to_idx
  on dealer_stock_transfer_batches (to_branch_id, created_at);

alter table dealer_stock_transfers
  add column batch_id uuid references dealer_stock_transfer_batches (id);

create index dealer_stock_transfers_batch_idx on dealer_stock_transfers (batch_id, created_at)
  where batch_id is not null;
