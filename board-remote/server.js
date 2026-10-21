'use strict';
/*
  HCI ONE Board Remote
  Keeps ADB connected to every board on the list, serves the dashboard at
  http://localhost:7755 and drives screen capture, taps, keys, live mirror
  (scrcpy) and shell windows, plus Device Health (health.js): heartbeat,
  diagnosis, alerts, remote fixes and discovery, and Deploy (deploy.js): room
  list import, bulk app push and rooms in MediaCare. Needs nothing but Node;
  adb and scrcpy are fetched into ./tools by SETUP.bat.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const VERSION = '2.1.0';
/* APP holds the program (replaced by updates); ROOT holds this PC's data (boards, health, audit,
   snapshots, tools). They are the same folder unless the Windows service sets BR_DATA_DIR. */
const APP = __dirname;
const ROOT = process.env.BR_DATA_DIR ? path.resolve(process.env.BR_DATA_DIR) : __dirname;
const AS_SERVICE = process.env.BR_SERVICE === '1';
try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) { /* reported when files are written */ }
const PORT = Number(process.env.BOARD_REMOTE_PORT) || 7755;
const DATA_FILE = path.join(ROOT, 'boards.json');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'boardremote.log');
const IS_WIN = process.platform === 'win32';

/* ---------------- logging ---------------- */
function log() {
  const line = new Date().toISOString() + '  ' + Array.prototype.join.call(arguments, ' ') + '\n';
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch (e) { /* first write */ }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* logging must never break the tool */ }
  if (process.stdout.isTTY) process.stdout.write(line);
}

/* ---------------- saved boards ---------------- */
const store = {
  settings: { adbPath: '', scrcpyPath: '', keepaliveSeconds: 10, mirrorMaxSize: 1920 },
  boards: []
};
const newId = () => crypto.randomBytes(4).toString('hex');
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$/;

const KIND_KEYS = ['wb', 'ds', 'tv', 'cam', 'tab', 'usb', 'other'];   // other = type not set yet
const PKG_RE = /^[A-Za-z][\w]*(\.[\w]+)+$/;
const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
function normBoard(b) {
  return {
    id: b.id && /^[a-f0-9]{8}$/.test(b.id) ? b.id : newId(),
    name: String(b.name || b.host).trim().slice(0, 60) || String(b.host),
    host: String(b.host).trim(),
    port: Number(b.port) || 5555,
    auto: b.auto !== false,
    unit: clip(b.unit, 40), closet: clip(b.closet, 40), room: clip(b.room, 20),
    kind: KIND_KEYS.indexOf(b.kind) >= 0 ? b.kind : 'other',
    app: PKG_RE.test(b.app || '') ? b.app : ''
  };
}
function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    Object.assign(store.settings, j.settings || {});
    store.boards = (Array.isArray(j.boards) ? j.boards : []).filter(b => b && HOST_RE.test(String(b.host || ''))).map(normBoard);
  } catch (e) {
    if (e.code !== 'ENOENT') log('boards.json could not be read:', e.message);
  }
}
function saveStore() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function checkInput(body, existing) {
  const host = String(body.host || '').trim();
  const port = Number(body.port || 5555);
  if (!HOST_RE.test(host)) return 'Enter a valid IP address or host name.';
  if (!(port >= 1 && port <= 65535 && Math.floor(port) === port)) return 'Port must be a number from 1 to 65535.';
  const dupe = store.boards.find(x => x.host === host && x.port === port && (!existing || x.id !== existing.id));
  if (dupe) return host + ':' + port + ' is already on the list as ' + dupe.name + '.';
  return '';
}

/* ---------------- adb and scrcpy ---------------- */
function isFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }
function onPath(exe) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d.replace(/^"|"$/g, ''), exe);
    if (isFile(p)) return p;
  }
  return null;
}
let exeCache = { at: 0, adb: null, scrcpy: null };
function exes() {
  if (Date.now() - exeCache.at < 15000) return exeCache;
  const ext = IS_WIN ? '.exe' : '';
  // Android Studio's adb comes first so the two never fight over the adb server.
  const adbList = [
    store.settings.adbPath,
    process.env.ADB,
    IS_WIN && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe') : '',
    process.env.BR_TOOLS_DIR ? path.join(process.env.BR_TOOLS_DIR, 'scrcpy', 'adb' + ext) : '',
    path.join(ROOT, 'tools', 'scrcpy', 'adb' + ext),
    path.join(ROOT, 'tools', 'platform-tools', 'adb' + ext)
  ];
  // the Windows app ships scrcpy in Program Files, where the desktop helper (run as the signed in user) can start it
  const scrList = [store.settings.scrcpyPath, process.env.BR_TOOLS_DIR ? path.join(process.env.BR_TOOLS_DIR, 'scrcpy', 'scrcpy' + ext) : '', path.join(ROOT, 'tools', 'scrcpy', 'scrcpy' + ext)];
  exeCache = {
    at: Date.now(),
    adb: adbList.find(isFile) || onPath('adb' + ext),
    scrcpy: scrList.find(isFile) || onPath('scrcpy' + ext)
  };
  return exeCache;
}

