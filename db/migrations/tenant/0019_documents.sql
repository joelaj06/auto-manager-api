-- Document engine (P3-1, docs/24 §3, §5, §6): versioned templates with locked clauses, issued
-- documents with their data snapshot, verification code and immutable PDF, and their events.

create table document_templates (
  id              uuid primary key default uuidv7(),
  type            text not null,
  language        text not null default 'en',
  name            text not null check (length(name) between 1 and 120),
  version         integer not null check (version > 0),
  body            text not null check (length(body) between 1 and 200000),
  status          text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  -- The system template version whose locked clauses this version was checked against.
  system_version  integer not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  activated_by    uuid references users (id),
  activated_at    timestamptz,
  archived_at     timestamptz,
  unique (type, language, version),
  check ((status = 'draft') = (activated_at is null)),
  check ((status = 'archived') = (archived_at is not null))
);

-- At most one version in use per type and language.
create unique index document_templates_active_idx on document_templates (type, language)
  where status = 'active';

create table documents (
  id                 uuid primary key default uuidv7(),
  number             text not null unique,
  type               text not null,
  language           text not null,
  -- The business's template version, or null for the system template.
  template_id        uuid references document_templates (id),
  template_version   text not null,
  -- The template as it was when the document was issued, so it always renders the same.
  template_body      text not null,
  subject_type       text not null,
  subject_id         uuid not null,
  branch_id          uuid references branches (id),
  data_snapshot      jsonb not null,
  verification_code  text not null unique check (verification_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  status             text not null default 'issued' check (status in ('issued', 'void')),
  pdf_file_id        uuid references files (id),
  pdf_sha256         text check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  rendered_at        timestamptz,
  issued_by          uuid references users (id),
  issued_at          timestamptz not null,
  voided_by          uuid references users (id),
  voided_at          timestamptz,
  void_reason        text,
  -- A correction names the document it replaces (which is voided).
  replaces_id        uuid references documents (id),
  check ((pdf_file_id is null) = (pdf_sha256 is null)),
  check ((pdf_file_id is null) = (rendered_at is null)),
  check ((status = 'void') = (voided_at is not null)),
  check ((status = 'void') = (void_reason is not null))
);

create index documents_subject_idx on documents (subject_type, subject_id, id desc);
create index documents_branch_idx on documents (branch_id, id desc);
create index documents_unrendered_idx on documents (id) where pdf_file_id is null;

-- What was issued never changes: only the PDF is attached (once) and the document voided.
create function documents_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'issued documents cannot be deleted' using errcode = '55000';
  end if;
  if new.number <> old.number or new.type <> old.type or new.language <> old.language
     or new.template_id is distinct from old.template_id
     or new.template_version <> old.template_version or new.template_body <> old.template_body
     or new.subject_type <> old.subject_type or new.subject_id <> old.subject_id
     or new.branch_id is distinct from old.branch_id or new.data_snapshot <> old.data_snapshot
     or new.verification_code <> old.verification_code or new.issued_at <> old.issued_at
     or new.issued_by is distinct from old.issued_by
     or new.replaces_id is distinct from old.replaces_id then
    raise exception 'an issued document cannot be changed' using errcode = '55000';
  end if;
  if old.pdf_file_id is not null and (new.pdf_file_id is distinct from old.pdf_file_id
     or new.pdf_sha256 is distinct from old.pdf_sha256
     or new.rendered_at is distinct from old.rendered_at) then
    raise exception 'the PDF of an issued document cannot be replaced' using errcode = '55000';
  end if;
  if old.status = 'void' and (new.status <> 'void' or new.voided_at is distinct from old.voided_at
     or new.void_reason is distinct from old.void_reason) then
    raise exception 'a voided document stays void' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger documents_immutable before update or delete on documents
  for each row execute function documents_immutable();

-- The stored PDF of a document is never deleted or swapped.
create function issued_document_files_immutable() returns trigger language plpgsql as $$
begin
  if old.kind = 'issued_document' and old.status = 'ready'
     and (new.status <> old.status or new.storage_key <> old.storage_key
          or new.size_bytes <> old.size_bytes) then
    raise exception 'the file of an issued document cannot change' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger issued_document_files_immutable before update on files
  for each row execute function issued_document_files_immutable();

create table document_events (
  id           uuid primary key default uuidv7(),
  document_id  uuid not null references documents (id),
  type         text not null check (type in ('issued', 'rendered', 'downloaded', 'voided', 'verified')),
  actor_type   text not null check (actor_type in ('user', 'system', 'public')),
  actor_id     uuid,
  ip           text,
  metadata     jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);

create index document_events_document_idx on document_events (document_id, id);

create trigger document_events_append_only before update or delete on document_events
  for each row execute function forbid_mutation();
