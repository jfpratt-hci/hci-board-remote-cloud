'use strict';
/*
  HCI ONE Remote, the site side (proof of concept).
  Board Remote dials OUT to an HCI ONE Remote relay over one WebSocket (port 443 in production)
  and gives HCI full support access: health, fixes and live view. Connecting the site with HCI's
  code is the hospital's consent. After that nobody here is asked again, and the link stays on
  (it comes back by itself after a restart) until HCI removes the site. Nothing ever dials in.

  Everything a remote person does goes through this PC's own Board Remote API, so the same
  checks and logs apply. A bar shows while HCI is viewing a board, and every action is logged.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const ws = require('./ws');

module.exports = function createRemote(ctx) {
  const { store, saveStore, log, PORT, VERSION, ROOT, APP = ROOT, send, readJson } = ctx;
  const LOG_FILE = path.join(ROOT, 'remote.json');
  const PAGE = path.join(APP, 'public', 'remote.html');
  const BANNER = path.join(APP, 'public', 'remote-banner.js');
  const LEVEL = { off: 0, health: 1, fixes: 2, live: 3 };
  const POLICY_NAME = { off: 'Off', health: 'Health only', fixes: 'Fixes', live: 'Live view' };
  const now = () => Date.now();

  const S = () => {
    store.settings.remote = Object.assign({ url: '', key: '', siteId: '', siteName: '', enrolledAt: 0 }, store.settings.remote || {});
    delete store.settings.remote.ask;   // 1.5 asked before each live view; consent now comes with enrollment
    store.settings.remote.policy = 'live';   // full access, fixed: no switch at the hospital turns it down or off
    return store.settings.remote;
  };

  let activity = [];
  try { activity = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')).activity || []; } catch (e) { /* first start */ }
  let saveT = null;
  function saveLog() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { fs.writeFileSync(LOG_FILE, JSON.stringify({ activity: activity.slice(-500) })); } catch (e) { /* ignore */ } }, 1000);
  }
  function note(who, what, board, ok) {
    activity.push({ at: now(), who: who || '', what, board: board || '', ok: ok !== false });
    if (activity.length > 600) activity = activity.slice(-500);
    saveLog();
    log('remote', who || '-', what, board || '');
  }

  /* ---------------- this PC's own API ---------------- */
  const HDR = { Host: '127.0.0.1:' + PORT, 'X-Board-Remote': '1' };
  function local(method, p, body, raw) {
    return new Promise(resolve => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign({}, HDR, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (raw) return resolve({ status: res.statusCode, buf, type: res.headers['content-type'] || '' });
          let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
          resolve({ status: res.statusCode, json: j });
        });
      });
      req.setTimeout(60000, () => req.destroy(new Error('timeout')));
      req.on('error', e => resolve({ status: 0, json: { ok: false, message: e.message } }));
      if (data) req.write(data);
      req.end();
    });
  }

  /* ---------------- link state ---------------- */
  let dialing = false, sock = null, status = 'off', message = '', connectedAt = 0, retryT = null, backoff = 2000, stopped = false, lastSent = '', lastSentAt = 0;
  const lives = new Map();          // ch -> { ch, who, board, boardName, req, started, live, waitKey, queue }

  function relayHttp(u) { return u.replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, ''); }
  function relayWs(u) { return relayHttp(u).replace(/^http(s?):/i, 'ws$1:') + '/agent'; }

  function start() {
    clearTimeout(retryT);
    const s = S();
    if (!s.key || !s.url) { setStatus('setup', 'Enter the code from HCI to connect this site.'); return; }
    if (sock || dialing) return;
    stopped = false;
    dialing = true;
    setStatus('connecting', 'Connecting to ' + relayHttp(s.url) + '…');
    ws.connect(relayWs(s.url), { Authorization: 'Bearer ' + s.key, 'User-Agent': 'HCI-ONE-Board-Remote/' + VERSION }, 15000).then(conn => {
      dialing = false;
      if (stopped || !S().key) { conn.close(1000); return; }
      sock = conn;
      backoff = 2000;
      connectedAt = now();
      setStatus('connected', 'Connected as ' + (S().siteName || 'this site') + '.');
      hello();
      lastSent = ''; pushState(true);
      conn.on('message', (m, bin) => { if (!bin) onMessage(m); });
      conn.on('close', (codeN, why) => {
        if (sock === conn) sock = null;
        endAll('The link to HCI dropped.');
        if (codeN === 4001) {           // HCI removed this site
          S().key = ''; saveStore();
          setStatus('error', (why || 'This site was removed from HCI ONE Remote') + '. Connect it again with a new code from HCI.');
          note('', 'Removed by HCI, link stopped');
          return;
        }
        if (stopped) return;
        setStatus('connecting', 'The link dropped. Trying again…');
        retry();
      });
    }).catch(e => {
      dialing = false;
      if (stopped) return;
      if (e.status === 401) {
        S().key = ''; saveStore();
        setStatus('error', 'HCI ONE Remote no longer knows this site. Connect it again with a new code from HCI.');
        note('', 'Not known at HCI any more, link stopped');
        return;
      }
      setStatus('connecting', 'Cannot reach ' + relayHttp(S().url) + ' (' + (e.code || e.message) + '). Trying again…');
      retry();
    });
  }
  function retry() {
    clearTimeout(retryT);
    retryT = setTimeout(start, backoff);
    backoff = Math.min(60000, backoff * 2);
  }
  function stop(why) {
    stopped = true;
    clearTimeout(retryT);
    endAll(why || 'Remote was turned off at the hospital.');
    if (sock) { try { sock.close(1000, 'stopped'); } catch (e) { /* gone */ } sock = null; }
  }
  function setStatus(st, msg) { status = st; message = msg; }
  function hello() { if (sock) sock.json({ t: 'hello', version: VERSION, policy: S().policy, ask: false, site: S().siteName }); }

  /* ---------------- what HCI sees: health and inventory, never screens or logs ---------------- */
  async function buildState() {
    const [h, st] = await Promise.all([local('GET', '/api/health'), local('GET', '/api/state')]);
    if (!h.json || !h.json.boards) return null;
    const live = new Map(((st.json && st.json.boards) || []).map(b => [b.id, b]));
    const t = h.json.now || now();
    const counts = { online: 0, late: 0, degraded: 0, offline: 0, unknown: 0, paused: 0 };
    const boards = h.json.boards.map(b => {
      const hh = b.health || {}, lb = live.get(b.id) || {};
      counts[hh.state] = (counts[hh.state] || 0) + 1;
      return {
        id: b.id, name: b.name, room: b.room || '', unit: b.unit || '', closet: b.closet || '', kind: b.kind || 'other',
        model: [b.make, b.model].filter(Boolean).join(' '), android: b.android || '', adb: b.status,
        state: hh.state || 'unknown', sinceAgo: hh.since ? t - hh.since : null, beatAgo: hh.lastBeat ? t - hh.lastBeat : null,
        faults: (hh.faults || []).map(f => ({ sev: f.sev, title: f.title })), headline: hh.headline || '',
        watch: b.app || '', onScreen: lb.app || '', awake: lb.awake === undefined ? null : lb.awake
      };
    });
    const issues = (h.json.issues || []).filter(i => !i.resolvedAt).map(i => ({
      title: i.title, where: i.where, sev: i.sev, ago: t - (i.openedAt || t), acked: !!i.acked, owner: i.owner || [], boards: i.boards || []
    }));
    return { site: S().siteName, version: VERSION, policy: S().policy, ask: false, counts, boards, issues };
  }
  let building = false;
  async function pushState(force) {
    if (!sock || !sock.open || building) return;
    building = true;
    try {
      const data = await buildState();
      if (!data || !sock || !sock.open) return;
      // ages change every second, so compare without them and still send a fresh copy every 30 s
      const sig = JSON.stringify(data, (k, v) => (k === 'sinceAgo' || k === 'beatAgo' || k === 'ago') ? undefined : v);
      if (force || sig !== lastSent || now() - lastSentAt > 30000) {
        sock.json({ t: 'state', data });
        lastSent = sig; lastSentAt = now();
      }
    } catch (e) { log('remote state', e.message); }
    finally { building = false; }
  }
  setInterval(() => pushState(false), 3000);

  /* ---------------- requests from HCI ---------------- */
  function boardName(id) {
    const b = store.boards.find(x => x.id === id);
    return b ? b.name : '';
  }
  function allowed(need) { return LEVEL[S().policy] >= LEVEL[need]; }
  function refuseWhy(need) {
    return 'This hospital allows ' + POLICY_NAME[S().policy].toLowerCase() + ' from HCI, not ' + (need === 'live' ? 'live view' : 'remote fixes') + '.';
  }
  function reply(id, obj) { if (sock && sock.open) sock.json(Object.assign({ t: 'res', id }, obj)); }

  function onMessage(m) {
    let msg; try { msg = JSON.parse(m); } catch (e) { return; }
    if (msg.t === 'req') return onRequest(msg).catch(e => reply(msg.id, { ok: false, message: e.message }));
    if (msg.t === 'live') return startLive(msg);
    if (msg.t === 'live-end') return endLive(msg.ch, '', true);
    if (msg.t === 'touch') return liveTouch(msg);
    if (msg.t === 'key') return liveKey(msg);
  }

  async function onRequest(msg) {
    const b = store.boards.find(x => x.id === msg.board);
    if (!b) return reply(msg.id, { ok: false, message: 'That board is not on this site any more.' });
    const who = String(msg.user || '').slice(0, 40);
    if (msg.op === 'restartapp' || msg.op === 'reboot' || msg.op === 'key') {
      const need = msg.op === 'key' && msg.key !== 'wake' ? 'live' : 'fixes';   // waking a screen is a fix; other keys need live view
      if (!allowed(need)) { note(who, 'Refused: ' + (msg.op === 'key' ? 'pressing ' + msg.key : msg.op === 'reboot' ? 'reboot' : 'restart app'), b.name, false); return reply(msg.id, { ok: false, message: refuseWhy(need) }); }
      const r = msg.op === 'key'
        ? await local('POST', '/api/boards/' + b.id + '/key', { key: msg.key })
        : await local('POST', '/api/boards/' + b.id + '/' + msg.op, {});
      const j = r.json || { ok: false };
      const label = msg.op === 'restartapp' ? 'Restarted the app' : msg.op === 'reboot' ? 'Rebooted the board' : 'Pressed ' + msg.key;
      note(who, label, b.name, !!j.ok);
      setTimeout(() => pushState(true), 1500);
      return reply(msg.id, { ok: !!j.ok, message: j.message || (j.ok ? 'Done.' : 'The board did not take it.') });
    }
    if (msg.op === 'screen') {
      if (!allowed('live')) { note(who, 'Refused: screen picture', b.name, false); return reply(msg.id, { ok: false, message: refuseWhy('live') }); }
      const r = await local('GET', '/api/boards/' + b.id + '/screen?fresh=1', null, true);
      if (r.status !== 200 || !/image\/png/.test(r.type)) {
        let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch (e) { /* not json */ }
        return reply(msg.id, { ok: false, message: (j && j.message) || 'Could not capture the screen.' });
      }
      return reply(msg.id, { ok: true, png: r.buf.toString('base64') });
    }
    reply(msg.id, { ok: false, message: 'Unknown request.' });
  }

  /* ---------------- live view: the same video as the Boards page, sent out frame by frame ---------------- */
  function liveSay(ch, state, msg) { if (sock && sock.open) sock.json({ t: 'live', ch, state, message: msg || '' }); }
  async function startLive(msg) {
    const ch = msg.ch >>> 0, who = String(msg.user || '').slice(0, 40);
    const b = store.boards.find(x => x.id === msg.board);
    if (!b) return liveSay(ch, 'error', 'That board is not on this site any more.');
    if (!allowed('live')) { note(who, 'Refused: live view', b.name, false); return liveSay(ch, 'denied', refuseWhy('live')); }
    const l = { ch, who, board: b.id, boardName: b.name, req: null, started: now(), live: false, waitKey: false, tq: [], tBusy: false, ended: false };
    lives.set(ch, l);
    liveSay(ch, 'connecting', 'Starting video at the board…');
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/boards/' + b.id + '/stream', method: 'GET', headers: HDR }, res => {
      if (l.ended) { res.destroy(); return; }
      if (res.statusCode !== 200) {
        let s = ''; res.on('data', c => { s += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } endLive(ch, (j && j.message) || 'Live video is not available for this board.'); });
        return;
      }
      l.live = true;
      note(who, 'Live view started', b.name);
      liveSay(ch, 'live', '');
      let buf = Buffer.alloc(0);
      res.on('data', d => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        let off = 0;
        while (buf.length - off >= 13) {
          const len = buf.readUInt32BE(off + 1);
          if (buf.length - off < 13 + len) break;
          forward(l, buf.subarray(off, off + 13 + len));
          off += 13 + len;
        }
        if (off) buf = buf.subarray(off);
      });
      res.on('end', () => endLive(ch, 'Live video ended at the board.'));
      res.on('error', () => endLive(ch, 'Live video ended at the board.'));
    });
    req.on('error', e => endLive(ch, 'Could not start live video: ' + e.message));
    req.end();
    l.req = req;
  }
  function forward(l, f) {
    if (!sock || !sock.open) return;
    const kind = f[0];
    // A slow link skips ahead to the next key frame instead of falling behind.
    if (kind === 4 && (l.waitKey || sock.bufferedAmount > 2 * 1024 * 1024)) { l.waitKey = true; return; }
    if (kind === 3) l.waitKey = false;
    const h = Buffer.alloc(4); h.writeUInt32BE(l.ch, 0);
    sock.send(Buffer.concat([h, f]));
  }
  function liveTouch(msg) {
    const l = lives.get(msg.ch >>> 0);
    if (!l || !l.live || !allowed('live')) return;
    const t = { a: msg.a, x: msg.x | 0, y: msg.y | 0, w: msg.w | 0, h: msg.h | 0 };
    if (!['down', 'move', 'up'].includes(t.a)) return;
    const last = l.tq[l.tq.length - 1];
    if (t.a === 'move' && last && last.a === 'move') l.tq[l.tq.length - 1] = t; else l.tq.push(t);
    if (t.a === 'up') l.taps = (l.taps || 0) + 1;
    if (l.tBusy) return;
    l.tBusy = true;
    (async () => {
      while (l.tq.length && !l.ended) await local('POST', '/api/boards/' + l.board + '/touch', l.tq.shift());
      l.tBusy = false;
    })();
  }
  function liveKey(msg) {
    const l = lives.get(msg.ch >>> 0);
    if (!l || !l.live || !allowed('live')) return;
    if (!['back', 'home', 'wake', 'recents'].includes(msg.key)) return;
    local('POST', '/api/boards/' + l.board + '/key', { key: msg.key });
    note(l.who, 'Pressed ' + msg.key + ' in live view', l.boardName);
  }
  function endLive(ch, why, fromRelay) {
    const l = lives.get(ch);
    if (!l || l.ended) return;
    l.ended = true;
    lives.delete(ch);
    try { if (l.req) l.req.destroy(); } catch (e) { /* gone */ }
    if (!fromRelay) liveSay(ch, 'ended', why || 'Live view ended.');
    if (l.live) note(l.who, 'Live view ended after ' + Math.max(1, Math.round((now() - l.started) / 1000)) + ' s' + (l.taps ? ', ' + l.taps + ' taps' : '') + (why && !fromRelay ? ' (' + why + ')' : ''), l.boardName);
  }
  function endAll(why) {
    for (const ch of Array.from(lives.keys())) endLive(ch, why);
  }

  /* ---------------- this PC's Remote page and banner ---------------- */
  function publicStatus(full) {
    const s = S();
    const o = {
      status, message, policy: s.policy, enrolled: !!s.key, enrolledAt: s.enrolledAt || 0, siteName: s.siteName, url: relayHttp(s.url || ''),
      connectedAt: status === 'connected' ? connectedAt : 0,
      live: Array.from(lives.values()).filter(l => l.live).map(l => ({ ch: l.ch, who: l.who, board: l.boardName, since: l.started }))
    };
    if (full) o.activity = activity.slice(-150).reverse();
    return o;
  }

  async function enroll(body) {
    let u = String(body.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(u)) u = (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u) ? 'http://' : 'https://') + u;
    let parsed; try { parsed = new URL(u); } catch (e) { return { ok: false, message: 'That relay address is not a web address.' }; }
    const codeV = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (codeV.length < 6) return { ok: false, message: 'Enter the enrollment code from HCI.' };
    const lib = parsed.protocol === 'https:' ? require('https') : http;
    const data = Buffer.from(JSON.stringify({ code: codeV, version: VERSION }));
    const r = await new Promise(resolve => {
      const req = lib.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: '/agent/enroll', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'HCI-ONE-Board-Remote/' + VERSION } }, res => {
        let s = ''; res.on('data', c => { s += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } resolve(j || { ok: false, message: 'The relay answered ' + res.statusCode + '. Is that the right address?' }); });
      });
      req.setTimeout(15000, () => req.destroy(new Error('The relay did not answer.')));
      req.on('error', e => resolve({ ok: false, message: 'Cannot reach ' + u + ' (' + (e.code || e.message) + ').' }));
      req.write(data); req.end();
    });
    if (!r.ok) return { ok: false, message: r.message || 'Enrollment failed.' };
    stop('Enrolling again.');
    const s = S();
    s.url = u; s.key = r.key; s.siteId = r.siteId; s.siteName = r.siteName; s.enrolledAt = now();
    s.policy = 'live';                // connecting with HCI's code is the consent: full access, no asking later
    saveStore();
    note('', 'Enrolled as ' + r.siteName + ' with ' + u + '. HCI may fix and view boards without asking.');
    stopped = false; start();
    return { ok: true, message: 'Enrolled as ' + r.siteName + '. Connecting…' };
  }

  async function handle(req, res, p, url) {
    if (req.method === 'GET' && (p === '/remote' || p === '/remote.html')) { send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8'); return true; }
    if (req.method === 'GET' && p === '/remote-banner.js') { send(res, 200, fs.readFileSync(BANNER), 'text/javascript; charset=utf-8'); return true; }
    if (req.method === 'GET' && p === '/api/remote') { send(res, 200, publicStatus(url.searchParams.get('full') === '1')); return true; }
    if (req.method !== 'POST' || !/^\/api\/remote\//.test(p)) return false;
    if (req.headers['x-board-remote'] !== '1') { send(res, 403, { ok: false, message: 'Forbidden' }); return true; }
    const body = await readJson(req);
    if (p === '/api/remote/enroll') { send(res, 200, await enroll(body)); return true; }
    if (p === '/api/remote/end') {
      const l = lives.get(Number(body.ch) >>> 0);
      if (l) { endLive(l.ch, 'Ended by the hospital.'); note('', 'Ended live view of ' + l.who, l.boardName); }
      send(res, 200, { ok: !!l, message: l ? 'Live view ended.' : 'That live view already ended.' });
      return true;
    }
    send(res, 404, { ok: false, message: 'Not found' });
    return true;
  }

  return { start, stop: () => stop('Board Remote is stopping.'), handle, save: () => { try { fs.writeFileSync(LOG_FILE, JSON.stringify({ activity: activity.slice(-500) })); } catch (e) { /* ignore */ } } };
};