function adb(args, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const bin = exes().adb;
    if (!bin) return resolve({ ok: false, out: opts.buffer ? Buffer.alloc(0) : '', err: 'adb was not found. Run SETUP.bat once.' });
    execFile(bin, args, {
      timeout: opts.timeout || 8000,
      encoding: opts.buffer ? 'buffer' : 'utf8',
      maxBuffer: 96 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const err = String(stderr || '').trim() || (error ? (error.killed ? 'adb timed out' : error.message) : '');
      resolve({ ok: !error, out: stdout, err });
    });
  });
}
const serialOf = b => b.host + ':' + b.port;
const shell = (b, cmd, timeout) => adb(['-s', serialOf(b), 'shell', cmd], { timeout: timeout || 8000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mapState(s) {
  s = String(s || '');
  if (s === 'device') return 'online';
  if (s === 'unauthorized' || s === 'no' || /permission/.test(s)) return 'unauthorized';
  if (s === 'authorizing' || s === 'connecting') return 'connecting';
  if (s === 'offline') return 'offline';
  return s || 'disconnected';
}
async function listDevices() {
  const r = await adb(['devices', '-l'], { timeout: 15000 });
  if (!r.ok && !r.out) return null;
  const map = {};
  for (const raw of String(r.out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^List of devices/.test(line) || line[0] === '*') continue;
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const info = { state: m[2] };
    for (const kv of m[3].trim().split(/\s+/)) {
      const i = kv.indexOf(':');
      if (i > 0) info[kv.slice(0, i)] = kv.slice(i + 1);
    }
    map[m[1]] = info;
  }
  return map;
}
const isUsbSerial = s => !/:\d+$/.test(s) && !/^emulator/.test(s) && !/_adb-tls/.test(s);

function probe(host, port, ms) {
  return new Promise(resolve => {
    let done = false;
    const s = net.connect({ host, port });
    const fin = ok => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

/* ---------------- live state per board ---------------- */
const rt = new Map();
function R(b) {
  if (!rt.has(b.id)) rt.set(b.id, { status: 'starting', error: '', paused: false, connecting: false, offlineTicks: 0 });
  return rt.get(b.id);
}
function resetInfo(r) { r.make = r.model = r.android = r.app = r.activity = ''; r.size = null; r.awake = null; r.shot = null; }

async function fetchInfo(b) {
  const r = R(b);
  const res = await shell(b, 'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; wm size', 6000);
  if (!res.ok) return;
  const out = String(res.out);
  const L = out.split(/\r?\n/).map(s => s.trim());
  r.make = L[0] || ''; r.model = L[1] || ''; r.android = L[2] || '';
  const m = /Override size:\s*(\d+)x(\d+)/.exec(out) || /Physical size:\s*(\d+)x(\d+)/.exec(out);
  if (m) r.size = { w: +m[1], h: +m[2] };
}
async function fetchLive(b) {
  const r = R(b);
  const res = await shell(b, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'; dumpsys power | grep -m 1 'mWakefulness='", 6000);
  const out = String(res.out || '');
  if (!out) return;
  const f = /mCurrentFocus=Window\{[^}]*?\s([A-Za-z]\w*(?:\.\w+)+)\/([\w.$]+)/.exec(out) || /([A-Za-z]\w*(?:\.\w+)+)\/([\w.$]+)/.exec(out);
  if (f) { r.app = f[1]; r.activity = f[2]; }
  const w = /mWakefulness=(\w+)/.exec(out);
  r.awake = w ? w[1] === 'Awake' : null;
}

function connect(b) {
  const r = R(b);
  // A click during a keepalive attempt waits for that attempt instead of starting another.
  if (!r.connectP) r.connectP = doConnect(b).finally(() => { r.connectP = null; });
  return r.connectP;
}
// At most 16 connect attempts at once, so a PC start or a closet coming back with 150 boards is a steady stream, not a burst.
const CONNECT_MAX = 16, connectQ = [];
let connectN = 0;
const connectSlot = () => new Promise(res => { if (connectN < CONNECT_MAX) { connectN++; res(); } else connectQ.push(res); });
const connectDone = () => { const next = connectQ.shift(); if (next) next(); else connectN--; };
async function doConnect(b) {
  const r = R(b);
  r.connecting = true;
  await connectSlot();
  try {
    if (!(await probe(b.host, b.port, 1500))) {
      if (r.status !== 'unreachable' || !r.downAt) r.downAt = Date.now();
      r.status = 'unreachable';
      r.error = 'No answer on ' + serialOf(b) + '. The board is off, off the network, or ADB over network is not on.';
      return r;
    }
    if (r.status !== 'online') r.status = 'connecting';
    const res = await adb(['connect', serialOf(b)], { timeout: 12000 });
    const text = (String(res.out || '') + ' ' + (res.err || '')).trim();
    r.error = /connected to/i.test(text) && !/(failed|cannot|unable)/i.test(text) ? '' : (text.split(/\r?\n/)[0] || 'adb could not connect.');
    const devs = await listDevices();
    const d = devs && devs[serialOf(b)];
    if (d) r.status = mapState(d.state);
    if (r.status === 'unauthorized') r.error = 'Tap Allow on the board and tick Always allow from this computer.';
    if (r.status === 'online' && !r.model) await fetchInfo(b);
  } finally {
    r.connecting = false;
    connectDone();
  }
  return r;
}

async function keep(b, d) {
  const r = R(b);
  if (d) {
    r.status = mapState(d.state);
    if (r.status === 'online') {
      r.error = ''; r.offlineTicks = 0; r.lastSeen = Date.now(); r.downAt = 0;
      if (!r.model) await fetchInfo(b);
      // Device Health refreshes the app and sleep state every 30 s; this is only a fallback.
      if (!r.liveAt || Date.now() - r.liveAt > 75000) { r.liveAt = Date.now(); await fetchLive(b); }
      return;
    }
    stopLive(b.id, 'Board went offline');
    if (r.status === 'unauthorized') {
      r.error = 'Tap Allow on the board and tick Always allow from this computer.';
    } else if (r.status === 'offline' && !r.paused) {
      // A board that rebooted or dropped WiFi can sit in "offline" forever; kick it.
      if (++r.offlineTicks >= 3) {
        r.offlineTicks = 0;
        await adb(['disconnect', serialOf(b)], { timeout: 5000 });
        await connect(b);
      }
    }
    return;
  }
  stopLive(b.id, 'Board disconnected');
  if (r.paused || !b.auto) { r.status = 'disconnected'; return; }
  // a board that has not answered for 2 minutes is tried every 30 s instead of every cycle (Connect all still tries at once)
  const t = Date.now();
  if (r.status === 'unreachable' && r.downAt && t - r.downAt > 120000 && t - (r.triedAt || 0) < 30000) return;
  r.triedAt = t;
  await connect(b);
}

let ticking = false, lastTick = 0, adbOk = null, usb = [];
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const devs = await listDevices();
    adbOk = !!devs;
    lastTick = Date.now();
    if (devs) {
      usb = Object.keys(devs).filter(isUsbSerial).map(s => ({ serial: s, state: mapState(devs[s].state), model: String(devs[s].model || '').replace(/_/g, ' ') }));
      // Each board is kept on its own, so one slow or unreachable board never holds up the cycle for the rest.
      for (const b of store.boards) {
        const r = R(b), d = devs[serialOf(b)];
        if (r.keeping) { if (d && !r.connecting) r.status = mapState(d.state); continue; }
        r.keeping = true;
        keep(b, d).catch(e => log('keep', b.name, e.message)).finally(() => { r.keeping = false; });
      }
    }
    if (health) health.onTick(devs);
    if (logs) logs.onTick(devs);
    if (audit) audit.onTick();
    if (cloud) cloud.onTick();
    snapTick();
  } catch (e) {
    log('tick error', e.stack || e);
  } finally {
    ticking = false;
  }
}

/* ---------------- screen, input, actions ---------------- */
// At most 6 screen captures run at once across every board and browser tab; a full screen view goes to the front of the line.
const SHOT_MAX = 6, shotQ = [];
let shotN = 0;
const shotSlot = front => new Promise(res => { if (shotN < SHOT_MAX) { shotN++; res(); } else if (front) shotQ.unshift(res); else shotQ.push(res); });
const shotDone = () => { const next = shotQ.shift(); if (next) next(); else shotN--; };
function capture(b, maxAge, front) {
  const r = R(b);
  if (r.shot && Date.now() - r.shot.at < maxAge) return Promise.resolve(r.shot);
  if (!r.shotP) {
    r.shotP = (async () => {
      await shotSlot(front);
      try {
        const res = await adb(['-s', serialOf(b), 'exec-out', 'screencap', '-p'], { timeout: 12000, buffer: true });
        const buf = res.out;
        if (Buffer.isBuffer(buf) && buf.length > 64 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) {
          r.shot = { buf, at: Date.now() };
          return r.shot;
        }
        throw new Error((res.err || String(buf || '')).trim().split(/\r?\n/)[0] || 'Screen capture failed');
      } finally { shotDone(); }
    })().finally(() => { r.shotP = null; });
  }
  return r.shotP;
}

/* ---------------- snapshots to a folder (for audits) ---------------- */
// Saves the board's screen as a PNG under <folder>/<date>/<room and name>_<time>.png, so you can
// line up what was on a board against the messages that came in. On demand, or on a timer.
const SNAP_DEFAULTS = { dir: '', everyMinutes: 0, keepDays: 14 };
function snapCfg() { store.settings.snapshots = Object.assign({}, SNAP_DEFAULTS, store.settings.snapshots || {}); return store.settings.snapshots; }
function snapDir() { const d = snapCfg().dir; return d && String(d).trim() ? String(d).trim() : path.join(ROOT, 'snapshots'); }
const pad2 = n => String(n).padStart(2, '0');
const safeName = v => String(v || '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'board';
async function saveSnapshot(b) {
  const shot = await capture(b, 1500, true);
  const d = new Date();
  const day = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const time = pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
  const dir = path.join(snapDir(), day);
  fs.mkdirSync(dir, { recursive: true });
  const label = safeName((b.room ? 'room ' + b.room + ' ' : '') + b.name);
  const file = path.join(dir, label + '_' + time + '.png');
  fs.writeFileSync(file, shot.buf);
  return { ok: true, rel: day + '/' + path.basename(file), file, at: d.getTime(), bytes: shot.buf.length };
}
function listSnaps(limit) {
  limit = limit || 300;
  const base = snapDir();
  const out = [];
  let days = [];
  try { days = fs.readdirSync(base).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse(); } catch (e) { return out; }
  for (const day of days) {
    let files = [];
    try { files = fs.readdirSync(path.join(base, day)).filter(n => n.endsWith('.png')); } catch (e) { continue; }
    for (const name of files) {
      let st; try { st = fs.statSync(path.join(base, day, name)); } catch (e) { continue; }
      out.push({ rel: day + '/' + name, name, day, at: st.mtimeMs, bytes: st.size });
    }
    if (out.length >= limit) break;
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, limit);
}
function pruneSnaps() {
  const base = snapDir();
  const keep = Math.max(1, Number(snapCfg().keepDays) || 14);
  const c = new Date(Date.now() - keep * 86400000);
  const cutDay = c.getFullYear() + '-' + pad2(c.getMonth() + 1) + '-' + pad2(c.getDate());
  let days = [];
  try { days = fs.readdirSync(base).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)); } catch (e) { return; }
  for (const day of days) if (day < cutDay) { try { fs.rmSync(path.join(base, day), { recursive: true, force: true }); } catch (e) { /* leave it */ } }
}
let snapRunAt = 0, snapPruneAt = 0, snapBusy = false;
function snapTick() {
  const every = Math.max(0, Number(snapCfg().everyMinutes) || 0);
  const t = Date.now();
  if (every > 0 && !snapBusy && t - snapRunAt >= every * 60000) {
    snapRunAt = t; snapBusy = true;
    (async () => {
      for (const b of store.boards.filter(x => R(x).status === 'online')) { try { await saveSnapshot(b); } catch (e) { /* skip */ } }
    })().catch(() => {}).finally(() => { snapBusy = false; });
  }
  if (t - snapPruneAt >= 3600000) { snapPruneAt = t; try { pruneSnaps(); } catch (e) { /* leave it */ } }
}

const KEYS = { home: 3, back: 4, recents: 187, power: 26, wake: 224, sleep: 223, volup: 24, voldown: 25, mute: 164, menu: 82 };
const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n < 20000 ? n : null; };

/* ---------------- the desktop helper (Windows app) ----------------
   As a Windows service, Board Remote has no desktop, so a window it opened would be invisible.
   The desktop helper runs in each signed in user's session (started at sign in) and asks for work
   here; Mirror and Shell windows are handed to it and open on that person's screen. */
const desk = { waiting: [], queue: [], pending: new Map(), seen: 0 };
const deskOnline = () => desk.waiting.length > 0 || Date.now() - desk.seen < 40000;
function deskPoll(res) {
  desk.seen = Date.now();
  const job = desk.queue.shift();
  if (job) return send(res, 200, { ok: true, job });
  const w = { res, t: setTimeout(() => { desk.waiting = desk.waiting.filter(x => x !== w); send(res, 200, { ok: true, job: null }); }, 25000) };
  desk.waiting.push(w);
  res.on('close', () => { clearTimeout(w.t); desk.waiting = desk.waiting.filter(x => x !== w); });
}
function viaDesktop(job, waitMs) {
  if (!deskOnline()) return Promise.resolve({ ok: false, message: 'Nobody is signed in to Windows on this PC, so there is no screen to open the window on. Sign in to this PC, or use Live view with touch from any browser.' });
  job.id = crypto.randomBytes(6).toString('hex');
  return new Promise(resolve => {
    const t = setTimeout(() => { desk.pending.delete(job.id); desk.queue = desk.queue.filter(j => j !== job); resolve({ ok: false, message: 'The Board Remote desktop helper did not answer. Sign out of Windows and back in, or reinstall Board Remote.' }); }, waitMs || 15000);
    desk.pending.set(job.id, r => { clearTimeout(t); resolve(r); });
    const w = desk.waiting.shift();
    if (w) { clearTimeout(w.t); desk.seen = Date.now(); send(w.res, 200, { ok: true, job }); } else desk.queue.push(job);
  });
}
function deskResult(body) {
  const fn = desk.pending.get(String(body.id || ''));
  if (!fn) return false;
  desk.pending.delete(String(body.id));
  fn({ ok: !!body.ok, message: String(body.message || '').slice(0, 500), command: body.command });
  return true;
}

function mirror(b) {
  const r = R(b);
  const ex = exes();
  if (!ex.scrcpy) return Promise.resolve({ ok: false, message: 'scrcpy is not installed yet. Run SETUP.bat once.' });
  if (r.mirror && r.mirror.exitCode === null) return Promise.resolve({ ok: true, message: 'The mirror window for ' + b.name + ' is already open.' });
  const args = ['--serial', serialOf(b), '--window-title', b.name + '   ' + serialOf(b), '--no-audio', '--max-size', String(store.settings.mirrorMaxSize || 1920)];
  // As a Windows service: the window opens on the signed in person's screen, through the desktop helper.
  if (AS_SERVICE) return viaDesktop({ type: 'mirror', exe: ex.scrcpy, args, adb: ex.adb || '', name: b.name });
  const env = Object.assign({}, process.env);
  if (ex.adb) env.ADB = ex.adb;
  let child;
  try {
    child = spawn(ex.scrcpy, args, { cwd: path.dirname(ex.scrcpy), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return Promise.resolve({ ok: false, message: 'Could not start scrcpy: ' + e.message });
  }
  r.mirror = child;
  let text = '';
  const grab = d => { if (text.length < 8000) text += d.toString(); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ ok: true, message: 'Live mirror opening for ' + b.name + '.' }), 3500);
    child.on('error', e => { clearTimeout(t); if (r.mirror === child) r.mirror = null; resolve({ ok: false, message: 'Could not start scrcpy: ' + e.message }); });
    child.on('exit', code => {
      if (r.mirror === child) r.mirror = null;
      if (code) {
        clearTimeout(t);
        log('scrcpy exited', code, text.slice(-800));
        const err = (/ERROR:.*$/m.exec(text) || [text.trim().split(/\r?\n/).pop() || 'unknown error'])[0];
        resolve({ ok: false, message: 'Mirror closed. ' + err });
      }
    });
  });
}

