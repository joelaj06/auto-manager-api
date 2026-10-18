-- Files service (P1-8, docs/03 §12): platform-side file records (KYC documents of tenant
-- applications, reseller documents). Same shape as the tenant `files` table.

create table platform_files (
  id            uuid primary key default uuidv7(),
  kind          text not null check (kind ~ '^[a-z][a-z_]*$'),
  storage_key   text not null unique,
  visibility    text not null check (visibility in ('public', 'private')),
  filename      text not null check (length(filename) between 1 and 200),
  content_type  text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  status        text not null default 'pending' check (status in ('pending', 'ready', 'deleted')),
  owner_type    text,
  owner_id      uuid,
  -- A platform user, or null for an applicant (identified by their private link).
  uploaded_by   uuid references platform_users (id),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  deleted_at    timestamptz,
  check ((owner_type is null) = (owner_id is null)),
  check ((status = 'ready') <= (completed_at is not null)),
  check ((status = 'deleted') = (deleted_at is not null))
);

create index platform_files_owner_idx on platform_files (owner_type, owner_id, created_at desc)
  where status = 'ready';
create index platform_files_pending_idx on platform_files (created_at) where status = 'pending';
