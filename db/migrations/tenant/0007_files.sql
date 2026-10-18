-- Files service (P1-8, docs/03 §12): records of files kept in object storage. The bytes are
-- uploaded straight to storage with pre-signed URLs; a record becomes `ready` once checked.

create table files (
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
  uploaded_by   uuid references users (id),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  deleted_at    timestamptz,
  check ((owner_type is null) = (owner_id is null)),
  check ((status = 'ready') <= (completed_at is not null)),
  check ((status = 'deleted') = (deleted_at is not null))
);

create index files_owner_idx on files (owner_type, owner_id, created_at desc) where status = 'ready';
create index files_pending_idx on files (created_at) where status = 'pending';

alter table organisation add column logo_file_id uuid references files (id);
