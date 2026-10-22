'use strict';
// Dashboard and reports: the state history trigger, alerts opening and closing, uptime arithmetic,
// filters (type, floor, unit, closet, PC), and that each person only ever counts their own hospitals.
const { Pool } = require('pg');
const db = require('../src/db');
const Reports = require('../src/reports');

module.exports = async function (T, url) {
  db.init(url);
  const S = db.SYSTEM;
  const owner = new Pool({ connectionString: url.replace('br_app:apppw', 'br_owner:ownerpw') });
  const emitted = [];
  const rep = Reports.create({ isOnline: () => true, emit: (h, e) => emitted.push(h) });
  const ids = await db.tx(S, async c => {
    const q = (s, p) => c.query(s, p).then(r => r.rows[0]);
    const g = await q("insert into br.hospitals (name) values ('Goshen Health') returning id");
    const b = await q("insert into br.hospitals (name) values ('Ball Health') returning id");
    const admin = await q("insert into br.users (email, name, is_hci) values ('admin@hci-tv.com', 'Admin', true) returning id");
    const it = await q("insert into br.users (email, name) values ('it@goshenhealth.com', 'Goshen IT') returning id");
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin'), ($2, $3, 'hospital_it')", [admin.id, it.id, g.id]);
    const ag = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Goshen PC 4W', '\\x00') returning id", [g.id]);
    const ag2 = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Goshen PC 5E', '\\x00') returning id", [g.id]);
    const mk = (h, idn, kind, room, unit, closet) => q('insert into br.devices (hospital_id, identity, kind, room, unit, closet) values ($1, $2, $3, $4, $5, $6) returning id', [h, idn, kind, room, unit, closet]);
    const w401 = await mk(g.id, 'aa:01', 'wb', '401', '4 West', 'IDF 4');
    const d401 = await mk(g.id, 'aa:02', 'ds', '401', '4 West', 'IDF 4');
    const w512 = await mk(g.id, 'aa:03', 'wb', '512', '5 East', 'IDF 5');
    const w1205 = await mk(g.id, 'aa:04', 'wb', '1205B', 'Tower', 'IDF 12');
    const ball = await mk(b.id, 'bb:01', 'wb', '101', 'Med Surg', 'IDF 1');
    for (const [dev, a] of [[w401, ag], [d401, ag], [w512, ag2], [w1205, ag2]]) await c.query("insert into br.device_reach (device_id, hospital_id, agent_id, local_board_id, online, is_primary) values ($1, $4, $2, $3, true, true)", [dev.id, a.id, 'l' + dev.id.slice(0, 8), g.id]);
    return { g: g.id, b: b.id, admin: admin.id, it: it.id, ag: ag.id, ag2: ag2.id, w401: w401.id, d401: d401.id, w512: w512.id, w1205: w1205.id, ball: ball.id };
  });
  const U = id => ({ kind: 'user', userId: id, canLock: false });
  const HCI = Object.assign(U(ids.admin), { canLock: true });
  const qs = o => new URLSearchParams(Object.assign({ tz: 'America/New_York' }, o));
  const setState = (dev, h, st, actor) => db.tx(actor || { kind: 'agent', agentId: ids.ag }, c => c.query(`insert into br.device_state (device_id, hospital_id, state) values ($1, $2, $3)
    on conflict (device_id) do update set state = excluded.state, updated_at = now()`, [dev, h, st]));
  const logOf = dev => owner.query('select state, ended_at from br.state_log where device_id = $1 order by id', [dev]).then(r => r.rows);
  const openAlerts = dev => owner.query("select * from br.alerts where device_id = $1 and resolved_at is null", [dev]).then(r => r.rows);

  /* ---------- floor ---------- */
  const fl = async (room, floor) => (await owner.query('select br.floor_of($1, $2) f', [room, floor])).rows[0].f;
  T('floor from room 401 is 4', await fl('401', '') === '4');
  T('floor from room 1205B is 12', await fl('1205B', '') === '12');
  T('a floor typed in wins over the room', await fl('401', 'Basement') === 'Basement');
  T('no floor from a room like ICU 3', await fl('ICU 3', '') === '');

  /* ---------- the trigger: history and alerts ---------- */
  await setState(ids.w401, ids.g, 'online');
  T('first state starts the history', (await logOf(ids.w401)).length === 1);
  await setState(ids.w401, ids.g, 'online');
  T('the same state again adds no row', (await logOf(ids.w401)).length === 1);
  await setState(ids.w401, ids.g, 'offline');
  let L = await logOf(ids.w401);
  T('going offline closes the online stretch and opens an offline one', L.length === 2 && L[0].ended_at && !L[1].ended_at && L[1].state === 'offline');
  let al = await openAlerts(ids.w401);
  T('going offline opens one alert', al.length === 1 && al[0].kind === 'board_offline' && al[0].title === 'Room 401 went offline');
  await setState(ids.w401, ids.g, 'unknown');
  await setState(ids.w401, ids.g, 'offline');
  T('offline again while the alert is open does not open a second', (await openAlerts(ids.w401)).length === 1);
  await setState(ids.w401, ids.g, 'online');
  T('back online resolves the alert', (await openAlerts(ids.w401)).length === 0);
  T('people and PCs cannot write the history', await db.tx(S, c => c.query("insert into br.state_log (device_id, hospital_id, state) values ($1, $2, 'online')", [ids.w401, ids.g])).then(() => false, e => /permission denied/.test(e.message)));

  /* ---------- uptime arithmetic on a known history ---------- */
  // replace the history with exact stretches: two days ago midnight to now, board 512 offline 6 hours on day one
  await owner.query('delete from br.state_log');
  await owner.query("delete from br.alerts");
  const tz = 'America/New_York';
  const D = (await owner.query("select ((now() at time zone $1)::date - 2)::text d, ((now() at time zone $1)::date)::text t", [tz])).rows[0];
  const at = (dayOff, h) => `((${"'" + D.d + "'"}::date + ${dayOff})::timestamp + interval '${h} hours') at time zone '${tz}'`;
  const put = (dev, h, st, a, b) => owner.query(`insert into br.state_log (device_id, hospital_id, state, started_at, ended_at) values ($1, $2, $3, ${a}, ${b})`, [dev, h, st]);
  await put(ids.w512, ids.g, 'online', at(0, 0), at(0, 6));
  await put(ids.w512, ids.g, 'offline', at(0, 6), at(0, 12));
  await put(ids.w512, ids.g, 'online', at(0, 12), at(2, 0));
  await put(ids.w512, ids.g, 'paused', at(2, 0), 'null');
  await put(ids.w401, ids.g, 'online', at(0, 0), at(1, 0));
  await put(ids.w401, ids.g, 'unknown', at(1, 0), at(2, 0));
  await put(ids.w401, ids.g, 'online', at(2, 0), 'null');
  await put(ids.ball, ids.b, 'offline', at(0, 0), 'null');
  const two = { from: D.d, to: (await owner.query("select ($1::date + 1)::text d", [D.d])).rows[0].d };
  const up = await rep.report(HCI, 'uptime', qs(Object.assign({ hospital: ids.g }, two)));
  const r512 = up.rows.find(x => x.id === ids.w512), r401 = up.rows.find(x => x.id === ids.w401);
  T('512: 6 of 48 hours down is 87.5%', r512 && r512.uptime === 87.5 && Math.round(r512.down_s) === 6 * 3600, r512 && [r512.uptime, r512.down_s]);
  T('512: one outage, longest 6 hours', r512.outages === 1 && Math.round(r512.longest_s) === 6 * 3600);
  T('401: a day nobody could watch neither helps nor hurts (100%)', r401 && r401.uptime === 100 && Math.round(r401.other_s) === 86400, r401 && [r401.uptime, r401.other_s]);
  T('a board with no history shows no uptime, not 0%', up.rows.find(x => x.id === ids.w1205).uptime === null);
  T('worst first: 512 tops the uptime report', up.rows[0].id === ids.w512);
  T('daily: day one is 512 at 75% plus 401 at 100%', up.days.length === 2 && up.days[0].uptime === Math.round(42 / 48 * 10000) / 100, up.days);
  T('daily: day two is 100%', up.days[1].uptime === 100);
  T('summary across the hospital', up.summary.boards === 4 && up.summary.outages === 1 && up.summary.unwatched === 2);

  /* ---------- filters ---------- */
  const n = async o => (await rep.report(HCI, 'inventory', qs(Object.assign({ hospital: ids.g }, o)))).rows.length;
  T('filter by type: one door sign', await n({ kind: 'ds' }) === 1);
  T('filter by floor 4 (from room numbers)', await n({ floor: '4' }) === 2);
  T('filter by floor 12 (room 1205B)', await n({ floor: '12' }) === 1);
  T('filter by unit', await n({ unit: '5 East' }) === 1);
  T('filter by closet', await n({ closet: 'IDF 4' }) === 2);
  T('filter by Board Remote PC', await n({ pc: ids.ag2 }) === 2);
  T('filters combine', await n({ floor: '4', kind: 'wb' }) === 1);
  await db.tx(S, c => c.query("update br.devices set floor = 'L' where id = $1", [ids.w512]));
  T('a floor set by hand is used for the filter', await n({ floor: 'L' }) === 1 && await n({ floor: '5' }) === 0);

  /* ---------- who sees what ---------- */
  const dashIt = await rep.dashboard(U(ids.it), qs({ hospital: 'all' }));
  T('hospital IT dashboard counts only their hospital', dashIt.totals.boards === 4 && dashIt.options.hospitals.length === 1);
  T('one hospital groups by unit', dashIt.by === 'unit');
  T('hospital IT cannot ask for another hospital', await rep.dashboard(U(ids.it), qs({ hospital: ids.b })).then(() => false, e => e.status === 404));
  T('hospital IT cannot pull a report for another hospital', await rep.report(U(ids.it), 'uptime', qs({ hospital: ids.b })).then(() => false, e => e.status === 404));
  const dashH = await rep.dashboard(HCI, qs({ hospital: 'all' }));
  T('HCI sees every hospital, grouped by hospital', dashH.totals.boards === 5 && dashH.by === 'hospital' && dashH.groups.length === 2);
  T('filter options come from the boards', dashH.options.floors.join() === '1,4,12,L' && dashH.options.units.length === 4 && dashH.options.pcs.length === 2, dashH.options.floors);

  /* ---------- alerts and acknowledging ---------- */
  await setState(ids.w1205, ids.g, 'online', { kind: 'agent', agentId: ids.ag2 });
  await setState(ids.w1205, ids.g, 'offline', { kind: 'agent', agentId: ids.ag2 });
  const d2 = await rep.dashboard(U(ids.it), qs({ hospital: ids.g }));
  const a1 = d2.alerts.find(a => a.room === '1205B');
  T('the dashboard lists the open alert', a1 && !a1.acked_at && d2.totals.alertsUnacked === 1);
  T('a type filter that excludes the board hides its alert', (await rep.dashboard(U(ids.it), qs({ hospital: ids.g, kind: 'ds' }))).alerts.length === 0);
  const ack = await rep.ack(U(ids.it), a1.id);
  T('hospital IT acknowledges it', ack.ok && emitted.indexOf(ids.g) >= 0);
  T('acknowledging twice says so', !(await rep.ack(U(ids.it), a1.id)).ok);
  const audit = (await owner.query("select actor_user from br.audit_log where action = 'alert.acked'")).rows;
  T('the acknowledgement is in the audit log', audit.length === 1 && audit[0].actor_user === ids.it);
  const ar = await rep.report(HCI, 'alerts', qs({ hospital: ids.g }));
  T('alerts report shows who acknowledged it', ar.rows.length === 1 && ar.rows[0].acked_by_name === 'Goshen IT' && ar.rows[0].ack_min === 0 && ar.summary.open === 1);
  await db.tx(S, c => c.query("insert into br.alerts (hospital_id, agent_id, kind, title) values ($1, $2, 'pc_offline', 'Goshen PC 5E lost its connection')", [ids.g, ids.ag2]));
  const ar2 = await rep.report(HCI, 'alerts', qs({ hospital: ids.g }));
  T('PC alerts count when no board filter is set', ar2.summary.pcs === 1);
  T('PC alerts drop out with a board filter', (await rep.report(HCI, 'alerts', qs({ hospital: ids.g, unit: 'Tower' }))).summary.pcs === 0);
  T('hospital IT cannot acknowledge a Ball alert', await (async () => {
    const x = (await owner.query("insert into br.alerts (hospital_id, device_id, kind, title) values ($1, $2, 'board_offline', 'Room 101 went offline') returning id", [ids.b, ids.ball])).rows[0];
    return !(await rep.ack(U(ids.it), x.id)).ok;
  })());

  /* ---------- activity ---------- */
  await db.tx(U(ids.it), async c => {
    const cm = await c.query("insert into br.commands (hospital_id, device_id, agent_id, action, args, created_by, status) values ($1, $2, $3, 'act', '{\"key\":\"restart\"}', $4, 'done'), ($1, $2, $3, 'act', '{\"key\":\"reboot\"}', $4, 'failed') returning id", [ids.g, ids.w401, ids.ag, ids.it]);
    for (const x of cm.rows) await db.audit(c, U(ids.it), { hospitalId: ids.g, deviceId: ids.w401, action: 'command.act', details: { command: x.id } });
  });
  const act = await rep.report(HCI, 'activity', qs({ hospital: ids.g }));
  T('activity counts commands and their results', act.summary.commands === 2 && act.summary.done === 1 && act.summary.failed === 1 && act.summary.success === 50);
  T('activity lists each person', act.summary.people.some(p => p.who === 'Goshen IT' && p.commands === 2));
  T('activity respects a board filter', (await rep.report(HCI, 'activity', qs({ hospital: ids.g, kind: 'ds' }))).summary.commands === 0);

  await db.tx(HCI, c => db.audit(c, HCI, { hospitalId: ids.g, deviceId: ids.w401, action: 'device.placement', details: {} }));
  const actIt = await rep.report(U(ids.it), 'activity', qs({ hospital: ids.g }));
  T('hospital IT sees HCI staff as HCI ONE support, not a blank', actIt.rows.some(l => l.user_name === 'HCI ONE support') && !actIt.rows.some(l => l.actor_kind === 'user' && !l.user_name));

  /* ---------- floor and the HCI lock ---------- */
  await db.tx(HCI, c => c.query('update br.devices set location_locked = true where id = $1', [ids.w401]));
  T('a locked board\'s floor cannot change', await db.tx(U(ids.it), c => c.query("update br.devices set floor = '9' where id = $1", [ids.w401])).then(() => false, e => /locked by HCI/.test(e.message)));

  T('an unknown report is refused', await rep.report(HCI, 'nope', qs({})).then(() => false, e => e.status === 404));
  T('a bad time zone falls back to Eastern', (await rep.report(HCI, 'inventory', qs({ tz: "x'; drop table br.devices; --" }))).range.tz === 'America/New_York');
  await owner.end();
};
