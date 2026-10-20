-- Inviting someone: find or create their user row and return only its id. It runs as the owner
-- because the person being invited is not visible to the inviter yet (they belong to no hospital
-- the inviter can see). Whether they may then be given a role is still decided by the memberships
-- policy (br.can_grant), so this function grants nothing by itself.
set search_path = br, pg_catalog;

create function br.invite_user(p_email text, p_name text, p_is_hci boolean, p_tid text) returns uuid
language plpgsql security definer set search_path = br, pg_catalog as $$
declare uid uuid;
begin
  if br.actor_kind() not in ('user', 'system') then raise exception 'Not allowed' using errcode = 'insufficient_privilege'; end if;
  if p_is_hci and not br.is_hci('hci_admin') then raise exception 'Only an HCI admin can invite HCI staff' using errcode = 'insufficient_privilege'; end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Not an email address' using errcode = 'check_violation'; end if;
  select id into uid from br.users where lower(email) = lower(p_email);
  if uid is null then
    insert into br.users (email, name, is_hci, entra_tid) values (lower(p_email), coalesce(p_name, ''), p_is_hci, nullif(lower(p_tid), '')) returning id into uid;
  end if;
  return uid;
end $$;
revoke all on function br.invite_user(text, text, boolean, text) from public;
grant execute on function br.invite_user(text, text, boolean, text) to br_app;

insert into br.schema_migrations (version) values ('002_invite');