function openShell(b) {
  const bin = exes().adb;
  const command = 'adb -s ' + serialOf(b) + ' shell';
  if (!bin) return { ok: false, message: 'adb was not found. Run SETUP.bat once.', command };
  if (!IS_WIN) return { ok: false, message: 'Shell windows open on Windows only. Run this in a terminal:', command };
  if (AS_SERVICE) return viaDesktop({ type: 'shell', adb: bin, serial: serialOf(b), title: (b.name.replace(/[^A-Za-z0-9 ._]/g, '').trim() || 'Board') + '  ' + serialOf(b) }).then(r => Object.assign({ command }, r));
  const dir = path.join(ROOT, 'tools', 'shells');
  fs.mkdirSync(dir, { recursive: true });
  const safe = b.name.replace(/[^A-Za-z0-9 ._]/g, '').trim() || 'Board';
  const file = path.join(dir, 'shell_' + b.id + '.cmd');
  fs.writeFileSync(file, [
    '@echo off',
    'title ' + safe + '  ' + serialOf(b),
    'echo  ' + safe + '  ' + serialOf(b),
    'echo  Type exit to leave.',
    'echo.',
    '"' + bin + '" -s ' + serialOf(b) + ' shell',
    'echo.',
    'pause'
  ].join('\r\n'));
  // Not detached: cmd shares the hidden console, so only the new shell window appears.
  spawn('cmd.exe', ['/c', 'start "" "' + file + '"'], { windowsVerbatimArguments: true, stdio: 'ignore' }).on('error', e => log('shell', e.message));
  return { ok: true, message: 'Shell opened for ' + b.name + '.' };
}

