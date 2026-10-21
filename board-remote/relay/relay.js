'use strict';
/*
  HCI ONE Remote relay (proof of concept)
  Stands in for the HCI cloud. Each hospital's Board Remote dials out to it; the web viewer
  signs in here and sees every site. The relay never dials into a hospital, and each hospital's
  own Board Remote decides what is allowed there (off, health only, fixes, live view).

  Node 16 or newer, no dependencies. Data: relay.json beside this file.
  Port 8780 (RELAY_PORT to change). First start writes FIRST_SIGN_IN.txt with the admin login.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ws = require('./ws');

const VERSION = '0.1';
const ROOT = __dirname;
const PORT = Number(process.env.RELAY_PORT) || 8780;
// On a server the relay sits behind an HTTPS proxy (Caddy) on the same machine: RELAY_HOST=127.0.0.1 keeps it off the internet.
const HOST = process.env.RELAY_HOST || '0.0.0.0';
const DATA = path.join(ROOT, 'relay.json');
const VIEWER = path.join(ROOT, 'viewer.html');
const FIRST = path.join(ROOT, 'FIRST_SIGN_IN.txt');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString('hex');
const code = n => Array.from(crypto.randomBytes(n), b => ALPHA[b % ALPHA.length]).join('');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------------- data ---------------- */
let db = { users: [], sites: [], codes: [], audit: [] };
function load() {
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch (e) { /* first start */ }
}
let saveTimer = null;
function save(soon) {
  clearTimeout(saveTimer);
  const write = () => { try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db, null, 1), { mode: 0o600 }); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { log('save failed', e.message); } };
  if (soon) saveTimer = setTimeout(write, 1500); else write();
}
function hashPass(pass, salt) {
  salt = salt || rid(16);
  return { salt, hash: crypto.scryptSync(String(pass), salt, 32).toString('hex') };
}
function checkPass(u, pass) {
  const h = crypto.scryptSync(String(pass), u.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
}
function audit(who, what, extra) {
  db.audit.push(Object.assign({ at: now(), who: who || '' , what }, extra || {}));
  if (db.audit.length > 3000) db.audit = db.audit.slice(-2000);
  save(true);
}
function firstStart() {
  if (db.users.length) return;
  const pass = code(4) + ' ' + code(4) + ' ' + code(4);
  db.users.push(Object.assign({ name: 'admin', role: 'admin', created: now() }, hashPass(pass)));
  save();
  const text = 'HCI ONE Remote relay\r\nFirst sign in\r\n\r\nName:     admin\r\nPassword: ' + pass + '\r\n\r\nSign in, add your own user under Admin, then delete this file.\r\n';
  try { fs.writeFileSync(FIRST, text, { mode: 0o600 }); } catch (e) { /* read only folder */ }
  log('First sign in: admin / ' + pass + '  (also in FIRST_SIGN_IN.txt)');
}

/* ---------------- sessions ---------------- */
const sessions = new Map();          // token -> { name, role, exp }
const SESSION_MS = 12 * 3600 * 1000;
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function who(req) {
  const t = cookies(req).hcir;
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < now()) { sessions.delete(t); return null; }
  const u = db.users.find(x => x.name === s.name);
  if (!u) { sessions.delete(t); return null; }
  s.exp = now() + SESSION_MS;
  return { name: u.name, role: u.role, token: t };
}
const secureReq = req => !!req.socket.encrypted || (/^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || '')) && req.headers['x-forwarded-proto'] === 'https');
// The address a request really came from. Only a proxy on this same machine (Caddy, or a tunnel) is believed,
// and only the last hop it added, so a caller cannot dodge the sign in limit by sending its own header.
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '');
  if (/^(127\.|::1$|::ffff:127\.)/.test(peer)) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return peer;
}
const fails = new Map();             // ip -> { n, until }
function blocked(ip) { const f = fails.get(ip); return f && f.until > now(); }
function failed(ip) {
  const f = fails.get(ip) || { n: 0, until: 0, first: now() };
  if (now() - f.first > 10 * 60000) { f.n = 0; f.first = now(); }
  f.n++;
  if (f.n >= 6) { f.until = now() + 10 * 60000; f.n = 0; f.first = now(); }
  fails.set(ip, f);
}

