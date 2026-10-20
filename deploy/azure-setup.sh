#!/usr/bin/env bash
# HCI ONE Board Remote Cloud: one time Azure wiring. Run in Azure Cloud Shell (Bash) as the
# subscription owner who is also the database's Entra admin. Safe to run again.
# No secret value is printed: the session key and the Microsoft client secret go straight into Key Vault.
set -euo pipefail
SUB=f39eaa0e-c370-4bc6-a6c1-0e33978cb893
RG=rg-board-remote-cloud
LOC=centralus
KV=hcione-boardremote-kv
ACR=hcioneboardremote
APP=hcione-boardremote
PG=hcione-boardremote-db
ENTRA_APP=3410a8c2-8e42-4156-835e-66ce79e7da6d
TENANT=e55dab1c-8b8f-4c0b-bb05-f0fb52f04e62
REPO=jfpratt-hci/hci-board-remote-cloud
ADMIN=johnpratt@hcic.com
az account set -s "$SUB"
az config set extension.use_dynamic_install=yes_without_prompt -o none 2>/dev/null || true
q() { az "$@" -o tsv; }
ME=$(q ad signed-in-user show --query id)
KVID=$(q keyvault show -n $KV -g $RG --query id)
ACRID=$(q acr show -n $ACR -g $RG --query id)
APPRES=$(q containerapp show -n $APP -g $RG --query id)
OWNER_RID=$(q identity show -n id-br-owner -g $RG --query id)
OWNER_CID=$(q identity show -n id-br-owner -g $RG --query clientId)
OWNER_OID=$(q identity show -n id-br-owner -g $RG --query principalId)
APP_RID=$(q identity show -n id-br-app -g $RG --query id)
APP_CID=$(q identity show -n id-br-app -g $RG --query clientId)
APP_OID=$(q identity show -n id-br-app -g $RG --query principalId)
role() { az role assignment create --assignee-object-id "$1" --assignee-principal-type "$2" --role "$3" --scope "$4" -o none 2>/dev/null || true; }
retry() { for i in 1 2 3 4 5 6 7 8 9 10; do "$@" && return 0; echo "  waiting for access to take effect..."; sleep 15; done; return 1; }

echo "1/7 Access: you manage vault secrets; the app reads them and pulls images"
role "$ME" User "Key Vault Secrets Officer" "$KVID"
role "$APP_OID" ServicePrincipal "Key Vault Secrets User" "$KVID"
role "$APP_OID" ServicePrincipal AcrPull "$ACRID"

echo "2/7 Secrets into Key Vault (values are never shown)"
if ! az keyvault secret show --vault-name $KV -n session-secret -o none 2>/dev/null; then
  retry az keyvault secret set --vault-name $KV -n session-secret --value "$(openssl rand -hex 32)" -o none
fi
if ! az keyvault secret show --vault-name $KV -n entra-client-secret -o none 2>/dev/null; then
  CS=$(az ad app credential reset --id $ENTRA_APP --append --display-name board-remote-cloud --years 2 --query password -o tsv 2>/dev/null)
  retry az keyvault secret set --vault-name $KV -n entra-client-secret --value "$CS" -o none
  unset CS
fi

echo "3/7 GitHub deploy identity (trusted for $REPO main only, no stored secret)"
az identity show -n id-br-deploy -g $RG -o none 2>/dev/null || az identity create -n id-br-deploy -g $RG -l $LOC -o none
DEP_CID=$(q identity show -n id-br-deploy -g $RG --query clientId)
DEP_OID=$(q identity show -n id-br-deploy -g $RG --query principalId)
az identity federated-credential show --name github-main --identity-name id-br-deploy -g $RG -o none 2>/dev/null || \
  az identity federated-credential create --name github-main --identity-name id-br-deploy -g $RG \
    --issuer https://token.actions.githubusercontent.com --subject "repo:$REPO:ref:refs/heads/main" --audiences api://AzureADTokenExchange -o none
role "$DEP_OID" ServicePrincipal AcrPush "$ACRID"
role "$DEP_OID" ServicePrincipal Contributor "$APPRES"
role "$DEP_OID" ServicePrincipal Reader "$(q group show -n $RG --query id)"

