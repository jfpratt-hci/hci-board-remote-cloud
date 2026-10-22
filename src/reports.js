'use strict';
/* Dashboard and reports. Every query runs as the signed in person, so row level security decides
   which hospitals, boards, alerts and audit rows count: HCI sees every hospital, a hospital's own
   people see only theirs. Nothing here reads screen content; the cloud never has any.

   Uptime comes from br.state_log, one row per stretch of time a board spent in one state.
     up        online, heartbeat late, needs a look (the board is there and answering)
     down      offline
     unwatched checking or paused (no Board Remote could see it, or someone paused it)
   Uptime % = up / (up + down), so time nobody could watch neither helps nor hurts a board.

   Filters, the same for the dashboard and every report:
     hospital  a hospital id, or all (every hospital this person can see)
     kind, floor, unit, closet, pc (a Board Remote PC id)
     from, to  local dates YYYY-MM-DD, to included; tz the viewer's time zone */
const db = require('./db');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UP = "('online', 'late', 'degraded')";
const bad = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const pct = (up, down) => up + down > 0 ? Math.round(up / (up + down) * 10000) / 100 : null;
const day = d => d.toISOString().slice(0, 10);

function create(agents) {
  /* ---------- scope: which hospitals, which boards, which days ---------- */
  async function scope(c, q) {
    const vis = (await c.query('select id, name from br.hospitals order by name')).rows;
    const want = clip(q.get('hospital'), 36) || 'all';
    let hs;
    if (want === 'all') hs = vis;
    else { if (!GUID.test(want)) throw bad(400, 'Unknown hospital.'); hs = vis.filter(h => h.id === want); if (!hs.length) throw bad(404, 'Unknown hospital.'); }
    let tz = clip(q.get('tz'), 64) || 'America/New_York';
    if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz) || !(await c.query('select 1 from pg_timezone_names where name = $1', [tz])).rowCount) tz = 'America/New_York';
    const today = (await c.query('select (now() at time zone $1)::date::text d', [tz])).rows[0].d;
    let to = clip(q.get('to'), 10), from = clip(q.get('from'), 10);
    if (!DATE.test(to)) to = today;
    if (!DATE.test(from)) { const f = new Date(to + 'T00:00:00Z'); f.setUTCDate(f.getUTCDate() - 6); from = day(f); }
    if (from > to) [from, to] = [to, from];
    if ((new Date(to) - new Date(from)) / 864e5 > 400) throw bad(400, 'Pick a range of 400 days or less.');
    const b = (await c.query("select ($1::date::timestamp at time zone $3) a, (($2::date + 1)::timestamp at time zone $3) b", [from, to, tz])).rows[0];
    const f = { kind: clip(q.get('kind'), 10), floor: clip(q.get('floor'), 20), unit: clip(q.get('unit'), 40), closet: clip(q.get('closet'), 40), pc: clip(q.get('pc'), 36) };
    if (f.pc && !GUID.test(f.pc)) f.pc = '';
    return { hs, ids: hs.map(h => h.id), tz, from, to, a: b.a, b: b.b, f, boardFilter: !!(f.kind || f.floor || f.unit || f.closet) };
  }
  // the boards in scope, as a CTE named dv; params: $1 hospital ids, $2 kind, $3 floor, $4 unit, $5 closet, $6 pc
  const DV = `dv as (select d.id, d.hospital_id, h.name hname, d.kind, d.name, d.identity, d.model, d.android, d.room, d.unit, d.closet,
      br.floor_of(d.room, d.floor) floor, d.floor floor_set, d.location_locked locked
    from br.devices d join br.hospitals h on h.id = d.hospital_id
    where d.hospital_id = any($1::uuid[]) and ($2 = '' or d.kind = $2) and ($3 = '' or br.floor_of(d.room, d.floor) = $3)
      and ($4 = '' or d.unit = $4) and ($5 = '' or d.closet = $5)
      and ($6 = '' or exists (select 1 from br.device_reach r where r.device_id = d.id and r.agent_id::text = $6)))`;
  const P = s => [s.ids, s.f.kind, s.f.floor, s.f.unit, s.f.closet, s.f.pc];

  // seconds up, down and unwatched for each board in scope between $7 and $8
  const PER_BOARD = `with ${DV}
    select dv.*, coalesce(st.state, 'unknown') state, st.last_beat,
      coalesce(sum(o.secs) filter (where o.state in ${UP}), 0)::float8 up_s,
      coalesce(sum(o.secs) filter (where o.state = 'offline'), 0)::float8 down_s,
      coalesce(sum(o.secs) filter (where o.state not in ${UP} and o.state <> 'offline'), 0)::float8 other_s,
      count(*) filter (where o.state = 'offline' and o.started_at >= $7)::int outages,
      coalesce(max(o.secs) filter (where o.state = 'offline'), 0)::float8 longest_s
    from dv left join br.device_state st on st.device_id = dv.id
    left join lateral (select l.state, l.started_at,
        extract(epoch from least(coalesce(l.ended_at, now()), $8, now()) - greatest(l.started_at, $7)) secs
      from br.state_log l where l.device_id = dv.id and l.started_at < least($8, now()) and coalesce(l.ended_at, now()) > $7) o on true
    group by dv.id, dv.hospital_id, dv.hname, dv.kind, dv.name, dv.identity, dv.model, dv.android, dv.room, dv.unit, dv.closet, dv.floor, dv.floor_set, dv.locked, st.state, st.last_beat`;
  const perBoard = (c, s) => c.query(PER_BOARD, P(s).concat([s.a, s.b])).then(r => r.rows.map(x => Object.assign(x, { uptime: pct(x.up_s, x.down_s) })));

  // fleet uptime for each local day in the range
  async function daily(c, s) {
    const r = await c.query(`with ${DV}, g as (select d::date dd, (d at time zone $9) ds, ((d + interval '1 day') at time zone $9) de
          from generate_series($7::date::timestamp, $8::date::timestamp, interval '1 day') d)
      select g.dd::text as day,
        coalesce(sum(extract(epoch from least(coalesce(l.ended_at, now()), g.de, now()) - greatest(l.started_at, g.ds))) filter (where l.state in ${UP}), 0)::float8 up_s,
        coalesce(sum(extract(epoch from least(coalesce(l.ended_at, now()), g.de, now()) - greatest(l.started_at, g.ds))) filter (where l.state = 'offline'), 0)::float8 down_s,
        count(*) filter (where l.state = 'offline' and l.started_at >= g.ds)::int outages
      from g left join (br.state_log l join dv on dv.id = l.device_id) on l.started_at < least(g.de, now()) and coalesce(l.ended_at, now()) > g.ds
      group by g.dd order by g.dd`, P(s).concat([s.from, s.to, s.tz]));
    return r.rows.map(x => ({ day: x.day, up_s: x.up_s, down_s: x.down_s, outages: x.outages, uptime: pct(x.up_s, x.down_s) }));
  }
  // what the filters can be set to, from the boards this person can see in the chosen hospitals
  async function options(c, s) {
    const r = (await c.query(`select coalesce(json_agg(distinct d.kind) filter (where d.kind <> ''), '[]') kinds,
        coalesce(json_agg(distinct br.floor_of(d.room, d.floor)) filter (where br.floor_of(d.room, d.floor) <> ''), '[]') floors,
        coalesce(json_agg(distinct d.unit) filter (where d.unit <> ''), '[]') units,
        coalesce(json_agg(distinct d.closet) filter (where d.closet <> ''), '[]') closets
      from br.devices d where d.hospital_id = any($1::uuid[])`, [s.ids])).rows[0];
    const pcs = (await c.query('select a.id, a.name, h.name hname from br.agents a join br.hospitals h on h.id = a.hospital_id where a.hospital_id = any($1::uuid[]) and a.revoked_at is null order by h.name, a.name', [s.ids])).rows;
    const nat = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true });
    return { kinds: r.kinds.sort(), floors: r.floors.sort(nat), units: r.units.sort(nat), closets: r.closets.sort(nat), pcs, hospitals: s.hs };
  }
  // alerts that belong to the scope: board alerts for boards in scope, PC alerts unless a board filter is set
  const ALERTS = `select al.id, al.kind, al.title, al.opened_at, al.acked_at, al.resolved_at, al.hospital_id, h.name hname,
      dv.room, dv.unit, dv.floor, dv.kind board_kind, ag.name pc, coalesce(u.name, case when br.hci_user(al.acked_by) then 'HCI ONE support' end) acked_by_name, u.email acked_by_email
    from br.alerts al join br.hospitals h on h.id = al.hospital_id
    left join dv on dv.id = al.device_id left join br.agents ag on ag.id = al.agent_id left join br.users u on u.id = al.acked_by
    where al.hospital_id = any($1::uuid[]) and ((al.device_id is not null and dv.id is not null) or (al.device_id is null and not $7::boolean and ($6 = '' or al.agent_id::text = $6)))`;
  const ALERT_P = s => P(s).concat([s.boardFilter]);

  /* ---------- the dashboard ---------- */
  async function dashboard(A, q) {
    return db.tx(A, async c => {
      const s = await scope(c, q);
      const boards = await perBoard(c, s);
      const days = await daily(c, s);
      const now = { online: 0, warn: 0, offline: 0, other: 0 };
      for (const b of boards) now[b.state === 'online' ? 'online' : b.state === 'offline' ? 'offline' : (b.state === 'late' || b.state === 'degraded') ? 'warn' : 'other']++;
      const sum = (list, k) => list.reduce((n, x) => n + (x[k] || 0), 0);
      const pcs = (await c.query('select id, hospital_id from br.agents where hospital_id = any($1::uuid[]) and revoked_at is null' + (s.f.pc ? ' and id::text = $2' : ''), s.f.pc ? [s.ids, s.f.pc] : [s.ids])).rows;
      // by hospital when more than one is in view, otherwise by unit
      const byHosp = s.hs.length > 1;
      const groups = new Map();
      for (const b of boards) {
        const key = byHosp ? b.hname : (b.unit || 'No unit set');
        if (!groups.has(key)) groups.set(key, { name: key, hospital_id: byHosp ? b.hospital_id : null, boards: 0, online: 0, offline: 0, up_s: 0, down_s: 0, outages: 0 });
        const g = groups.get(key);
        g.boards++; if (b.state === 'online' || b.state === 'late' || b.state === 'degraded') g.online++; if (b.state === 'offline') g.offline++;
        g.up_s += b.up_s; g.down_s += b.down_s; g.outages += b.outages;
      }
      const alerts = (await c.query(`with ${DV} ${ALERTS} and al.resolved_at is null order by al.opened_at desc limit 100`, ALERT_P(s))).rows;
      return {
        ok: true, range: { from: s.from, to: s.to, tz: s.tz }, by: byHosp ? 'hospital' : 'unit',
        totals: { boards: boards.length, now, uptime: pct(sum(boards, 'up_s'), sum(boards, 'down_s')), down_s: sum(boards, 'down_s'), outages: sum(boards, 'outages'),
          pcs: pcs.length, pcsOnline: pcs.filter(p => agents.isOnline(p.id)).length, alertsOpen: alerts.length, alertsUnacked: alerts.filter(a => !a.acked_at).length },
        days,
        groups: [...groups.values()].map(g => Object.assign(g, { uptime: pct(g.up_s, g.down_s) })).sort((x, y) => (x.uptime === null) - (y.uptime === null) || (x.uptime || 0) - (y.uptime || 0) || x.name.localeCompare(y.name, undefined, { numeric: true })),
        worst: boards.filter(b => b.down_s > 0).sort((x, y) => y.down_s - x.down_s).slice(0, 10)
          .map(b => ({ id: b.id, hname: b.hname, kind: b.kind, room: b.room, unit: b.unit, floor: b.floor, name: b.name, state: b.state, uptime: b.uptime, down_s: b.down_s, outages: b.outages })),
        alerts,
        options: await options(c, s)
      };
    });
  }

  /* ---------- reports ---------- */
  async function report(A, kind, q) {
    return db.tx(A, async c => {
      const s = await scope(c, q);
      const base = { ok: true, kind, range: { from: s.from, to: s.to, tz: s.tz }, hospitals: s.hs.map(h => h.name), filters: s.f };
      if (kind === 'uptime') {
        const rows = (await perBoard(c, s)).sort((x, y) => (x.uptime === null) - (y.uptime === null) || (x.uptime || 0) - (y.uptime || 0) || y.down_s - x.down_s);
        const up = rows.reduce((n, x) => n + x.up_s, 0), down = rows.reduce((n, x) => n + x.down_s, 0);
        return Object.assign(base, { rows, days: await daily(c, s), summary: { boards: rows.length, uptime: pct(up, down), down_s: down, outages: rows.reduce((n, x) => n + x.outages, 0), perfect: rows.filter(x => x.down_s === 0 && x.up_s > 0).length, unwatched: rows.filter(x => x.up_s + x.down_s === 0).length } });
      }
      if (kind === 'alerts') {
        const rows = (await c.query(`with ${DV} ${ALERTS} and al.opened_at >= $8 and al.opened_at < $9 order by al.opened_at desc limit 5000`, ALERT_P(s).concat([s.a, s.b]))).rows
          .map(x => Object.assign(x, { ack_min: x.acked_at ? Math.round((new Date(x.acked_at) - new Date(x.opened_at)) / 6e4) : null, fix_min: x.resolved_at ? Math.round((new Date(x.resolved_at) - new Date(x.opened_at)) / 6e4) : null }));
        const med = a => { const v = a.filter(x => x !== null).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
        const rep = new Map();
        for (const x of rows) if (x.kind === 'board_offline') { const k = x.hname + '|' + (x.room || x.title); rep.set(k, Object.assign(rep.get(k) || { hname: x.hname, room: x.room, unit: x.unit, title: x.title, n: 0 }, {})); rep.get(k).n++; }
        return Object.assign(base, { rows, summary: { total: rows.length, open: rows.filter(x => !x.resolved_at).length, unacked: rows.filter(x => !x.acked_at && !x.resolved_at).length,
          boards: rows.filter(x => x.kind === 'board_offline').length, pcs: rows.filter(x => x.kind === 'pc_offline').length, medAck: med(rows.map(x => x.ack_min)), medFix: med(rows.map(x => x.fix_min)),
          repeat: [...rep.values()].filter(x => x.n >= 2).sort((x, y) => y.n - x.n).slice(0, 10) } });
      }
      if (kind === 'inventory') {
        const rows = (await c.query(`with ${DV} select dv.*, coalesce(st.state, 'unknown') state, st.last_beat, st.updated_at state_at,
            (select json_build_object('pc', a.name, 'version', a.version, 'host', r.host) from br.device_reach r join br.agents a on a.id = r.agent_id where r.device_id = dv.id order by r.is_primary desc, r.online desc limit 1) seen_by
          from dv left join br.device_state st on st.device_id = dv.id order by dv.hname, dv.unit, dv.room, dv.kind`, P(s))).rows;
        const count = k => rows.reduce((m, x) => { const v = x[k] || 'Not set'; m[v] = (m[v] || 0) + 1; return m; }, {});
        return Object.assign(base, { rows, summary: { boards: rows.length, byKind: count('kind'), byModel: count('model'), byAndroid: count('android'), byUnit: count('unit'), locked: rows.filter(x => x.locked).length } });
      }
      if (kind === 'activity') {
        const rows = (await c.query(`with ${DV} select l.id, l.at, l.action, l.details, l.origin, l.result, l.actor_kind, coalesce(u.name, case when br.hci_user(l.actor_user) then 'HCI ONE support' end) user_name, u.email user_email, a.name pc, h.name hname, dv.room, dv.kind board_kind
            from br.audit_log l join br.hospitals h on h.id = l.hospital_id left join br.users u on u.id = l.actor_user left join br.agents a on a.id = l.actor_agent left join dv on dv.id = l.device_id
            where l.hospital_id = any($1::uuid[]) and l.at >= $7 and l.at < $8 and l.action <> 'user.sign_in'
              and (not $9::boolean or dv.id is not null) and ($6 = '' or l.actor_agent is null or l.actor_agent::text = $6)
            order by l.id desc limit 5000`, P(s).concat([s.a, s.b, s.boardFilter]))).rows;
        const cmds = (await c.query(`with ${DV} select cm.action, cm.status, cm.args, cm.created_at, cm.done_at, coalesce(u.name, case when br.hci_user(cm.created_by) then 'HCI ONE support' end) user_name, u.email user_email
            from br.commands cm join dv on dv.id = cm.device_id left join br.users u on u.id = cm.created_by
            where cm.created_at >= $7 and cm.created_at < $8 and ($6 = '' or cm.agent_id::text = $6)`, P(s).concat([s.a, s.b]))).rows;
        const people = new Map();
        for (const x of rows) {
          const who = x.user_name || x.user_email || x.pc || (x.actor_kind === 'system' ? 'Board Remote Cloud' : 'Unknown');
          const p = people.get(who) || { who, kind: x.user_email ? 'person' : x.pc ? 'pc' : 'system', actions: 0, commands: 0, changes: 0 };
          p.actions++; if (/^command\./.test(x.action) && x.action !== 'command.result') p.commands++; else if (/^device\.|^hospital\.|^person\./.test(x.action)) p.changes++;
          people.set(who, p);
        }
        const st = k => cmds.filter(x => x.status === k).length;
        const fixes = cmds.reduce((m, x) => { const k = x.action === 'act' ? (x.args && x.args.key) || 'fix' : x.action; m[k] = m[k] || { name: k, n: 0, done: 0 }; m[k].n++; if (x.status === 'done') m[k].done++; return m; }, {});
        return Object.assign(base, { rows, summary: { actions: rows.length, commands: cmds.length, done: st('done'), failed: st('failed'), expired: st('expired'), waiting: st('queued') + st('sent'),
          success: cmds.length - st('queued') - st('sent') ? Math.round(st('done') / (cmds.length - st('queued') - st('sent')) * 1000) / 10 : null,
          people: [...people.values()].sort((x, y) => y.actions - x.actions), fixes: Object.values(fixes).sort((x, y) => y.n - x.n) } });
      }
      throw bad(404, 'Unknown report.');
    });
  }

  /* ---------- acknowledge an alert ---------- */
  async function ack(A, id) {
    const r = await db.tx(A, async c => {
      const x = (await c.query('update br.alerts set acked_at = now(), acked_by = $2 where id = $1 and acked_at is null returning hospital_id, device_id, title, kind', [id, A.userId])).rows[0];
      if (!x) return null;
      await db.audit(c, A, { hospitalId: x.hospital_id, deviceId: x.device_id, action: 'alert.acked', details: { alert: id, title: x.title, kind: x.kind } });
      return x;
    });
    if (!r) return { ok: false, message: 'Already acknowledged, or not an alert you can see.' };
    agents.emit(r.hospital_id, { t: 'fleet' });
    return { ok: true, message: 'Acknowledged. Everyone watching sees who has it.' };
  }

  return { dashboard, report, ack };
}

module.exports = { create, pct };
