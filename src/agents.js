'use strict';
/* The link between each Board Remote install (an agent) and the cloud.
   Enrollment: an HCI or hospital admin makes a one time code for a hospital; Board Remote trades it
   for its own id and secret. The secret is shown to nobody and stored here only as a hash.
   Link: Board Remote dials out to wss://<cloud>/agent and keeps that one connection open. Nothing at
   the hospital is opened to the internet. Over it:
     up    hello (every board it watches), state (heartbeat changes), placement (a room edited
           locally), result (a command finished), containers (cAdvisor numbers, see containers.js)
     down  welcome, placement (a room edited in the cloud or by another tech's PC, or the HCI lock),
           command (a fix someone asked for in the web app)
   A board two techs both reach is one device here, matched by MAC or serial. Its state comes from
   whichever PC most recently reached it. Room, unit and closet follow most recent change wins, field
   by field, except that a location HCI has locked never changes from a Board Remote edit.
   Nothing that could carry patient data (screens, screen text, logs) travels on this link. */
const crypto = require('crypto');
const ws = require('./ws');
const db = require('./db');
const { sha256, b64u, unb64u } = require('./auth');

const PROTO = 1;
const ACTS = ['restart', 'reboot', 'wake', 'clock', 'storage', 'reconnect', 'keeper'];
const ACTIONS = { act: a => ACTS.indexOf(a && a.key) >= 0, led: a => /^(off|white|red|amber|green|blue)$/.test(a && a.color) && /^(solid|flash)$/.test((a && a.mode) || 'solid'), probe: () => true, auditRun: () => true };
const FIELDS = ['room', 'unit', 'closet'];
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATES = ['online', 'late', 'degraded', 'offline', 'unknown', 'paused'];
const clip = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const PC_ALERT_MS = Number(process.env.BR_PC_ALERT_MS) || 120000;
function create(log) {
  log = log || (() => {});
  let containers = null;           // set by the server once both exist
  const conns = new Map();        // agentId -> { sock, hospitalId, actor }
  const listeners = new Set();     // web app live updates: fn(hospitalId, event)
  const emit = (h, e) => listeners.forEach(fn => { try { fn(h, e); } catch (x) { /* ignore */ } });

  /* ---------- enrollment ---------- */
  async function makeCode(actor, hospitalId, label) {
    const raw = Array.from(crypto.randomBytes(12), b => ALPH[b % ALPH.length]).join('');
    await db.tx(actor, async c => {
      await c.query("insert into br.enrollment_codes (hospital_id, code_hash, label, created_by, expires_at) values ($1, $2, $3, $4, now() + interval '24 hours')",
        [hospitalId, sha256(raw), clip(label, 80), actor.userId || null]);
      await db.audit(c, actor, { hospitalId, action: 'agent.code_created', details: { label: clip(label, 80) } });
    });
    return raw.match(/.{4}/g).join(' ');
  }
  async function enroll(code, pcName, version) {
    const raw = normCode(code);
    if (raw.length !== 12) return { ok: false, message: 'That code is not right. It has 12 letters and numbers.' };
    return db.tx(db.SYSTEM, async c => {
      const k = (await c.query('select * from br.enrollment_codes where code_hash = $1 for update', [sha256(raw)])).rows[0];
      if (!k) return { ok: false, message: 'That code is not right. Check it, or ask for a new one.' };
      if (k.used_at) return { ok: false, message: 'That code has already been used. Ask for a new one.' };
      if (new Date(k.expires_at) < new Date()) return { ok: false, message: 'That code has expired. Codes last 24 hours. Ask for a new one.' };
      const secret = crypto.randomBytes(32);
      const a = (await c.query('insert into br.agents (hospital_id, name, pc_name, version, credential_hash, enrolled_by) values ($1, $2, $3, $4, $5, $6) returning id',
        [k.hospital_id, clip(k.label || pcName, 80), clip(pcName, 80), clip(version, 20), sha256(secret), k.created_by])).rows[0];
      await c.query('update br.enrollment_codes set used_at = now(), used_by = $1 where id = $2', [a.id, k.id]);
      const h = (await c.query('select name from br.hospitals where id = $1', [k.hospital_id])).rows[0];
      await db.audit(c, db.SYSTEM, { hospitalId: k.hospital_id, action: 'agent.enrolled', details: { agent: a.id, pc: clip(pcName, 80), version: clip(version, 20) } });
      return { ok: true, agentId: a.id, secret: b64u(secret), hospital: { id: k.hospital_id, name: h.name } };
    });
  }
  async function revoke(actor, agentId) {
    const r = await db.tx(actor, async c => {
      const a = (await c.query('update br.agents set revoked_at = now() where id = $1 and revoked_at is null returning hospital_id', [agentId])).rows[0];
      if (a) await db.audit(c, actor, { hospitalId: a.hospital_id, action: 'agent.revoked', details: { agent: agentId } });
      return a;
    });
    const k = conns.get(agentId); if (k) { k.sock.close(4001, 'Revoked'); conns.delete(agentId); }
    return !!r;
  }

  /* ---------- the WebSocket ---------- */
  async function authAgent(req) {
    const m = /^Bearer ([0-9a-f-]{36})\.([\w-]{40,})$/i.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const a = (await db.tx(db.SYSTEM, c => c.query('select id, hospital_id, credential_hash from br.agents where id = $1 and revoked_at is null', [m[1]]))).rows[0];
    if (!a) return null;
    const got = sha256(unb64u(m[2])), want = a.credential_hash;
    return got.length === want.length && crypto.timingSafeEqual(got, want) ? a : null;
  }
  async function upgrade(req, socket, head) {
    let a;
    try { a = await authAgent(req); } catch (e) { return ws.refuse(socket, 503, 'Try again'); }
    if (!a) return ws.refuse(socket, 401, 'This Board Remote is not enrolled, or was removed. Enroll it again with a new code.');
    const sock = ws.accept(req, socket, head);
    if (!sock) return;
    const old = conns.get(a.id); if (old) old.sock.close(4000, 'Replaced by a newer connection');
    const k = { sock, hospitalId: a.hospital_id, actor: { kind: 'agent', agentId: a.id }, queue: Promise.resolve() };
    conns.set(a.id, k);
    log('agent connected', a.id);
    const ping = setInterval(() => { try { sock.ping(); } catch (e) { /* closing */ } }, 30000);
    sock.on('message', m => {
      if (typeof m !== 'string' || m.length > 4 * 1024 * 1024) return;
      let msg; try { msg = JSON.parse(m); } catch (e) { return; }
      // one message at a time per agent, in order
      k.queue = k.queue.then(() => onMessage(k, a.id, msg)).catch(e => { log('agent message', a.id, e.message); send(k, { t: 'error', message: e.message.slice(0, 200) }); });
    });
    sock.on('close', () => {
      clearInterval(ping);
      if (conns.get(a.id) === k) { conns.delete(a.id); offline(a.id, a.hospital_id).catch(e => log('agent offline', e.message)); }
      log('agent disconnected', a.id);
    });
  }
  const send = (k, msg) => { try { k.sock.send(JSON.stringify(msg)); return true; } catch (e) { return false; } };

  async function offline(agentId, hospitalId) {
    await db.tx({ kind: 'agent', agentId }, async c => {
      await c.query('update br.agents set last_seen = now() where id = $1', [agentId]);
      await c.query('update br.device_reach set online = false where agent_id = $1', [agentId]);
      // devices no other PC can reach now are unknown, not "online" from a stale report
      await c.query(`update br.device_state s set state = 'unknown', headline = 'The Board Remote PC watching this board is offline.', updated_at = now()
        where s.by_agent = $1 and not exists (select 1 from br.device_reach r where r.device_id = s.device_id and r.online)`, [agentId]);
    });
    emit(hospitalId, { t: 'fleet' });
    // a PC that restarts is back within a minute; one still gone after PC_ALERT_MS gets an alert
    setTimeout(() => { if (!conns.has(agentId)) pcAlert(agentId, hospitalId).catch(e => log('pc alert', e.message)); }, PC_ALERT_MS).unref();
  }
  async function pcAlert(agentId, hospitalId) {
    await db.tx({ kind: 'agent', agentId }, async c => {
      const a = (await c.query('select name, revoked_at from br.agents where id = $1', [agentId])).rows[0];
      if (!a || a.revoked_at) return;
      const open = (await c.query("select 1 from br.alerts where agent_id = $1 and kind = 'pc_offline' and resolved_at is null", [agentId])).rowCount;
      if (!open) await c.query("insert into br.alerts (hospital_id, agent_id, kind, title) values ($1, $2, 'pc_offline', $3)", [hospitalId, agentId, a.name + ' lost its connection']);
    });
    emit(hospitalId, { t: 'fleet' });
  }

  /* ---------- messages from Board Remote ---------- */
  async function onMessage(k, agentId, msg) {
    const A = k.actor;
    if (msg.t === 'hello') {
      const boards = Array.isArray(msg.boards) ? msg.boards.slice(0, 2000) : [];
      const fixes = await db.tx(A, async c => {
        await c.query('update br.agents set last_seen = now(), version = $2, pc_name = case when $3 <> \'\' then $3 else pc_name end where id = $1', [agentId, clip(msg.version, 20), clip(msg.pcName, 80)]);
        await c.query("update br.alerts set resolved_at = now() where agent_id = $1 and kind = 'pc_offline' and resolved_at is null", [agentId]);
        const out = [];
        const keep = [];
        boards.sort((x, y) => String(identityOf(x) || '').localeCompare(String(identityOf(y) || '')));
        for (const b of boards) { const f = await upsertBoard(c, k.hospitalId, agentId, b); if (f) out.push(f); keep.push(clip(b.localId, 40)); }
        await c.query('delete from br.device_reach where agent_id = $1 and not (local_board_id = any($2::text[]))', [agentId, keep]);
        return out;
      });
      const h = (await db.tx(A, c => c.query('select id, name from br.hospitals where id = $1', [k.hospitalId]))).rows[0];
      send(k, { t: 'welcome', proto: PROTO, agentId, hospital: h, placements: fixes });
      await flush(agentId);
      emit(k.hospitalId, { t: 'fleet' });
      return;
    }
    if (msg.t === 'state') {
      const ups = Array.isArray(msg.updates) ? msg.updates.slice(0, 2000) : [];
      await db.tx(A, async c => {
        // boards in a fixed order (by device id) so a batch from one PC never locks against another PC's batch in reverse
        const map = new Map((await c.query('select local_board_id, device_id from br.device_reach where agent_id = $1', [agentId])).rows.map(r => [r.local_board_id, r.device_id]));
        ups.sort((x, y) => String(map.get(clip(x.localId, 40)) || '').localeCompare(String(map.get(clip(y.localId, 40)) || '')));
        for (const u of ups) await applyState(c, k.hospitalId, agentId, u);
      });
      emit(k.hospitalId, { t: 'state' });
      return;
    }
    if (msg.t === 'placement') {
      const r = await db.tx(A, c => applyPlacement(c, A, k.hospitalId, agentId, msg));
      if (r && r.correct) send(k, Object.assign({ t: 'placement' }, r.correct));
      if (r && r.changed) { await fanOut(r.deviceId, agentId); emit(k.hospitalId, { t: 'fleet' }); }
      return;
    }
    if (msg.t === 'containers') { if (containers) await containers.ingest(A, k.hospitalId, agentId, msg); return; }
    if (msg.t === 'result') {
      const r = await db.tx(A, async c => {
        const x = (await c.query("update br.commands set status = $2, result = $3, done_at = now() where id = $1 and agent_id = $4 and status in ('sent', 'queued') returning hospital_id, device_id, action, created_by",
          [msg.id, msg.ok ? 'done' : 'failed', { ok: !!msg.ok, message: clip(msg.message, 500) }, agentId])).rows[0];
        if (x) await db.audit(c, A, { hospitalId: x.hospital_id, deviceId: x.device_id, action: 'command.result', details: { command: msg.id, action: x.action, by: x.created_by, message: clip(msg.message, 300) }, result: msg.ok ? 'ok' : 'failed' });
        return x;
      });
      if (r) emit(r.hospital_id, { t: 'command', id: msg.id });
      return;
    }
  }

  function identityOf(b) {
    const id = String(b.identity || '').trim().toLowerCase();
    return /^[\w:.\-]{4,80}$/.test(id) ? id : null;
  }
  async function upsertBoard(c, hospitalId, agentId, b) {
    const identity = identityOf(b);
    if (!identity) return null;
    const one = (sql, p) => c.query(sql, p).then(r => r.rows[0]);
    const ts = b.placementTs || {};
    let d = await one('select * from br.devices where hospital_id = $1 and identity = $2 for update', [hospitalId, identity]);
    if (!d) {
      // two PCs can discover the same new board at the same instant: one insert wins, the other reads it
      d = await one(`insert into br.devices (hospital_id, identity, kind, name, model, android, details, room, unit, closet, placement_ts)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (hospital_id, identity) do nothing returning *`,
        [hospitalId, identity, /^(wb|ds|tv|cam|tab|usb|other)$/.test(b.kind) ? b.kind : 'other', clip(b.name, 80), clip(b.model, 80), clip(b.android, 20), details(b),
         clip(b.room, 20), clip(b.unit, 40), clip(b.closet, 40), { room: num(ts.room), unit: num(ts.unit), closet: num(ts.closet) }]);
      if (d) await db.audit(c, { kind: 'agent', agentId }, { hospitalId, deviceId: d.id, action: 'device.discovered', details: { identity, room: d.room, kind: d.kind } });
      else d = await one('select * from br.devices where hospital_id = $1 and identity = $2 for update', [hospitalId, identity]);
    }
    {
      // refresh what the PC knows about the hardware (harmless on a row just created)
      await c.query('update br.devices set model = case when $2 <> \'\' then $2 else model end, android = case when $3 <> \'\' then $3 else android end, details = details || $4, name = case when name = \'\' then $5 else name end where id = $1',
        [d.id, clip(b.model, 80), clip(b.android, 20), details(b), clip(b.name, 80)]);
    }
    await c.query(`insert into br.device_reach (device_id, agent_id, hospital_id, local_board_id, host, port, online, last_seen) values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (device_id, agent_id) do update set local_board_id = excluded.local_board_id, host = excluded.host, port = excluded.port, online = excluded.online, last_seen = now()`,
      [d.id, agentId, hospitalId, clip(b.localId, 40), clip(b.host, 80), Number(b.port) || 5555, !!b.online]);
    // the PC's own view of room, unit and closet against the cloud's: most recent wins, a lock always wins
    const r = await applyPlacement(c, { kind: 'agent', agentId }, hospitalId, agentId, { localId: b.localId, fields: { room: b.room, unit: b.unit, closet: b.closet }, ts }, d);
    if (b.state) await applyState(c, hospitalId, agentId, { localId: b.localId, online: b.online, state: b.state, headline: b.headline, lastBeat: b.lastBeat });
    return r && r.correct ? r.correct : null;
  }
  const num = v => (Number(v) > 0 ? Number(v) : 0);
  const details = b => { const o = {}; for (const k of ['make', 'serial', 'ethMac', 'wifiMac', 'sdk']) if (b[k]) o[k] = clip(b[k], 60); return o; };

  async function applyPlacement(c, A, hospitalId, agentId, msg, dev) {
    const reach = dev ? null : (await c.query('select device_id from br.device_reach where agent_id = $1 and local_board_id = $2', [agentId, clip(msg.localId, 40)])).rows[0];
    const d = dev || (reach && (await c.query('select * from br.devices where id = $1', [reach.device_id])).rows[0]);
    if (!d) return null;
    const fields = msg.fields || (msg.field ? { [msg.field]: msg.value } : {});
    const ts = msg.ts && typeof msg.ts === 'object' ? msg.ts : (msg.field ? { [msg.field]: msg.ts } : {});
    const cur = d.placement_ts || {};
    const set = {}, newTs = Object.assign({}, cur);
    let correct = false;
    for (const f of FIELDS) {
      if (!(f in fields)) continue;
      const v = clip(fields[f], f === 'room' ? 20 : 40).trim(), t = num(ts[f]);
      if (v === d[f]) continue;
      if (d.location_locked || t <= num(cur[f])) { correct = true; continue; }       // cloud value stands
      set[f] = v; newTs[f] = t;
    }
    const keys = Object.keys(set);
    if (keys.length) {
      await c.query('update br.devices set ' + keys.map((f, i) => f + ' = $' + (i + 2)).join(', ') + ', placement_ts = $' + (keys.length + 2) + ' where id = $1', [d.id].concat(keys.map(f => set[f]), [newTs]));
      await db.audit(c, A, { hospitalId, deviceId: d.id, action: 'device.placement', details: { from: pick(d, keys), to: set, by: 'Board Remote' } });
    }
    const after = Object.assign({}, d, set);
    return { deviceId: d.id, changed: keys.length > 0, correct: correct ? { localId: msg.localId, room: after.room, unit: after.unit, closet: after.closet, locked: d.location_locked, ts: newTs } : null };
  }
  const pick = (o, keys) => keys.reduce((a, k) => { a[k] = o[k]; return a; }, {});

  async function applyState(c, hospitalId, agentId, u) {
    const reach = (await c.query('select device_id from br.device_reach where agent_id = $1 and local_board_id = $2', [agentId, clip(u.localId, 40)])).rows[0];
    if (!reach) return;
    // lock the board first, so two PCs updating the same board take turns instead of deadlocking
    await c.query('select 1 from br.devices where id = $1 for update', [reach.device_id]);
    const r = (await c.query('update br.device_reach set online = $3, last_seen = now() where agent_id = $1 and local_board_id = $2 returning device_id', [agentId, clip(u.localId, 40), !!u.online])).rows[0];
    if (!r) return;
    // the PC that reached the board most recently, online first, is the one whose word counts
    await c.query(`update br.device_reach set is_primary = (agent_id = (select agent_id from br.device_reach where device_id = $1 order by online desc, last_seen desc limit 1)) where device_id = $1`, [r.device_id]);
    const prim = (await c.query('select agent_id from br.device_reach where device_id = $1 and is_primary', [r.device_id])).rows[0];
    if (!prim || prim.agent_id !== agentId) return;
    const st = STATES.indexOf(u.state) >= 0 ? u.state : (u.online ? 'online' : 'offline');
    await c.query(`insert into br.device_state (device_id, hospital_id, state, headline, last_beat, by_agent, updated_at) values ($1, $2, $3, $4, $5, $6, now())
      on conflict (device_id) do update set state = excluded.state, headline = excluded.headline, last_beat = coalesce(excluded.last_beat, br.device_state.last_beat), by_agent = excluded.by_agent, updated_at = now()`,
      [r.device_id, hospitalId, st, clip(u.headline, 200), u.lastBeat ? new Date(Number(u.lastBeat)) : null, agentId]);
  }

  /* ---------- telling PCs about changes made elsewhere ---------- */
  async function fanOut(deviceId, exceptAgent) {
    const rows = await db.tx(db.SYSTEM, c => c.query(`select r.agent_id, r.local_board_id, d.room, d.unit, d.closet, d.location_locked, d.placement_ts
      from br.device_reach r join br.devices d on d.id = r.device_id where r.device_id = $1`, [deviceId])).then(x => x.rows);
    for (const r of rows) {
      if (r.agent_id === exceptAgent) continue;
      const k = conns.get(r.agent_id);
      if (k) send(k, { t: 'placement', localId: r.local_board_id, room: r.room, unit: r.unit, closet: r.closet, locked: r.location_locked, ts: r.placement_ts });
    }
  }

  /* ---------- commands ---------- */
  async function command(actor, deviceId, action, args) {
    if (!ACTIONS[action] || !ACTIONS[action](args || {})) return { ok: false, message: 'That action is not allowed.' };
    const row = await db.tx(actor, async c => {
      const d = (await c.query('select id, hospital_id, kind from br.devices where id = $1', [deviceId])).rows[0];
      if (!d) return { err: 'Unknown board.' };
      if (action === 'led' && d.kind !== 'ds') return { err: 'LED control is for door signs only.' };
      const r = (await c.query('select agent_id, local_board_id, online from br.device_reach where device_id = $1 order by online desc, is_primary desc, last_seen desc limit 1', [deviceId])).rows[0];
      if (!r) return { err: 'No Board Remote is watching this board.' };
      const x = (await c.query('insert into br.commands (hospital_id, device_id, agent_id, action, args, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
        [d.hospital_id, d.id, r.agent_id, action, Object.assign({}, args || {}, { localId: r.local_board_id }), actor.userId || null])).rows[0];
      await db.audit(c, actor, { hospitalId: d.hospital_id, deviceId: d.id, action: 'command.' + action, details: { command: x.id, args: args || {} } });
      return { id: x.id, agentId: r.agent_id, hospitalId: d.hospital_id };
    });
    if (row.err) return { ok: false, message: row.err };
    await flush(row.agentId);
    const live = conns.has(row.agentId);
    return { ok: true, id: row.id, message: live ? 'Sent to the Board Remote watching this board.' : 'Queued. It goes out when the Board Remote watching this board is back online (within 10 minutes).' };
  }
  async function hospitalCommand(actor, hospitalId, action) {
    if (action !== 'auditRun') return { ok: false, message: 'That action is not allowed.' };
    const ids = await db.tx(actor, async c => {
      const ags = (await c.query('select id from br.agents where hospital_id = $1 and revoked_at is null', [hospitalId])).rows;
      const out = [];
      for (const a of ags) {
        const x = (await c.query("insert into br.commands (hospital_id, agent_id, action, created_by) values ($1, $2, 'auditRun', $3) returning id", [hospitalId, a.id, actor.userId || null])).rows[0];
        out.push([x.id, a.id]);
      }
      await db.audit(c, actor, { hospitalId, action: 'command.auditRun', details: { pcs: ags.length } });
      return out;
    });
    for (const [, a] of ids) await flush(a);
    return { ok: true, message: ids.length ? 'Morning audit started on ' + ids.length + ' Board Remote PC' + (ids.length > 1 ? 's' : '') + '.' : 'No Board Remote is enrolled for this hospital yet.' };
  }
  async function flush(agentId) {
    const k = conns.get(agentId);
    if (!k) return;
    const rows = await db.tx(k.actor, async c => {
      await c.query("update br.commands set status = 'expired' where agent_id = $1 and status = 'queued' and expires_at < now()", [agentId]);
      return (await c.query("update br.commands set status = 'sent', sent_at = now() where id in (select id from br.commands where agent_id = $1 and status = 'queued' order by created_at limit 50) returning id, action, args", [agentId])).rows;
    });
    for (const r of rows) send(k, { t: 'command', id: r.id, action: r.action, args: r.args });
  }

  return { setContainers: x => { containers = x; }, upgrade, authAgent, emit, enroll, makeCode, revoke, command, hospitalCommand, fanOut, isOnline: id => conns.has(id), onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }, ACTIONS: Object.keys(ACTIONS), ACTS, _conns: conns };
}

module.exports = { create, normCode, PROTO };