echo "4/7 Container app: identities, registry, secrets from the vault"
az containerapp identity assign -n $APP -g $RG --user-assigned "$OWNER_RID" "$APP_RID" -o none
retry az containerapp registry set -n $APP -g $RG --server $ACR.azurecr.io --identity "$APP_RID" -o none
retry az containerapp secret set -n $APP -g $RG --secrets \
  "session-secret=keyvaultref:https://$KV.vault.azure.net/secrets/session-secret,identityref:$APP_RID" \
  "entra-client-secret=keyvaultref:https://$KV.vault.azure.net/secrets/entra-client-secret,identityref:$APP_RID" -o none

echo "5/7 Container app settings: port 8080, exactly one copy, Microsoft sign in"
FQDN=$(q containerapp show -n $APP -g $RG --query properties.configuration.ingress.fqdn)
az ad app update --id $ENTRA_APP --web-redirect-uris "https://boardremote.hci-tv.com/auth/callback" "https://$FQDN/auth/callback"
az containerapp ingress update -n $APP -g $RG --target-port 8080 --transport auto -o none
DBH=$PG.postgres.database.azure.com
az containerapp update -n $APP -g $RG --min-replicas 1 --max-replicas 1 --cpu 0.5 --memory 1Gi -o none --set-env-vars \
  "PUBLIC_URL=https://$FQDN" "ENTRA_CLIENT_ID=$ENTRA_APP" "HCI_TENANT_ID=$TENANT" "BR_BOOTSTRAP_ADMIN=$ADMIN" PORT=8080 \
  "DATABASE_URL=postgres://br_app@$DBH:5432/boardremote" "DATABASE_URL_OWNER=postgres://br_owner@$DBH:5432/boardremote" \
  "DB_IDENTITY_APP=$APP_CID" "DB_IDENTITY_OWNER=$OWNER_CID" \
  SESSION_SECRET=secretref:session-secret ENTRA_CLIENT_SECRET=secretref:entra-client-secret

echo "6/7 Database: open only to the app (and this shell for a minute), then make the two roles"
i=0; for ip in $(q containerapp show -n $APP -g $RG --query "properties.outboundIpAddresses"); do
  i=$((i+1)); az postgres flexible-server firewall-rule create -g $RG --server-name $PG --name "app-$i" --start-ip-address "$ip" --end-ip-address "$ip" -o none
done
MYIP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create -g $RG --server-name $PG --name cloudshell-temp --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
export PGPASSWORD=$(q account get-access-token --resource-type oss-rdbms --query accessToken)
cat > /tmp/bootstrap_entra.sql <<'SQL'
select * from pgaadauth_create_principal_with_oid('br_owner', :'owner_oid', 'service', false, false)
  where not exists (select 1 from pg_roles where rolname = 'br_owner');
select * from pgaadauth_create_principal_with_oid('br_app', :'app_oid', 'service', false, false)
  where not exists (select 1 from pg_roles where rolname = 'br_app');
select 'create database boardremote' where not exists (select 1 from pg_database where datname = 'boardremote') \gexec
grant create, connect on database boardremote to br_owner;
grant connect on database boardremote to br_app;
select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('br_owner', 'br_app') order by 1;
SQL
psql "host=$DBH dbname=postgres user=$ADMIN sslmode=require" -v ON_ERROR_STOP=1 -v owner_oid="$OWNER_OID" -v app_oid="$APP_OID" -f /tmp/bootstrap_entra.sql
unset PGPASSWORD
az postgres flexible-server firewall-rule delete -g $RG --server-name $PG --name cloudshell-temp --yes -o none

echo "7/7 Done. Set these as GitHub repo variables (not secrets; none of them is sensitive):"
echo "  AZURE_CLIENT_ID=$DEP_CID"
echo "  AZURE_TENANT_ID=$TENANT"
echo "  AZURE_SUBSCRIPTION_ID=$SUB"
echo "  ACR_NAME=$ACR"
echo "  RESOURCE_GROUP=$RG"
echo "  CONTAINER_APP=$APP"
echo "Cloud address until boardremote.hci-tv.com is set up: https://$FQDN"
