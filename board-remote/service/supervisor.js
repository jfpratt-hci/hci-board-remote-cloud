'use strict';
/* HCI ONE Board Remote, Windows service.
   Runs Board Remote, restarts it if it stops, and keeps it up to date from HCI ONE Cloud.

   Layout (the installer makes it):
     <install>\node\node.exe                 Node, bundled
     <install>\service\supervisor.js         this file (run by WinSW as the service)
     <install>\service\release-key.pub       HCI's release public key; packages must be signed by its private key
     <install>\versions\<version>\           each Board Remote version, side by side
     <data>\                                 this PC's boards, health, audit, snapshots, tools (BR_DATA_DIR)
     <data>\service.json                     which version runs, the one before it, versions that failed

   An update, start to finish:
     1. ask the cloud (GET /api/agent/update, with this PC's own enrollment credential)
     2. wait for the overnight window (02:00 to 05:00 here) unless someone approved it to go now
     3. download, check the size and sha256, check HCI's ed25519 signature with the key above
     4. unpack beside the running version (nothing running is touched)
     5. switch, then require the new version to answer /api/ping with its own version and keep
        running for 20 seconds
     6. if it does not, switch straight back, mark that version bad so it is not tried again,
        and report it. Every step is reported to the cloud and lands in the audit log. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SERVICE_DIR = __dirname;
const INSTALL = process.env.BR_INSTALL_DIR ? path.resolve(process.env.BR_INSTALL_DIR) : path.resolve(SERVICE_DIR, '..');
const VERSIONS = path.join(INSTALL, 'versions');
const DATA = process.env.BR_DATA_DIR ? path.resolve(process.env.BR_DATA_DIR) : path.join(process.env.ProgramData || '/var/lib', 'HCI ONE', 'Board Remote');
const STATE_FILE = path.join(DATA, 'service.json');
const LOG_FILE = path.join(DATA, 'logs', 'service.log');
const PORT = Number(process.env.BOARD_REMOTE_PORT) || 7755;
const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';
const CHECK_MS = Number(process.env.BR_UPDATE_CHECK_MS) || 15 * 60 * 1000;
const FIRST_CHECK_MS = Number(process.env.BR_UPDATE_FIRST_MS) || 60 * 1000;
const HEALTH_MS = Number(process.env.BR_HEALTH_MS) || 120 * 1000;
const STEADY_MS = Number(process.env.BR_STEADY_MS) || 20 * 1000;
const MAX_PKG = 100 * 1024 * 1024;
const SIGN_PREFIX = 'HCI-ONE-BOARD-REMOTE|';
const VER = /^\d+\.\d+\.\d+$/;

/* ---------- small helpers ---------- */
function log(...a) {
  const line = new Date().toISOString() + '  ' + a.join(' ') + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch (e) { /* first write */ }
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) { /* logging never stops the service */ }
  if (process.stdout.isTTY || process.env.BR_SERVICE_ECHO) process.stdout.write(line);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj, null, 2)); fs.renameSync(t, f); }
const verDir = v => path.join(VERSIONS, v);
const hasVersion = v => VER.test(v || '') && fs.existsSync(path.join(verDir(v), 'server.js'));

function loadState() {
  const s = readJson(STATE_FILE, {});
  s.bad = Array.isArray(s.bad) ? s.bad : [];
  const all = (fs.existsSync(VERSIONS) ? fs.readdirSync(VERSIONS) : []).filter(hasVersion).sort(cmpVer);
  const newest = all[all.length - 1] || null;
  if (!hasVersion(s.current)) {
    // first start, or the recorded version is gone: run the newest version on disk
    s.current = newest;
  } else if (!s.pending && newest && cmpVer(newest, s.current) > 0 && s.bad.indexOf(newest) < 0) {
    // the installer was run again with a newer version: use it, and keep the old one to go back to
    s.previous = s.current; s.current = newest;
  }
  return s;
}
let state = null;
const saveState = () => writeJson(STATE_FILE, state);

