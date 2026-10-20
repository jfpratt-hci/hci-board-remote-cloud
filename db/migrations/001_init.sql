-- HCI ONE Board Remote Cloud: initial schema
-- Runs as the owner role (br_owner). The service connects as br_app, which is not the owner,
-- so row level security applies to every query it makes. Every hospital scoped row is only
-- visible to the people and Board Remote installs that belong to that hospital, enforced here
-- in the database, not only in the service code.
--
-- Who is asking is set per transaction by the service:
--   br.actor_kind  'user' | 'agent' | 'system'
--   br.user_id     the signed in user's id   (when actor_kind = 'user')
--   br.agent_id    the Board Remote install  (when actor_kind = 'agent')
--   br.can_lock    'on' for HCI admin and HCI tech, who may lock and unlock locations
-- With nothing set, nothing is visible.
--
-- No table has a column for screenshots, screen text or device log lines: PHI has nowhere to land.

create schema if not exists br;
set search_path = br, pg_catalog;

create table br.schema_migrations (version text primary key, applied_at timestamptz not null default now());

/* ---------------- tenants and people ---------------- */
create table br.hospitals (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(name) between 1 and 120),
  entra_tenant_id  text unique check (entra_tenant_id ~ '^[0-9a-f-]{36}$'),   -- the hospital's own Microsoft tenant
  settings         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

create table br.users (
  id          uuid primary key default gen_random_uuid(),
  email       text not null check (email ~ '^[^@\s]+@[^@\s]+$'),
  name        text not null default '',
  entra_tid   text,             -- Microsoft tenant the account lives in
  entra_oid   text,             -- Microsoft object id, set on first sign in
  is_hci      boolean not null default false,
  disabled    boolean not null default false,
  created_at  timestamptz not null default now(),
  last_login  timestamptz,
  unique (entra_tid, entra_oid)
);
create unique index users_email_lower on br.users (lower(email));

