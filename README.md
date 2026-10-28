# HCI ONE Board Remote Cloud 0.4.0

One web view of every hospital's boards, built from the Board Remote PCs at each site. Microsoft sign in, roles per hospital, the HCI location lock, live commands, and an audit log that cannot be edited.

## What lives where

| | Cloud (this) | Board Remote PC |
|---|---|---|
| Boards: identity (MAC or serial), room, unit, closet, type, model | yes | yes |
| Health: state, headline, last heartbeat | yes | yes |
| People, roles, PCs, audit log | yes | |
| Backend containers (cAdvisor): name, image, CPU, memory, network, disk | yes | yes |
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

Tests: `npm test` (195: token sign in, database, sign in, agent link, concurrency, updates, reports, containers), `npm run e2e` (30, one cloud and two real Board Remote copies with a fake adb) and `npm run e2e:update` (23).

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

## Dashboard and reports (0.3.0)
- **Dashboard** (the first page): boards up now, offline now, uptime, open alerts and PCs connected; downtime by day; worst units or hospitals; the boards with the most downtime; open alerts with Acknowledge.
- **Reports**: Uptime, Alerts and response, Inventory, Support activity. Each downloads as CSV, and Print or save PDF gives a one hospital report to send.
- **Filters** for both: hospital (HCI sees All hospitals), device type, floor, unit, closet, Board Remote PC, and a date range.
- **Where the numbers come from**: `br.state_log`, written by a database trigger whenever a board's state changes. Uptime = up / (up + offline); time nobody could watch a board (its PC offline, or paused) does not count either way. History starts when 0.3.0 goes live.
- **Alerts**: a board going offline opens one and coming back closes it (same trigger). A PC gone more than 2 minutes opens one, closed when it reconnects. Acknowledging is in the audit log.
- **Floor**: worked out from the room number (401 is floor 4, 1205 is floor 12), or typed on the board in the cloud. Cloud only; Board Remote PCs keep room, unit and closet.

## Backend containers (0.4.0, Board Remote 2.2)
- **Containers** page: one hospital's Docker hosts (MediaCare and its services), from [cAdvisor](https://github.com/google/cadvisor), over 1 h, 6 h, 24 h, 7 days or a custom stretch of the 8 days kept (Custom: From and To, Today, Yesterday, Last 2 days; or drag across a chart or the heatmap to zoom in). A custom stretch also sets what Sizing and headroom is worked out from:
  - **Where the host goes**: host memory and CPU right now, cut into the containers using it.
  - **Focus panel**: CPU, memory (with its limit), network and disk for the whole host or the one container picked; in and out mirrored about a centre line; restarts and stops marked, memory limit hits as a strip along the top.
  - **Every container over time**: a heatmap, a row per container and a cell per minute, for CPU, memory, network, disk or CPU throttling.
  - **Sizing and headroom**, from each container's last 7 days: memory limits too tight, missing or far too generous, with a suggested limit (30% over the peak); CPU limits that hold a container back; memory growing steadily toward its limit (or the host's memory) with the days left; filesystems that keep growing; and whether the limits add up to more than the host has.
  - a table of every container with its image, state and uptime: All, Needs a look or Stopped, sorted by any column.
  - **Recent events** in the stretch shown, paged by the server (`GET /api/containers/events`, 25 rows a page, newest first, by cursor): the same container and kind again within 10 minutes is one row with a count, filtered by kind or by the container looked at. The charts' markers get the events counted per minute instead.
  - Long lists (problems, containers, the heatmap, sizing) show a page at a time with Show more, and problems narrow by kind.
- **How it gets here**: the Board Remote PC at the hospital reads cAdvisor on the LAN once a minute (Remote, Backend containers, add `http://<host>:8098`) and sends the numbers up its link. The cloud never connects into the hospital. Labels, environment, processes and logs are never read.
- **Alerts**, each closing on its own once the cause is gone:
  - from cAdvisor: a container stopped; cAdvisor not answering for 3 minutes; at 90% of its memory limit for 5 minutes, or it hit the limit; held back by its CPU limit a quarter of the time for 10 minutes; restarted twice in 30 minutes;
  - unusual for this time of day, against its own history of at least 3 earlier days: much more memory or CPU than usual, or network traffic stopping;
  - from the services (when the host's Prometheus address is added in Board Remote): HCI's rules in `board-remote/prom-rules.js`, run read-only against the site's Prometheus: service down, 5xx error rate, slow responses, Java memory, garbage collection, waiting for database connections, error logs far above last week, Kong errors and Kong's database. Any alert the site's Prometheus itself fires is passed on too (name, severity and service only). Nothing on the site's Prometheus is changed.
- **Timeline**: restarts, stops, starts and memory limit hits per container (`br.container_events`).
- **Kept** 8 days, one sample per container per minute, in `br.container_samples` behind row level security like everything else.
- **Adding monitoring to a deployment** that runs only its services (production today): `deploy/monitoring/`. Step 1 `add-cadvisor` (host port 8098), step 2 `add-prometheus` (9090, finds the services that publish metrics and writes its config from them). Each starts only its own container next to the existing compose project, without touching the rest. `.ps1` for Windows Docker Desktop, `.sh` for Linux. See `deploy/monitoring/README.md`.

- **Upgrading a database from 0.3**: migration `004_reports` never recorded itself, so run this once before deploying 0.4.0, or the migrator tries 004 again and stops on "state_log already exists":
  `insert into br.schema_migrations (version) values ('004_reports') on conflict do nothing;`
  From 0.4.0 the migrator records every migration it runs.

## Board Remote for Windows and its updates

This repo also holds Board Remote itself (`board-remote/`) and its Windows installer (`installer/`).

- **The Windows app.** `HCI-ONE-Board-Remote-Setup-<version>.exe` installs Node, the program, scrcpy and adb, and a Windows service (WinSW running `service/supervisor.js`). Data lives in `C:\ProgramData\HCI ONE\Board Remote`, locked to SYSTEM and Administrators. Running it on a PC with a folder install stops the old one and brings its boards and settings over.
- **Build.** Every push to `main` that touches `board-remote/`, `installer/` or the packager runs `.github/workflows/windows.yml`: it signs the update package with the key from Key Vault (`dist/board-remote-<v>.zip` and `.sig`), checks the signature, starts Board Remote under the service on a Windows runner, builds the installer, and publishes a GitHub release `board-remote-v<v>` with all three files. Not code signed yet; `CODESIGN_ENABLED` turns on the step once HCI has a certificate.
- **Releasing.** On the cloud's **Updates** page an HCI admin uploads the .zip and .sig (the cloud checks HCI's signature), then **Send to pilot**, **Send to everyone**, or **Pause**.
- **How a PC updates.** Every 15 minutes it asks `GET /api/agent/update` with its own credential. Hospitals on automatic install between 2 and 5 am; hospitals set to approve wait for **Approve** on the PCs page (**Install now** skips the window). The PC checks the sha256 and HCI's signature itself, installs beside the running version, requires it to answer `/api/ping` with its own version and stay up, and otherwise goes straight back, marks the version bad and reports it. Every step lands in the audit log.
- **Per hospital.** Updates: Automatic overnight or Wait for approval; Pilot gets new versions first. Only HCI changes these.
- Tests: `npm test` (126) and `npm run e2e:update` (23: install, update, a broken version rolling back, restart after a crash, wrong key and tampered packages refused).

Live screens through the cloud (streamed from the PC on demand, never stored) are the next phase.