/* ---------- running Board Remote ---------- */
let child = null, childVersion = null, stopping = false, wantRun = true, backoff = 2000, startedAt = 0;
function startApp(v, crashRestart) {
  if (!hasVersion(v)) { log('cannot start: version', v, 'is not installed'); return; }
  if (!crashRestart) backoff = 2000;   // a deliberate start (boot, update, rollback) begins with a short restart delay
  const out = fs.openSync(path.join(DATA, 'logs', 'app-console.log'), 'a');
  child = spawn(NODE, [path.join(verDir(v), 'server.js')], {
    cwd: verDir(v), windowsHide: true, stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { BR_DATA_DIR: DATA, BR_SERVICE: '1', BOARD_REMOTE_PORT: String(PORT) })
  });
  childVersion = v; startedAt = Date.now();
  log('started Board Remote', v, 'pid', child.pid);
  const me = child;
  child.on('exit', (code, sig) => {
    try { fs.closeSync(out); } catch (e) { /* closed */ }
    if (child === me) child = null;
    log('Board Remote', v, 'stopped', code === null ? 'by ' + sig : 'with code ' + code);
    if (stopping || !wantRun || me._replaced) return;
    // ran a while: it was a one off, restart quickly; died at once again and again: back off
    backoff = Date.now() - startedAt > 60000 ? 2000 : Math.min(backoff * 2, 60000);
    setTimeout(() => { if (!child && wantRun && !stopping) startApp(state.current, true); }, backoff);
  });
}
function stopApp() {
  return new Promise(resolve => {
    if (!child) return resolve();
    const c = child; c._replaced = true;
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 10000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    try { c.kill(); } catch (e) { clearTimeout(t); resolve(); }
  });
}
function ping() {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 3000 }, res => {
      let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    r.on('timeout', () => r.destroy()); r.on('error', () => resolve(null));
  });
}
// The new version must answer with its own version number, then still be running STEADY_MS later.
async function healthy(v) {
  const end = Date.now() + HEALTH_MS;
  while (Date.now() < end) {
    const p = await ping();
    if (p && p.ok && p.version === v) {
      await sleep(STEADY_MS);
      const q = await ping();
      return !!(q && q.ok && q.version === v && child && childVersion === v);
    }
    await sleep(1000);
  }
  return false;
}

/* ---------- the cloud ---------- */
function cloudCreds() {
  const c = (readJson(path.join(DATA, 'boards.json'), {}).settings || {}).cloud || {};
  return c.url && c.agentId && c.secret ? c : null;
}
function request(method, url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('Bad cloud address')); }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? http : null;
    if (!lib) return reject(new Error('The cloud address must be https'));
    const body = opts.json ? Buffer.from(JSON.stringify(opts.json)) : null;
    const r = lib.request(u, { method, timeout: opts.timeout || 30000, headers: Object.assign({ Authorization: opts.auth, 'User-Agent': 'HCI-Board-Remote-Service' }, body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) }, res => {
      const ch = []; let n = 0;
      res.on('data', d => { n += d.length; if (n > (opts.max || 1024 * 1024)) { r.destroy(new Error('Answer too large')); return; } ch.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(ch) }));
    });
    r.on('timeout', () => r.destroy(new Error('The cloud did not answer'))); r.on('error', reject);
    r.end(body);
  });
}
async function report(c, st, version, detail) {
  try { await request('POST', c.url + '/api/agent/update-status', { auth: 'Bearer ' + c.agentId + '.' + c.secret, json: { state: st, version, detail: String(detail || '').slice(0, 300) }, timeout: 15000 }); }
  catch (e) { log('could not report', st, 'to the cloud:', e.message); }
}