async function restartApp(b) {
  const r = R(b);
  await fetchLive(b);
  const pkg = r.app;
  if (!pkg || !/^[A-Za-z]\w*(\.\w+)+$/.test(pkg)) return { ok: false, message: 'Could not tell which app is on screen.' };
  await shell(b, 'am force-stop ' + pkg, 8000);
  const res = await shell(b, 'monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1', 12000);
  if (/No activities found|aborted/i.test(String(res.out) + res.err)) await shell(b, 'input keyevent 3', 5000);
  return { ok: true, message: 'Restarted ' + pkg + ' on ' + b.name + '.' };
}

async function install(b, req) {
  const tmp = path.join(os.tmpdir(), 'boardremote_' + b.id + '_' + Date.now() + '.apk');
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 700 * 1024 * 1024) { req.destroy(); reject(new Error('That file is too large.')); } });
    req.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    req.pipe(ws);
  });
  try {
    const res = await adb(['-s', serialOf(b), 'install', '-r', tmp], { timeout: 300000 });
    const text = (String(res.out || '') + '\n' + (res.err || '')).trim();
    if (/Success/.test(text)) return { ok: true, message: 'Installed on ' + b.name + '.' };
    return { ok: false, message: 'Install failed on ' + b.name + '. ' + ((/Failure.*$/m.exec(text) || [text.split(/\r?\n/).pop()])[0] || '') };
  } finally {
    fs.unlink(tmp, () => {});
  }
}

async function usbToWifi() {
  const devs = await listDevices();
  if (!devs) return { ok: false, message: 'adb is not responding.' };
  const serials = Object.keys(devs).filter(isUsbSerial);
  if (!serials.length) return { ok: false, message: 'No board on USB. Plug one in, tap Allow on the board, then try again.' };
  const lines = [];
  let any = false;
  for (const s of serials) {
    const st = mapState(devs[s].state);
    if (st !== 'online') { lines.push(s + ': ' + (st === 'unauthorized' ? 'tap Allow on the board first.' : st)); continue; }
    const ipr = await adb(['-s', s, 'shell', 'ip -o -4 addr show'], { timeout: 6000 });
    const ips = [];
    String(ipr.out || '').replace(/inet (\d+\.\d+\.\d+\.\d+)\//g, (m, ip) => { if (!/^127\.|^169\.254\./.test(ip)) ips.push(ip); return m; });
    if (!ips.length) { lines.push(s + ': the board has no network address yet.'); continue; }
    const model = String(devs[s].model || 'Board').replace(/_/g, ' ');
    await adb(['-s', s, 'tcpip', '5555'], { timeout: 12000 });
    let b = store.boards.find(x => x.host === ips[0] && x.port === 5555);
    if (!b) {
      b = normBoard({ name: model + ' ' + ips[0].split('.').pop(), host: ips[0], port: 5555 });
      store.boards.push(b);
      saveStore();
    }
    R(b).paused = false;
    await sleep(2500);
    await connect(b);
    any = true;
    lines.push(b.name + ' is on ' + ips[0] + ':5555. You can unplug the cable.');
  }
  return { ok: any, message: lines.join('\n') };
}

/* ---------------- network scan ---------------- */
const ipToInt = ip => ip.split('.').reduce((a, o) => ((a * 256) + Number(o)) >>> 0, 0);
const intToIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function scanTargets() {
  const seen = new Set(), targets = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const a of nets[name] || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || /^169\.254\./.test(a.address)) continue;
      let bits = a.cidr ? Number(a.cidr.split('/')[1]) : 24;
      if (bits < 22) bits = 24;   // never sweep more than a /22
      if (bits > 30) continue;
      const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
      const base = (ipToInt(a.address) & mask) >>> 0;
      const count = Math.pow(2, 32 - bits);
      for (let i = 1; i < count - 1; i++) {
        const t = intToIp(base + i);
        if (t !== a.address && !seen.has(t)) { seen.add(t); targets.push(t); }
      }
    }
  }
  return targets;
}
async function scanHosts(port) {
  const targets = scanTargets();
  const found = [];
  let i = 0;
  const worker = async () => { while (i < targets.length) { const t = targets[i++]; if (await probe(t, port, 450)) found.push(t); } };
  await Promise.all(Array.from({ length: Math.min(128, targets.length) }, worker));
  found.sort((a, b) => ipToInt(a) - ipToInt(b));
  return found;
}
async function scan(port) {
  const targets = scanTargets();
  const found = await scanHosts(port);
  return {
    ok: true,
    scanned: targets.length,
    found: found.map(h => {
      const b = store.boards.find(x => x.host === h && x.port === port);
      return { host: h, port, known: !!b, name: b ? b.name : '' };
    })
  };
}

/* ---------------- live video (scrcpy server, streamed to the dashboard) ----------------
   The board's own hardware encoder sends H.264 over adb; the browser decodes it.
   Touches and keys go back over scrcpy's control socket, so they land instantly
   instead of starting the slow "input" program on the board each time.
   Wire format follows the scrcpy source: v4+ has session packets; v2/v3 do not. */
const LIVE_JAR = '/data/local/tmp/hci-board-remote.jar';
const live = new Map();
let verCache = { path: null, p: null };

