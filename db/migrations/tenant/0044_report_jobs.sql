-- The report engine (P8-1, docs/14 §2, §7): a report asked for as a file (CSV, XLSX or PDF) is
-- built by a background job as the user who asked, kept privately for 7 days and downloaded by a
-- short-lived link.

create table report_jobs (
  id            uuid primary key default uuidv7(),
  report_id     text not null check (length(report_id) between 1 and 80),
  params        jsonb not null default '{}',
  format        text not null check (format in ('csv', 'xlsx', 'pdf')),
  status        text not null default 'queued' check (status in ('queued', 'running', 'ready',
                  'failed', 'expired')),
  requested_by  uuid not null references users (id),
  row_count     integer check (row_count >= 0),
  file_id       uuid references files (id),
  error         text check (length(error) <= 500),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz,
  check (status not in ('ready', 'expired') or (file_id is not null and expires_at is not null)),
  check ((status = 'failed') = (error is not null))
);
create index report_jobs_requester on report_jobs (requested_by, created_at desc);
create index report_jobs_open on report_jobs (status) where status in ('queued', 'running', 'ready');