/* ---------- checking a package ---------- */
function releaseKey() {
  const f = path.join(SERVICE_DIR, 'release-key.pub');
  try { return crypto.createPublicKey(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function checkPackage(buf, u) {
  if (buf.length !== u.size) return 'The download is ' + buf.length + ' bytes, not ' + u.size + '.';
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== u.sha256) return 'The download does not match its checksum.';
  const key = releaseKey();
  if (!key) return 'This PC has no HCI release key, so it cannot check the signature.';
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(SIGN_PREFIX + u.version + '|' + sha), key, Buffer.from(String(u.signature || ''), 'base64')); } catch (e) { ok = false; }
  return ok ? null : 'The package is not signed by HCI. It was not installed.';
}
function unzip(zipFile, dest) {
  return new Promise((resolve, reject) => {
    fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
    const cmd = IS_WIN
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:BR_ZIP -DestinationPath $env:BR_DEST -Force']]
      : ['unzip', ['-q', '-o', zipFile, '-d', dest]];
    execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 180000, env: Object.assign({}, process.env, { BR_ZIP: zipFile, BR_DEST: dest }) }, err => err ? reject(new Error('Could not unpack: ' + err.message.split('\n')[0])) : resolve());
  });
}
function prune() {
  const keep = new Set([state.current, state.previous].filter(Boolean));
  for (const v of fs.readdirSync(VERSIONS)) {
    if (keep.has(v) || /\.new$/.test(v) === false && !VER.test(v)) continue;
    try { fs.rmSync(path.join(VERSIONS, v), { recursive: true, force: true }); log('removed old version', v); } catch (e) { log('could not remove', v, e.message); }
  }
  try { for (const f of fs.readdirSync(path.join(DATA, 'updates'))) if (!f.startsWith(state.current + '.')) fs.rmSync(path.join(DATA, 'updates', f), { force: true }); } catch (e) { /* none yet */ }
}