function scrcpyVersion() {
  const bin = exes().scrcpy;
  if (!bin) return Promise.resolve(null);
  if (verCache.path === bin && verCache.p) return verCache.p;
  verCache = {
    path: bin,
    p: new Promise(resolve => {
      execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (err, out, errOut) => {
        const m = /scrcpy\s+v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(out || '') + String(errOut || ''));
        if (!m) verCache = { path: null, p: null };   // try again next time
        resolve(m ? { v: m[1] + '.' + m[2] + (m[3] !== undefined ? '.' + m[3] : ''), major: +m[1] } : null);
      });
    })
  };
  return verCache.p;
}
function scrcpyServerFile() {
  const bin = exes().scrcpy;
  if (!bin) return null;
  const dir = path.dirname(bin);
  return [path.join(dir, 'scrcpy-server'), path.join(dir, 'scrcpy-server.jar'),
    '/usr/share/scrcpy/scrcpy-server', '/usr/local/share/scrcpy/scrcpy-server'].find(isFile) || null;
}

function frame(kind, pts, payload) {
  const h = Buffer.alloc(13);
  h[0] = kind;
  h.writeUInt32BE(payload.length, 1);
  h.writeUInt32BE(Math.floor(pts / 4294967296) >>> 0, 5);
  h.writeUInt32BE(pts >>> 0, 9);
  return Buffer.concat([h, payload]);
}
const K_META = 1, K_CONFIG = 2, K_KEY = 3, K_DELTA = 4;

class LiveSession {
  constructor(b) {
    this.b = b;
    this.serial = serialOf(b);
    this.subs = new Set();
    this.closed = false;
    this.meta = null; this.config = null; this.gop = [];
    this.size = null;
    this.out = '';
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  async start() {
    const ex = exes();
    const jar = scrcpyServerFile();
    const ver = await scrcpyVersion();
    if (!jar || !ver) throw new Error('Live video needs scrcpy. Run SETUP.bat once.');
    if (ver.major < 2) throw new Error('scrcpy ' + ver.v + ' is too old for live video. Run SETUP.bat to update.');
    this.major = ver.major;

    const push = await adb(['-s', this.serial, 'push', jar, LIVE_JAR], { timeout: 30000 });
    if (!push.ok) throw new Error('Could not copy the video helper to the board. ' + push.err);
    this.scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
    const fw = await adb(['-s', this.serial, 'forward', 'tcp:0', 'localabstract:scrcpy_' + this.scid], { timeout: 8000 });
    this.port = parseInt(String(fw.out || '').trim(), 10);
    if (!this.port) throw new Error('adb could not open a video tunnel. ' + fw.err);
    if (this.closed) throw new Error('Closed');

    const maxSize = Number(store.settings.liveMaxSize) || 1600;
    const args = ['-s', this.serial, 'shell', 'CLASSPATH=' + LIVE_JAR, 'app_process', '/', 'com.genymobile.scrcpy.Server', ver.v,
      'scid=' + this.scid, 'log_level=info', 'audio=false', 'tunnel_forward=true', 'control=true',
      'max_size=' + maxSize, 'video_bit_rate=8000000', 'max_fps=30', 'clipboard_autosync=false'];
    this.proc = spawn(ex.adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const grab = d => { this.out = (this.out + d.toString()).slice(-4000); };
    this.proc.stdout.on('data', grab);
    this.proc.stderr.on('data', grab);
    this.proc.on('error', e => this.fail('Could not start the video helper: ' + e.message));
    this.proc.on('exit', () => { this.procDone = true; if (!this.closed) this.fail('Live video stopped. ' + this.lastLine()); });

    const first = await this.connectFirst();
    this.video = first.sock;
    this.control = await this.connectPlain();
    this.control.on('data', () => { /* device messages (clipboard) are not used */ });
    this.control.on('error', () => {});
    this.video.on('error', () => {});
    this.video.on('close', () => { if (!this.closed) this.fail('Live video ended. ' + this.lastLine()); });
    this.parse(first.rest);
    R(this.b).liveError = '';
    log('live video started', this.b.name, 'scrcpy', ver.v, 'port', this.port);
  }

  lastLine() {
    const lines = this.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const err = lines.filter(l => /ERROR|Exception|error/.test(l)).pop();
    return (err || '').replace(/^\[server\]\s*/, '').slice(0, 200);
  }

  // The adb tunnel accepts at once even before the board listens; the dummy byte proves it is real.
  connectFirst() {
    const deadline = Date.now() + 10000;
    const attempt = (resolve, reject) => {
      if (this.closed) return reject(new Error(this.error || 'Closed'));
      if (this.procDone) return reject(new Error('The video helper did not start. ' + this.lastLine()));
      if (Date.now() > deadline) return reject(new Error('The board did not answer the video request. ' + this.lastLine()));
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      let done = false;
      const retry = () => { if (done) return; done = true; s.destroy(); setTimeout(() => attempt(resolve, reject), 150); };
      s.setTimeout(2000, retry);
      s.once('error', retry);
      s.once('end', retry);
      s.once('data', d => {
        if (done) return;
        done = true;
        s.setTimeout(0);
        s.removeAllListeners('end');
        s.removeAllListeners('error');
        s.pause();
        resolve({ sock: s, rest: d.subarray(1) });   // first byte is the dummy byte
      });
    };
    return new Promise(attempt);
  }

  connectPlain() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  parse(initial) {
    let buf = initial && initial.length ? Buffer.from(initial) : Buffer.alloc(0);
    let stage = 'device';
    const v4 = this.major >= 4;
    const pump = () => {
      for (;;) {
        if (stage === 'device') {
          if (buf.length < 64) return;
          const end = buf.indexOf(0);
          this.name = buf.subarray(0, end >= 0 && end < 64 ? end : 64).toString('utf8');
          buf = buf.subarray(64);
          stage = 'codec';
        } else if (stage === 'codec') {
          const n = v4 ? 4 : 12;
          if (buf.length < n) return;
          const id = buf.readUInt32BE(0);
          this.codec = ({ 0x68323634: 'h264', 0x68323635: 'h265', 0x00617631: 'av1', 0x00767038: 'vp8', 0x00767039: 'vp9' })[id] || 'h264';
          if (!v4) this.setSize(buf.readUInt32BE(4), buf.readUInt32BE(8));
          buf = buf.subarray(n);
          stage = 'packets';
        } else {
          if (buf.length < 12) return;
          const hi = buf.readUInt32BE(0), lo = buf.readUInt32BE(4);
          if (v4 && (hi & 0x80000000)) {           // session packet: new size (rotation)
            this.setSize(buf.readUInt32BE(4), buf.readUInt32BE(8));
            buf = buf.subarray(12);
            continue;
          }
          const size = buf.readUInt32BE(8);
          if (buf.length < 12 + size) return;
          const payload = Buffer.from(buf.subarray(12, 12 + size));
          buf = buf.subarray(12 + size);
          const config = v4 ? !!(hi & 0x40000000) : !!(hi & 0x80000000);
          const key = v4 ? !!(hi & 0x20000000) : !!(hi & 0x40000000);
          const pts = ((v4 ? hi & 0x1fffffff : hi & 0x3fffffff) * 4294967296) + lo;
          this.packet(config ? K_CONFIG : key ? K_KEY : K_DELTA, config ? 0 : pts, payload);
        }
      }
    };
    this.video.on('data', d => { buf = buf.length ? Buffer.concat([buf, d]) : d; pump(); });
    this.video.resume();
    pump();
  }

  setSize(w, h) {
    this.size = { w, h };
    this.meta = frame(K_META, 0, Buffer.from(JSON.stringify({ w, h, codec: this.codec, name: this.name || '' })));
    this.broadcast(this.meta, false);
  }

  packet(kind, pts, payload) {
    const f = frame(kind, pts, payload);
    if (kind === K_CONFIG) { this.config = f; this.gop = []; }
    else if (kind === K_KEY) this.gop = [f];
    else if (this.gop.length && this.gop.length < 900) this.gop.push(f);
    this.broadcast(f, kind === K_KEY);
  }

  broadcast(f, isKey) {
    for (const sub of this.subs) {
      if (sub.waitKey && !isKey && f[0] === K_DELTA) continue;   // a slow viewer skips ahead to the next key frame
      sub.waitKey = false;
      if (!sub.res.write(f)) sub.waitKey = true;
    }
  }

  addSub(res) {
    clearTimeout(this.idle);
    const sub = { res, waitKey: false };
    this.subs.add(sub);
    // Catch a late viewer up: size, decoder config, then the frames since the last key frame.
    for (const f of [this.meta, this.config].concat(this.gop)) if (f) res.write(f);
    return sub;
  }

  removeSub(sub) {
    this.subs.delete(sub);
    if (!this.subs.size) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => { if (!this.subs.size) this.stop('No viewers'); }, 6000);
    }
  }

