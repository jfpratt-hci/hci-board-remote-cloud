'use strict';
/* HCI ONE Board Remote · Backend containers
   Reads cAdvisor (github.com/google/cadvisor) on the hospital's Docker hosts, for example the MediaCare
   server at http://192.168.1.20:8098, once a minute, and sends the numbers up the HCI ONE Cloud link.
   The cloud never reaches into the hospital; this PC reads the LAN and reports out, like boards.
   Taken from cAdvisor: container name, image, start time, CPU, memory, network, disk, filesystem,
   CPU throttling, pressure (PSI) and memory limit hits.
   Never taken: labels, environment, processes, logs. Hosts are added here only, never from the cloud.
   With the host's Prometheus address as well, HCI's rules (prom-rules.js) run read-only against it
   and the services breaking one are reported, with any alert Prometheus itself fires. */
const http = require('http');
const https = require('https');
const RULES = require('./prom-rules');

const EVERY = 60000;
const MAX_BODY = 32 * 1024 * 1024;

module.exports = function createContainers(ctx) {
  const { store, saveStore, log, send, readJson } = ctx;
  store.settings.containers = Object.assign({ hosts: [] }, store.settings.containers || {});
  const S = () => store.settings.containers;
  const live = new Map();     // address -> { ok, error, at, machine, cadvisor, cores, memory, count, host, busy }
  const prev = new Map();     // address + '|' + name -> { t, cpu, rx, tx, rd, wr, thr, per, hits } cumulative, for rates
  const pend = new Map();     // address + '|' + rule + '|' + job -> since when it has broken the rule
  let nextAt = Date.now() + 5000, cloud = null;

  const norm = a => {
    let u; try { u = new URL(/^https?:\/\//i.test(String(a).trim()) ? String(a).trim() : 'http://' + String(a).trim()); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    return u.origin;
  };
  function get(base, p, ms) {
    return new Promise((resolve, reject) => {
      const u = new URL(p, base), lib = u.protocol === 'https:' ? https : http;
      const r = lib.get(u, { timeout: ms || 15000, headers: { Accept: 'application/json' } }, res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('cAdvisor answered ' + res.statusCode + ' for ' + p)); }
        let n = 0; const chunks = [];
        res.on('data', d => { n += d.length; if (n > MAX_BODY) r.destroy(new Error('cAdvisor sent too much')); else chunks.push(d); });
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(new Error('cAdvisor did not answer with JSON. Is this the cAdvisor address?')); } });
      });
      r.on('timeout', () => r.destroy(new Error('cAdvisor did not answer in time.')));
      r.on('error', e => reject(new Error(e.code === 'ECONNREFUSED' ? 'Nothing answers at ' + base + '. Is cAdvisor running?' : e.message)));
    });
  }

  /* ---------- numbers from one cAdvisor container record ---------- */
  const sum = (list, f) => (Array.isArray(list) ? list : []).reduce((n, x) => n + (Number(f(x)) || 0), 0);
  function counters(s) {
    const net = s.network || {}, ifs = Array.isArray(net.interfaces) && net.interfaces.length ? net.interfaces : [net];
    const io = (s.diskio && s.diskio.io_service_bytes) || [];
    return {
      t: new Date(s.timestamp).getTime(),
      cpu: Number(s.cpu && s.cpu.usage && s.cpu.usage.total) || 0,
      rx: sum(ifs, i => i.rx_bytes), tx: sum(ifs, i => i.tx_bytes),
      rd: sum(io, d => d.stats && d.stats.Read), wr: sum(io, d => d.stats && d.stats.Write),
      thr: Number(s.cpu && s.cpu.cfs && s.cpu.cfs.throttled_periods) || 0, per: Number(s.cpu && s.cpu.cfs && s.cpu.cfs.periods) || 0,
      hits: Number(s.memory && s.memory.events && s.memory.events.max) || 0
    };
  }
  // rates since this PC's last read (a full minute), or across cAdvisor's own recent samples the first time
  function rates(key, stats) {
    const last = counters(stats[stats.length - 1]);
    const base = prev.get(key) || (stats.length > 1 ? counters(stats[0]) : null);
    prev.set(key, last);
    const dt = base ? (last.t - base.t) / 1000 : 0;
    const r = k => dt > 0 && last[k] >= base[k] ? (last[k] - base[k]) / dt : null;
    const dPer = base ? last.per - base.per : 0;
    return { cpu: dt > 0 && last.cpu >= base.cpu ? (last.cpu - base.cpu) / 1e9 / dt : null, rx: r('rx'), tx: r('tx'), rd: r('rd'), wr: r('wr'),
      throttle: dPer > 0 && last.thr >= base.thr ? Math.min(1, (last.thr - base.thr) / dPer) : (base ? 0 : null),
      memHits: base && last.hits >= base.hits ? last.hits - base.hits : 0 };
  }
  const psi = o => { const v = o && o.psi && o.psi.some && o.psi.some.avg60; return typeof v === 'number' ? v : null; };
  function measure(address, rec, name) {
    const stats = Array.isArray(rec.stats) ? rec.stats.filter(s => s && s.timestamp) : [];
    if (!stats.length) return null;
    const s = stats[stats.length - 1], spec = rec.spec || {};
    const lim = Number(spec.memory && spec.memory.limit) || 0;
    return Object.assign(rates(address + '|' + name, stats), {
      mem: Number(s.memory && (s.memory.working_set || s.memory.usage)) || 0,
      memLimit: lim > 0 && lim < 2 ** 62 ? lim : 0,
      fs: sum(s.filesystem, f => f.usage),
      // pressure (cgroup v2): share of the last minute some work waited for CPU, memory or disk, 0..100
      psiCpu: psi(s.cpu), psiMem: psi(s.memory), psiIo: psi(s.diskio)
    });
  }

  /* ---------- the site's Prometheus: HCI's rules, and its own alerts ---------- */
  async function prom(h) {
    if (!h.prometheus) return null;
    const firing = [], q = p => get(h.prometheus, p, 10000);
    try {
      for (const r of RULES) {
        const res = await q('/api/v1/query?query=' + encodeURIComponent(r.q));
        if (res.status !== 'success' || !res.data || !Array.isArray(res.data.result)) continue;
        const now = new Set(), at = h.address + '|' + r.id + '|';
        for (const x of res.data.result.slice(0, 50)) {
          const job = String((x.metric && x.metric.job) || r.job || 'backend').slice(0, 80), v = Number(x.value && x.value[1]);
          if (!Number.isFinite(v)) continue;
          now.add(at + job);
          const since = pend.get(at + job) || Date.now(); pend.set(at + job, since);
          // polls are a minute apart, so allow a few seconds of slack on "for N minutes"
          if (Date.now() - since >= r.for * 60000 - 5000) firing.push({ rule: r.id, job, value: v, title: r.title(job, v).slice(0, 200), since });
        }
        for (const k of pend.keys()) if (k.indexOf(at) === 0 && !now.has(k)) pend.delete(k);
      }
      // alerts the site's own Prometheus rules fire: the alert name, its severity and the job only
      const a = await q('/api/v1/alerts').catch(() => null);
      for (const x of ((a && a.data && a.data.alerts) || []).slice(0, 100)) {
        if (x.state !== 'firing') continue;
        const l = x.labels || {}, name = String(l.alertname || 'Alert').slice(0, 80), job = String(l.job || l.service || '').slice(0, 80);
        firing.push({ rule: 'prometheus', name, job, severity: String(l.severity || '').slice(0, 20), title: (name + (job ? ' on ' + job : '')).slice(0, 200), since: Date.parse(x.activeAt) || Date.now() });
      }
      return { ok: true, rules: RULES.length, firing };
    } catch (e) { return { ok: false, error: e.message.replace('cAdvisor', 'Prometheus') }; }
  }

  /* ---------- one host ---------- */
  async function read(h) {
    const st = live.get(h.address) || {};
    if (st.busy) return null;
    st.busy = true; live.set(h.address, st);
    try {
      if (!st.machine || Date.now() - (st.machineAt || 0) > 3600000) {
        const m = await get(h.address, '/api/v1.3/machine');
        st.machine = String(m.machine_id || m.system_uuid || m.boot_id || h.address).slice(0, 120);
        st.cores = Number(m.num_cores) || 0; st.memory = Number(m.memory_capacity) || 0; st.machineAt = Date.now();
        st.cadvisor = await get(h.address, '/api/v2.0/version', 5000).then(v => String(v).slice(0, 40), () => '');
      }
      const [root, docker] = await Promise.all([get(h.address, '/api/v1.3/containers/'), get(h.address, '/api/v1.3/docker/')]);
      const list = [];
      for (const rec of Object.values(docker || {})) {
        const name = String((rec.aliases && rec.aliases[0]) || rec.name || '').replace(/^\/+/, '').slice(0, 200);
        const m = name && measure(h.address, rec, name);
        if (!m) continue;
        const spec = rec.spec || {};
        list.push(Object.assign({ name, image: String(spec.image || '').slice(0, 200), started: spec.start_time || spec.creation_time || null }, m));
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      const host = measure(h.address, root || {}, '') || {};
      const pr = await prom(h);
      Object.assign(st, { ok: true, error: '', at: Date.now(), count: list.length, prom: pr });
      return { machine: st.machine, address: h.address, name: h.name, ok: true, cadvisor: st.cadvisor, cores: st.cores, memory: st.memory, host, containers: list,
        prometheus: h.prometheus || '', prom: pr };
    } catch (e) {
      // Prometheus is checked even when cAdvisor is not answering
      const pr = await prom(h).catch(() => null);
      Object.assign(st, { ok: false, error: e.message, at: Date.now(), prom: pr });
      // a host never reached has no machine id yet; it is reported by address until it answers once
      return { machine: st.machine || h.address, address: h.address, name: h.name, ok: false, error: e.message, prometheus: h.prometheus || '', prom: pr };
    } finally { st.busy = false; }
  }

  async function poll() {
    const hosts = S().hosts.slice();
    const out = (await Promise.all(hosts.map(read))).filter(Boolean);
    if (out.length && cloud && cloud.push) cloud.push({ t: 'containers', hosts: out });
  }
  function onTick() {
    if (!S().hosts.length || Date.now() < nextAt) return;
    nextAt = Date.now() + EVERY;
    poll().catch(e => log('containers', e.message));
  }

  /* ---------- this PC's API ---------- */
  const pub = () => ({ ok: true, hosts: S().hosts.map(h => {
    const st = live.get(h.address) || {};
    const pr = st.prom || null;
    return { address: h.address, name: h.name, prometheus: h.prometheus || '', promOk: pr ? !!pr.ok : null, promError: (pr && pr.error) || '', firing: pr && pr.firing ? pr.firing.length : 0, ok: !!st.ok, error: st.error || '', at: st.at || 0, count: st.count || 0, cadvisor: st.cadvisor || '', cores: st.cores || 0, memory: st.memory || 0 };
  }) });
  async function handle(req, res, p) {
    if (req.method === 'GET' && p === '/api/containers/state') return send(res, 200, pub()), true;
    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' }), true;
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' }), true;
    const body = await readJson(req);
    if (p === '/api/containers/add') {
      const address = norm(body.address);
      if (!address) return send(res, 200, { ok: false, message: 'Enter the cAdvisor address, like http://192.168.1.20:8098' }), true;
      const name = String(body.name || '').trim().slice(0, 80) || address.replace(/^https?:\/\//, '');
      const prometheus = String(body.prometheus || '').trim() ? norm(body.prometheus) : '';
      if (prometheus === null) return send(res, 200, { ok: false, message: 'Enter the Prometheus address, like http://192.168.1.20:9090, or leave it empty.' }), true;
      // check it really is cAdvisor (and Prometheus) before keeping it
      try { await get(address, '/api/v1.3/machine', 10000); } catch (e) { return send(res, 200, { ok: false, message: e.message }), true; }
      if (prometheus) {
        const b = await get(prometheus, '/api/v1/status/buildinfo', 10000).catch(() => null);
        if (!b || b.status !== 'success') return send(res, 200, { ok: false, message: 'Nothing that looks like Prometheus answers at ' + prometheus + '.' }), true;
      }
      const hs = S().hosts, x = hs.find(h => h.address === address);
      if (x) Object.assign(x, { name, prometheus }); else { if (hs.length >= 20) return send(res, 200, { ok: false, message: 'Twenty hosts is the most one PC reads.' }), true; hs.push({ address, name, prometheus }); }
      saveStore(); nextAt = 0; live.delete(address);
      log('containers host', address, name);
      return send(res, 200, { ok: true, message: name + ' added. Its containers show in HCI ONE Cloud within a minute.' }), true;
    }
    if (p === '/api/containers/remove') {
      const address = norm(body.address);
      S().hosts = S().hosts.filter(h => h.address !== address); saveStore(); live.delete(address);
      for (const m of [prev, pend]) for (const k of m.keys()) if (k.indexOf(address + '|') === 0) m.delete(k);
      return send(res, 200, { ok: true, message: 'Removed. This PC no longer reads it.' }), true;
    }
    return send(res, 404, { ok: false, message: 'Not found' }), true;
  }

  return { handle, onTick, state: pub, setCloud: c => { cloud = c; }, _poll: poll };
};
