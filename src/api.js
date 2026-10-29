'use strict';
/* The web app's API. Every call runs as the signed in user, so row level security in the database
   decides what each person sees: a Goshen IT lead never gets a row from another hospital, whatever
   is asked. Every change writes its audit row in the same transaction. */
const db = require('./db');

const ROLES = ['hci_admin', 'hci_tech', 'dealer', 'hospital_it'];
const ROLE_NAME = { hci_admin: 'HCI admin', hci_tech: 'HCI tech', dealer: 'Dealer', hospital_it: 'Hospital IT' };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const bad = (status, message) => Object.assign(new Error(message), { status });

function create(agents, updates, reports, containers) {
  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[0-9a-f-]{36})') + '$'), fn });

  /* ---------- me ---------- */
  on('GET', '/api/me', async (A) => {
    const hospitals = (await db.tx(A, c => c.query('select id, name from br.hospitals order by name'))).rows;
    return { ok: true, user: A.user, hospitals, roleNames: ROLE_NAME };
  });

  /* ---------- hospitals ---------- */
  on('GET', '/api/hospitals', async (A) => {
    const r = await db.tx(A, c => c.query(`select h.id, h.name, h.entra_tenant_id, h.update_mode, h.update_ring,
        (select count(*)::int from br.devices d where d.hospital_id = h.id) devices,
        (select count(*)::int from br.device_state s where s.hospital_id = h.id and s.state in ('online', 'late', 'degraded')) up,
        (select count(*)::int from br.device_state s where s.hospital_id = h.id and s.state = 'offline') down,
        (select count(*)::int from br.devices d where d.hospital_id = h.id and d.location_locked) locked,
        (select json_agg(a.id) from br.agents a where a.hospital_id = h.id and a.revoked_at is null) agent_ids
      from br.hospitals h order by h.name`));
    return { ok: true, hospitals: r.rows.map(h => Object.assign(h, { pcs: (h.agent_ids || []).length, pcsOnline: (h.agent_ids || []).filter(agents.isOnline).length, agent_ids: undefined })) };
  });
  on('POST', '/api/hospitals', async (A, b) => {
    const name = clip(b.name, 120); if (!name) throw bad(400, 'Give the hospital a name.');
    const tid = clip(b.entraTenantId, 36).toLowerCase(); if (tid && !GUID.test(tid)) throw bad(400, 'The Microsoft tenant ID is a 36 character ID like 1a2b3c4d-....');
    const h = await db.tx(A, async c => {
      const x = (await c.query('insert into br.hospitals (name, entra_tenant_id) values ($1, $2) returning id, name', [name, tid || null])).rows[0];
      await db.audit(c, A, { hospitalId: x.id, action: 'hospital.created', details: { name, tenant: tid || null } });
      return x;
    });
    return { ok: true, hospital: h, message: name + ' added.' };
  });
  on('PATCH', '/api/hospitals/:id', async (A, b, p) => {
    const tid = b.entraTenantId === undefined ? undefined : clip(b.entraTenantId, 36).toLowerCase();
    if (tid && !GUID.test(tid)) throw bad(400, 'The Microsoft tenant ID is a 36 character ID.');
    await db.tx(A, async c => {
      const r = await c.query('update br.hospitals set name = coalesce($2, name), entra_tenant_id = case when $3::boolean then $4 else entra_tenant_id end where id = $1 returning id',
        [p.id, b.name ? clip(b.name, 120) : null, tid !== undefined, tid || null]);
      if (!r.rowCount) throw bad(403, 'Only HCI can change a hospital.');
      await db.audit(c, A, { hospitalId: p.id, action: 'hospital.updated', details: { name: b.name, tenant: tid } });
    });
    return { ok: true, message: 'Saved.' };
  });

  /* ---------- the fleet: every board in the hospital, across every PC ---------- */
  on('GET', '/api/hospitals/:id/fleet', async (A, b, p) => {
    const r = await db.tx(A, async c => {
      const h = (await c.query('select id, name from br.hospitals where id = $1', [p.id])).rows[0];
      if (!h) throw bad(404, 'Unknown hospital.');
      const devices = (await c.query(`select d.id, d.identity, d.kind, d.name, d.model, d.android, d.room, d.unit, d.closet, d.floor floor_set, br.floor_of(d.room, d.floor) floor, d.location_locked locked, d.locked_at,
          lu.name locked_by_name, coalesce(s.state, 'unknown') state, s.headline, s.last_beat, s.updated_at state_at,
          (select json_agg(json_build_object('agent', r.agent_id, 'pc', a.name, 'online', r.online, 'primary', r.is_primary, 'host', r.host) order by r.is_primary desc)
             from br.device_reach r join br.agents a on a.id = r.agent_id where r.device_id = d.id) reach
        from br.devices d left join br.device_state s on s.device_id = d.id left join br.users lu on lu.id = d.locked_by
        where d.hospital_id = $1 order by d.unit, d.room, d.kind`, [p.id])).rows;
      const pcs = (await c.query('select id, name, pc_name, version, last_seen, enrolled_at, service, update_state, update_version, update_detail, update_at from br.agents where hospital_id = $1 and revoked_at is null order by name', [p.id])).rows;
      const upd = (await c.query('select update_mode, update_ring, (select version from br.br_releases where id = br.target_release($1)) target from br.hospitals where id = $1', [p.id])).rows[0];
      h.updates = upd;
      return { hospital: h, devices, pcs: pcs.map(x => Object.assign(x, { online: agents.isOnline(x.id) })) };
    });
    return Object.assign({ ok: true }, r);
  });

  /* ---------- placement and the HCI lock ---------- */
  on('PATCH', '/api/devices/:id', async (A, b, p) => {
    const set = {}; for (const f of ['room', 'unit', 'closet', 'floor']) if (b[f] !== undefined) set[f] = clip(b[f], f === 'room' || f === 'floor' ? 20 : 40);
    const keys = Object.keys(set); if (!keys.length) throw bad(400, 'Nothing to change.');
    await db.tx(A, async c => {
      const d = (await c.query('select * from br.devices where id = $1 for update', [p.id])).rows[0];
      if (!d) throw bad(404, 'Unknown board.');
      const ts = Object.assign({}, d.placement_ts); keys.forEach(k => { ts[k] = Date.now(); });
      await c.query('update br.devices set ' + keys.map((k, i) => k + ' = $' + (i + 2)).join(', ') + ', placement_ts = $' + (keys.length + 2) + ' where id = $1', [p.id].concat(keys.map(k => set[k]), [ts]));
      await db.audit(c, A, { hospitalId: d.hospital_id, deviceId: d.id, action: 'device.placement', details: { from: keys.reduce((o, k) => (o[k] = d[k], o), {}), to: set } });
    });
    await agents.fanOut(p.id, null);
    return { ok: true, message: 'Saved. Every Board Remote watching this board is updated.' };
  });
  on('POST', '/api/devices/:id/lock', async (A, b, p) => {
    if (!A.canLock) throw bad(403, 'Only HCI can lock or unlock a location.');
    const locked = !!b.locked;
    await db.tx(A, async c => {
      const d = (await c.query('update br.devices set location_locked = $2 where id = $1 and location_locked <> $2 returning hospital_id, room, unit, closet', [p.id, locked])).rows[0];
      if (d) await db.audit(c, A, { hospitalId: d.hospital_id, deviceId: p.id, action: locked ? 'device.locked' : 'device.unlocked', details: { room: d.room, unit: d.unit, closet: d.closet } });
    });
    await agents.fanOut(p.id, null);
    return { ok: true, message: locked ? 'Location locked.' : 'Location unlocked. Lock it again once it is right.' };
  });
  on('POST', '/api/hospitals/:id/lock', async (A, b, p) => {
    if (!A.canLock) throw bad(403, 'Only HCI can lock or unlock locations.');
    const locked = !!b.locked, unit = b.unit === undefined ? null : clip(b.unit, 40);
    const ids = await db.tx(A, async c => {
      const r = (await c.query('update br.devices set location_locked = $2 where hospital_id = $1 and location_locked <> $2 and ($3::text is null or unit = $3) returning id', [p.id, locked, unit])).rows;
      await db.audit(c, A, { hospitalId: p.id, action: locked ? 'hospital.locked' : 'hospital.unlocked', details: { unit, boards: r.length } });
      return r.map(x => x.id);
    });
    for (const id of ids) await agents.fanOut(id, null);
    return { ok: true, message: (locked ? 'Locked ' : 'Unlocked ') + ids.length + ' board' + (ids.length === 1 ? '' : 's') + (unit ? ' in ' + unit : '') + '.' };
  });

  /* ---------- commands ---------- */
  on('POST', '/api/devices/:id/command', async (A, b, p) => agents.command(A, p.id, String(b.action || ''), b.args || {}));
  on('POST', '/api/hospitals/:id/command', async (A, b, p) => agents.hospitalCommand(A, p.id, String(b.action || '')));
  on('GET', '/api/commands/:id', async (A, b, p) => {
    const r = (await db.tx(A, c => c.query('select id, action, status, result, created_at, done_at from br.commands where id = $1', [p.id]))).rows[0];
    if (!r) throw bad(404, 'Unknown command.');
    return { ok: true, command: r };
  });

  /* ---------- Board Remote PCs ---------- */
  on('POST', '/api/hospitals/:id/codes', async (A, b, p) => {
    const can = await db.tx(A, c => c.query('select 1 from br.hospitals where id = $1', [p.id])).then(r => r.rowCount);
    if (!can) throw bad(404, 'Unknown hospital.');
    const code = await agents.makeCode(A, p.id, clip(b.label, 80));
    return { ok: true, code, message: 'Enter this code in Board Remote within 24 hours. It works once.' };
  });
  on('POST', '/api/agents/:id/revoke', async (A, b, p) => (await agents.revoke(A, p.id)) ? { ok: true, message: 'Removed. That PC can no longer connect.' } : { ok: false, message: 'Unknown or already removed.' });

  /* ---------- people ---------- */
  on('GET', '/api/hospitals/:id/people', async (A, b, p) => {
    const r = await db.tx(A, c => c.query(`select m.id membership, m.role, u.id, u.email, u.name, u.last_login, u.disabled, u.entra_oid is not null signed_in
      from br.memberships m join br.users u on u.id = m.user_id where m.hospital_id = $1 order by u.name, u.email`, [p.id]));
    return { ok: true, people: r.rows };
  });
  on('POST', '/api/hospitals/:id/people', async (A, b, p) => invite(A, p.id, b));
  on('GET', '/api/hci/people', async (A) => {
    if (!A.user.hciRole) throw bad(403, 'HCI only.');
    const r = await db.tx(A, c => c.query(`select m.id membership, m.role, u.id, u.email, u.name, u.last_login, u.disabled, u.entra_oid is not null signed_in
      from br.users u left join br.memberships m on m.user_id = u.id and m.hospital_id is null where u.is_hci order by u.name, u.email`));
    return { ok: true, people: r.rows };
  });
  on('POST', '/api/hci/people', async (A, b) => invite(A, null, b));
  on('DELETE', '/api/memberships/:id', async (A, b, p) => {
    await db.tx(A, async c => {
      const m = (await c.query('delete from br.memberships where id = $1 returning user_id, hospital_id, role', [p.id])).rows[0];
      if (!m) throw bad(403, 'You cannot remove that person.');
      if (m.user_id === A.userId && !m.hospital_id) throw bad(400, 'You cannot remove your own HCI role.');
      await db.audit(c, A, { hospitalId: m.hospital_id, action: 'person.removed', details: { user: m.user_id, role: m.role } });
    });
    return { ok: true, message: 'Removed.' };
  });
  async function invite(A, hospitalId, b) {
    const email = clip(b.email, 200).toLowerCase(), role = String(b.role || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(400, 'Enter their work email.');
    if (ROLES.indexOf(role) < 0) throw bad(400, 'Pick a role.');
    if (hospitalId ? role.indexOf('hci_') === 0 : role.indexOf('hci_') !== 0) throw bad(400, hospitalId ? 'HCI roles are given on the HCI page.' : 'Pick an HCI role.');
    const tid = clip(b.tenantId, 36).toLowerCase(); if (tid && !GUID.test(tid)) throw bad(400, 'The Microsoft tenant ID is a 36 character ID.');
    if (role === 'dealer' && !tid) throw bad(400, 'A dealer signs in with their own company\'s Microsoft account, so enter their Microsoft tenant ID.');
    return db.tx(A, async c => {
      let uid;
      try { uid = (await c.query('select br.invite_user($1, $2, $3, $4) id', [email, clip(b.name, 120), !hospitalId, tid || ''])).rows[0].id; }
      catch (e) { if (/Only an HCI admin/.test(e.message)) throw bad(403, e.message + '.'); throw e; }
      if (!hospitalId) {
        const u = (await c.query('select is_hci from br.users where id = $1', [uid])).rows[0];
        if (!u || !u.is_hci) throw bad(400, 'That email belongs to someone who is not HCI staff.');
      }
      try {
        await c.query('insert into br.memberships (user_id, hospital_id, role, created_by) values ($1, $2, $3, $4) on conflict (user_id, coalesce(hospital_id, \'00000000-0000-0000-0000-000000000000\'::uuid)) do update set role = excluded.role', [uid, hospitalId, role, A.userId]);
      } catch (e) { if (/row-level security/.test(e.message)) throw bad(403, 'You cannot give that role here.'); throw e; }
      await db.audit(c, A, { hospitalId, action: 'person.invited', details: { email, role } });
      return { ok: true, message: email + ' can now sign in with Microsoft as ' + ROLE_NAME[role] + '.' };
    });
  }

  /* ---------- Board Remote program updates ---------- */
  on('GET', '/api/releases', async (A) => { if (!A.user.hciRole) throw bad(403, 'HCI only.'); return updates.list(A); });
  on('POST', '/api/releases', async (A, b) => updates.upload(A, b));
  on('POST', '/api/releases/:id/status', async (A, b, p) => updates.setStatus(A, p.id, String(b.status || '')));
  on('PATCH', '/api/hospitals/:id/updates', async (A, b, p) => updates.setHospital(A, p.id, b));
  on('POST', '/api/agents/:id/approve', async (A, b, p) => updates.approve(A, { agentId: p.id }));
  on('POST', '/api/hospitals/:id/approve', async (A, b, p) => updates.approve(A, { hospitalId: p.id }));

  /* ---------- dashboard and reports ---------- */
  on('GET', '/api/dashboard', async (A, b, p, q) => reports.dashboard(A, q));
  for (const k of ['uptime', 'alerts', 'inventory', 'activity']) on('GET', '/api/reports/' + k, async (A, b, p, q) => reports.report(A, k, q));
  on('POST', '/api/alerts/:id/ack', async (A, b, p) => reports.ack(A, p.id));

  /* ---------- backend containers (cAdvisor) ---------- */
  on('GET', '/api/containers', async (A, b, p, q) => containers.view(A, q));
  on('GET', '/api/containers/events', async (A, b, p, q) => containers.events(A, q));

  /* ---------- audit log ---------- */
  on('GET', '/api/hospitals/:id/audit', async (A, b, p, q) => {
    const lim = Math.min(500, Math.max(1, Number(q.get('limit')) || 200));
    const r = await db.tx(A, c => c.query(`select l.id, l.at, l.action, l.details, l.origin, l.result, l.actor_kind, coalesce(u.name, case when br.hci_user(l.actor_user) then 'HCI ONE support' end) user_name, u.email user_email, a.name pc, d.room, d.kind
      from br.audit_log l left join br.users u on u.id = l.actor_user left join br.agents a on a.id = l.actor_agent left join br.devices d on d.id = l.device_id
      where l.hospital_id = $1 order by l.id desc limit $2`, [p.id, lim]));
    return { ok: true, entries: r.rows };
  });

  async function handle(req, res, url, A, body) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      return r.fn(A, body || {}, m.groups || {}, url.searchParams);
    }
    return undefined;
  }
  return { handle };
}

module.exports = { create, ROLE_NAME };
