-- Container health: what makes a backend misbehave before it falls over, and the services' own view.
-- 1. More from cAdvisor per container per minute: CPU throttling (the share of time the CPU limit held
--    it back), pressure (PSI: the share of time work waited for CPU, memory or disk) and how often it
--    hit its memory limit.
-- 2. container_events: restarts, memory limit hits, stops and starts, for the timeline and for alerts
--    such as a restart loop.
-- 3. Service alerts: HCI's rules, which Board Remote runs read-only against the site's own Prometheus
--    (service down, error rate, slow responses, Java memory, database pool, Kong), plus any alert that
--    Prometheus itself fires. Only the rule, the service name and a number travel; never URLs or labels.
set search_path = br, pg_catalog;

alter table br.container_samples
  add column throttle  real,     -- 0..1 of CPU periods held back by the limit
  add column psi_cpu   real,     -- 0..100, some pressure, 60 s average
  add column psi_mem   real,
  add column psi_io    real,
  add column mem_hits  int;      -- times it reached its memory limit this minute

alter table br.containers
  add column restarts     int not null default 0,
  add column restarted_at timestamptz;

alter table br.container_hosts
  add column prometheus      text not null default '' check (length(prometheus) <= 200),
  add column prom_ok         boolean,
  add column prom_error      text not null default '',
  add column prom_last_ok    timestamptz,
  add column prom_rules      int not null default 0,
  add column checked_unusual timestamptz;

create table br.container_events (
  id           bigserial primary key,
  host_id      uuid not null references br.container_hosts(id) on delete cascade,
  hospital_id  uuid not null references br.hospitals(id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('restart', 'limit', 'stopped', 'started')),
  at           timestamptz not null default now(),
  detail       text not null default ''
);
create index container_events_host on br.container_events (host_id, at);

-- one open alert per host and key: a container alert's key is its kind, a service alert's is rule + service
alter table br.alerts add column alert_key text;
create index alerts_key on br.alerts (container_host_id, alert_key) where resolved_at is null;

alter table br.container_events enable row level security;
create policy hosp on br.container_events for all using (br.visible(hospital_id)) with check (br.visible(hospital_id));
grant select, insert, delete on br.container_events to br_app;
grant usage on sequence br.container_events_id_seq to br_app;

insert into br.schema_migrations (version) values ('006_container_health');