/* ---------------- sites and their agents ---------------- */
const agents = new Map();            // siteId -> { sock, hello, state, stateAt, pending, lives }
const lives = new Map();             // ch -> { viewer, siteId, board, who, started, state }
let nextCh = 1;
function siteSummary(s) {
  const a = agents.get(s.id);
  const st = (a && a.state) || s.lastState || null;
  return {
    id: s.id, name: s.name, online: !!(a && a.sock && a.sock.open), lastSeen: a && a.sock && a.sock.open ? now() : (s.lastSeen || 0),
    policy: (a && a.hello && a.hello.policy) || s.policy || 'health', ask: !!((a && a.hello && a.hello.ask) ?? s.ask),
    version: (a && a.hello && a.hello.version) || s.version || '', enrolled: s.enrolled || 0,
    counts: st ? st.counts : null, issues: st ? (st.issues || []).length : 0, stateAge: st ? now() - ((a && a.stateAt) || s.stateAt || now()) : null
  };
}
function request(siteId, msg, ms) {
  const a = agents.get(siteId);
  if (!a || !a.sock || !a.sock.open) return Promise.resolve({ ok: false, message: 'That site is not connected right now.' });
  const id = rid(6);
  return new Promise(resolve => {
    const timer = setTimeout(() => { a.pending.delete(id); resolve({ ok: false, message: 'The site did not answer in time.' }); }, ms || 30000);
    a.pending.set(id, { resolve, timer });
    a.sock.json(Object.assign({ t: 'req', id }, msg));
  });
}
function agentGone(siteId, a) {
  for (const p of a.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, message: 'The site disconnected.' }); }
  a.pending.clear();
  for (const [ch, l] of lives) if (l.siteId === siteId) endLive(ch, 'The site disconnected.');
}
function onAgent(sock, site, req) {
  const old = agents.get(site.id);
  if (old && old.sock && old.sock.open) { old.sock.close(4002, 'Replaced by a newer connection'); agentGone(site.id, old); }
  const a = { sock, hello: null, state: site.lastState || null, stateAt: site.stateAt || 0, pending: new Map() };
  agents.set(site.id, a);
  site.lastSeen = now(); site.ip = clientIp(req);
  log('site connected', site.name, site.ip);
  audit('', 'Site connected', { site: site.name, ip: site.ip });
  sock.on('message', (m, bin) => {
    if (bin) return fromAgentFrame(m);
    let msg; try { msg = JSON.parse(m); } catch (e) { return; }
    site.lastSeen = now();
    if (msg.t === 'hello') {
      a.hello = { version: String(msg.version || ''), policy: String(msg.policy || 'health'), ask: !!msg.ask, name: String(msg.site || '') };
      site.version = a.hello.version; site.policy = a.hello.policy; site.ask = a.hello.ask;
      save(true);
    } else if (msg.t === 'state') {
      a.state = msg.data; a.stateAt = now();
      site.lastState = msg.data; site.stateAt = a.stateAt;
      save(true);
    } else if (msg.t === 'res') {
      const p = a.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); a.pending.delete(msg.id); p.resolve(msg); }
    } else if (msg.t === 'live') {
      const l = lives.get(msg.ch);
      if (!l) return;
      if (msg.state === 'live' && l.state !== 'live') { l.state = 'live'; l.liveAt = now(); audit(l.who, 'Live view started', { site: site.name, board: l.boardName }); }
      if (msg.state === 'denied') audit(l.who, 'Live view denied at the hospital', { site: site.name, board: l.boardName });
      if (l.viewer.open) l.viewer.json(msg);
      if (msg.state === 'ended' || msg.state === 'denied' || msg.state === 'error') endLive(msg.ch, msg.message || '', true);
    }
  });
  sock.on('close', () => {
    if (agents.get(site.id) !== a) return;
    agents.delete(site.id);
    site.lastSeen = now();
    save(true);
    log('site disconnected', site.name);
    audit('', 'Site disconnected', { site: site.name });
    agentGone(site.id, a);
  });
}
// A binary message from an agent: 4 byte live channel, then one video frame (13 byte header + data).
function fromAgentFrame(m) {
  if (m.length < 5) return;
  const l = lives.get(m.readUInt32BE(0));
  if (!l || !l.viewer.open) return;
  const kind = m[4];
  if (l.viewer.bufferedAmount > 1.5 * 1024 * 1024 && kind === 4) { l.skip = true; return; }   // slow phone: drop to the next key frame
  if (l.skip && kind === 4) return;
  if (kind === 3) l.skip = false;
  l.viewer.send(m.subarray(4));
}
function endLive(ch, why, fromAgent) {
  const l = lives.get(ch);
  if (!l) return;
  lives.delete(ch);
  const a = agents.get(l.siteId);
  if (!fromAgent && a && a.sock && a.sock.open) a.sock.json({ t: 'live-end', ch });
  if (l.viewer.open) { if (why && !fromAgent) l.viewer.json({ t: 'live', ch, state: 'ended', message: why }); l.viewer.close(1000, 'ended'); }
  if (l.state === 'live') {
    const site = db.sites.find(s => s.id === l.siteId);
    audit(l.who, 'Live view ended', { site: site ? site.name : '', board: l.boardName, seconds: Math.round((now() - l.liveAt) / 1000) });
  }
}

