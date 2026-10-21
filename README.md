# HCI ONE Board Remote Cloud 0.2.0

One web view of every hospital's boards, built from the Board Remote PCs at each site. Microsoft sign in, roles per hospital, the HCI location lock, live commands, and an audit log that cannot be edited.

## What lives where

| | Cloud (this) | Board Remote PC |
|---|---|---|
| Boards: identity (MAC or serial), room, unit, closet, type, model | yes | yes |
| Health: state, headline, last heartbeat | yes | yes |
| People, roles, PCs, audit log | yes | |
| Screens, snapshots, screen text, device logs (can show PHI) | **never** | yes |

Each PC connects **out** on 443 (WebSocket at `/agent`). Nothing is opened at the hospital.

## Rules the database enforces

- Row level security on every table. The service connects as `br_app`, which is not the owner and has no BYPASSRLS. A hospital's people only ever get that hospital's rows.
- The HCI location lock is a trigger: once locked, room, unit and closet change only through HCI, from anywhere (web, any PC).
- Room, unit and closet sync both ways, most recent change wins, per field.
- The audit log is append only (trigger plus grants). Every change writes its row in the same transaction.
- Commands are a fixed list: restart, reboot, wake, clock, storage, reconnect, keeper, door sign LED, health check, morning audit. Nothing else, no shell.

## Roles

| Role | Sees | Can |
|---|---|---|
| HCI admin | every hospital | everything, adds HCI staff |
| HCI tech | every hospital | everything, locks and unlocks locations |
| Hospital IT | its hospital | everything there except change a locked location |
| Dealer | its hospitals | same as Hospital IT, signs in with its own company's Microsoft |

## Run it here

```
service postgresql start
psql -v owner_pw=... -v app_pw=... -f db/bootstrap.sql     # once, as a superuser, in the target database
DATABASE_URL_OWNER=postgres://br_owner:...@host/db npm run migrate
DATABASE_URL=postgres://br_app:...@host/db PUBLIC_URL=http://localhost:8080 SESSION_SECRET=... BR_DEV_LOGIN=1 npm start
```

`BR_DEV_LOGIN=1` allows `/auth/dev?email=...` from this computer only, and the server refuses to start with it on an https address.

Tests: `npm test` (126: token sign in, database, sign in, agent link, concurrency, updates), `npm run e2e` (30, one cloud and two real Board Remote copies with a fake adb) and `npm run e2e:update` (23).

## Settings

| Setting | |
|---|---|
| `DATABASE_URL` | as `br_app` |
| `DATABASE_URL_OWNER` | as `br_owner`; if set, migrations run at start |
| `PUBLIC_URL` | `https://remote.hci-tv.com` |
| `SESSION_SECRET` | 32+ random bytes |
| `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | the app registration |
| `HCI_TENANT_ID` | HCI's Microsoft tenant |
| `BR_BOOTSTRAP_ADMIN` | the first HCI admin's email, used once |

## Azure (created 20 Oct 2026; wiring: `deploy/azure-setup.sh` in Cloud Shell)

1. **Entra app registration: done 20 Oct 2026.** "HCI ONE Board Remote Cloud" in HCI's tenant (e55dab1c-8b8f-4c0b-bb05-f0fb52f04e62), client ID 3410a8c2-8e42-4156-835e-66ce79e7da6d, multiple organizations limited to allowed tenants (hci-tv.com so far), redirect `https://remote.hci-tv.com/auth/callback`. Non secret settings are in `deploy.env`. The client secret is made at step 3 straight into Key Vault. Each new hospital: add its tenant to the allowed list, and its admin grants consent once (the app has no verified publisher yet).
2. **Two managed identities**, id-br-owner (migrations) and id-br-app (the service), then **Azure Database for PostgreSQL, Flexible Server** with Microsoft Entra sign in only (no passwords), TLS required, backups 35 days, firewall allows Azure services only (Container Apps uses 50+ shared outbound addresses), sign in still needs the app identity. Run `db/bootstrap_entra.sql` once from Cloud Shell; it binds the roles br_owner and br_app to the two identities. The service then signs in with tokens (`DB_IDENTITY_APP`, `DB_IDENTITY_OWNER`, see `src/aztoken.js`).
3. **Key Vault** for the session secret and the Microsoft client secret (there are no database passwords).
4. **Container Apps**: this `Dockerfile`, ingress 443 with WebSockets on, exactly 1 replica (min 1, max 1: PC connections are held in memory, so a second replica needs Postgres LISTEN/NOTIFY first), secrets from Key Vault, health probe `/healthz`.
5. **DNS: done 21 Oct 2026.** GoDaddy CNAME `remote` to the app, TXT `asuid.remote` for verification, Azure managed certificate (renews itself). The old relay address moved off this name.

6. **Release signing key: done 21 Oct 2026.** ed25519, private key only in Key Vault (`br-release-signing-key`), readable by the GitHub build identity alone; its public half is the app setting `BR_RELEASE_PUBKEY` and ships inside every Board Remote install.

## Board Remote for Windows and its updates

This repo also holds Board Remote itself (`board-remote/`) and its Windows installer (`installer/`).

- **The Windows app.** `HCI-ONE-Board-Remote-Setup-<version>.exe` installs Node, the program, scrcpy and adb, and a Windows service (WinSW running `service/supervisor.js`). Data lives in `C:\ProgramData\HCI ONE\Board Remote`, locked to SYSTEM and Administrators. Running it on a PC with a folder install stops the old one and brings its boards and settings over.
- **Build.** Every push to `main` that touches `board-remote/`, `installer/` or the packager runs `.github/workflows/windows.yml`: it signs the update package with the key from Key Vault (`dist/board-remote-<v>.zip` and `.sig`), checks the signature, starts Board Remote under the service on a Windows runner, builds the installer, and publishes a GitHub release `board-remote-v<v>` with all three files. Not code signed yet; `CODESIGN_ENABLED` turns on the step once HCI has a certificate.
- **Releasing.** On the cloud's **Updates** page an HCI admin uploads the .zip and .sig (the cloud checks HCI's signature), then **Send to pilot**, **Send to everyone**, or **Pause**.
- **How a PC updates.** Every 15 minutes it asks `GET /api/agent/update` with its own credential. Hospitals on automatic install between 2 and 5 am; hospitals set to approve wait for **Approve** on the PCs page (**Install now** skips the window). The PC checks the sha256 and HCI's signature itself, installs beside the running version, requires it to answer `/api/ping` with its own version and stay up, and otherwise goes straight back, marks the version bad and reports it. Every step lands in the audit log.
- **Per hospital.** Updates: Automatic overnight or Wait for approval; Pilot gets new versions first. Only HCI changes these.
- Tests: `npm test` (126) and `npm run e2e:update` (23: install, update, a broken version rolling back, restart after a crash, wrong key and tampered packages refused).

Live screens through the cloud (streamed from the PC on demand, never stored) are the next phase.
