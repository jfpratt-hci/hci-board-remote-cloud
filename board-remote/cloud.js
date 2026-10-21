'use strict';
/* HCI ONE Board Remote Cloud link (Board Remote side)
   Enroll once with the cloud address and a one time code from the web app. After that this PC keeps
   one outbound connection (https / wss on 443) to the cloud. Nothing here is opened to the internet.
   Up:   every board this PC watches (identity by MAC or serial, room, unit, closet, type, model),
         changes in each board's health (only when something changes, plus a refresh every 5 min),
         room, unit and closet edits made here, and the result of each command.
   Down: room, unit and closet edits made in the web app or on another tech's PC, the HCI lock,
         and commands (the Device health fixes, door sign LED, a health check, the morning audit).
   Never sent: screens, screen text, snapshots, device logs. They stay on this PC.
   Commands run through this PC's own local API, the same way the dashboard runs them. */
const os = require('os');
const http = require('http');
const https = require('https');
const ws = require('./ws');

module.exports = function createCloud(ctx) {
  const { store, saveStore, R, serialOf, log, VERSION, PORT, send, readJson, health, deploy } = ctx;
  store.settings.cloud = Object.assign({ url: '', agentId: '', secret: '', hospital: null, ts: {}, locks: {} }, store.settings.cloud || {});
  const C = () => store.settings.cloud;
  const now = () => Date.now();
  let sock = null, connecting = false, since = 0, lastError = '', backoff = 2000, retryAt = 0;
  const sent = new Map();          // boardId -> last state signature sent
  const placed = new Map();        // boardId -> 'room|unit|closet' as last agreed with the cloud
  let refreshAt = 0, identBusy = 0;
  const identTry = new Map();      // boardId -> when we last asked it for its MAC and serial

  const cloudBase = () => C().url.replace(/\/+$/, '');
  const wsUrl = () => cloudBase().replace(/^http/, 'ws') + '/agent';
  const identity = b => {
    const id = deploy && deploy.identCached ? deploy.identCached(b.id) : null;
    const v = id && (id.ethMac || id.wifiMac || id.serial || id.androidId);
    return v ? String(v).toLowerCase() : null;
  };
  const placeKey = b => [b.room || '', b.unit || '', b.closet || ''].join('|');
  const tsOf = id => C().ts[id] || (C().ts[id] = {});

  /* ---------- enrollment ---------- */
  function postJson(url, body) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch (e) { return reject(new Error('That is not a web address.')); }
      const data = JSON.stringify(body), lib = u.protocol === 'https:' ? https : http;
      const r = lib.request(u, { method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
        let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('The cloud did not answer as expected (' + res.statusCode + ').')); } });
      });
      r.on('timeout', () => r.destroy(new Error('The cloud did not answer.'))); r.on('error', reject); r.end(data);
    });
  }
  async function enroll(url, code) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[\w.\-]+(:\d+)?$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) return { ok: false, message: 'Enter the cloud address, like https://remote.hci-tv.com' };
    let j; try { j = await postJson(url + '/api/agent/enroll', { code, pcName: os.hostname(), version: VERSION }); } catch (e) { return { ok: false, message: e.message }; }
    if (!j.ok) return { ok: false, message: j.message || 'The code was not accepted.' };
    Object.assign(C(), { url, agentId: j.agentId, secret: j.secret, hospital: j.hospital, ts: {}, locks: {} });
    saveStore(); sent.clear(); placed.clear(); lastError = ''; backoff = 2000; retryAt = 0;
    connect();
    return { ok: true, message: 'This PC is now part of ' + j.hospital.name + ' in HCI ONE Board Remote Cloud.' };
  }
  function leave() {
    Object.assign(C(), { url: '', agentId: '', secret: '', hospital: null, ts: {}, locks: {} });
    saveStore();
    if (sock) { try { sock.close(1000, 'Left'); } catch (e) { /* gone */ } }
    sock = null; lastError = '';
    return { ok: true, message: 'This PC has left the cloud. Remove it in the web app too.' };
  }

  /* ---------- the connection ---------- */
  function connect() {
    if (sock || connecting || !C().agentId) return;
    connecting = true;
    ws.connect(wsUrl(), { Authorization: 'Bearer ' + C().agentId + '.' + C().secret, 'User-Agent': 'HCI-ONE-Board-Remote/' + VERSION }, 15000).then(s => {
      connecting = false; sock = s; since = now(); lastError = ''; backoff = 2000;
      log('cloud connected', cloudBase());
      s.on('message', m => { let msg; try { msg = JSON.parse(m); } catch (e) { return; } onMessage(msg).catch(e => log('cloud message', e.message)); });
      s.on('close', () => { if (sock === s) { sock = null; retryAt = now() + backoff; backoff = Math.min(backoff * 2, 60000); log('cloud disconnected'); } });
      hello();
    }, e => {
      connecting = false; lastError = e.status === 401 ? 'This PC was removed from the cloud, or its enrollment is no longer valid. Enroll again with a new code.' : e.message;
      retryAt = now() + (e.status === 401 ? 10 * 60000 : backoff); backoff = Math.min(backoff * 2, 60000);
    });
  }
  const out = msg => { if (!sock) return false; try { sock.send(JSON.stringify(msg)); return true; } catch (e) { return false; } };

  function boardMsg(b) {
    const id = identity(b); if (!id) return null;
    const h = health && health.H ? health.H(b) : null, r = R(b);
    const ident = deploy.identCached(b.id) || {};
    return { localId: b.id, identity: id, kind: b.kind || 'other', name: b.name, host: b.host, port: b.port, room: b.room || '', unit: b.unit || '', closet: b.closet || '',
      placementTs: tsOf(b.id), model: r.model || '', android: r.android || '', make: r.make || '', serial: ident.serial || '', ethMac: ident.ethMac || '', wifiMac: ident.wifiMac || '', sdk: ident.sdk || 0,
      online: r.status === 'online', state: h ? h.state : (r.status === 'online' ? 'online' : 'offline'), headline: h && health.headline ? health.headline(b) : '', lastBeat: h ? h.lastBeat : 0 };
  }
  function hello() {
    const boards = store.boards.map(boardMsg).filter(Boolean);
    sent.clear();
    for (const b of store.boards) placed.set(b.id, placeKey(b));
    out({ t: 'hello', version: VERSION, pcName: os.hostname(), boards });
    for (const m of boards) sent.set(m.localId, m.state + '|' + m.online + '|' + m.headline);
    refreshAt = now() + 5 * 60000;
  }

  /* ---------- messages from the cloud ---------- */
  async function onMessage(msg) {
    if (msg.t === 'welcome') { if (msg.hospital) { C().hospital = msg.hospital; saveStore(); } (msg.placements || []).forEach(applyPlacement); return; }
    if (msg.t === 'placement') return applyPlacement(msg);
    if (msg.t === 'command') return runCommand(msg);
  }
  function applyPlacement(p) {
    const b = store.boards.find(x => x.id === p.localId); if (!b) return;
    b.room = String(p.room || ''); b.unit = String(p.unit || ''); b.closet = String(p.closet || '');
    if (p.ts && typeof p.ts === 'object') C().ts[b.id] = Object.assign({}, p.ts);
    if (p.locked) C().locks[b.id] = true; else delete C().locks[b.id];
    placed.set(b.id, placeKey(b));
    saveStore();
  }
  function local(path, body) {
    return new Promise(resolve => {
      const data = JSON.stringify(body || {});
      const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', timeout: 180000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Board-Remote': '1' } }, res => {
        let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ ok: false, message: 'Board Remote gave no answer.' }); } });
      });
      r.on('timeout', () => r.destroy()); r.on('error', e => resolve({ ok: false, message: e.message })); r.end(data);
    });
  }
  async function runCommand(c) {
    const a = c.args || {}, id = String(a.localId || '');
    const b = store.boards.find(x => x.id === id);
    let r;
    if (c.action === 'auditRun') r = await local('/api/audit/run', {});
    else if (!b) r = { ok: false, message: 'That board is no longer on this Board Remote.' };
    else if (c.action === 'act') r = await local('/api/health/' + b.id + '/act', { act: a.key });
    else if (c.action === 'led') r = await local('/api/health/' + b.id + '/led', { color: a.color, mode: a.mode || 'solid' });
    else if (c.action === 'probe') r = await local('/api/health/' + b.id + '/probe', {});
    else r = { ok: false, message: 'This Board Remote does not know that command. Update it.' };
    log('cloud command', c.action, b ? b.name : '', r.ok ? 'ok' : 'failed', r.message || '');
    out({ t: 'result', id: c.id, ok: !!r.ok, message: String(r.message || '').slice(0, 500) });
  }

  /* ---------- every tick: changes go up ---------- */
  function onTick() {
    if (!C().agentId) return;
    if (!sock) { if (now() >= retryAt) connect(); return; }
    // learn the MAC or serial of boards that do not have one yet, two at a time
    for (const b of store.boards) {
      if (identBusy >= 2) break;
      if (!identity(b) && R(b).status === 'online' && now() - (identTry.get(b.id) || 0) > 10 * 60000) { identTry.set(b.id, now()); identBusy++; deploy.ident(b, true).catch(() => {}).finally(() => { identBusy--; }); }
    }
    if (store.boards.some(b => identity(b) && !sent.has(b.id))) return hello();  // a new board here, or its identity just arrived
    if (now() >= refreshAt) return hello();
    const ups = [];
    for (const b of store.boards) {
      const m = boardMsg(b); if (!m) continue;
      const sig = m.state + '|' + m.online + '|' + m.headline;
      if (sent.get(b.id) !== sig) { ups.push({ localId: b.id, online: m.online, state: m.state, headline: m.headline, lastBeat: m.lastBeat }); sent.set(b.id, sig); }
      const pk = placeKey(b);
      if (placed.has(b.id) && placed.get(b.id) !== pk) {
        // a room, unit or closet changed here: tell the cloud (it decides, and corrects us if HCI locked it)
        const [r0, u0, c0] = placed.get(b.id).split('|'), t = now(), ts = tsOf(b.id), fields = {};
        if ((b.room || '') !== r0) { fields.room = b.room || ''; ts.room = t; }
        if ((b.unit || '') !== u0) { fields.unit = b.unit || ''; ts.unit = t; }
        if ((b.closet || '') !== c0) { fields.closet = b.closet || ''; ts.closet = t; }
        placed.set(b.id, pk); saveStore();
        out({ t: 'placement', localId: b.id, fields, ts });
      }
    }
    if (ups.length) out({ t: 'state', updates: ups });
  }

  /* ---------- this PC's API ---------- */
  const pub = () => ({ ok: true, enrolled: !!C().agentId, url: C().url, hospital: C().hospital, connected: !!sock, since, lastError, boards: store.boards.length,
    known: store.boards.filter(identity).length, locked: Object.keys(C().locks).length });
  async function handle(req, res, p) {
    if (!/^\/api\/cloud\b/.test(p)) return false;
    if (req.method === 'GET' && p === '/api/cloud/state') return send(res, 200, pub()), true;
    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' }), true;
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' }), true;
    const body = await readJson(req);
    if (p === '/api/cloud/enroll') return send(res, 200, await enroll(body.url, body.code)), true;
    if (p === '/api/cloud/leave') return send(res, 200, leave()), true;
    return send(res, 404, { ok: false, message: 'Not found' }), true;
  }
  const isLocked = id => !!C().locks[id];
  if (C().agentId) setTimeout(connect, 3000);
  return { handle, onTick, isLocked, state: pub, stop: () => { if (sock) sock.close(1000, 'Quit'); } };
};
