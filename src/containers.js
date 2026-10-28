'use strict';
/* Backend containers, read from cAdvisor on each hospital's Docker hosts by the Board Remote PC there.
   Up (from Board Remote, once a minute):
     { t: 'containers', hosts: [{ machine, address, name, ok, error, cadvisor, cores, memory,
         host: { cpu, mem, rx, tx, rd, wr, fs }, containers: [{ name, image, started, cpu, mem, memLimit, rx, tx, rd, wr, fs,
         throttle, psiCpu, psiMem, psiIo, memHits }],
         prometheus, prom: { ok, error, rules, firing: [{ rule, name, job, severity, title, since }] } }] }
   cpu is cores in use, rx/tx/rd/wr bytes per second, mem/fs bytes, throttle 0..1, psi 0..100.
   Nothing else is taken from cAdvisor; from Prometheus only the rule, the service (job) and a title.
   A host that two PCs both read is one host here (cAdvisor's machine id); the first report in a
   minute counts and the second is skipped, so samples are not doubled.
   Alerts, each closing on its own once the cause is gone:
     container_down       a container that was running is gone
     container_host_down  the host's cAdvisor has not answered for HOST_ALERT_MS
     container_memory     at 90% of its memory limit for 5 minutes, or it hit the limit
     container_cpu        held back by its CPU limit a quarter of the time for 10 minutes
     container_restarting restarted twice or more in 30 minutes
     container_unusual    far from its own usual for this time of day (memory, CPU, traffic), from
                          at least 3 earlier days of history, checked every 15 minutes
     service              an HCI rule the PC runs against the site's Prometheus, or Prometheus's own alert
     prometheus_down      the host's Prometheus has not answered for HOST_ALERT_MS (service alerts pause) */
const db = require('./db');

const KEEP_DAYS = 8;
const HOST_ALERT_MS = Number(process.env.BR_CONTAINER_HOST_ALERT_MS) || 180000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGES = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400 };
const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const int = v => { const n = num(v); return n === null ? null : Math.round(n); };
const bad = (status, message) => Object.assign(new Error(message), { status });
const GB = 1073741824, MB = 1048576;
const size = n => n >= GB ? (n / GB).toFixed(1) + ' GB' : n >= MB ? Math.round(n / MB) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : Math.round(n) + ' B';
const UNUSUAL_EVERY = 15 * 60000;
const EVENT_KINDS = ['restart', 'stopped', 'started', 'limit'];
const SIZING_MS = 5 * 60000;   // the week's summary is read again at most this often per host

// a memory limit to suggest: room over the week's peak, rounded up to 64 MB (256 MB above 1 GB)
const roundUp = n => { const s = n > GB ? 256 * MB : 64 * MB; return Math.ceil(n / s) * s; };
/* Sizing and headroom for each container, from its last 7 days:
     mem   tight (hit or came within 10% of its limit), none (no limit), spare (peak under 40% of a
           limit that could give back 256 MB or more) or ok, with a suggested limit
     cpu   tight when its CPU limit held it back a quarter of the time in 5% of minutes or more
     grow  memory that rose steadily over the last 3 days (a straight-line fit that explains most of
           the change), with the days left until its limit, or until the host's memory is used up when
           it has none; and a filesystem that keeps growing (logs, temp files)
   A week is not needed: what there is counts, and `hours` says how much that was. A stretch that ended
   in the past (live false) gets no days-left, since it is counted from today's memory. */
