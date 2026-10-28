'use strict';
// Backend containers from cAdvisor: a Board Remote report lands as samples, a stopped container and a
// silent host open alerts that close on their own, two PCs reading one host count it once, and each
// hospital only ever sees its own hosts.
const { Pool } = require('pg');
const db = require('../src/db');
const Containers = require('../src/containers');

module.exports = async function (T, url) {
  db.init(url);
  const S = db.SYSTEM;
  const owner = new Pool({ connectionString: url.replace('br_app:apppw', 'br_owner:ownerpw') });
  const emitted = [];
  const K = Containers.create({ emit: (h, e) => emitted.push(h) });
  const ids = await db.tx(S, async c => {
    const q = (s, p) => c.query(s, p).then(r => r.rows[0]);
    const g = await q("insert into br.hospitals (name) values ('Goshen Health') returning id");
    const b = await q("insert into br.hospitals (name) values ('Ball Health') returning id");
    const it = await q("insert into br.users (email, name) values ('it@goshenhealth.com', 'Goshen IT') returning id");
    const bit = await q("insert into br.users (email, name) values ('it@ballhealth.com', 'Ball IT') returning id");
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, $2, 'hospital_it'), ($3, $4, 'hospital_it')", [it.id, g.id, bit.id, b.id]);
    const ag = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Goshen PC 4W', '\\x00') returning id", [g.id]);
    const ag2 = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Goshen PC 5E', '\\x00') returning id", [g.id]);
    const bag = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Ball PC', '\\x00') returning id", [b.id]);
    return { g: g.id, b: b.id, it: it.id, bit: bit.id, ag: ag.id, ag2: ag2.id, bag: bag.id };
  });
  const U = id => ({ kind: 'user', userId: id, canLock: false });
  const AG = id => ({ kind: 'agent', agentId: id });
  const ctr = (name, cpu, mem) => ({ name, image: 'registry.hcic.com/hciwebapp/qalatest:' + name, started: '2026-10-28T04:55:10Z', cpu, mem, memLimit: 9223372036854771712, rx: 100, tx: 50, rd: 0, wr: 10, fs: 0 });
  const host = list => ({ machine: 'm-1', address: 'http://192.168.1.20:8098', name: 'MediaCare server', ok: true, cadvisor: 'v0.60.6', cores: 8, memory: 16709709824,
    host: { cpu: 0.4, mem: 10e9, rx: 1000, tx: 500 }, containers: list });
  const report = (agent, h, hosts) => K.ingest(AG(agent), h, agent, { t: 'containers', hosts });
  const q = (s, p) => owner.query(s, p).then(r => r.rows);

  /* ---------- a report becomes samples ---------- */
  await report(ids.ag, ids.g, [host([ctr('mediacare', 0.02, 1.7e9), ctr('hci-alerts-service', 0.005, 2.6e8)])]);
  const hs = await q('select * from br.container_hosts');
  T('the host is stored once, by machine id', hs.length === 1 && hs[0].machine === 'm-1' && hs[0].name === 'MediaCare server' && hs[0].cores === 8 && hs[0].ok, hs);
  const sm = await q("select name, cpu, mem, mem_limit from br.container_samples order by name");
  T('one sample for the host and one per container', sm.length === 3 && sm[0].name === '' && sm.some(x => x.name === 'mediacare' && Number(x.mem) === 1.7e9), sm);
  T('an unlimited memory limit is stored as none', sm.every(x => Number(x.mem_limit) === 0), sm);
  T('the hospital page is told', emitted.indexOf(ids.g) >= 0);

  /* ---------- the page ---------- */
  const v = await K.view(U(ids.it), new URLSearchParams({ hospital: ids.g, range: '1h' }));
  T('Goshen IT sees the host and its containers', v.ok && v.host && v.host.name === 'MediaCare server' && v.containers.length === 2 && v.host.running === 2, v);
  T('series share one time axis', v.series.t.length > 50 && v.series.cpu.mediacare.length === v.series.t.length && v.series.cpu.mediacare.some(x => x !== null));
  T('numbers come back as numbers', typeof v.host.memory === 'number' && typeof v.containers[0].mem === 'number', [typeof v.host.memory, typeof v.containers[0].mem]);
  let err = null; try { await K.view(U(ids.bit), new URLSearchParams({ hospital: ids.g })); } catch (e) { err = e; }
  T('Ball IT cannot open Goshen containers', err && err.status === 404, err && err.message);
  const rows = await db.tx(U(ids.bit), c => c.query('select count(*)::int n from br.container_samples')).then(r => r.rows[0].n);
  T('row level security hides Goshen samples from Ball IT', rows === 0, rows);
  err = null; try { await report(ids.bag, ids.g, [host([ctr('x', 0, 0)])]); } catch (e) { err = e; }
  T('a PC cannot report into another hospital', !!err && /row-level security/.test(err.message), err && err.message);

  /* ---------- a container stops, then comes back ---------- */
  await owner.query("update br.container_hosts set last_seen = now() - interval '1 minute'");
  await report(ids.ag, ids.g, [host([ctr('mediacare', 0.02, 1.7e9)])]);
  let al = await q("select * from br.alerts where kind = 'container_down'");
  T('a container that stopped opens an alert', al.length === 1 && al[0].container === 'hci-alerts-service' && /stopped on MediaCare server/.test(al[0].title) && !al[0].resolved_at, al);
  T('it shows as stopped', (await q("select running from br.containers where name = 'hci-alerts-service'"))[0].running === false);
  await report(ids.ag, ids.g, [host([ctr('mediacare', 0.02, 1.7e9)])]);
  T('a second report does not open a second alert', (await q("select 1 from br.alerts where kind = 'container_down'")).length === 1);
  await report(ids.ag, ids.g, [host([ctr('mediacare', 0.02, 1.7e9), ctr('hci-alerts-service', 0.005, 2.6e8)])]);
  al = await q("select * from br.alerts where kind = 'container_down'");
  T('it closes when the container is back', al.length === 1 && al[0].resolved_at, al);

  /* ---------- two PCs read the same host ---------- */
  const before = (await q('select count(*)::int n from br.container_samples'))[0].n;
  await report(ids.ag2, ids.g, [host([ctr('mediacare', 0.02, 1.7e9), ctr('hci-alerts-service', 0.005, 2.6e8)])]);
  T('a second PC reading the same host within 30 s adds nothing', (await q('select count(*)::int n from br.container_samples'))[0].n === before && (await q('select count(*)::int n from br.container_hosts'))[0].n === 1);

  /* ---------- cAdvisor stops answering ---------- */
  await report(ids.ag, ids.g, [{ machine: 'm-1', address: 'http://192.168.1.20:8098', name: 'MediaCare server', ok: false, error: 'Nothing answers at http://192.168.1.20:8098.' }]);
  T('a short silence opens no alert yet', (await q("select 1 from br.alerts where kind = 'container_host_down'")).length === 0);
  const h1 = (await q('select ok, error from br.container_hosts'))[0];
  T('the host shows why', h1.ok === false && /Nothing answers/.test(h1.error), h1);
  await owner.query("update br.container_hosts set last_ok = now() - interval '10 minutes'");
  await report(ids.ag, ids.g, [{ machine: 'm-1', address: 'http://192.168.1.20:8098', name: 'MediaCare server', ok: false, error: 'timeout' }]);
  al = await q("select * from br.alerts where kind = 'container_host_down'");
  T('a long silence opens one host alert', al.length === 1 && !al[0].resolved_at && al[0].container_host_id === hs[0].id, al);
  await report(ids.ag, ids.g, [host([ctr('mediacare', 0.02, 1.7e9), ctr('hci-alerts-service', 0.005, 2.6e8)])]);
  T('it closes when cAdvisor answers again', (await q("select resolved_at from br.alerts where kind = 'container_host_down'"))[0].resolved_at !== null);

  /* ---------- the dashboard lists container alerts ---------- */
  await report(ids.ag, ids.g, [host([ctr('mediacare', 0.02, 1.7e9)])]);
  const dash = await require('../src/reports').create({ isOnline: () => true }).dashboard(U(ids.it), new URLSearchParams({ hospital: ids.g, tz: 'America/New_York' }));
  T('an open container alert shows on the dashboard', dash.alerts.some(a => a.kind === 'container_down'), dash.alerts);

  /* ---------- container health: memory limit, CPU throttling, restart loops ---------- */
  const hostId = hs[0].id;
  const backfill = (name, minutes, cols) => owner.query(`insert into br.container_samples (host_id, hospital_id, at, name, cpu, mem, mem_limit, throttle, mem_hits)
      select $1, $2, date_trunc('second', now()) - make_interval(mins => g), $3, $4, $5, $6, $7, 0 from generate_series(1, $8) g on conflict do nothing`,
    [hostId, ids.g, name, cols.cpu || 0.01, cols.mem || 1e8, cols.lim || 0, cols.thr || 0, minutes]);
  const openOf = kind => q("select * from br.alerts where kind = $1 and resolved_at is null", [kind]);
  const both = list => [host(list)];
  const big = (mem, extra) => Object.assign(ctr('hci-alerts-service', 0.005, mem), { memLimit: 1073741824 }, extra || {});
  await owner.query("delete from br.container_samples where name = 'hci-alerts-service'");
  await backfill('hci-alerts-service', 5, { mem: 1e9, lim: 1073741824 });
  await report(ids.ag, ids.g, both([ctr('mediacare', 0.02, 1.7e9), big(1.0e9)]));
  let a2 = await openOf('container_memory');
  T('5 minutes at 93% of its memory limit opens an alert', a2.length === 1 && a2[0].container === 'hci-alerts-service' && /uses 93% of its memory limit \(1\.0 GB\)/.test(a2[0].title), a2.map(x => x.title));
  await owner.query("delete from br.container_samples where name = 'hci-alerts-service'");
  await report(ids.ag, ids.g, both([ctr('mediacare', 0.02, 1.7e9), big(3e8)]));
  T('it closes once memory is back under 80%', (await openOf('container_memory')).length === 0);
  await owner.query("delete from br.container_samples where name = 'hci-alerts-service'");
  await report(ids.ag, ids.g, both([ctr('mediacare', 0.02, 1.7e9), big(3e8, { memHits: 2 })]));
  a2 = await openOf('container_memory');
  T('hitting the memory limit opens it at once', a2.length === 1 && /hit its memory limit/.test(a2[0].title), a2.map(x => x.title));
  T('and is in the timeline', (await q("select * from br.container_events where kind = 'limit'")).length === 1);

  await backfill('mediacare', 9, { thr: 0.5 });
  await report(ids.ag, ids.g, both([Object.assign(ctr('mediacare', 0.02, 1.7e9), { throttle: 0.5 }), big(3e8)]));
  a2 = await openOf('container_cpu');
  T('held back by its CPU limit half the time opens an alert', a2.length === 1 && /held back by its CPU limit 50% of the time/.test(a2[0].title), a2.map(x => x.title));

  const restart = t => report(ids.ag, ids.g, both([Object.assign(ctr('mediacare', 0.02, 1.7e9), { started: t }), big(3e8)]));
  await restart('2026-10-28T06:00:00Z');
  T('a new start time is a restart', (await q("select restarts from br.containers where name = 'mediacare'"))[0].restarts === 1 && (await openOf('container_restarting')).length === 0);
  await restart('2026-10-28T06:05:00Z');
  a2 = await openOf('container_restarting');
  T('two restarts in 30 minutes open a restart loop alert', a2.length === 1 && /restarted 2 times in 30 minutes/.test(a2[0].title), a2.map(x => x.title));

  /* ---------- the services, from the site's Prometheus ---------- */
  const withProm = (prom, list) => [Object.assign(host(list || [ctr('mediacare', 0.02, 1.7e9), big(3e8)]), { prometheus: 'http://192.168.1.20:9090', prom })];
  await report(ids.ag, ids.g, withProm({ ok: true, rules: 9, firing: [
    { rule: 'error_rate', job: 'mcdata-service', value: 0.083, title: 'mcdata-service fails 8.3% of its requests (5xx)' },
    { rule: 'prometheus', name: 'HighLoad', job: 'kong-gateway', severity: 'warning', title: 'HighLoad on kong-gateway' }] }));
  a2 = await openOf('service');
  T('firing rules open one service alert each', a2.length === 2 && a2.some(x => x.title === 'mcdata-service fails 8.3% of its requests (5xx)' && x.container === 'mcdata-service'), a2.map(x => x.title));
  await report(ids.ag, ids.g, withProm({ ok: true, rules: 9, firing: [{ rule: 'error_rate', job: 'mcdata-service', value: 0.09, title: 'mcdata-service fails 9.0% of its requests (5xx)' }] }));
  a2 = await openOf('service');
  T('a rule that stops firing closes; one still firing stays open with its new number', a2.length === 1 && /9\.0%/.test(a2[0].title), a2.map(x => x.title));
  await report(ids.ag, ids.g, withProm({ ok: false, error: 'timeout' }));
  T('Prometheus not answering briefly changes nothing', (await openOf('service')).length === 1 && (await openOf('prometheus_down')).length === 0);
  await owner.query("update br.container_hosts set prom_last_ok = now() - interval '10 minutes'");
  await report(ids.ag, ids.g, withProm({ ok: false, error: 'timeout' }));
  T('Prometheus silent for long opens prometheus_down and keeps service alerts', (await openOf('prometheus_down')).length === 1 && (await openOf('service')).length === 1);
  await report(ids.ag, ids.g, withProm({ ok: true, rules: 9, firing: [] }));
  T('when it answers again both close', (await openOf('prometheus_down')).length === 0 && (await openOf('service')).length === 0);

  /* ---------- unlike its own usual ---------- */
  await owner.query("delete from br.container_samples where name = 'mediacare'");
  // three earlier days around this time at 300 MB, then the last 15 minutes at 1.7 GB
  await owner.query(`insert into br.container_samples (host_id, hospital_id, at, name, cpu, mem, rx)
      select $1, $2, date_trunc('second', now()) - make_interval(days => d, mins => m), 'mediacare', 0.02, 3e8, 5000 from generate_series(1, 3) d, generate_series(-20, 20, 5) m`, [hostId, ids.g]);
  await owner.query(`insert into br.container_samples (host_id, hospital_id, at, name, cpu, mem, rx)
      select $1, $2, date_trunc('second', now()) - make_interval(mins => m), 'mediacare', 0.02, 1.7e9, 5000 from generate_series(1, 12) m`, [hostId, ids.g]);
  await owner.query('update br.container_hosts set checked_unusual = null');
  await report(ids.ag, ids.g, both([ctr('mediacare', 0.02, 1.7e9), big(3e8)]));
  a2 = await openOf('container_unusual');
  T('far more memory than usual for this time of day opens an alert', a2.length === 1 && /mediacare uses 5\.\d× its usual memory/.test(a2[0].title), a2.map(x => x.title));

  const v2 = await K.view(U(ids.it), new URLSearchParams({ hospital: ids.g, range: '1h' }));
  T('the page lists the host\'s open alerts and recent events', v2.alerts.length >= 3 && v2.alerts.every(a => a.title) && v2.marks.some(e => e.kind === 'restart' && e.n >= 1), { alerts: v2.alerts.length, marks: v2.marks.length });
  T('the page has CPU throttling per container', !!v2.series.throttle && v2.containers.every(c => 'throttle' in c && 'restarts' in c));

  T('the page has a week\'s sizing for each running container', !!v2.sizing && v2.sizing.containers.length > 0 && v2.sizing.containers.every(x => x.mem && x.cpu), v2.sizing && v2.sizing.containers.length);

  // a custom stretch: any 10 minutes or more of the 8 days kept
  const iso = ms => new Date(ms).toISOString(), nowMs = Date.now();
  const v3 = await K.view(U(ids.it), new URLSearchParams({ hospital: ids.g, from: iso(nowMs - 2 * 86400000 - 3600000), to: iso(nowMs - 2 * 86400000 + 3600000) }));
  T('a custom stretch returns its own time axis and sizing', v3.range === 'custom' && v3.step === 60 && v3.series.t.length === 121 && Math.abs(v3.to - (nowMs - 2 * 86400000 + 3600000)) < 1000 && !!v3.sizing,
    { range: v3.range, step: v3.step, n: v3.series.t.length });
  T('a custom stretch holds the samples taken in it, and only those', (v3.series.mem.mediacare || []).some(v => v !== null) && v3.series.mem.mediacare.filter(v => v !== null).every(v => v === 3e8));
  for (const [what, q, re] of [['an end before the start', { from: iso(nowMs), to: iso(nowMs - 3600000) }, /start before the end/], ['under 10 minutes', { from: iso(nowMs - 300000) }, /10 minutes/],
    ['older than what is kept', { from: iso(nowMs - 9 * 86400000) }, /8 days/], ['not a date', { from: 'yesterday-ish' }, /dates and times/]]) {
    let e = null; try { await K.view(U(ids.it), new URLSearchParams(Object.assign({ hospital: ids.g }, q))); } catch (x) { e = x; }
    T('a custom stretch ' + what + ' is refused', e && e.status === 400 && re.test(e.message), e && e.message);
  }

  // Recent events, a page at a time: repeats within 10 minutes are one row
  await owner.query('delete from br.container_events where host_id = $1', [hostId]);
  await owner.query(`insert into br.container_events (host_id, hospital_id, name, kind, at, detail)
      select $1, $2, 'hci-cadvisor', 'limit', now() - make_interval(mins => m), 'hit 256 MB' from generate_series(1, 40) m`, [hostId, ids.g]);
  await owner.query(`insert into br.container_events (host_id, hospital_id, name, kind, at, detail)
      select $1, $2, 'mediacare', 'restart', now() - make_interval(mins => 45 + m * 20), 'restart ' || m from generate_series(1, 30) m`, [hostId, ids.g]);
  const evq = o => K.events(U(ids.it), new URLSearchParams(Object.assign({ hospital: ids.g, host: hostId, range: '24h' }, o)));
  const p1 = await evq({});
  T('a container at its limit every minute is one row with a count', p1.rows[0].name === 'hci-cadvisor' && p1.rows[0].n === 40 && p1.rows[0].detail === 'hit 256 MB', p1.rows[0]);
  T('events come 25 rows a page, newest first, with the counts by kind', p1.rows.length === 25 && !!p1.next && p1.counts.limit === 40 && p1.counts.restart === 30 &&
    p1.rows.every((r, i) => !i || new Date(r.last_at) <= new Date(p1.rows[i - 1].last_at)), { n: p1.rows.length, counts: p1.counts });
  const p2 = await evq({ before: p1.next });
  T('the next page carries on where the last stopped, without repeats', p2.rows.length === 6 && !p2.next && !p2.rows.some(r => p1.rows.some(x => x.name === r.name && x.last_at.getTime() === r.last_at.getTime())), p2.rows.length);
  const p3 = await evq({ kind: 'limit' }), p4 = await evq({ name: 'mediacare', range: '6h' });
  T('events narrow to one kind, or one container and a shorter stretch', p3.rows.length === 1 && p3.rows[0].kind === 'limit' && p4.rows.length > 0 && p4.rows.length < 30 && p4.rows.every(r => r.name === 'mediacare'), { kind: p3.rows.length, one: p4.rows.length });
  let ee = null; try { await evq({ before: 'not-a-cursor' }); } catch (x) { ee = x; }
  T('a broken page cursor is refused', ee && ee.status === 400);
  let eb = null; try { await K.events(U(ids.bit), new URLSearchParams({ hospital: ids.g, host: hostId })); } catch (x) { eb = x; }
  T('another hospital cannot read these events', eb && eb.status === 404, eb && eb.message);
  const v4 = await K.view(U(ids.it), new URLSearchParams({ hospital: ids.g, range: '1h' }));
  const lim = v4.marks.filter(m => m.kind === 'limit' && m.name === 'hci-cadvisor');
  T('the charts get events counted per minute, not one by one', lim.length >= 38 && lim.length <= 41 && lim.every(m => m.n === 1 && typeof m.at === 'number'), lim.length);

  // Sizing and headroom, from a week's summary rows
  const MBb = 1048576, run = (name, mem, mem_limit) => ({ name, running: true, mem, mem_limit });
  const row = (name, o) => Object.assign({ name, hours: 168, mem_peak: 200 * MBb, mem_p95: 180 * MBb, mem_hits: 0, cpu_p95: 0.1, thr_share: 0, mem_slope: 0, mem_r2: 0, fs_slope: 0, fs_r2: 0, span: 3 * 86400 }, o);
  const z = Containers.sizing([
    row('tight', { mem_peak: 250 * MBb, mem_hits: 4 }), row('none'), row('spare'), row('fine', { mem_peak: 300 * MBb, mem_p95: 280 * MBb }),
    row('leak', { mem_slope: 100 * MBb / 86400, mem_r2: 0.9 }), row('noisy', { mem_slope: 100 * MBb / 86400, mem_r2: 0.2 }),
    row('logs', { fs_slope: 1024 * MBb / 86400, fs_r2: 0.95 }), row('held', { thr_share: 0.2 }), row('gone')
  ], [run('tight', 240 * MBb, 256 * MBb), run('none', 190 * MBb, 0), run('spare', 190 * MBb, 1024 * MBb), run('fine', 290 * MBb, 400 * MBb),
    run('leak', 300 * MBb, 600 * MBb), run('noisy', 300 * MBb, 600 * MBb), run('logs', 190 * MBb, 400 * MBb), run('held', 190 * MBb, 400 * MBb), { name: 'gone', running: false }], { memory: 4096 * MBb }, 2048 * MBb);
  const by = new Map(z.containers.map(x => [x.name, x]));
  T('a container that hit its memory limit is too tight, with a bigger limit suggested', by.get('tight').mem === 'tight' && by.get('tight').suggest > 256 * MBb, by.get('tight'));
  T('a container without a memory limit gets one suggested', by.get('none').mem === 'none' && by.get('none').suggest === 320 * MBb, by.get('none').suggest / MBb);
  T('a limit far above the peak can give memory back', by.get('spare').mem === 'spare' && by.get('spare').suggest < 1024 * MBb);
  T('a limit that fits is left alone', by.get('fine').mem === 'ok' && by.get('fine').suggest === null);
  T('steady memory growth says when it reaches the limit', !!by.get('leak').grow && by.get('leak').grow.days === 3 && by.get('leak').grow.against === 'limit', by.get('leak').grow);
  T('memory that only wobbles is not called growth', by.get('noisy').grow === null);
  T('a filesystem that keeps growing is named with how much a day', Math.round(by.get('logs').fs_day / MBb) === 1024);
  T('a CPU limit that holds a container back often is too tight', by.get('held').cpu === 'tight' && by.get('fine').cpu === 'ok');
  T('a stopped container is not sized, and what is heading for a limit comes first', !by.has('gone') && z.containers[0].name === 'leak', z.containers.map(x => x.name));

  await owner.end();
};
