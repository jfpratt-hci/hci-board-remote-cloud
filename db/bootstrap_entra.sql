-- Azure, no passwords. Run once by the server's Microsoft Entra admin (deploy/azure-setup.sh does it):
--   psql "host=<server>.postgres.database.azure.com dbname=postgres user=<admin email> sslmode=require" \
--        -v owner_oid=<object id of id-br-owner> -v app_oid=<object id of id-br-app> -f db/bootstrap_entra.sql
-- Makes the same two roles as bootstrap.sql, but each can only be signed in to by its Azure identity:
-- br_owner (creates the schema, runs migrations) and br_app (the running service: not the owner and
-- no BYPASSRLS, so every query goes through row level security).
select * from pgaadauth_create_principal_with_oid('br_owner', :'owner_oid', 'service', false, false)
  where not exists (select 1 from pg_roles where rolname = 'br_owner');
select * from pgaadauth_create_principal_with_oid('br_app', :'app_oid', 'service', false, false)
  where not exists (select 1 from pg_roles where rolname = 'br_app');
select 'create database boardremote' where not exists (select 1 from pg_database where datname = 'boardremote') \gexec
grant create, connect on database boardremote to br_owner;
grant connect on database boardremote to br_app;
-- must show f, f: neither role may bypass row level security or be a superuser
select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('br_owner', 'br_app') order by 1;