-- hospital_id null means every hospital, which only HCI admin and HCI tech may have
create table br.memberships (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references br.users(id) on delete cascade,
  hospital_id  uuid references br.hospitals(id) on delete cascade,
  role         text not null check (role in ('hci_admin', 'hci_tech', 'dealer', 'hospital_it')),
  created_by   uuid references br.users(id),
  created_at   timestamptz not null default now(),
  check (hospital_id is not null or role in ('hci_admin', 'hci_tech'))
);
create unique index memberships_one on br.memberships (user_id, coalesce(hospital_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table br.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references br.users(id) on delete cascade,
  token_hash  bytea not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_seen   timestamptz not null default now(),
  ip          text not null default '',
  ua          text not null default ''
);

/* ---------------- Board Remote installs ---------------- */
create table br.agents (
  id               uuid primary key default gen_random_uuid(),
  hospital_id      uuid not null references br.hospitals(id) on delete cascade,
  name             text not null default '',
  pc_name          text not null default '',
  version          text not null default '',
  credential_hash  bytea not null,
  enrolled_by      uuid references br.users(id),
  enrolled_at      timestamptz not null default now(),
  last_seen        timestamptz,
  revoked_at       timestamptz
);

create table br.enrollment_codes (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  code_hash    bytea not null unique,
  label        text not null default '',
  created_by   uuid references br.users(id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_by      uuid references br.agents(id)
);

/* ---------------- devices ---------------- */
create table br.devices (
  id               uuid primary key default gen_random_uuid(),
  hospital_id      uuid not null references br.hospitals(id) on delete cascade,
  identity         text not null,                 -- MAC or serial, the same no matter which PC sees it
  kind             text not null default 'other' check (kind in ('wb', 'ds', 'tv', 'cam', 'tab', 'usb', 'other')),
  name             text not null default '',
  model            text not null default '',
  android          text not null default '',
  details          jsonb not null default '{}',   -- make, sdk, MACs: never screen content
  room             text not null default '',
  unit             text not null default '',
  closet           text not null default '',
  placement_ts     jsonb not null default '{}',   -- when room, unit and closet were last changed, for most recent wins
  location_locked  boolean not null default false,
  locked_by        uuid references br.users(id),
  locked_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (hospital_id, identity)
);

create table br.device_reach (
  device_id       uuid not null references br.devices(id) on delete cascade,
  agent_id        uuid not null references br.agents(id) on delete cascade,
  hospital_id     uuid not null references br.hospitals(id) on delete cascade,
  local_board_id  text not null,           -- the board's id inside that Board Remote
  host            text not null default '',
  port            int not null default 5555,
  is_primary      boolean not null default false,
  online          boolean not null default false,
  last_seen       timestamptz not null default now(),
  primary key (device_id, agent_id),
  unique (agent_id, local_board_id)
);

create table br.device_state (
  device_id    uuid primary key references br.devices(id) on delete cascade,
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  state        text not null default 'unknown' check (state in ('online', 'late', 'degraded', 'offline', 'unknown', 'paused')),
  headline     text not null default '',
  last_beat    timestamptz,
  by_agent     uuid references br.agents(id) on delete set null,
  updated_at   timestamptz not null default now()
);

/* ---------------- configuration, alerts, live use, commands, apps ---------------- */
create table br.settings (
  id               uuid primary key default gen_random_uuid(),
  hospital_id      uuid not null references br.hospitals(id) on delete cascade,
  scope            text not null check (scope in ('hospital', 'agent', 'device')),
  scope_id         text not null default '',
  key              text not null check (key ~ '^[A-Za-z][\w.]{0,63}$'),
  value            jsonb,
  updated_at       timestamptz not null default now(),
  updated_by_user  uuid references br.users(id),
  updated_by_agent uuid references br.agents(id) on delete set null,
  origin           text not null default 'cloud' check (origin in ('cloud', 'agent')),
  unique (hospital_id, scope, scope_id, key)
);

create table br.alerts (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  device_id    uuid references br.devices(id) on delete set null,
  kind         text not null,
  title        text not null,
  opened_at    timestamptz not null default now(),
  acked_at     timestamptz,
  acked_by     uuid references br.users(id),
  resolved_at  timestamptz,
  told         jsonb not null default '[]'
);

create table br.live_locks (
  device_id    uuid primary key references br.devices(id) on delete cascade,
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  user_id      uuid not null references br.users(id) on delete cascade,
  kind         text not null check (kind in ('mirror', 'shell')),
  expires_at   timestamptz not null
);

create table br.commands (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  device_id    uuid references br.devices(id) on delete cascade,
  agent_id     uuid not null references br.agents(id) on delete cascade,
  action       text not null,
  args         jsonb not null default '{}',
  status       text not null default 'queued' check (status in ('queued', 'sent', 'done', 'failed', 'expired')),
  result       jsonb,
  created_by   uuid references br.users(id),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz,
  expires_at   timestamptz not null default now() + interval '10 minutes'
);
create index commands_agent_queue on br.commands (agent_id, status, created_at);

create table br.app_releases (
  id            uuid primary key default gen_random_uuid(),
  hospital_id   uuid references br.hospitals(id) on delete cascade,   -- null means every hospital
  pkg           text not null,
  version_name  text not null default '',
  version_code  bigint not null default 0,
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  blob_url      text not null,                                         -- Azure blob storage, not the database
  created_by    uuid references br.users(id),
  created_at    timestamptz not null default now()
);

/* ---------------- audit log: append only ---------------- */
create table br.audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  hospital_id  uuid references br.hospitals(id) on delete set null,
  actor_kind   text not null check (actor_kind in ('user', 'agent', 'system')),
  actor_user   uuid references br.users(id) on delete set null,
  actor_agent  uuid references br.agents(id) on delete set null,
  device_id    uuid references br.devices(id) on delete set null,
  action       text not null,
  details      jsonb not null default '{}',
  origin       text not null default 'cloud' check (origin in ('cloud', 'agent')),
  result       text not null default 'ok'
);
create index audit_by_hospital on br.audit_log (hospital_id, at desc);
create index audit_by_user on br.audit_log (actor_user, at desc);

create function br.audit_append_only() returns trigger language plpgsql as $$
begin
  -- the only change allowed is the foreign key nulling a deleted hospital, user, agent or device
  if tg_op = 'UPDATE' and new.id = old.id and new.at = old.at and new.action = old.action and new.details = old.details
     and new.result = old.result and new.actor_kind = old.actor_kind and new.origin = old.origin
     and (new.hospital_id is not distinct from old.hospital_id or new.hospital_id is null)
     and (new.actor_user is not distinct from old.actor_user or new.actor_user is null)
     and (new.actor_agent is not distinct from old.actor_agent or new.actor_agent is null)
     and (new.device_id is not distinct from old.device_id or new.device_id is null) then
    return new;
  end if;
  raise exception 'The audit log is append only' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_no_change before update or delete on br.audit_log for each row execute function br.audit_append_only();
create trigger audit_no_truncate before truncate on br.audit_log execute function br.audit_append_only();

/* ---------------- who is asking ---------------- */
create function br.actor_kind() returns text language sql stable as $$ select coalesce(nullif(current_setting('br.actor_kind', true), ''), 'none') $$;
create function br.actor_user() returns uuid language sql stable as $$ select nullif(current_setting('br.user_id', true), '')::uuid $$;
create function br.actor_agent() returns uuid language sql stable as $$ select nullif(current_setting('br.agent_id', true), '')::uuid $$;
create function br.can_lock() returns boolean language sql stable as $$ select coalesce(current_setting('br.can_lock', true), '') = 'on' $$;

-- Runs as the owner so it can read memberships without recursing through their own policies.
create function br.visible(h uuid) returns boolean language sql stable security definer set search_path = br, pg_catalog as $$
  select case br.actor_kind()
    when 'system' then true
    when 'agent' then exists (select 1 from br.agents a where a.id = br.actor_agent() and a.hospital_id = h and a.revoked_at is null)
    when 'user' then exists (
      select 1 from br.memberships m join br.users u on u.id = m.user_id
      where m.user_id = br.actor_user() and not u.disabled
        and (m.hospital_id = h or (m.hospital_id is null and m.role in ('hci_admin', 'hci_tech'))))
    else false end
$$;
create function br.is_hci(min_role text default 'hci_tech') returns boolean language sql stable security definer set search_path = br, pg_catalog as $$
  select br.actor_kind() = 'system' or (br.actor_kind() = 'user' and exists (
    select 1 from br.memberships m join br.users u on u.id = m.user_id
    where m.user_id = br.actor_user() and not u.disabled and u.is_hci and m.hospital_id is null
      and (m.role = 'hci_admin' or (min_role = 'hci_tech' and m.role = 'hci_tech'))))
$$;
-- May the person asking give someone this role here? HCI admin: anything. HCI tech: hospital roles anywhere.
-- Hospital IT and dealers: hospital IT in their own hospital.
create function br.can_grant(h uuid, r text) returns boolean language sql stable security definer set search_path = br, pg_catalog as $$
  select br.actor_kind() = 'system'
      or br.is_hci('hci_admin')
      or (br.is_hci() and r in ('dealer', 'hospital_it') and h is not null)
      or (r = 'hospital_it' and h is not null and br.visible(h) and exists (
            select 1 from br.memberships m where m.user_id = br.actor_user() and m.hospital_id = h and m.role in ('hospital_it', 'dealer')))
$$;

/* ---------------- the HCI location lock, enforced in the database ---------------- */
create function br.device_lock_rule() returns trigger language plpgsql as $$
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
  if old.location_locked and new.location_locked and (new.room <> old.room or new.unit <> old.unit or new.closet <> old.closet) then
    raise exception 'This location is locked by HCI. HCI must unlock it before it can change.' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger device_lock before insert or update on br.devices for each row execute function br.device_lock_rule();

/* ---------------- row level security ---------------- */
alter table br.hospitals enable row level security;
create policy see on br.hospitals for select using (br.visible(id));
create policy add on br.hospitals for insert with check (br.is_hci('hci_admin'));
create policy edit on br.hospitals for update using (br.visible(id) and br.is_hci()) with check (br.is_hci());
create policy drop on br.hospitals for delete using (br.is_hci('hci_admin'));

alter table br.users enable row level security;
create policy see on br.users for select using (
  br.actor_kind() = 'system' or br.is_hci() or id = br.actor_user()
  or exists (select 1 from br.memberships m where m.user_id = users.id and m.hospital_id is not null and br.visible(m.hospital_id)));
create policy add on br.users for insert with check (br.actor_kind() in ('system', 'user'));
create policy edit on br.users for update using (br.actor_kind() = 'system' or br.is_hci('hci_admin') or id = br.actor_user()
  or (not is_hci and exists (select 1 from br.memberships m where m.user_id = users.id and m.hospital_id is not null and br.can_grant(m.hospital_id, m.role))));

alter table br.memberships enable row level security;
create policy see on br.memberships for select using (
  br.actor_kind() = 'system' or user_id = br.actor_user() or br.is_hci() or (hospital_id is not null and br.visible(hospital_id)));
create policy add on br.memberships for insert with check (br.can_grant(hospital_id, role));
create policy edit on br.memberships for update using (br.can_grant(hospital_id, role)) with check (br.can_grant(hospital_id, role));
create policy drop on br.memberships for delete using (br.can_grant(hospital_id, role));

alter table br.sessions enable row level security;
create policy own on br.sessions for all using (br.actor_kind() = 'system' or user_id = br.actor_user()) with check (br.actor_kind() = 'system' or user_id = br.actor_user());

alter table br.agents enable row level security;
create policy see on br.agents for all using (br.visible(hospital_id) and (br.actor_kind() <> 'agent' or id = br.actor_agent()))
  with check (br.visible(hospital_id));

alter table br.enrollment_codes enable row level security;
create policy see on br.enrollment_codes for all using (br.visible(hospital_id) and br.actor_kind() <> 'agent') with check (br.visible(hospital_id) and br.actor_kind() <> 'agent');

-- the plain hospital scoped tables: visible to that hospital only, in every direction
do $$ declare t text; begin
  foreach t in array array['devices', 'device_reach', 'device_state', 'settings', 'alerts', 'live_locks', 'commands'] loop
    execute format('alter table br.%I enable row level security', t);
    execute format('create policy hosp on br.%I for all using (br.visible(hospital_id)) with check (br.visible(hospital_id))', t);
  end loop;
end $$;

alter table br.app_releases enable row level security;
create policy see on br.app_releases for select using (hospital_id is null or br.visible(hospital_id));
create policy add on br.app_releases for insert with check (br.is_hci());

alter table br.audit_log enable row level security;
create policy see on br.audit_log for select using ((hospital_id is not null and br.visible(hospital_id)) or br.is_hci() or actor_user = br.actor_user());
create policy add on br.audit_log for insert with check (
  actor_kind = br.actor_kind() and (hospital_id is null or br.visible(hospital_id))
  and (actor_kind <> 'user' or actor_user = br.actor_user()) and (actor_kind <> 'agent' or actor_agent = br.actor_agent()));

/* ---------------- what the service role may do ---------------- */
grant usage on schema br to br_app;
grant select, insert, update, delete on br.hospitals, br.users, br.memberships, br.sessions, br.agents, br.enrollment_codes,
  br.devices, br.device_reach, br.device_state, br.settings, br.alerts, br.live_locks, br.commands to br_app;
grant select, insert on br.app_releases to br_app;
grant select, insert on br.audit_log to br_app;              -- no update, no delete
grant usage on sequence br.audit_log_id_seq to br_app;
grant select on br.schema_migrations to br_app;
grant execute on all functions in schema br to br_app;

insert into br.schema_migrations (version) values ('001_init');
