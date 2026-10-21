'use strict';
/* HCI ONE Board Remote, desktop helper.
   The Windows service has no desktop. This small helper starts when someone signs in to Windows
   (from the All Users Startup folder), runs as that person with no window of its own, and opens
   the windows Board Remote asks for on their screen:
     mirror   the scrcpy window for a board (live screen, mouse and keyboard)
     shell    a Command Prompt with an adb shell on a board
   It only talks to Board Remote on this PC (127.0.0.1), and only opens scrcpy and adb shells.
   One copy per signed in person; a second copy exits at once. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const PORT = Number(process.env.BOARD_REMOTE_PORT) || 7755;
const IS_WIN = process.platform === 'win32';
const LOCK_PORT = Number(process.env.BR_HELPER_LOCK_PORT) || 0;   // tests only; on Windows a named pipe per user is used
const sleep = ms => new Promise(r => setTimeout(r, ms));
const okExe = (p, name) => typeof p === 'string' && path.isAbsolute(p) && new RegExp('^' + name + '(\\.exe)?$', 'i').test(path.basename(p)) && fs.existsSync(p);
const SERIAL = /^[\w.:\-]{1,80}$/;

function post(p, body, timeout) {
  return new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', timeout: timeout || 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Board-Remote': '1' } }, res => {
      let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    r.on('timeout', () => r.destroy()); r.on('error', () => resolve(null)); r.end(data);
  });
}

function mirror(job) {
  if (!okExe(job.exe, 'scrcpy')) return Promise.resolve({ ok: false, message: 'scrcpy was not found on this PC.' });
  if (!Array.isArray(job.args) || job.args.some(a => typeof a !== 'string' || a.length > 200)) return Promise.resolve({ ok: false, message: 'Bad mirror request.' });
  const env = Object.assign({}, process.env);
  if (okExe(job.adb, 'adb')) env.ADB = job.adb;
  let child, text = '';
  try { child = spawn(job.exe, job.args, { cwd: path.dirname(job.exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false }); }
  catch (e) { return Promise.resolve({ ok: false, message: 'Could not start scrcpy: ' + e.message }); }
  const grab = d => { if (text.length < 8000) text += d.toString(); };
  child.stdout.on('data', grab); child.stderr.on('data', grab);
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ ok: true, message: 'Live mirror opening for ' + (job.name || 'the board') + ' on this PC\'s screen.' }), 3500);
    child.on('error', e => { clearTimeout(t); resolve({ ok: false, message: 'Could not start scrcpy: ' + e.message }); });
    child.on('exit', code => {
      if (!code) return;
      clearTimeout(t);
      const err = (/ERROR:.*$/m.exec(text) || [text.trim().split(/\r?\n/).pop() || 'unknown error'])[0];
      resolve({ ok: false, message: 'Mirror closed. ' + err });
    });
  });
}

function shell(job) {
  if (!okExe(job.adb, 'adb')) return { ok: false, message: 'adb was not found on this PC.' };
  if (!SERIAL.test(job.serial || '')) return { ok: false, message: 'Bad shell request.' };
  if (!IS_WIN) return { ok: false, message: 'Shell windows open on Windows only.' };
  const title = String(job.title || job.serial).replace(/[^A-Za-z0-9 ._:\-]/g, '').slice(0, 80);
  const dir = path.join(os.tmpdir(), 'HCI Board Remote');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'shell_' + job.serial.replace(/[^\w]/g, '_') + '.cmd');
  fs.writeFileSync(file, ['@echo off', 'title ' + title, 'echo  ' + title, 'echo  Type exit to leave.', 'echo.', '"' + job.adb + '" -s ' + job.serial + ' shell', 'echo.', 'pause'].join('\r\n'));
  spawn('cmd.exe', ['/c', 'start "" "' + file + '"'], { windowsVerbatimArguments: true, stdio: 'ignore', detached: true }).unref();
  return { ok: true, message: 'Shell opened on this PC\'s screen.' };
}

async function run() {
  for (;;) {
    const r = await post('/api/desktop/poll', {}, 35000);
    if (!r) { await sleep(5000); continue; }   // Board Remote not running yet, or restarting for an update
    if (!r.job) continue;
    const job = r.job;
    let out;
    try { out = job.type === 'mirror' ? await mirror(job) : job.type === 'shell' ? shell(job) : { ok: false, message: 'Unknown request.' }; }
    catch (e) { out = { ok: false, message: e.message }; }
    await post('/api/desktop/result', Object.assign({ id: job.id }, out));
  }
}

// one helper per signed in person
const lockName = IS_WIN ? '\\\\.\\pipe\\hci-board-remote-helper-' + String(process.env.USERNAME || 'user').replace(/[^\w.-]/g, '_') : null;
const lock = net.createServer(() => {});
lock.on('error', () => process.exit(0));
if (lockName) lock.listen(lockName, run);
else if (LOCK_PORT) lock.listen(LOCK_PORT, '127.0.0.1', run);
else run();