function sizing(rows, containers, host, hostMem, live = true) {
  const now = new Map(containers.map(c => [c.name, c]));
  const out = [];
  for (const r of rows) {
    const c = now.get(r.name); if (!c || !c.running) continue;
    const limit = c.mem_limit || 0, peak = r.mem_peak || 0, p95 = r.mem_p95 || 0;
    const suggest = roundUp(Math.max(peak * 1.3, p95 * 1.5, 128 * MB));
    let mem = 'ok';
    if (limit && (r.mem_hits > 0 || peak >= limit * 0.9)) mem = 'tight';
    else if (!limit) mem = 'none';
    else if (peak < limit * 0.4 && limit - suggest >= 256 * MB) mem = 'spare';
    const x = { name: r.name, hours: Math.round(r.hours), limit, peak, p95, hits: r.mem_hits, mem, suggest: mem === 'ok' ? null : suggest,
      cpu: r.thr_share >= 0.05 ? 'tight' : 'ok', thr_share: r.thr_share, cpu_p95: r.cpu_p95, grow: null, fs_day: null };
    // steady growth only: six hours or more of samples, a fit that explains 60% of the change, and enough to matter
    const day = (r.mem_slope || 0) * 86400, cur = c.mem || 0;
    if (live && r.span >= 6 * 3600 && r.mem_r2 >= 0.6 && day >= Math.max(20 * MB, cur * 0.02)) {
      const room = limit ? limit - cur : host.memory ? host.memory - (hostMem || 0) : 0;
      const days = room > 0 ? room / day : 0;
      if (days <= 30) x.grow = { per_day: day, days: Math.round(days * 10) / 10, against: limit ? 'limit' : 'host' };
    }
    const fday = (r.fs_slope || 0) * 86400;
    if (r.span >= 6 * 3600 && r.fs_r2 >= 0.6 && fday >= 200 * MB) x.fs_day = fday;
    out.push(x);
  }
  const rank = x => (x.grow ? 0 : 10) + (x.mem === 'tight' ? 0 : x.cpu === 'tight' ? 1 : x.mem === 'none' ? 2 : x.mem === 'spare' ? 3 : 4);
  out.sort((a, b) => rank(a) - rank(b) || (a.grow && b.grow ? a.grow.days - b.grow.days : 0) || b.peak - a.peak || a.name.localeCompare(b.name));
  const sum = f => out.reduce((s, x) => s + f(x), 0);
  return { containers: out, limits: sum(x => x.limit), limited: out.filter(x => x.limit).length, peaks: sum(x => x.peak),
    suggested: sum(x => x.suggest || x.limit || 0), memory: host.memory || 0, hours: Math.max(0, ...out.map(x => x.hours)) };
}

