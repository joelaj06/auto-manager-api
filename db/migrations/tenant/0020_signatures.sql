-- E-signatures (P3-2, docs/24 §4–6): who signs each document, how they signed, single-use links
-- for signers without an account, and the signed PDF with its audit page.

alter table documents drop constraint documents_status_check;
alter table documents add constraint documents_status_check check (status in ('issued',
  'pending_signatures', 'partially_signed', 'fully_signed', 'declined', 'expired', 'void'));
alter table documents
  -- Signatures must be complete by then (null: the document is not signed in the system).
  add column signing_expires_at timestamptz,
  add column signed_pdf_file_id uuid references files (id),
  add column signed_pdf_sha256 text check (signed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  add column fully_signed_at timestamptz,
  add check ((signed_pdf_file_id is null) = (signed_pdf_sha256 is null)),
  add check ((status = 'fully_signed') <= (fully_signed_at is not null));

-- What was issued never changes; signing moves the status forward only, the signed PDF is
-- attached once, and a final status stays final (a signed or ended document can only be voided).
create or replace function documents_immutable() returns trigger language plpgsql as $$
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
     or new.replaces_id is distinct from old.replaces_id
     or new.signing_expires_at is distinct from old.signing_expires_at then
    raise exception 'an issued document cannot be changed' using errcode = '55000';
  end if;
  if (old.pdf_file_id is not null and (new.pdf_file_id is distinct from old.pdf_file_id
        or new.pdf_sha256 is distinct from old.pdf_sha256
        or new.rendered_at is distinct from old.rendered_at))
     or (old.signed_pdf_file_id is not null and (new.signed_pdf_file_id is distinct from
        old.signed_pdf_file_id or new.signed_pdf_sha256 is distinct from old.signed_pdf_sha256)) then
    raise exception 'the PDF of an issued document cannot be replaced' using errcode = '55000';
  end if;
  if old.fully_signed_at is not null and new.fully_signed_at is distinct from old.fully_signed_at then
    raise exception 'the signing date of a document cannot change' using errcode = '55000';
  end if;
  if new.status <> old.status and not (
       (old.status in ('issued', 'fully_signed', 'declined', 'expired') and new.status = 'void')
       or (old.status in ('pending_signatures', 'partially_signed') and new.status in
           ('partially_signed', 'fully_signed', 'declined', 'expired', 'void'))) then
    raise exception 'a document cannot go from % to %', old.status, new.status
      using errcode = '55000';
  end if;
  if old.status = 'void' and (new.voided_at is distinct from old.voided_at
     or new.void_reason is distinct from old.void_reason) then
    raise exception 'a voided document stays void' using errcode = '55000';
  end if;
  return new;
end;
$$;

create table document_signers (
  id                uuid primary key default uuidv7(),
  document_id       uuid not null references documents (id),
  position          smallint not null,
  -- The signer's place in the template's signature block (owner, driver, witness …).
  role              text not null check (role ~ '^[a-z][a-z_]{1,39}$'),
  label             text not null,
  -- Who: a user of the business, a driver (signs in the driver app) or a guest (signing link).
  party_type        text not null check (party_type in ('user', 'driver', 'guest')),
  party_id          uuid,
  name              text not null check (length(name) between 1 and 160),
  phone             text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  email             citext,
  required          boolean not null default true,
  status            text not null default 'pending' check (status in ('pending', 'signed', 'declined')),
  method            text check (method in ('drawn', 'typed', 'paper')),
  signature_file_id uuid references files (id),
  typed_name        text,
  paper_file_id     uuid references files (id),
  verified_by       uuid references users (id),
  consent_text      text,
  -- SHA-256 of the unsigned PDF the signer had in front of them.
  document_sha256   text check (document_sha256 ~ '^[0-9a-f]{64}$'),
  otp_sent_at       timestamptz,
  otp_verified_at   timestamptz,
  otp_channel       text check (otp_channel in ('sms', 'email')),
  signed_at         timestamptz,
  ip                text,
  user_agent        text,
  declined_at       timestamptz,
  decline_reason    text,
  last_reminded_at  timestamptz,
  reminders         integer not null default 0,
  created_at        timestamptz not null default now(),
  unique (document_id, position),
  check ((party_type = 'guest') = (party_id is null)),
  check ((status = 'signed') = (signed_at is not null)),
  check ((status = 'declined') = (declined_at is not null)),
  check (status <> 'signed' or method is not null),
  check (method is distinct from 'drawn' or signature_file_id is not null),
  check (method is distinct from 'typed' or typed_name is not null),
  check (method is distinct from 'paper' or (paper_file_id is not null and verified_by is not null))
);

create index document_signers_document_idx on document_signers (document_id, position);
create index document_signers_party_idx on document_signers (party_type, party_id)
  where status = 'pending';

-- A signer's evidence never changes once they have signed or declined.
create function document_signers_final() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'signers cannot be deleted' using errcode = '55000';
  end if;
  if old.status <> 'pending' and (new.status <> old.status or new.method is distinct from old.method
     or new.signature_file_id is distinct from old.signature_file_id
     or new.typed_name is distinct from old.typed_name
     or new.paper_file_id is distinct from old.paper_file_id
     or new.signed_at is distinct from old.signed_at or new.declined_at is distinct from old.declined_at
     or new.document_sha256 is distinct from old.document_sha256
     or new.otp_verified_at is distinct from old.otp_verified_at or new.ip is distinct from old.ip) then
    raise exception 'a signature cannot be changed' using errcode = '55000';
  end if;
  if new.document_id <> old.document_id or new.role <> old.role or new.party_type <> old.party_type
     or new.party_id is distinct from old.party_id then
    raise exception 'a signer cannot be swapped' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger document_signers_final before update or delete on document_signers
  for each row execute function document_signers_final();

-- Single-use, expiring links for signers without an account (only the token's hash is kept).
create table document_signing_links (
  id          uuid primary key default uuidv7(),
  signer_id   uuid not null references document_signers (id),
  token_hash  text not null unique,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  check (expires_at > created_at)
);

create index document_signing_links_signer_idx on document_signing_links (signer_id);

alter table document_events drop constraint document_events_type_check;
alter table document_events add constraint document_events_type_check check (type in ('issued',
  'rendered', 'downloaded', 'voided', 'verified', 'signature_requested', 'link_created', 'viewed',
  'otp_sent', 'otp_verified', 'signed', 'declined', 'paper_attached', 'reminded', 'fully_signed',
  'signed_pdf_rendered', 'expired'));
alter table document_events add column signer_id uuid references document_signers (id);

alter table notification_deliveries drop constraint notification_deliveries_recipient_type_check;
alter table notification_deliveries add constraint notification_deliveries_recipient_type_check
  check (recipient_type in ('user', 'driver', 'signer'));

-- Signatures and paper scans are evidence: like the document PDFs, they never change.
create or replace function issued_document_files_immutable() returns trigger language plpgsql as $$
begin
  if old.kind in ('issued_document', 'signature_image', 'signed_paper_scan') and old.status = 'ready'
     and (new.status <> old.status or new.storage_key <> old.storage_key
          or new.size_bytes <> old.size_bytes) then
    raise exception 'the file of an issued document cannot change' using errcode = '55000';
  end if;
  return new;
end;
$$;