  touch(action, x, y, w, h) {
    if (!this.control || this.closed) return false;
    const size = this.size || { w, h };
    const m = Buffer.alloc(32);
    m[0] = 2;                                   // inject touch event
    m[1] = action;                              // 0 down, 1 up, 2 move
    m.writeUInt32BE(0xffffffff, 2);             // pointer id -2: generic finger
    m.writeUInt32BE(0xfffffffe, 6);
    m.writeInt32BE(x, 10);
    m.writeInt32BE(y, 14);
    m.writeUInt16BE(size.w, 18);
    m.writeUInt16BE(size.h, 20);
    m.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);   // pressure
    m.writeInt32BE(0, 24);                      // action button
    m.writeInt32BE(0, 28);                      // buttons
    this.control.write(m);
    return true;
  }

  key(code) {
    if (!this.control || this.closed) return false;
    for (const action of [0, 1]) {
      const m = Buffer.alloc(14);
      m[0] = 0;                                  // inject keycode
      m[1] = action;
      m.writeInt32BE(code, 2);
      this.control.write(m);
    }
    return true;
  }

  fail(msg) {
    if (this.closed) return;
    this.error = msg;
    R(this.b).liveError = msg;
    log('live video', this.b.name, msg);
    this.stop(msg);
  }

  stop(why) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    for (const sub of this.subs) { try { sub.res.end(); } catch (e) { /* gone */ } }
    this.subs.clear();
    try { this.video && this.video.destroy(); } catch (e) { /* ignore */ }
    try { this.control && this.control.destroy(); } catch (e) { /* ignore */ }
    try { this.proc && this.proc.kill(); } catch (e) { /* ignore */ }
    if (this.port) adb(['-s', this.serial, 'forward', '--remove', 'tcp:' + this.port], { timeout: 5000 });
    if (live.get(this.b.id) === this) live.delete(this.b.id);
    if (why && why !== 'No viewers') log('live video closed', this.b.name, why);
  }
}

function stopLive(id, why) {
  const s = live.get(id);
  if (s) s.stop(why);
}
function liveFor(id) {
  const s = live.get(id);
  return s && !s.closed && s.control ? s : null;
}

