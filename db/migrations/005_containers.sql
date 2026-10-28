-- Backend containers, from cAdvisor (github.com/google/cadvisor) on the hospital's Docker hosts.
-- The cloud never reaches into a hospital: the Board Remote PC there reads cAdvisor on the LAN and
-- sends what it read up its own outbound link, once a minute. Only resource numbers travel: container
-- name, image, CPU, memory, network, disk. Never labels, environment, logs or anything inside.
-- 1. container_hosts: one row per Docker host, matched by cAdvisor's machine id, so two PCs that
--    both read the same host show it once.
-- 2. containers: what runs on each host now, and since when; a container that stops opens an alert.
-- 3. container_samples: one row per container per minute (name '' is the whole host), kept 8 days.
set search_path = br, pg_catalog;

create table br.container_hosts (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  agent_id     uuid references br.agents(id) on delete set null,   -- the PC that reported it last
  machine      text not null check (length(machine) between 1 and 120),
  address      text not null default '' check (length(address) <= 200),
  name         text not null default '' check (length(name) <= 80),
  cores        int not null default 0,
  memory       bigint not null default 0,
  cadvisor     text not null default '',
  ok           boolean not null default false,
  error        text not null default '',
  last_ok      timestamptz,
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (hospital_id, machine)
);

create table br.containers (
  host_id      uuid not null references br.container_hosts(id) on delete cascade,
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  name         text not null check (length(name) between 1 and 200),
  image        text not null default '',
  started_at   timestamptz,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  running      boolean not null default true,
  primary key (host_id, name)
);

create table br.container_samples (
  host_id      uuid not null references br.container_hosts(id) on delete cascade,
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  at           timestamptz not null,
  name         text not null,            -- '' is the whole host
  cpu          real,                     -- cores in use
  mem          bigint,                   -- working set, bytes
  mem_limit    bigint,                   -- 0 when there is none
  rx           real,                     -- network bytes per second
  tx           real,
  rd           real,                     -- disk bytes per second
  wr           real,
  fs           bigint,                   -- bytes on its filesystems
  primary key (host_id, name, at)
);
create index container_samples_time on br.container_samples (host_id, at);

alter table br.alerts add column container_host_id uuid references br.container_hosts(id) on delete set null;
alter table br.alerts add column container text;
create index alerts_container on br.alerts (container_host_id, container) where resolved_at is null;

do $$ declare t text; begin
  foreach t in array array['container_hosts', 'containers', 'container_samples'] loop
    execute format('alter table br.%I enable row level security', t);
    execute format('create policy hosp on br.%I for all using (br.visible(hospital_id)) with check (br.visible(hospital_id))', t);
  end loop;
end $$;
grant select, insert, update, delete on br.container_hosts, br.containers, br.container_samples to br_app;

insert into br.schema_migrations (version) values ('005_containers');
