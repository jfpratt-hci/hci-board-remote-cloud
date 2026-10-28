# Monitoring a hospital's backend: cAdvisor and Prometheus

A production backend that runs only its Docker services needs two things added, in this order. Neither changes the deployment's own `docker-compose.yml` or restarts its services.

| Step | Script (Windows / Linux) | Gives | Host port |
|---|---|---|---|
| 1 | `add-cadvisor.ps1` / `add-cadvisor.sh` | Containers page: CPU, memory, network, disk per container; container alerts (stopped, memory limit, CPU throttling, restart loop, unusual) | 8098 |
| 2 | `add-prometheus.ps1` / `add-prometheus.sh` | Service alerts from the services' own numbers: down, error rate, slow, Java memory, database pool, error logs, Kong | 9090 |

Then on a Board Remote PC (2.2+) joined to the hospital: Remote, Backend containers, cAdvisor address `http://<host>:8098`, Prometheus address `http://<host>:9090`, a name, Add host.

**Check first on one server**: `curl http://<host>:<service port>/actuator/prometheus` on one HCI service. If it answers `# HELP ...`, step 2 finds every service on its own. If it does not, the services need `management.endpoints.web.exposure.include=health,prometheus` (and `micrometer-registry-prometheus`) in their Spring configuration first; until then Prometheus watches only Kong (if its Prometheus plugin is on) and cAdvisor.

**Room it needs**: cAdvisor about 170 MB of memory and a few % of a core; Prometheus up to 768 MB (its limit) and up to 2 GB of disk (15 days kept).

## Prometheus (step 2)

`add-prometheus` finds the running compose project, starts only `prometheus` from `docker-compose.prometheus.yml` (`prom/prometheus` v2.55.1, 15 days, at most 2 GB), joins the deployment's networks, and asks every service **from inside Prometheus's container** for `/actuator/prometheus` or `/metrics`. Only the ones that answer go into `hci-monitoring/prometheus.yml` (job = compose service name, which is what HCI's rules group by), so nothing shows as down that never had metrics. Services added later: run it again with `-Rescan` / `--rescan`. Already has Prometheus (like QA, 192.168.1.20): it says so and changes nothing; just add its address in Board Remote.

No alert rules are installed on Prometheus: Board Remote runs HCI's rules against it read-only, so they are the same at every site and update with Board Remote.

# cAdvisor (step 1)

HCI ONE Cloud's **Containers** page shows each container of a hospital's backend (MediaCare and its services): CPU, memory, network, disk, what stopped and when. The numbers come from [cAdvisor](https://github.com/google/cadvisor) on the Docker host. The Board Remote PC at the hospital reads cAdvisor on the LAN once a minute and sends them up its own outbound link. The cloud never connects into the hospital.

```
Docker host (MediaCare)            Board Remote PC (2.2+)                 HCI ONE Cloud (0.4+)
  cAdvisor :8098  <-- LAN, GET --   containers.js  -- wss, 443, out -->   Containers page, alerts
```

Only resource numbers leave the hospital: container name, image, start time, CPU, memory, network, disk. Never labels, environment, processes or logs.

## Add cAdvisor to an existing deployment

Copy this folder to the Docker host and run, on Windows (Docker Desktop):

```powershell
powershell -ExecutionPolicy Bypass -File add-cadvisor.ps1
```

or on Linux:

```bash
sudo ./add-cadvisor.sh
```

It finds the running compose project (for example `hci-mediacare` in `D:\hci-mediacare`), puts `docker-compose.cadvisor.yml` next to its `docker-compose.yml` without editing that file, and starts **only** the `cadvisor` service (`up -d --no-deps cadvisor`), so nothing else in the deployment restarts. Then it waits for cAdvisor to answer and prints the address to add in Board Remote.

- Already has cAdvisor (like 192.168.1.20): it says so and changes nothing. `-Force` / `--force` recreates it from this kit.
- No compose project: it uses `docker run` with the same settings.
- Options: `-ComposeDir D:\hci-mediacare` / `--dir`, `-Port 8098` / `--port`, `-Bind 192.168.1.20` / `--bind`, `-Version 0.60.6` / `--version`.

### Ports

cAdvisor takes **one host port, 8098** by default, and listens on 8098 inside its container too (`--port=8098`), the same as the existing sites, whose Prometheus scrapes `cadvisor:8098`. Nothing uses 8080. If 8098 is taken, the script stops and suggests a free port; run it again with `-Port <that port>` and add that address in Board Remote.

### Security

cAdvisor and Prometheus have no sign in. Bind them to the LAN address (`-Bind`) and allow their ports only from the Board Remote PCs (Windows Firewall or the network). The kit runs it with `--store_container_labels=false` and turns off the metrics nobody uses.

### Keeping it in the deployment

`restart: unless-stopped` brings it back after a reboot. When the deployment is next brought up with compose, add the override so cAdvisor stays part of it:

```
docker compose -f docker-compose.yml -f docker-compose.cadvisor.yml up -d
```

## Then, in Board Remote

On a Board Remote PC joined to the hospital in HCI ONE Cloud: **Remote, Backend containers**, enter `http://<host>:8098` and a name ("MediaCare server"), **Add host**. Board Remote checks it really is cAdvisor first. Containers show on the Containers page within a minute.

## Alerts

From cAdvisor: a container stopped, cAdvisor not answering, memory near or at its limit, CPU held back by its limit, a restart loop, and anything far from the container's own usual for this time of day. Add the host's Prometheus address too (Board Remote, Backend containers, for example `http://192.168.1.20:9090`) and HCI's service rules run against it read-only: service down, error rate, slow responses, Java memory, database connections, error logs, Kong. All show on the Containers page and the dashboard, and close on their own.