/* ---------------- http ---------------- */
function send(res, codeN, body, type, extra) {
  const isBuf = Buffer.isBuffer(body), isStr = typeof body === 'string';
  res.writeHead(codeN, Object.assign({
    'Content-Type': type || (isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY'
  }, extra || {}));
  res.end(isBuf || isStr ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 64 * 1024) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
const clean = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const NAME_RE = /^[a-z0-9._@]{2,40}$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://relay');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || /^\/s\/[a-f0-9]{8}(\/(b|live)\/[a-f0-9]{8})?$/.test(p))) {
      const host = String(req.headers.host || '');
      const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ws://" + host + ' wss://' + host + "; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
      return send(res, 200, fs.readFileSync(VIEWER), 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
    }
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true, version: VERSION });

    /* a hospital's Board Remote enrolling with a one time code */
    if (req.method === 'POST' && p === '/agent/enroll') {
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, { ok: false, message: 'Too many tries. Wait 10 minutes.' });
      const body = await readJson(req);
      const c = clean(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const hit = db.codes.find(x => x.code === c && x.exp > now());
      if (!hit) { failed(ip); return send(res, 403, { ok: false, message: 'That code is not valid or has expired. Ask HCI for a new one.' }); }
      db.codes = db.codes.filter(x => x !== hit);
      const key = crypto.randomBytes(32).toString('base64url');
      const site = { id: rid(4), name: hit.name, keyHash: sha(key), created: now(), enrolled: now(), by: hit.by, policy: 'health', lastSeen: 0 };
      db.sites.push(site);
      save();
      audit(hit.by, 'Site enrolled', { site: site.name, ip, version: clean(body.version, 20) });
      log('site enrolled', site.name);
      return send(res, 200, { ok: true, siteId: site.id, siteName: site.name, key });
    }

    /* viewer */
    if (req.method === 'POST' && p === '/api/login') {
      if (req.headers['x-hci-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' });
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, { ok: false, message: 'Too many tries from here. Wait 10 minutes.' });
      const body = await readJson(req);
      const u = db.users.find(x => x.name === clean(body.name, 40).toLowerCase());
      if (!u || !checkPass(u, body.pass || '')) { failed(ip); audit(clean(body.name, 40), 'Sign in failed', { ip }); return send(res, 401, { ok: false, message: 'That name and password do not match.' }); }
      const t = crypto.randomBytes(24).toString('base64url');
      sessions.set(t, { name: u.name, role: u.role, exp: now() + SESSION_MS });
      audit(u.name, 'Signed in', { ip });
      const cookie = 'hcir=' + t + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (SESSION_MS / 1000) + (secureReq(req) ? '; Secure' : '');
      return send(res, 200, { ok: true, name: u.name, role: u.role }, null, { 'Set-Cookie': cookie });
    }

    const me = who(req);
    if (p.startsWith('/api/')) {
      if (!me) return send(res, 401, { ok: false, message: 'Sign in first.' });
      if (req.method === 'POST' && req.headers['x-hci-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' });
    }
    if (req.method === 'GET' && p === '/api/me') return send(res, 200, { ok: true, name: me.name, role: me.role, version: VERSION });
    if (req.method === 'POST' && p === '/api/logout') {
      sessions.delete(me.token);
      return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'hcir=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (req.method === 'POST' && p === '/api/password') {
      const body = await readJson(req);
      const u = db.users.find(x => x.name === me.name);
      if (!checkPass(u, body.old || '')) return send(res, 400, { ok: false, message: 'Your current password is not right.' });
      if (String(body.pass || '').length < 10) return send(res, 400, { ok: false, message: 'Use at least 10 characters.' });
      Object.assign(u, hashPass(body.pass));
      save();
      audit(me.name, 'Changed password');
      return send(res, 200, { ok: true, message: 'Password changed.' });
    }
    if (req.method === 'GET' && p === '/api/sites') {
      return send(res, 200, { ok: true, sites: db.sites.map(siteSummary).sort((a, b) => a.name.localeCompare(b.name)) });
    }
    let m = /^\/api\/sites\/([a-f0-9]{8})$/.exec(p);
    if (req.method === 'GET' && m) {
      const s = db.sites.find(x => x.id === m[1]);
      if (!s) return send(res, 404, { ok: false, message: 'Unknown site' });
      const a = agents.get(s.id);
      return send(res, 200, { ok: true, site: siteSummary(s), state: (a && a.state) || s.lastState || null });
    }
    m = /^\/api\/sites\/([a-f0-9]{8})\/boards\/([a-f0-9]{8})\/(restartapp|reboot|key|screen)$/.exec(p);
    if (req.method === 'POST' && m) {
      const s = db.sites.find(x => x.id === m[1]);
      if (!s) return send(res, 404, { ok: false, message: 'Unknown site' });
      const body = await readJson(req);
      const op = m[3];
      const r = await request(s.id, { op, board: m[2], key: clean(body.key, 12), user: me.name }, op === 'screen' ? 70000 : 40000);
      const boardName = boardLabel(s, m[2]);
      if (op !== 'screen') audit(me.name, ({ restartapp: 'Restart app', reboot: 'Reboot', key: 'Key ' + clean(body.key, 12) })[op], { site: s.name, board: boardName, ok: !!r.ok, detail: r.message || '' });
      return send(res, 200, r);
    }

    /* admin */
    if (p.startsWith('/api/admin')) {
      if (me.role !== 'admin') return send(res, 403, { ok: false, message: 'Admins only.' });
      if (req.method === 'GET' && p === '/api/admin') {
        return send(res, 200, {
          ok: true,
          users: db.users.map(u => ({ name: u.name, role: u.role, created: u.created })),
          sites: db.sites.map(siteSummary),
          codes: db.codes.filter(c => c.exp > now()).map(c => ({ code: c.code, name: c.name, exp: c.exp })),
          audit: db.audit.slice(-300).reverse()
        });
      }
      const body = req.method === 'POST' ? await readJson(req) : {};
      if (req.method === 'POST' && p === '/api/admin/code') {
        const name = clean(body.name, 60);
        if (!name) return send(res, 400, { ok: false, message: 'Name the site first, for example Ball Health.' });
        const c = { code: code(8), name, exp: now() + 24 * 3600 * 1000, by: me.name };
        db.codes.push(c); save();
        audit(me.name, 'Enrollment code made', { site: name });
        return send(res, 200, { ok: true, code: c.code, name, exp: c.exp });
      }
      if (req.method === 'POST' && p === '/api/admin/user') {
        const name = clean(body.name, 40).toLowerCase();
        if (!NAME_RE.test(name)) return send(res, 400, { ok: false, message: 'Use 2 to 40 lower case letters, numbers, dots or @.' });
        if (db.users.some(u => u.name === name)) return send(res, 400, { ok: false, message: name + ' already exists.' });
        if (String(body.pass || '').length < 10) return send(res, 400, { ok: false, message: 'Use a password of at least 10 characters.' });
        db.users.push(Object.assign({ name, role: body.role === 'admin' ? 'admin' : 'support', created: now() }, hashPass(body.pass)));
        save();
        audit(me.name, 'User added', { detail: name });
        return send(res, 200, { ok: true, message: name + ' added.' });
      }
      m = /^\/api\/admin\/user\/([a-z0-9._@]{2,40})\/remove$/.exec(p);
      if (req.method === 'POST' && m) {
        if (m[1] === me.name) return send(res, 400, { ok: false, message: 'You cannot remove yourself.' });
        db.users = db.users.filter(u => u.name !== m[1]);
        for (const [t, s] of sessions) if (s.name === m[1]) sessions.delete(t);
        save();
        audit(me.name, 'User removed', { detail: m[1] });
        return send(res, 200, { ok: true, message: m[1] + ' removed.' });
      }
      m = /^\/api\/admin\/site\/([a-f0-9]{8})\/remove$/.exec(p);
      if (req.method === 'POST' && m) {
        const s = db.sites.find(x => x.id === m[1]);
        if (!s) return send(res, 404, { ok: false, message: 'Unknown site' });
        db.sites = db.sites.filter(x => x !== s);
        const a = agents.get(s.id);
        if (a && a.sock) a.sock.close(4001, 'This site was removed from HCI ONE Remote');
        save();
        audit(me.name, 'Site removed', { site: s.name });
        return send(res, 200, { ok: true, message: s.name + ' removed. Its Board Remote can no longer connect.' });
      }
    }
    return send(res, 404, { ok: false, message: 'Not found' });
  } catch (e) {
    log('request error', req.method, req.url, e.stack || e);
    if (!res.headersSent) send(res, 500, { ok: false, message: e.message });
  }
});
function boardLabel(s, id) {
  const a = agents.get(s.id);
  const st = (a && a.state) || s.lastState;
  const b = st && (st.boards || []).find(x => x.id === id);
  return b ? b.name : id;
}