function create(agents) {
  const pruned = new Map();   // host id -> when old samples were last removed
  const weeks = new Map();    // host id -> { at, rows }: the week's summary, read at most every SIZING_MS

  /* ---------- a report from a Board Remote PC ---------- */
  async function ingest(A, hospitalId, agentId, msg) {
    const hosts = Array.isArray(msg.hosts) ? msg.hosts.slice(0, 20) : [];
    let changed = false;
    for (const h of hosts) {
      const machine = clip(h.machine, 120); if (!machine) continue;
      if (await db.tx(A, c => one(c, hospitalId, agentId, machine, h))) changed = true;
    }
    if (changed && agents) agents.emit(hospitalId, { t: 'fleet' });
  }
  async function one(c, hospitalId, agentId, machine, h) {
    const ok = !!h.ok;
    const prev = (await c.query('select * from br.container_hosts where hospital_id = $1 and machine = $2 for update', [hospitalId, machine])).rows[0];
    // another PC already reported this host in the last 30 s: its numbers stand
    if (prev && prev.agent_id && prev.agent_id !== agentId && prev.ok && Date.now() - new Date(prev.last_seen) < 30000) return false;
    const pr = h.prom && typeof h.prom === 'object' ? h.prom : null;
    const row = (await c.query(`insert into br.container_hosts (hospital_id, agent_id, machine, address, name, cores, memory, cadvisor, ok, error, last_ok, last_seen,
          prometheus, prom_ok, prom_error, prom_last_ok, prom_rules)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $9 then now() end, now(), $11, $12, $13, case when $12 then now() end, $14)
      on conflict (hospital_id, machine) do update set agent_id = excluded.agent_id, address = excluded.address, name = excluded.name,
        cores = case when excluded.cores > 0 then excluded.cores else br.container_hosts.cores end,
        memory = case when excluded.memory > 0 then excluded.memory else br.container_hosts.memory end,
        cadvisor = case when excluded.cadvisor <> '' then excluded.cadvisor else br.container_hosts.cadvisor end,
        ok = excluded.ok, error = excluded.error, last_ok = coalesce(excluded.last_ok, br.container_hosts.last_ok), last_seen = now(),
        prometheus = excluded.prometheus, prom_ok = excluded.prom_ok, prom_error = excluded.prom_error,
        prom_last_ok = coalesce(excluded.prom_last_ok, br.container_hosts.prom_last_ok), prom_rules = excluded.prom_rules
      returning id, name, last_ok, prom_last_ok, checked_unusual`,
      [hospitalId, agentId, machine, clip(h.address, 200), clip(h.name, 80) || clip(h.address, 80), int(h.cores) || 0, int(h.memory) || 0, clip(h.cadvisor, 40), ok, ok ? '' : clip(h.error, 300),
       clip(h.prometheus, 200), pr ? !!pr.ok : null, pr && !pr.ok ? clip(pr.error, 300) : '', pr && pr.ok ? int(pr.rules) || 0 : 0])).rows[0];
    const hostName = row.name || machine;
    const X = { c, hospitalId, agentId, hostId: row.id };
    let svc = await services(X, hostName, h, pr, row);

    if (!ok) {
      // cAdvisor did not answer: open an alert once it has been quiet long enough
      if (!row.last_ok || Date.now() - new Date(row.last_ok) >= HOST_ALERT_MS) {
        const open = (await c.query("select 1 from br.alerts where container_host_id = $1 and kind = 'container_host_down' and resolved_at is null", [row.id])).rowCount;
        if (!open) {
          await c.query("insert into br.alerts (hospital_id, agent_id, container_host_id, kind, title) values ($1, $2, $3, 'container_host_down', $4)",
            [hospitalId, agentId, row.id, 'Containers on ' + hostName + ' are not reporting']);
          return true;
        }
      }
      return !prev || prev.ok || svc;
    }
    let changed = !prev || !prev.ok || svc;
    changed = (await c.query("update br.alerts set resolved_at = now() where container_host_id = $1 and kind = 'container_host_down' and resolved_at is null", [row.id])).rowCount > 0 || changed;

    const list = (Array.isArray(h.containers) ? h.containers : []).slice(0, 500).map(x => Object.assign({}, x, { name: clip(x.name, 200) })).filter(x => x.name);
    const at = (await c.query("select date_trunc('second', now()) t")).rows[0].t;
    const rows = [Object.assign({ name: '' }, h.host || {})].concat(list);
    // one insert for the whole minute
    const vals = [], ps = [];
    for (const x of rows) {
      const b = ps.length;
      const pc = v => { const n = num(v); return n === null ? null : Math.min(100, n); };
      ps.push(row.id, hospitalId, at, x.name, num(x.cpu), int(x.mem), int(x.memLimit) < 2 ** 62 ? int(x.memLimit) || 0 : 0, num(x.rx), num(x.tx), num(x.rd), num(x.wr), int(x.fs),
        num(x.throttle) === null ? null : Math.min(1, num(x.throttle)), pc(x.psiCpu), pc(x.psiMem), pc(x.psiIo), Math.min(1e6, int(x.memHits) || 0));
      vals.push('(' + Array.from({ length: 17 }, (_, i) => '$' + (b + i + 1)).join(', ') + ')');
    }
    await c.query('insert into br.container_samples (host_id, hospital_id, at, name, cpu, mem, mem_limit, rx, tx, rd, wr, fs, throttle, psi_cpu, psi_mem, psi_io, mem_hits) values ' + vals.join(', ') + ' on conflict do nothing', ps);

    // what runs now; anything that was running and is gone has stopped
    const was = new Map((await c.query('select name, running, started_at from br.containers where host_id = $1', [row.id])).rows.map(r => [r.name, r]));
    const before = new Map([...was].map(([n, r]) => [n, r.running]));
    const event = (name, kind, detail) => c.query('insert into br.container_events (host_id, hospital_id, name, kind, detail) values ($1, $2, $3, $4, $5)', [row.id, hospitalId, name, kind, clip(detail, 200)]);
    for (const x of list) {
      const started = x.started && !isNaN(new Date(x.started)) ? new Date(x.started) : null;
      const w = was.get(x.name);
      // a new start time on a container that kept running between two reports: it restarted
      if (w && w.running && started && w.started_at && Math.abs(started - new Date(w.started_at)) > 5000) {
        await c.query('update br.containers set restarts = restarts + 1, restarted_at = now() where host_id = $1 and name = $2', [row.id, x.name]);
        await event(x.name, 'restart', '');
        changed = true;
      }
      if (w && !w.running) await event(x.name, 'started', '');
      if (int(x.memHits) > 0) await event(x.name, 'limit', 'reached its memory limit ' + int(x.memHits) + ' time' + (int(x.memHits) > 1 ? 's' : ''));
      await c.query(`insert into br.containers (host_id, hospital_id, name, image, started_at, last_seen, running) values ($1, $2, $3, $4, $5, now(), true)
        on conflict (host_id, name) do update set image = excluded.image, started_at = coalesce(excluded.started_at, br.containers.started_at), last_seen = now(), running = true`,
        [row.id, hospitalId, x.name, clip(x.image, 200), started]);
      if (before.get(x.name) === false) {
        await c.query("update br.alerts set resolved_at = now() where container_host_id = $1 and container = $2 and kind = 'container_down' and resolved_at is null", [row.id, x.name]);
        changed = true;
      }
      if (!before.has(x.name)) changed = true;
    }
    const now = new Set(list.map(x => x.name));
    for (const [name, running] of before) {
      if (!running || now.has(name)) continue;
      await c.query('update br.containers set running = false where host_id = $1 and name = $2', [row.id, name]);
      await event(name, 'stopped', '');
      await c.query("insert into br.alerts (hospital_id, agent_id, container_host_id, container, kind, title) values ($1, $2, $3, $4, 'container_down', $5)",
        [hospitalId, agentId, row.id, name, name + ' stopped on ' + hostName]);
      changed = true;
    }
    if (await health(X, hostName, list)) changed = true;
    if (!row.checked_unusual || Date.now() - new Date(row.checked_unusual) >= UNUSUAL_EVERY) {
      await c.query('update br.container_hosts set checked_unusual = now() where id = $1', [row.id]);
      if (await unusual(X, hostName)) changed = true;
    }
    if (Date.now() - (pruned.get(row.id) || 0) > 3600000) {
      pruned.set(row.id, Date.now());
      await c.query("delete from br.container_samples where host_id = $1 and at < now() - make_interval(days => $2)", [row.id, KEEP_DAYS]);
      await c.query("delete from br.container_events where host_id = $1 and at < now() - make_interval(days => $2)", [row.id, KEEP_DAYS]);
    }
    return changed;
  }

  /* ---------- alerts keyed per host: one open alert per key ---------- */
  async function raise(X, kind, key, title, container) {
    const have = (await X.c.query('select id, title from br.alerts where container_host_id = $1 and alert_key = $2 and resolved_at is null', [X.hostId, key])).rows[0];
    if (have) { if (have.title !== title) await X.c.query('update br.alerts set title = $2 where id = $1', [have.id, title]); return false; }
    await X.c.query('insert into br.alerts (hospital_id, agent_id, container_host_id, container, kind, title, alert_key) values ($1, $2, $3, $4, $5, $6, $7)',
      [X.hospitalId, X.agentId, X.hostId, container || null, kind, clip(title, 200), key]);
    return true;
  }
  async function clear(X, key) {
    return (await X.c.query('update br.alerts set resolved_at = now() where container_host_id = $1 and alert_key = $2 and resolved_at is null', [X.hostId, key])).rowCount > 0;
  }
  // close every open alert of a kind whose key is not in keep
  async function clearOthers(X, kind, keep) {
    const r = await X.c.query('update br.alerts set resolved_at = now() where container_host_id = $1 and kind = $2 and resolved_at is null and not (alert_key = any($3::text[]))', [X.hostId, kind, [...keep]]);
    return r.rowCount > 0;
  }

  /* ---------- the services, from the site's Prometheus ---------- */
  async function services(X, hostName, h, pr, row) {
    if (!clip(h.prometheus, 200)) return (await clearOthers(X, 'service', new Set())) | (await clear(X, 'prometheus'));
    if (!pr) return false;
    if (!pr.ok) {
      // keep the service alerts as they were (nothing is known), and say Prometheus is not answering
      if (!row.prom_last_ok || Date.now() - new Date(row.prom_last_ok) >= HOST_ALERT_MS) return raise(X, 'prometheus_down', 'prometheus', 'Prometheus on ' + hostName + ' is not answering, so service alerts are paused');
      return false;
    }
    let changed = await clear(X, 'prometheus');
    const keep = new Set();
    for (const f of (Array.isArray(pr.firing) ? pr.firing : []).slice(0, 100)) {
      const job = clip(f.job, 80), key = 'svc:' + clip(f.rule, 40) + ':' + clip(f.name, 80) + ':' + job;
      keep.add(key);
      if (await raise(X, 'service', key, clip(f.title, 200) || (clip(f.name, 80) + ' on ' + job), job)) changed = true;
    }
    if (await clearOthers(X, 'service', keep)) changed = true;
    return changed;
  }

  /* ---------- each container's health, over its last 10 minutes ---------- */
  async function health(X, hostName, list) {
    const names = list.map(x => x.name);
    if (!names.length) return false;
    const r = (await X.c.query(`select name,
        count(*) filter (where at > now() - interval '5 minutes')::int n5,
        min(mem::float8 / nullif(mem_limit, 0)) filter (where at > now() - interval '5 minutes') lo5,
        (array_agg(mem::float8 / nullif(mem_limit, 0) order by at desc))[1] last_ratio,
        (array_agg(mem_limit order by at desc))[1] lim,
        (array_agg(mem_hits order by at desc))[1] hits_now,
        coalesce(sum(mem_hits), 0)::int hits10,
        count(throttle)::int nthr, avg(throttle)::float8 thr
      from br.container_samples where host_id = $1 and name = any($2::text[]) and at > now() - interval '10 minutes' group by name`, [X.hostId, names])).rows;
    const restarts = new Map((await X.c.query(`select name, count(*)::int n from br.container_events where host_id = $1 and kind = 'restart' and at > now() - interval '30 minutes' group by name`, [X.hostId])).rows.map(x => [x.name, x.n]));
    let changed = false;
    const did = v => { if (v) changed = true; };
    for (const x of r) {
      const n = x.name;
      if ((x.n5 >= 4 && x.lo5 >= 0.9) || x.hits_now > 0) did(await raise(X, 'container_memory', 'mem:' + n, x.hits_now > 0 ? n + ' hit its memory limit (' + size(Number(x.lim)) + ') on ' + hostName : n + ' uses ' + Math.round(x.last_ratio * 100) + '% of its memory limit (' + size(Number(x.lim)) + ') on ' + hostName, n));
      else if ((x.last_ratio === null || x.last_ratio < 0.8) && !x.hits10) did(await clear(X, 'mem:' + n));
      if (x.nthr >= 8 && x.thr >= 0.25) did(await raise(X, 'container_cpu', 'cpu:' + n, n + ' is held back by its CPU limit ' + Math.round(x.thr * 100) + '% of the time on ' + hostName, n));
      else if (x.thr !== null && x.thr < 0.1) did(await clear(X, 'cpu:' + n));
      const k = restarts.get(n) || 0;
      if (k >= 2) did(await raise(X, 'container_restarting', 'restart:' + n, n + ' restarted ' + k + ' times in 30 minutes on ' + hostName, n));
      else if (!k) did(await clear(X, 'restart:' + n));
    }
    return changed;
  }

  /* ---------- "this is not like it": against its own usual for this time of day ---------- */
  // the same hour (+/- 30 min) on every earlier day kept, at least 3 days of it; checked every 15 minutes
  async function unusual(X, hostName) {
    const r = (await X.c.query(`with cur as (
          select name, avg(cpu)::float8 cpu, avg(mem)::float8 mem, avg(rx)::float8 rx, count(*)::int n
          from br.container_samples where host_id = $1 and name <> '' and at > now() - interval '15 minutes' group by name),
        usual as (
          select name, avg(cpu)::float8 cpu, avg(mem)::float8 mem, avg(rx)::float8 rx, count(distinct date_trunc('day', at))::int days
          from br.container_samples where host_id = $1 and name <> '' and at < now() - interval '12 hours'
            and (mod(extract(epoch from now() - at)::numeric, 86400) < 1800 or mod(extract(epoch from now() - at)::numeric, 86400) > 84600)
          group by name)
      select cur.name, cur.n, cur.cpu, cur.mem, cur.rx, usual.cpu ucpu, usual.mem umem, usual.rx urx, usual.days
      from cur join usual using (name) where usual.days >= 3`, [X.hostId])).rows;
    let changed = false;
    const keep = new Set();
    const times = (a, b) => (a / b >= 10 ? Math.round(a / b) : (a / b).toFixed(1)) + '×';
    for (const x of r) {
      if (x.n < 10) continue;
      const out = [];
      if (x.mem > 1.5 * x.umem && x.mem - x.umem > 200 * MB) out.push(['mem', x.name + ' uses ' + times(x.mem, x.umem) + ' its usual memory for this time of day (' + size(x.mem) + ', usually ' + size(x.umem) + ')']);
      if (x.cpu > 3 * x.ucpu && x.cpu - x.ucpu > 0.25) out.push(['cpu', x.name + ' uses ' + times(x.cpu, x.ucpu) + ' its usual CPU for this time of day']);
      if (x.urx > 2048 && x.rx < x.urx * 0.02) out.push(['rx', x.name + ' stopped receiving network traffic (usually ' + size(x.urx) + ' a second at this time)']);
      for (const [m, title] of out) {
        const key = 'unusual:' + m + ':' + x.name;
        keep.add(key);
        if (await raise(X, 'container_unusual', key, title + ' on ' + hostName, x.name)) changed = true;
      }
    }
    if (await clearOthers(X, 'container_unusual', keep)) changed = true;
    return changed;
  }

  /* ---------- the Containers page ---------- */
  // the stretch of time asked for: a preset (&range=) or &from= and &to= (to defaults to now)
  function stretch(q) {
    const range = RANGES[q.get('range')] ? q.get('range') : '1h';
    if (!q.get('from')) return { range, secs: RANGES[range], endMs: Date.now(), from: null };
    const f = Date.parse(clip(q.get('from'), 40)), t = q.get('to') ? Date.parse(clip(q.get('to'), 40)) : Date.now();
    if (!Number.isFinite(f) || !Number.isFinite(t)) throw bad(400, 'Pick a start and an end as dates and times.');
    if (t <= f) throw bad(400, 'Pick a start before the end.');
    if (t - f < 600000) throw bad(400, 'Pick at least 10 minutes.');
    if (f < Date.now() - KEEP_DAYS * 86400000 || t > Date.now() + 60000) throw bad(400, 'Pick a time within the last ' + KEEP_DAYS + ' days: older numbers are not kept.');
    return { range: 'custom', secs: Math.round((t - f) / 1000), endMs: t, from: f };
  }

  // ?hospital=<id> &host=<id> (default: the first host) &range=1h|6h|24h|7d, or &from=&to= (ISO times; to
  // defaults to now) for any stretch of the KEEP_DAYS kept, 10 minutes or longer. A custom stretch also
  // sets what Sizing and headroom is worked out from; the presets use the last 7 days for it.
  async function view(A, q) {
    const hospital = clip(q.get('hospital'), 36);
    if (!GUID.test(hospital)) throw bad(400, 'Pick a hospital.');
    const { range, secs, endMs, from } = stretch(q);
    const live = Date.now() - endMs < 600000;   // the stretch ends about now, so a trend can say when a limit is reached
    const step = Math.max(60, Math.round(secs / 120 / 60) * 60), endS = endMs / 1000;
    return db.tx(A, async c => {
      if (!(await c.query('select 1 from br.hospitals where id = $1', [hospital])).rowCount) throw bad(404, 'Unknown hospital.');
      const hosts = (await c.query(`select h.id, h.name, h.address, h.machine, h.cores, h.memory::float8 memory, h.cadvisor, h.ok, h.error, h.last_ok, h.last_seen, a.name pc, h.prometheus, h.prom_ok, h.prom_error, h.prom_last_ok, h.prom_rules,
          (select count(*)::int from br.containers k where k.host_id = h.id and k.running) running,
          (select count(*)::int from br.containers k where k.host_id = h.id and not k.running) stopped
        from br.container_hosts h left join br.agents a on a.id = h.agent_id where h.hospital_id = $1 order by h.name`, [hospital])).rows;
      for (const h of hosts) h.stale = Date.now() - new Date(h.last_seen) > HOST_ALERT_MS;
      const want = clip(q.get('host'), 36);
      const host = hosts.find(h => h.id === want) || hosts[0];
      if (!host) return { ok: true, range, step, from: from || endMs - secs * 1000, to: endMs, hosts, host: null, containers: [], series: null, alerts: [], marks: [] };
      // each container now, with its latest minute
      const containers = (await c.query(`select k.name, k.image, k.started_at, k.first_seen, k.last_seen, k.running, k.restarts, k.restarted_at,
          s.cpu, s.mem::float8 mem, s.mem_limit::float8 mem_limit, s.rx, s.tx, s.rd, s.wr, s.fs::float8 fs, s.throttle, s.psi_cpu, s.psi_mem, s.psi_io
        from br.containers k left join lateral (select * from br.container_samples x where x.host_id = k.host_id and x.name = k.name order by x.at desc limit 1) s on true
        where k.host_id = $1 order by k.running, k.name`, [host.id])).rows;
      const r = (await c.query(`select name, (floor(extract(epoch from at) / $3) * $3)::bigint b,
          avg(cpu)::float8 cpu, avg(mem)::float8 mem, avg(rx)::float8 rx, avg(tx)::float8 tx, avg(rd)::float8 rd, avg(wr)::float8 wr, max(fs)::float8 fs, avg(throttle)::float8 throttle
        from br.container_samples where host_id = $1 and at > to_timestamp($4) - make_interval(secs => $2) and at <= to_timestamp($4)
        group by name, b order by b`, [host.id, secs, step, endS])).rows;
      // one time axis for every series; a minute a container did not report is null (a gap, not a zero)
      const end = Math.floor(endS / step) * step, t = [];
      for (let x = end - Math.floor(secs / step) * step; x <= end; x += step) t.push(x);
      const at = new Map(t.map((x, i) => [x, i]));
      const series = {};
      for (const m of ['cpu', 'mem', 'rx', 'tx', 'rd', 'wr', 'fs', 'throttle']) series[m] = {};
      for (const x of r) {
        const i = at.get(Number(x.b)); if (i === undefined) continue;
        for (const m in series) {
          const s = series[m][x.name] || (series[m][x.name] = new Array(t.length).fill(null));
          s[i] = x[m] === null ? null : Math.round(x[m] * 1000) / 1000;
        }
      }
      // what is wrong on this host now, and what happened to its containers lately
      const alerts = (await c.query(`select al.id, al.kind, al.title, al.container, al.opened_at, al.acked_at, coalesce(u.name, u.email) acked_by_name
        from br.alerts al left join br.users u on u.id = al.acked_by where al.container_host_id = $1 and al.resolved_at is null order by al.opened_at desc`, [host.id])).rows;
      // events for the charts' markers, counted per bucket so a limit hit every minute for a week stays small
      const marks = (await c.query(`select name, kind, (floor(extract(epoch from at) / $2) * $2)::float8 * 1000 as at, count(*)::int n, (array_agg(detail order by at desc))[1] detail
        from br.container_events where host_id = $1 and at > to_timestamp($3) and at <= to_timestamp($4) group by name, kind, 3 order by 3 limit 5000`,
        [host.id, step, endS - secs - step, endS + step])).rows;
      // the week's peaks, limits and trends behind Sizing and headroom
      // over the custom stretch when there is one, else the last 7 days; the trend over its last 3 days
      const wEnd = from ? endS : Date.now() / 1000, wStart = from ? from / 1000 : wEnd - 7 * 86400, wTrend = Math.max(wStart, wEnd - 3 * 86400);
      const wKey = host.id + (from ? '|' + from + '|' + endMs : ''), TR = 'at > to_timestamp($4)';
      let wk = weeks.get(wKey);
      if (!wk || Date.now() - wk.at > SIZING_MS) {
        const rows = (await c.query(`select name, extract(epoch from to_timestamp($3) - min(at))::float8 / 3600 hours,
            max(mem)::float8 mem_peak, percentile_cont(0.95) within group (order by mem)::float8 mem_p95,
            coalesce(sum(mem_hits), 0)::int mem_hits, percentile_cont(0.95) within group (order by cpu)::float8 cpu_p95,
            coalesce((count(*) filter (where throttle >= 0.25))::float8 / nullif(count(throttle), 0), 0) thr_share,
            regr_slope(mem, extract(epoch from at)) filter (where ${TR}) mem_slope,
            regr_r2(mem, extract(epoch from at)) filter (where ${TR}) mem_r2,
            regr_slope(fs, extract(epoch from at)) filter (where ${TR}) fs_slope,
            regr_r2(fs, extract(epoch from at)) filter (where ${TR}) fs_r2,
            extract(epoch from max(at) filter (where ${TR}) - min(at) filter (where ${TR}))::float8 span
          from br.container_samples where host_id = $1 and name <> '' and at > to_timestamp($2) and at <= to_timestamp($3) group by name`, [host.id, wStart, wEnd, wTrend])).rows;
        // custom stretches come and go; keep only the latest few
        if (weeks.size > 200) weeks.clear();
        weeks.set(wKey, wk = { at: Date.now(), rows });
      }
      let hostMem = null; for (const v of series.mem[''] || []) if (v !== null) hostMem = v;
      const plan = sizing(wk.rows, containers, host, hostMem, live);
      return { ok: true, range, step, from: from || endMs - secs * 1000, to: endMs, hosts, host, containers, alerts, marks, sizing: plan, series: Object.assign({ t: t.map(x => x * 1000) }, series) };
    });
  }

  /* ---------- Recent events, a page at a time ---------- */
  // ?hospital &host &range | from &to, &kind (restart|stopped|started|limit) &name (one container)
  // &before (the `next` of the previous page). The same container and kind within 10 minutes of the
  // last one are one row with a count (a container at its memory limit can log one a minute for days).
  // Newest first; a cursor rather than an offset, so new events arriving do not shift the pages.
  const EV_PAGE = 25;
  async function events(A, q) {
    const hospital = clip(q.get('hospital'), 36), hostId = clip(q.get('host'), 36);
    if (!GUID.test(hospital) || !GUID.test(hostId)) throw bad(400, 'Pick a hospital and a Docker host.');
    const { secs, endMs } = stretch(q), endS = endMs / 1000;
    const kind = EVENT_KINDS.includes(q.get('kind')) ? q.get('kind') : '', name = clip(q.get('name'), 200);
    let cur = null;
    if (q.get('before')) {
      try { cur = JSON.parse(clip(q.get('before'), 600)); } catch (e) { /* checked below */ }
      if (!Array.isArray(cur) || cur.length !== 3 || !cur.every(x => typeof x === 'string')) throw bad(400, 'That page is no longer there. Load the events again.');
    }
    return db.tx(A, async c => {
      if (!(await c.query('select 1 from br.container_hosts where id = $1 and hospital_id = $2', [hostId, hospital])).rowCount) throw bad(404, 'Unknown Docker host.');
      const rows = (await c.query(`with e as (
            select name, kind, at, detail, case when at - lag(at) over (partition by name, kind order by at) <= interval '10 minutes' then 0 else 1 end brk
            from br.container_events where host_id = $1 and at > to_timestamp($2) and at <= to_timestamp($3) and ($4 = '' or name = $4) and ($5 = '' or kind = $5)),
          g as (select name, kind, at, detail, sum(brk) over (partition by name, kind order by at) grp from e),
          r as (select name, kind, min(at) first_at, max(at) last_at, count(*)::int n, (array_agg(detail order by at desc))[1] detail from g group by name, kind, grp)
        select name, kind, first_at, last_at, last_at::text cur, n, detail from r
        where $6::text is null or (last_at, name, kind) < ($6::timestamptz, $7, $8)
        order by last_at desc, name desc, kind desc limit $9`,
        [hostId, endS - secs, endS, name, kind, cur ? cur[0] : null, cur ? cur[1] : '', cur ? cur[2] : '', EV_PAGE + 1])).rows;
      const more = rows.length > EV_PAGE; if (more) rows.pop();
      const last = rows[rows.length - 1];
      const counts = Object.fromEntries((await c.query(`select kind, count(*)::int n from br.container_events
        where host_id = $1 and at > to_timestamp($2) and at <= to_timestamp($3) and ($4 = '' or name = $4) group by kind`, [hostId, endS - secs, endS, name])).rows.map(x => [x.kind, x.n]));
      return { ok: true, rows: rows.map(({ cur, ...x }) => x), next: more ? JSON.stringify([last.cur, last.name, last.kind]) : null, counts };
    });
  }

  return { ingest, view, events };
}

module.exports = { create, RANGES, sizing };
