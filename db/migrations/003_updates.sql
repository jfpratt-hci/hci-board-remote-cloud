-- Board Remote program updates.
-- A release is one signed Board Remote package. HCI uploads it as a draft, sends it to the pilot
-- hospitals, then to everyone; it can be paused at any time. Each hospital either installs
-- automatically overnight or waits for someone to approve each PC. The package is signed by HCI's
-- release key and every PC checks that signature itself, so even this database cannot push code
-- that HCI did not sign.
set search_path = br, pg_catalog;

create table br.br_releases (
  id           uuid primary key default gen_random_uuid(),
  version      text not null unique check (version ~ '^\d+\.\d+\.\d+$'),
  status       text not null default 'draft' check (status in ('draft', 'pilot', 'everyone', 'paused')),
  notes        text not null default '' check (length(notes) <= 2000),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  signature    text not null,                      -- ed25519 over 'HCI-ONE-BOARD-REMOTE|<version>|<sha256>', base64
  size         integer not null check (size between 1 and 104857600),
  package      bytea not null,
  created_by   uuid references br.users(id),
  created_at   timestamptz not null default now(),
  status_at    timestamptz not null default now()
);

alter table br.hospitals
  add column update_mode text not null default 'auto' check (update_mode in ('auto', 'approve')),
  add column update_ring text not null default 'normal' check (update_ring in ('pilot', 'normal'));

alter table br.agents
  add column update_state    text not null default '' check (update_state in ('', 'waiting', 'scheduled', 'downloading', 'installing', 'done', 'failed', 'rolled_back')),
  add column update_version  text not null default '',
  add column update_detail   text not null default '',
  add column update_at       timestamptz,
  add column approved_release uuid references br.br_releases(id) on delete set null,
  add column approved_by     uuid references br.users(id),
  add column service         boolean not null default false;

alter table br.br_releases enable row level security;
-- HCI sees every release. A hospital's people and its PCs see only releases that have left draft.
create policy see on br.br_releases for select using (br.is_hci() or status <> 'draft');
create policy add on br.br_releases for insert with check (br.is_hci('hci_admin'));
create policy edit on br.br_releases for update using (br.is_hci('hci_admin')) with check (br.is_hci('hci_admin'));

grant select, insert, update on br.br_releases to br_app;

-- Only HCI may change how a hospital updates, and the hospitals update policy already says so.
-- Which release a PC should have: the newest one cleared for its hospital's ring, never paused.
create function br.target_release(h uuid) returns uuid language sql stable security definer set search_path = br, pg_catalog as $$
  select r.id from br.br_releases r, br.hospitals x
  where x.id = h and (r.status = 'everyone' or (r.status = 'pilot' and x.update_ring = 'pilot'))
  order by string_to_array(r.version, '.')::int[] desc limit 1
$$;
revoke all on function br.target_release(uuid) from public;
grant execute on function br.target_release(uuid) to br_app;

insert into br.schema_migrations (version) values ('003_updates');
