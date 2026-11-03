-- P9-6: iOS has no install referrer, so a connect link can be held here behind a short code the
-- person takes through the App Store (docs/23 §7, decisions 518–519). The code is kept only as a
-- hash, the link (which may carry an invitation token) sealed; a hold is used once and lasts a day.
create table deferred_connect_links (
  id           uuid primary key default uuidv7(),
  code_hash    text not null unique,
  sealed_query text not null,
  tenant_slug  text not null,
  expires_at   timestamptz not null,
  claimed_at   timestamptz,
  created_at   timestamptz not null default now()
);

create index deferred_connect_links_expiry_idx on deferred_connect_links (expires_at);