/* ---------- one update check ---------- */
let busy = false, lastScheduled = '';
async function checkOnce(why) {
  if (busy) return; busy = true;
  try {
    const c = cloudCreds();
    if (!c) return;   // not joined to HCI ONE Cloud: nothing to ask
    const auth = 'Bearer ' + c.agentId + '.' + c.secret;
    const r = await request('GET', c.url + '/api/agent/update?version=' + encodeURIComponent(state.current || '') + '&service=1', { auth });
    if (r.status !== 200) { log('update check: the cloud answered', r.status); return; }
    const j = JSON.parse(r.buf.toString());
    const u = j.update;
    if (!u) return;
    if (!VER.test(u.version) || cmpVer(u.version, state.current) <= 0) return;
    if (state.bad.indexOf(u.version) >= 0 && !u.now) return;   // failed here before; only an explicit approval retries it
    const h = new Date().getHours(), win = Array.isArray(u.window) ? u.window : [2, 5];
    if (!u.now && !(h >= win[0] && h < win[1])) {
      if (lastScheduled !== u.version) { lastScheduled = u.version; await report(c, 'scheduled', u.version, 'Installs tonight between ' + win[0] + ' and ' + win[1] + ' am'); }
      return;
    }
    await install(c, auth, u, why);
  } catch (e) {
    log('update check failed:', e.message);
  } finally { busy = false; }
}
async function install(c, auth, u, why) {
  const from = state.current;
  log('updating', from, 'to', u.version, '(' + why + ')');
  await report(c, 'downloading', u.version, 'From ' + from);
  let buf;
  try {
    const r = await request('GET', c.url + '/api/agent/releases/' + u.id + '/package', { auth, max: MAX_PKG, timeout: 300000 });
    if (r.status !== 200) throw new Error('The cloud answered ' + r.status);
    buf = r.buf;
  } catch (e) { return report(c, 'failed', u.version, 'Download failed: ' + e.message); }
  const bad = checkPackage(buf, u);
  if (bad) { log('refused', u.version + ':', bad); state.bad.push(u.version); saveState(); return report(c, 'failed', u.version, bad); }

  await report(c, 'installing', u.version, 'Signature checked');
  const zip = path.join(DATA, 'updates', u.version + '.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true }); fs.writeFileSync(zip, buf);
  const stage = verDir(u.version) + '.new';
  try {
    await unzip(zip, stage);
    if (!fs.existsSync(path.join(stage, 'server.js'))) throw new Error('The package has no server.js');
    fs.rmSync(verDir(u.version), { recursive: true, force: true });
    fs.renameSync(stage, verDir(u.version));
  } catch (e) { fs.rmSync(stage, { recursive: true, force: true }); return report(c, 'failed', u.version, e.message); }

  // switch
  state.pending = { from, to: u.version, at: new Date().toISOString() }; saveState();
  wantRun = false; await stopApp(); wantRun = true;
  state.current = u.version; saveState();
  const t0 = Date.now();
  startApp(u.version);
  if (await healthy(u.version)) {
    state.previous = from; delete state.pending; state.bad = state.bad.filter(v => v !== u.version); saveState();
    log('updated to', u.version);
    await report(c, 'done', u.version, 'Running ' + u.version + ', answered in ' + Math.round((Date.now() - t0) / 1000) + ' s');
    prune();
    return selfUpdate(u.version);
  }
  // roll back
  log(u.version, 'did not come up; going back to', from);
  wantRun = false; await stopApp(); wantRun = true;
  state.current = from; delete state.pending; if (state.bad.indexOf(u.version) < 0) state.bad.push(u.version); saveState();
  startApp(from);
  const back = await healthy(from);
  await report(c, 'rolled_back', u.version, u.version + ' did not answer within ' + Math.round(HEALTH_MS / 1000) + ' s; back on ' + from + (back ? '' : ' (check this PC)'));
}
// A new version can carry a newer copy of this file. Take it, then exit so Windows restarts the service.
function selfUpdate(v) {
  const mine = __filename, next = path.join(verDir(v), 'service', 'supervisor.js');
  try {
    if (!fs.existsSync(next) || fs.readFileSync(next).equals(fs.readFileSync(mine))) return;
    fs.copyFileSync(next, mine + '.tmp'); fs.renameSync(mine + '.tmp', mine);
    const key = path.join(verDir(v), 'service', 'release-key.pub');
    if (fs.existsSync(key)) fs.copyFileSync(key, path.join(SERVICE_DIR, 'release-key.pub'));
    log('service updated itself from', v, '; restarting the service');
    shutdown(3);
  } catch (e) { log('service self update skipped:', e.message); }
}

/* ---------- start and stop ---------- */
async function shutdown(code) {
  stopping = true;
  await stopApp();
  process.exit(code || 0);
}
function main() {
  fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
  state = loadState();
  // a crash in the middle of a switch: go back to what ran before it
  if (state.pending && state.pending.from && hasVersion(state.pending.from) && state.current === state.pending.to) {
    log('found an unfinished update to', state.pending.to, '; going back to', state.pending.from);
    state.current = state.pending.from; if (state.bad.indexOf(state.pending.to) < 0) state.bad.push(state.pending.to); delete state.pending;
  }
  if (!state.current) { log('no Board Remote version is installed in', VERSIONS); process.exit(1); }
  saveState();
  log('HCI ONE Board Remote service starting; data in', DATA, '; version', state.current);
  startApp(state.current);
  setTimeout(() => checkOnce('first check'), FIRST_CHECK_MS);
  setInterval(() => checkOnce('regular check'), CHECK_MS);
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  // WinSW asks for a stop by writing to stdin's close; treat an end of stdin as a stop too
  if (process.env.BR_STOP_ON_STDIN_END === '1') process.stdin.on('end', () => shutdown(0)).resume();
}

module.exports = { checkPackage, cmpVer, SIGN_PREFIX };
if (require.main === module) main();