/* ---------------- http ---------------- */
function send(res, code, body, type) {
  const isBuf = Buffer.isBuffer(body);
  const isStr = typeof body === 'string';
  res.writeHead(code, {
    'Content-Type': type || (isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(isBuf || isStr ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) { req.destroy(); reject(new Error('Request too large')); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
function publicBoard(b) {
  const r = R(b);
  let status = r.status;
  if (r.paused && status !== 'online') status = 'disconnected';
  return {
    id: b.id, name: b.name, host: b.host, port: b.port, auto: b.auto, serial: serialOf(b),
    status, paused: r.paused, connecting: r.connecting, error: r.error || '',
    make: r.make || '', model: r.model || '', android: r.android || '', size: r.size || null,
    app: r.app || '', awake: r.awake === undefined ? null : r.awake, lastSeen: r.lastSeen || 0,
    mirroring: !!(r.mirror && r.mirror.exitCode === null), liveError: r.liveError || '',
    unit: b.unit || '', closet: b.closet || '', room: b.room || '', kind: b.kind || 'other', appPkg: b.app || ''
  };
}
function state() {
  const ex = exes();
  return {
    version: VERSION, platform: process.platform, keepaliveSeconds: store.settings.keepaliveSeconds,
    adb: { path: ex.adb || '', ok: adbOk }, scrcpy: { path: ex.scrcpy || '', live: !!scrcpyServerFile() },
    lastTick, usb, snapshots: snapCfg(), boards: store.boards.map(publicBoard)
  };
}

const INDEX = path.join(APP, 'public', 'index.html');
const HEALTH_PAGE = path.join(APP, 'public', 'health.html');
const DEPLOY_PAGE = path.join(APP, 'public', 'deploy.html');
const MANUAL_PAGE = path.join(APP, 'public', 'manual.html');
const AUDIT_PAGE = path.join(APP, 'public', 'audit.html');
const MANUAL_DIR = path.join(APP, 'public', 'manual');
const IMG_TYPES = { webp: 'image/webp', png: 'image/png', svg: 'image/svg+xml' };
let health = null, deploy = null, remote = null, logs = null, audit = null, cloud = null;
const server = http.createServer(async (req, res) => {
  try {
    // Only answer the dashboard itself: blocks other web pages and DNS rebinding.
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/health' || p === '/health.html')) {
      return send(res, 200, fs.readFileSync(HEALTH_PAGE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/deploy' || p === '/deploy.html')) {
      return send(res, 200, fs.readFileSync(DEPLOY_PAGE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/audit' || p === '/audit.html')) {
      return send(res, 200, fs.readFileSync(AUDIT_PAGE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && (p === '/manual' || p === '/manual.html')) {
      return send(res, 200, fs.readFileSync(MANUAL_PAGE), 'text/html; charset=utf-8');
    }
    const mi = /^\/manual\/([a-z0-9_]+)\.(webp|png|svg)$/.exec(p);
    if (req.method === 'GET' && mi) {
      const f = path.join(MANUAL_DIR, mi[1] + '.' + mi[2]);
      if (!isFile(f)) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': IMG_TYPES[mi[2]], 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true, version: VERSION, service: AS_SERVICE, desktop: AS_SERVICE ? deskOnline() : true });
    if (health && /^\/api\/(health|found)\b/.test(p) && await health.handle(req, res, p, url)) return;
    if (deploy && /^\/api\/deploy\b/.test(p) && await deploy.handle(req, res, p, url)) return;
    if (logs && /^\/api\/logs\b/.test(p) && await logs.handle(req, res, p, url)) return;
    if (audit && /^\/api\/audit\b/.test(p) && await audit.handle(req, res, p, url)) return;
    if (cloud && /^\/api\/cloud\b/.test(p) && await cloud.handle(req, res, p, url)) return;
    if (remote && (/^\/api\/remote\b/.test(p) || p === '/remote' || p === '/remote.html' || p === '/remote-banner.js') && await remote.handle(req, res, p, url)) return;
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, state());

    let m = /^\/api\/boards\/([a-f0-9]{8})\/screen$/.exec(p);
    if (req.method === 'GET' && m) {
      const b = store.boards.find(x => x.id === m[1]);
      if (!b) return send(res, 404, { ok: false, message: 'Unknown board' });
      if (R(b).status !== 'online') return send(res, 409, { ok: false, message: 'Board is not connected' });
      try {
        const fresh = !!url.searchParams.get('fresh');
        const shot = await capture(b, fresh ? 150 : 800, fresh);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Shot-Age': String(Date.now() - shot.at) });
        return res.end(shot.buf);
      } catch (e) {
        return send(res, 502, { ok: false, message: e.message });
      }
    }

    m = /^\/api\/boards\/([a-f0-9]{8})\/stream$/.exec(p);
    if (req.method === 'GET' && m) {
      const b = store.boards.find(x => x.id === m[1]);
      if (!b) return send(res, 404, { ok: false, message: 'Unknown board' });
      if (R(b).status !== 'online') return send(res, 409, { ok: false, message: 'Board is not connected' });
      let sess = live.get(b.id);
      if (!sess || sess.closed) { sess = new LiveSession(b); live.set(b.id, sess); }
      try {
        await sess.ready;
      } catch (e) {
        const why = sess.error || e.message;
        sess.stop(why);
        R(b).liveError = why;
        return send(res, 502, { ok: false, message: why });
      }
      if (sess.closed) return send(res, 502, { ok: false, message: sess.error || 'Live video ended' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (res.socket) res.socket.setNoDelay(true);
      const sub = sess.addSub(res);
      req.on('close', () => sess.removeSub(sub));
      return;
    }

    if (req.method === 'GET' && p === '/api/snaps') {
      return send(res, 200, { ok: true, dir: snapDir(), settings: snapCfg(), items: listSnaps(Number(url.searchParams.get('limit')) || 300) });
    }
    if (req.method === 'GET' && p === '/api/snap/file') {
      const rel = String(url.searchParams.get('p') || '');
      if (!/^\d{4}-\d{2}-\d{2}\/[\w.\-]+\.png$/.test(rel)) return send(res, 400, { ok: false, message: 'Bad path' });
      const f = path.join(snapDir(), rel);
      if (f.indexOf(snapDir()) !== 0) return send(res, 400, { ok: false, message: 'Bad path' });
      try {
        const buf = fs.readFileSync(f);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch (e) { return send(res, 404, { ok: false, message: 'Not found' }); }
    }

    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' });
    // Custom header forces a CORS preflight, so no other site can post here.
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' });

    // the desktop helper asks for windows to open, and says how it went
    if (p === '/api/desktop/poll') return deskPoll(res);
    if (p === '/api/desktop/result') return send(res, 200, { ok: deskResult(await readJson(req)) });

    if (p === '/api/boards') {
      const body = await readJson(req);
      const bad = checkInput(body);
      if (bad) return send(res, 400, { ok: false, message: bad });
      const b = normBoard({ name: body.name, host: body.host, port: body.port, auto: body.auto, unit: body.unit, closet: body.closet, room: body.room, kind: body.kind, app: body.app });
      store.boards.push(b);
      saveStore();
      connect(b).catch(() => {});
      return send(res, 200, { ok: true, board: publicBoard(b), message: b.name + ' added.' });
    }
    if (p === '/api/connectall') {
      store.boards.forEach(b => { R(b).paused = false; });
      await Promise.all(store.boards.filter(b => R(b).status !== 'online').map(b => connect(b).catch(() => {})));
      return send(res, 200, { ok: true, message: 'Reconnecting every board.' });
    }
    if (p === '/api/scan') {
      const body = await readJson(req);
      return send(res, 200, await scan(Number(body.port) || 5555));
    }
    if (p === '/api/usbwifi') return send(res, 200, await usbToWifi());
    if (p === '/api/snap') {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const targets = store.boards.filter(b => ids.indexOf(b.id) >= 0);
      if (!targets.length) return send(res, 400, { ok: false, message: 'Pick at least one board.' });
      const results = [];
      for (const b of targets) {
        if (R(b).status !== 'online') { results.push({ id: b.id, ok: false, message: 'Not connected' }); continue; }
        try { const s = await saveSnapshot(b); results.push({ id: b.id, ok: true, rel: s.rel }); }
        catch (e) { results.push({ id: b.id, ok: false, message: e.message }); }
      }
      const okN = results.filter(r => r.ok).length;
      return send(res, 200, { ok: okN > 0, saved: okN, results, dir: snapDir(), message: 'Saved ' + okN + ' of ' + targets.length + ' to ' + snapDir() });
    }
    if (p === '/api/snap/settings') {
      const body = await readJson(req);
      const c = snapCfg();
      if (body.dir !== undefined) c.dir = clip(body.dir, 300);
      if (body.everyMinutes !== undefined) c.everyMinutes = Math.min(1440, Math.max(0, Number(body.everyMinutes) || 0));
      if (body.keepDays !== undefined) c.keepDays = Math.min(365, Math.max(1, Number(body.keepDays) || 14));
      saveStore();
      try { fs.mkdirSync(snapDir(), { recursive: true }); } catch (e) { /* created on first save */ }
      return send(res, 200, { ok: true, message: 'Saved.', dir: snapDir(), settings: c });
    }
    if (p === '/api/snap/open') {
      if (!IS_WIN) return send(res, 200, { ok: false, message: 'Opening the folder works on Windows. The folder is ' + snapDir() });
      try { spawn('explorer', [snapDir()], { windowsHide: false, detached: true }).unref(); } catch (e) { /* best effort */ }
      return send(res, 200, { ok: true, message: 'Opened ' + snapDir() });
    }
    if (p === '/api/quit') {
      send(res, 200, { ok: true, message: 'Board Remote stopped.' });
      log('quit requested');
      for (const sess of Array.from(live.values())) sess.stop('Quit');
      if (health) health.save();
      if (deploy) deploy.save();
      if (remote) { remote.stop(); remote.save(); }
      return setTimeout(() => process.exit(0), 300);
    }

    m = /^\/api\/boards\/([a-f0-9]{8})\/(\w+)$/.exec(p);
    if (!m) return send(res, 404, { ok: false, message: 'Not found' });
    const b = store.boards.find(x => x.id === m[1]);
    if (!b) return send(res, 404, { ok: false, message: 'Unknown board' });
    const r = R(b);
    const action = m[2];
    const s = serialOf(b);

    if (action === 'install') return send(res, 200, await install(b, req));
    const body = await readJson(req);

    switch (action) {
      case 'edit': {
        const bad = checkInput(Object.assign({ host: b.host, port: b.port }, body), b);
        if (bad) return send(res, 400, { ok: false, message: bad });
        const moved = (body.host && body.host.trim() !== b.host) || (body.port && Number(body.port) !== b.port);
        if (moved) { await adb(['disconnect', s], { timeout: 5000 }); resetInfo(r); r.status = 'starting'; }
        if (body.name !== undefined) b.name = String(body.name).trim().slice(0, 60) || b.name;
        if (body.host) b.host = String(body.host).trim();
        if (body.port) b.port = Number(body.port);
        if (body.auto !== undefined) b.auto = !!body.auto;
        const placing = ['unit', 'closet', 'room'].some(k => body[k] !== undefined && String(body[k]).trim() !== String(b[k] || ''));
        if (placing && cloud && cloud.isLocked(b.id)) return send(res, 423, { ok: false, message: 'HCI locked the room, unit and closet of this board in HCI ONE Board Remote Cloud. Ask HCI to unlock it.' });
        if (body.unit !== undefined) b.unit = clip(body.unit, 40);
        if (body.closet !== undefined) b.closet = clip(body.closet, 40);
        if (body.room !== undefined) b.room = clip(body.room, 20);
        if (body.kind !== undefined && KIND_KEYS.indexOf(body.kind) >= 0) b.kind = body.kind;
        if (body.app !== undefined) {
          const a = clip(body.app, 200);
          if (a && !PKG_RE.test(a)) return send(res, 400, { ok: false, message: 'The app must be an Android package name, like com.hci.one.board.' });
          b.app = a;
        }
        saveStore();
        if (moved && b.auto) connect(b).catch(() => {});
        return send(res, 200, { ok: true, board: publicBoard(b), message: 'Saved.' });
      }
      case 'remove':
        stopLive(b.id, 'Removed');
        store.boards = store.boards.filter(x => x.id !== b.id);
        saveStore();
        rt.delete(b.id);
        if (health) health.forget(b.id);
        if (deploy) deploy.forget(b.id);
        if (logs) logs.forget(b.id);
        if (audit) audit.forget(b.id);
        await adb(['disconnect', s], { timeout: 5000 });
        return send(res, 200, { ok: true, message: b.name + ' removed.' });
      case 'connect':
        r.paused = false;
        await connect(b);
        return send(res, 200, { ok: r.status === 'online' || r.status === 'unauthorized', board: publicBoard(b), message: r.status === 'online' ? b.name + ' connected.' : (r.error || r.status) });
      case 'disconnect':
        stopLive(b.id, 'Disconnected');
        r.paused = true;
        await adb(['disconnect', s], { timeout: 5000 });
        r.status = 'disconnected';
        return send(res, 200, { ok: true, board: publicBoard(b), message: b.name + ' disconnected. It stays off until you click Connect.' });
      case 'tap': {
        const x = int(body.x), y = int(body.y);
        if (x === null || y === null) return send(res, 400, { ok: false, message: 'Bad tap' });
        const out = await shell(b, 'input tap ' + x + ' ' + y, 6000);
        return send(res, 200, { ok: out.ok });
      }
      case 'swipe': {
        const v = [body.x1, body.y1, body.x2, body.y2].map(int);
        const ms = Math.min(3000, Math.max(50, int(body.ms) || 250));
        if (v.some(n => n === null)) return send(res, 400, { ok: false, message: 'Bad swipe' });
        const out = await shell(b, 'input swipe ' + v.join(' ') + ' ' + ms, 8000);
        return send(res, 200, { ok: out.ok });
      }
      case 'touch': {
        const sess = liveFor(b.id);
        const act = { down: 0, up: 1, move: 2 }[body.a];
        const x = int(body.x), y = int(body.y), w = int(body.w), h = int(body.h);
        if (!sess || act === undefined || x === null || y === null) return send(res, 409, { ok: false });
        return send(res, 200, { ok: sess.touch(act, x, y, w || 0, h || 0) });
      }
      case 'key': {
        const code = KEYS[body.key];
        if (!code) return send(res, 400, { ok: false, message: 'Unknown key' });
        const sess = liveFor(b.id);
        if (sess && sess.key(code)) {
          if (body.key === 'wake' || body.key === 'sleep' || body.key === 'power') setTimeout(() => fetchLive(b).catch(() => {}), 800);
          return send(res, 200, { ok: true });
        }
        const out = await shell(b, 'input keyevent ' + code, 6000);
        if (body.key === 'wake' || body.key === 'sleep' || body.key === 'power') setTimeout(() => fetchLive(b).catch(() => {}), 800);
        return send(res, 200, { ok: out.ok });
      }
      case 'mirror':
        return send(res, 200, await mirror(b));
      case 'shell':
        return send(res, 200, await openShell(b));
      case 'restartapp':
        return send(res, 200, await restartApp(b));
      case 'reboot': {
        stopLive(b.id, 'Rebooting');
        const out = await adb(['-s', s, 'reboot'], { timeout: 10000 });
        r.status = 'offline'; r.shot = null;
        return send(res, 200, { ok: out.ok, message: out.ok ? b.name + ' is rebooting. It reconnects on its own.' : 'Reboot failed: ' + out.err });
      }
      default:
        return send(res, 404, { ok: false, message: 'Unknown action' });
    }
  } catch (e) {
    log('request error', req.method, req.url, e.stack || e);
    if (!res.headersSent) send(res, 500, { ok: false, message: e.message });
  }
});

/* ---------------- start ---------------- */
loadStore();
health = require('./health')({
  store, saveStore, R, serialOf, adb, shell, log, ROOT, APP, IS_WIN, send, readJson, publicBoard, normBoard,
  connect, listDevices, scanHosts, isUsbSerial, stopLive
});
deploy = require('./deploy')({ store, saveStore, R, serialOf, adb, shell, log, ROOT, APP, send, readJson, normBoard, connect, resetInfo, health });
logs = require('./logs')({ store, saveStore, R, serialOf, adb, log, ROOT, send, readJson });
audit = require('./audit')({ store, saveStore, R, serialOf, shell, capture, log, ROOT, send, readJson, health });
cloud = require('./cloud')({ store, saveStore, R, serialOf, log, VERSION, PORT, send, readJson, health, deploy });
remote = require('./remote')({ store, saveStore, log, PORT, VERSION, ROOT, APP, send, readJson });
const saveAll = () => { if (health) health.save(); if (deploy) deploy.save(); if (logs) logs.save(); if (audit) audit.save(); if (remote) remote.save(); };
process.on('SIGINT', () => { saveAll(); process.exit(0); });
process.on('SIGTERM', () => { saveAll(); process.exit(0); });
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('Board Remote is already running on port ' + PORT + '.'); process.exit(0); }
  log('server error', e.stack || e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', async () => {
  const ex = exes();
  log('Board Remote ' + VERSION + ' on http://localhost:' + PORT + '  adb=' + (ex.adb || 'missing') + '  scrcpy=' + (ex.scrcpy || 'missing') + '  boards=' + store.boards.length);
  await adb(['start-server'], { timeout: 20000 });
  remote.start();
  await tick();
  setInterval(tick, Math.max(3, Number(store.settings.keepaliveSeconds) || 10) * 1000);
});
process.on('uncaughtException', e => log('uncaught', e.stack || e));
process.on('unhandledRejection', e => log('unhandled', (e && e.stack) || e));
