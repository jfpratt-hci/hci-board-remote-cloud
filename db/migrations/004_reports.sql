-- Dashboard and reports.
-- 1. state_log: one row per stretch of time a board spent in one state, written by the database
--    itself whenever device_state changes, so uptime can be measured for any day, week or month.
--    Nothing in it is screen content: only the state word and the short headline Board Remote sends.
-- 2. alerts: opened and closed by the same trigger when a board goes offline and comes back, and by
--    the cloud when a Board Remote PC drops off. People acknowledge them on the dashboard.
set search_path = br, pg_catalog;

create table br.state_log (
  id           bigserial primary key,
  device_id    uuid not null references br.devices(id) on delete cascade,
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  state        text not null,
  headline     text not null default '',
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index state_log_one_open on br.state_log (device_id) where ended_at is null;
create index state_log_hosp_time on br.state_log (hospital_id, started_at);
create index state_log_dev_time on br.state_log (device_id, started_at);

alter table br.alerts add column agent_id uuid references br.agents(id) on delete set null;
create index alerts_hosp_time on br.alerts (hospital_id, opened_at);
create index alerts_open on br.alerts (hospital_id) where resolved_at is null;

-- Runs as the owner: people and PCs can read the log (through row level security) but never write it.
create function br.state_changed() returns trigger language plpgsql security definer set search_path = br, pg_catalog as $$
declare d record;
begin
  if tg_op = 'UPDATE' and old.state = new.state then return new; end if;
  update br.state_log set ended_at = greatest(now(), started_at) where device_id = new.device_id and ended_at is null;
  insert into br.state_log (device_id, hospital_id, state, headline) values (new.device_id, new.hospital_id, new.state, left(coalesce(new.headline, ''), 200));
  if new.state = 'offline' then
    if not exists (select 1 from br.alerts where device_id = new.device_id and kind = 'board_offline' and resolved_at is null) then
      select kind, room, unit, name, identity into d from br.devices where id = new.device_id;
      insert into br.alerts (hospital_id, device_id, kind, title)
        values (new.hospital_id, new.device_id, 'board_offline',
                case when coalesce(d.room, '') <> '' then 'Room ' || d.room else coalesce(nullif(d.name, ''), d.identity) end || ' went offline');
    end if;
  elsif new.state in ('online', 'late', 'degraded', 'paused') then
    update br.alerts set resolved_at = now() where device_id = new.device_id and kind = 'board_offline' and resolved_at is null;
  end if;
  return new;
end $$;
create trigger device_state_log after insert or update of state on br.device_state for each row execute function br.state_changed();

-- boards that already have a state start their history now
insert into br.state_log (device_id, hospital_id, state, headline, started_at)
  select device_id, hospital_id, state, left(headline, 200), now() from br.device_state;

alter table br.state_log enable row level security;
create policy see on br.state_log for select using (br.visible(hospital_id));
grant select on br.state_log to br_app;
grant execute on function br.state_changed() to br_app;

-- 3. floor, for filtering. Set by hand on a board, or worked out from a room number: 401 is floor 4,
--    1205 is floor 12. It lives in the cloud only; Board Remote PCs keep room, unit and closet.
alter table br.devices add column floor text not null default '' check (length(floor) <= 20);
create function br.floor_of(room text, floor text) returns text language sql immutable as $$
  select case when coalesce(floor, '') <> '' then floor
              when room ~ '^\d{3,4}[A-Za-z]?$' then ltrim(left(regexp_replace(room, '[A-Za-z]$', ''), length(regexp_replace(room, '[A-Za-z]$', '')) - 2), '0')
              else '' end $$;

-- a locked location covers the floor too
create or replace function br.device_lock_rule() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.location_locked and not br.can_lock() then raise exception 'Only HCI can lock a location' using errcode = 'insufficient_privilege'; end if;
    if new.location_locked then new.locked_by := br.actor_user(); new.locked_at := now(); end if;
    return new;
  end if;
  if new.location_locked is distinct from old.location_locked then
    if not br.can_lock() then raise exception 'Only HCI can lock or unlock a location' using errcode = 'insufficient_privilege'; end if;
    if new.location_locked then new.locked_by := br.actor_user(); new.locked_at := now(); else new.locked_by := null; new.locked_at := null; end if;
  end if;
  if old.location_locked and new.location_locked and (new.room <> old.room or new.unit <> old.unit or new.closet <> old.closet or new.floor <> old.floor) then
    raise exception 'This location is locked by HCI. HCI must unlock it before it can change.' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
grant execute on function br.floor_of(text, text) to br_app;

-- Hospital people cannot read HCI staff accounts, so their actions showed with no name. This says
-- only whether an account is HCI staff, so reports can show "HCI ONE support" instead of a blank.
create function br.hci_user(u uuid) returns boolean language sql stable security definer set search_path = br, pg_catalog as $$
  select coalesce((select is_hci from br.users where id = u), false) $$;
grant execute on function br.hci_user(uuid) to br_app;
