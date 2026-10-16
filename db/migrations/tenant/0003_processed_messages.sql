-- Idempotent job and event handling (P0-8). A handler records its message key in the same
-- transaction as its changes; a redelivered message finds the key and is skipped.
create table processed_messages (
  key          text primary key check (length(key) between 1 and 300),
  processed_at timestamptz not null default now()
);

-- Retention clean-up by the daily maintenance job.
create index processed_messages_processed_idx on processed_messages (processed_at);

-- Retention clean-up of published outbox rows.
create index outbox_published_idx on outbox (published_at) where published_at is not null;