/* websockets: /agent for hospitals, /ws/live for the viewer */
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://relay');
    if (url.pathname === '/agent') {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const site = key && db.sites.find(s => s.keyHash === sha(key));
      if (!site) { ws.refuse(socket, 401, 'This site is not enrolled. Enroll it again with a new code.'); return; }
      const sock = ws.accept(req, socket, head);
      if (sock) onAgent(sock, site, req);
      return;
    }
    if (url.pathname === '/ws/live') {
      const me = who(req);
      const origin = String(req.headers.origin || '');
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === req.headers.host; } catch (e) { /* no origin */ }
      if (!me || !sameOrigin) { ws.refuse(socket, 403, 'Forbidden'); return; }
      const siteId = url.searchParams.get('site'), board = url.searchParams.get('board');
      const s = db.sites.find(x => x.id === siteId);
      const a = s && agents.get(s.id);
      const sock = ws.accept(req, socket, head);
      if (!sock) return;
      if (!s || !/^[a-f0-9]{8}$/.test(board || '')) { sock.json({ t: 'live', state: 'error', message: 'Unknown site or board.' }); sock.close(1000); return; }
      if (!a || !a.sock || !a.sock.open) { sock.json({ t: 'live', state: 'error', message: 'That site is not connected right now.' }); sock.close(1000); return; }
      const ch = nextCh++;
      if (nextCh > 0x7fffffff) nextCh = 1;
      const l = { viewer: sock, siteId: s.id, board, boardName: boardLabel(s, board), who: me.name, started: now(), state: 'asking', skip: false };
      lives.set(ch, l);
      a.sock.json({ t: 'live', ch, board, user: me.name });
      sock.json({ t: 'live', ch, state: 'starting' });
      audit(me.name, 'Live view requested', { site: s.name, board: l.boardName });
      sock.on('message', (m, bin) => {
        if (bin) return;
        let msg; try { msg = JSON.parse(m); } catch (e) { return; }
        const ag = agents.get(s.id);
        if (!ag || !ag.sock || !ag.sock.open) return;
        if (msg.t === 'touch' || msg.t === 'key') ag.sock.json(Object.assign({}, msg, { ch }));
      });
      sock.on('close', () => endLive(ch, ''));
      return;
    }
    ws.refuse(socket, 404, 'Not found');
  } catch (e) {
    log('upgrade error', e.message);
    try { socket.destroy(); } catch (x) { /* gone */ }
  }
});

/* keep links alive through proxies and tunnels, and drop dead ones */
setInterval(() => {
  for (const a of agents.values()) {
    if (!a.sock || !a.sock.open) continue;
    if (now() - a.sock.heard > 75000) { a.sock.terminate(); continue; }
    a.sock.ping();
  }
  for (const l of lives.values()) if (l.viewer.open) l.viewer.ping();
}, 25000);
setInterval(() => { db.codes = db.codes.filter(c => c.exp > now()); }, 3600 * 1000);

load();
firstStart();
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('Something is already using port ' + PORT + '. Is the relay already running?'); process.exit(1); }
  log('server error', e.message); process.exit(1);
});
server.listen(PORT, HOST, () => {
  log('HCI ONE Remote relay ' + VERSION + ' on ' + HOST + ':' + PORT + '   sites ' + db.sites.length + '   users ' + db.users.length);
});
const quit = () => { save(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('uncaughtException', e => log('uncaught', e.stack || e));
