-- Run once by the server admin (in Azure: the Flexible Server admin login), then never again.
-- Creates the two logins the service uses. Passwords come from psql variables:
--   psql "<admin connection>" -v owner_pw='...' -v app_pw='...' -f db/bootstrap.sql
-- br_owner owns the schema and runs migrations. br_app is what the running service uses: it is not
-- the owner, has no BYPASSRLS, and so every query it makes goes through row level security.
select format('create role br_owner login password %L', :'owner_pw') where not exists (select 1 from pg_roles where rolname = 'br_owner') \gexec
select format('create role br_app login password %L nobypassrls', :'app_pw') where not exists (select 1 from pg_roles where rolname = 'br_app') \gexec
grant br_owner to current_user;
select format('grant create, connect on database %I to br_owner', current_database()) \gexec
select format('grant connect on database %I to br_app', current_database()) \gexec
