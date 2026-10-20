-- Dashboards v1 (P2-8, docs/14 §2): a daily read model per vehicle, rebuilt from the ledger,
-- odometer readings, fuel logs, status history and assignments. Writes to those tables mark the
-- days they touch as stale; the tenant's daily job (and a dashboard read) rebuilds them.

create table daily_vehicle_stats (
  vehicle_id               uuid not null references vehicles (id),
  stat_date                date not null,
  -- The vehicle's branch when the day was built.
  branch_id                uuid not null references branches (id),
  -- Status and driver at the end of the day (tenant timezone).
  status                   text not null,
  driver_id                uuid references drivers (id),
  -- Ledger lines tagged with the vehicle, by entry date, in base minor units.
  remittance_income_minor  bigint not null default 0,
  rental_income_minor      bigint not null default 0,
  other_income_minor       bigint not null default 0,
  cost_minor               bigint not null default 0,
  -- Odometer movement that day, in the vehicle's unit (km or mi); replacements don't count.
  distance                 bigint not null default 0,
  fuel_litres              numeric(12, 2) not null default 0,
  fuel_cost_minor          bigint not null default 0,
  primary key (vehicle_id, stat_date)
);

create index daily_vehicle_stats_branch_idx on daily_vehicle_stats (branch_id, stat_date);
create index daily_vehicle_stats_date_idx on daily_vehicle_stats (stat_date);

-- Days from which the stats are stale (append-only, so concurrent writers never wait on each
-- other); the builder takes the earliest and clears what it has seen.
create table stats_dirty_marks (
  id         bigint generated always as identity primary key,
  from_date  date not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

-- Last day the stats were built for (null: never built).
alter table organisation add column stats_built_through date;

create function mark_vehicle_stats_dirty() returns trigger language plpgsql as $$
declare
  touched date;
begin
  -- Timestamps are marked from the day before their UTC date: covers every tenant timezone.
  -- (One branch per table: a record has only its own table's fields.)
  if tg_table_name = 'journal_entries' then
    touched := new.entry_date;
  elsif tg_table_name = 'odometer_readings' then
    touched := (new.read_at at time zone 'UTC')::date - 1;
  elsif tg_table_name = 'fuel_logs' then
    touched := (new.filled_at at time zone 'UTC')::date - 1;
    if tg_op = 'UPDATE' then
      touched := least(touched, (old.filled_at at time zone 'UTC')::date - 1);
    end if;
  elsif tg_table_name = 'vehicle_status_history' then
    touched := (new.changed_at at time zone 'UTC')::date - 1;
  elsif tg_table_name = 'vehicle_assignments' then
    touched := (coalesce(new.ended_at, new.started_at) at time zone 'UTC')::date - 1;
    if tg_op = 'INSERT' then
      touched := (new.started_at at time zone 'UTC')::date - 1;
    end if;
  else -- vehicles
    touched := (least(now(), new.created_at) at time zone 'UTC')::date - 1;
  end if;
  insert into stats_dirty_marks (from_date, reason) values (touched, tg_table_name);
  return null;
end;
$$;

create trigger journal_entries_stats after insert on journal_entries
  for each row execute function mark_vehicle_stats_dirty();
create trigger odometer_readings_stats after insert on odometer_readings
  for each row execute function mark_vehicle_stats_dirty();
create trigger fuel_logs_stats after insert or update on fuel_logs
  for each row execute function mark_vehicle_stats_dirty();
create trigger vehicle_status_history_stats after insert on vehicle_status_history
  for each row execute function mark_vehicle_stats_dirty();
create trigger vehicle_assignments_stats after insert or update of ended_at on vehicle_assignments
  for each row execute function mark_vehicle_stats_dirty();
-- New vehicles, branch moves and removals change today's row.
create trigger vehicles_stats after insert or update of branch_id, deleted_at on vehicles
  for each row execute function mark_vehicle_stats_dirty();
