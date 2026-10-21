'use strict';
/* Builds the Board Remote update package: dist/board-remote-<version>.zip, with the program files
   at the root of the zip (what the Windows service unpacks into versions\<version>).
   Data never goes in: no boards.json, health, audit, snapshots, tools or app library.
     node scripts/package.js            version from board-remote/server.js
     node scripts/package.js --sign     also writes the .sig, with the PEM key in the file BR_RELEASE_SIGNING_KEY_FILE
   Uses the system zip on Linux and macOS, and PowerShell on Windows. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'board-remote');
const DIST = path.join(ROOT, 'dist');
const SIGN_PREFIX = 'HCI-ONE-BOARD-REMOTE|';
// what ships: the program, the dashboard, the bundled APKs, the service and its key, the docs
const INCLUDE = ['server.js', 'audit.js', 'cloud.js', 'deploy.js', 'health.js', 'logs.js', 'remote.js', 'ws.js', 'README.txt', 'board_remote.ico',
  'public', 'service', 'apks/HCI_ONE_ADB.apk', 'apks/HCI_ONE_Room_Sign.apk', 'relay'];

function version() {
  const m = /const VERSION = '(\d+\.\d+\.\d+)'/.exec(fs.readFileSync(path.join(SRC, 'server.js'), 'utf8'));
  if (!m) throw new Error('board-remote/server.js has no VERSION like 2.1.0');
  return m[1];
}
function sign(v, sha, pem) {
  return crypto.sign(null, Buffer.from(SIGN_PREFIX + v + '|' + sha), crypto.createPrivateKey(pem)).toString('base64');
}
function build(opts) {
  opts = opts || {};
  const v = opts.version || version();
  const src = opts.src || SRC, out = opts.out || DIST;
  const stage = path.join(out, 'stage-' + v);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const f of INCLUDE) {
    const from = path.join(src, f);
    if (!fs.existsSync(from)) { if (f.startsWith('relay')) continue; throw new Error('Missing ' + f); }
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.cpSync(from, path.join(stage, f), { recursive: true });
  }
  fs.writeFileSync(path.join(stage, 'VERSION'), v + '\n');
  const zip = path.join(out, 'board-remote-' + v + '.zip');
  fs.rmSync(zip, { force: true });
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -Path (Join-Path $env:BR_STAGE "*") -DestinationPath $env:BR_ZIP -CompressionLevel Optimal'], { env: Object.assign({}, process.env, { BR_STAGE: stage, BR_ZIP: zip }) });
  else execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  const buf = fs.readFileSync(zip), sha = crypto.createHash('sha256').update(buf).digest('hex');
  const res = { version: v, zip, sha256: sha, size: buf.length };
  const keyFile = process.env.BR_RELEASE_SIGNING_KEY_FILE;
  const pem = opts.key || (opts.sign ? (keyFile ? fs.readFileSync(keyFile, 'utf8') : process.env.BR_RELEASE_SIGNING_KEY) : null);
  if (opts.sign && !pem) throw new Error('Set BR_RELEASE_SIGNING_KEY_FILE (or BR_RELEASE_SIGNING_KEY) to sign');
  if (pem) { res.signature = sign(v, sha, pem); res.sig = zip.replace(/\.zip$/, '.sig'); fs.writeFileSync(res.sig, res.signature + '\n'); }
  return res;
}

module.exports = { build, sign, version, SIGN_PREFIX };
if (require.main === module) {
  fs.mkdirSync(DIST, { recursive: true });
  const r = build({ sign: process.argv.includes('--sign') });
  console.log('Board Remote ' + r.version + '\n  ' + r.zip + '\n  sha256 ' + r.sha256 + '\n  ' + r.size + ' bytes' + (r.sig ? '\n  signed: ' + r.sig : '\n  not signed'));
}
