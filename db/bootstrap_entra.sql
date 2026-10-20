-- Azure, no passwords. Run once by the server's Microsoft Entra admin, in Azure Cloud Shell:
--   export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
--   psql "host=<server>.postgres.database.azure.com dbname=postgres user=<your admin email> sslmode=require" \
--        -v owner_oid=<object id of id-br-owner> -v app_oid=<object id of id-br-app> -f db/bootstrap_entra.sql
-- It makes the same two roles as bootstrap.sql, but each one can only be signed in to by its Azure
-- identity: br_owner (owns the schema, runs migrations) and br_app (the running service: not the owner,
-- no BYPASSRLS, so every query goes through row level security).
select * from pgaadauth_create_principal_with_oid('br_owner', :'owner_oid', 'service', false, false)
  where not exists (select 1 from pg_roles where rolname = 'br_owner');
select * from pgaadauth_create_principal_with_oid('br_app', :'app_oid', 'service', false, false)
  where not exists (select 1 from pg_roles where rolname = 'br_app');
alter role br_app nobypassrls;
select 'create database boardremote' where not exists (select 1 from pg_database where datname = 'boardremote') \gexec
grant br_owner to current_user;
alter database boardremote owner to br_owner;
grant connect on database boardremote to br_app;
