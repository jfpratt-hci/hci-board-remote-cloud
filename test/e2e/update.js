'use strict';
/* End to end: the Windows service updating Board Remote from the cloud, for real.
   One cloud (with Postgres), one installed Board Remote run by service/supervisor.js, signed packages.
     1. 2.1.0 runs; the PC is enrolled; a signed 2.2.0 is uploaded, sent to everyone, approved
        -> the service downloads, checks, installs and switches; Board Remote answers 2.2.0
     2. a signed 2.3.0 that crashes on start -> the service rolls back to 2.2.0 by itself and says so
     3. Board Remote killed -> the service restarts it
     4. a package signed with the wrong key, and a tampered one -> refused by the PC
   node test/e2e/update.js   (needs local Postgres, like npm test) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { migrate } = require('../../src/migrate');
const pkgr = require('../../scripts/package');
const { checkPackage } = require('../../board-remote/service/supervisor');

const ROOT = path.join(__dirname, '..', '..'), HERE = path.join(os.tmpdir(), 'br-update-e2e');
const CLOUD_PORT = 7821, BR_PORT = 7822, BASE = 'http://localhost:' + CLOUD_PORT;
let pass = 0, fail = 0;
const T = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); } return null; };
const getJson = (url, opts) => new Promise(resolve => {
  const o = opts || {}; const data = o.body ? JSON.stringify(o.body) : '';
  const r = http.request(url, { method: o.method || 'GET', timeout: 5000, headers: Object.assign({ 'Content-Type': 'application/json', 'X-BR': '1', Origin: BASE }, o.headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
    let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* */ } resolve({ status: res.statusCode, j, headers: res.headers }); });
  });
  r.on('error', () => resolve({ status: 0 })); r.on('timeout', () => r.destroy()); r.end(data);
});

(async () => {
  fs.rmSync(HERE, { recursive: true, force: true }); fs.mkdirSync(HERE, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }), privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const wrong = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });

  // the cloud, on a fresh database
  const psql = s => execSync(process.env.PGHOST ? 'psql -q -v ON_ERROR_STOP=1 ' + s : 'su postgres -c ' + JSON.stringify('psql -q -v ON_ERROR_STOP=1 ' + s), { stdio: 'pipe' });
  psql("-c 'drop database if exists brupd' -c 'create database brupd'");
  psql('-d brupd -v owner_pw=ownerpw -v app_pw=apppw -f ' + JSON.stringify(path.join(ROOT, 'db', 'bootstrap.sql')));
  psql("-d brupd -c 'alter database brupd owner to br_owner'");
  await migrate('postgres://br_owner:ownerpw@localhost/brupd', () => {});
  const db = require('../../src/db');
  const app = require('../../src/server').start({ DATABASE_URL: 'postgres://br_app:apppw@localhost/brupd', PUBLIC_URL: BASE, SESSION_SECRET: 't', BR_DEV_LOGIN: '1', BR_RELEASE_PUBKEY: pubPem });
  await new Promise(r => app.server.listen(CLOUD_PORT, r));
  const h = (await db.tx(db.SYSTEM, async c => {
    const x = (await c.query("insert into br.hospitals (name) values ('Update Hospital') returning id")).rows[0];
    const u = (await c.query("insert into br.users (email, name, is_hci) values ('admin@hci-tv.com', 'Admin', true) returning id")).rows[0];
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin')", [u.id]);
    return x;
  })).id;
  const cookie = String((await getJson(BASE + '/auth/dev?email=admin@hci-tv.com')).headers['set-cookie']).split(';')[0];
  const api = (m, p, b) => getJson(BASE + p, { method: m, body: b, headers: { Cookie: cookie } }).then(r => r.j);

  // "install" Board Remote 2.1.0 the way the installer lays it out
  const INSTALL = path.join(HERE, 'Program Files', 'Board Remote'), DATA = path.join(HERE, 'ProgramData', 'Board Remote');
  const src = path.join(ROOT, 'board-remote');
  // the test's own version numbers (2.1.0, then 2.2.0 and 2.3.0), whatever version the source is at
  const v210 = pkgr.build({ src, out: HERE, key: privPem, version: '2.1.0' });
  fs.mkdirSync(path.join(INSTALL, 'versions', '2.1.0'), { recursive: true });
  execSync('unzip -q ' + JSON.stringify(v210.zip) + ' -d ' + JSON.stringify(path.join(INSTALL, 'versions', '2.1.0')));
  { const f = path.join(INSTALL, 'versions', '2.1.0', 'server.js'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/const VERSION = '[\d.]+';/, "const VERSION = '2.1.0';")); }
  fs.mkdirSync(path.join(INSTALL, 'service'), { recursive: true });
  fs.copyFileSync(path.join(src, 'service', 'supervisor.js'), path.join(INSTALL, 'service', 'supervisor.js'));
  fs.writeFileSync(path.join(INSTALL, 'service', 'release-key.pub'), pubPem);

  // enroll this PC: Board Remote stores the cloud credential in its own data folder
  const code = (await api('POST', '/api/hospitals/' + h + '/codes', { label: 'Station PC' })).code;
  const en = (await getJson(BASE + '/api/agent/enroll', { method: 'POST', body: { code, pcName: 'STATION', version: '2.1.0' } })).j;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'boards.json'), JSON.stringify({ settings: { cloud: { url: BASE, agentId: en.agentId, secret: en.secret, hospital: en.hospital } }, boards: [] }));
  T('the PC enrolled in the cloud', en.ok);

  // start the service
  const svcLog = fs.openSync(path.join(HERE, 'service-console.log'), 'w');
  const svc = spawn(process.execPath, [path.join(INSTALL, 'service', 'supervisor.js')], { env: Object.assign({}, process.env, {
    BR_DATA_DIR: DATA, BOARD_REMOTE_PORT: String(BR_PORT), BR_UPDATE_FIRST_MS: '1500', BR_UPDATE_CHECK_MS: '2000', BR_HEALTH_MS: '25000', BR_STEADY_MS: '3000', BOARD_REMOTE_NO_BROWSER: '1' }), stdio: ['ignore', svcLog, svcLog] });
  const ver = async () => (await getJson('http://127.0.0.1:' + BR_PORT + '/api/ping')).j;
  const p0 = await until(async () => { const p = await ver(); return p && p.ok ? p : null; }, 20000);
  T('the service starts Board Remote 2.1.0, marked as running as a service', p0 && p0.version === '2.1.0' && p0.service === true, p0);
  T('Board Remote keeps its data in the data folder, not the program folder', await until(() => fs.existsSync(path.join(DATA, 'deploy.json')), 10000) && !fs.existsSync(path.join(INSTALL, 'versions', '2.1.0', 'deploy.json')));
  const agentRow = () => db.tx(db.SYSTEM, c => c.query('select version, service, update_state, update_version, update_detail from br.agents where id = $1', [en.agentId])).then(r => r.rows[0]);
  T('the cloud sees the PC run 2.1.0 as a service', !!await until(async () => { const a = await agentRow(); return a.version === '2.1.0' && a.service; }, 15000));

  // 1. a good update
  const mk = (v, edit, key) => {
    const dir = path.join(HERE, 'src-' + v); fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(src, dir, { recursive: true });
    let s = fs.readFileSync(path.join(dir, 'server.js'), 'utf8').replace(/const VERSION = '[\d.]+';/, "const VERSION = '" + v + "';");
    if (edit) s = edit(s);
    fs.writeFileSync(path.join(dir, 'server.js'), s);
    return pkgr.build({ src: dir, out: HERE, key: key || privPem, version: v });
  };
  const upload = (p, notes) => api('POST', '/api/releases', { version: p.version, notes, packageBase64: fs.readFileSync(p.zip).toString('base64'), signature: p.signature });
  const v220 = mk('2.2.0');
  const up = await upload(v220, 'Faster health checks');
  T('2.2.0 uploads (signature checked by the cloud)', up.ok, up);
  await api('POST', '/api/releases/' + up.id + '/status', { status: 'everyone' });
  // outside 2 to 5 am the PC would wait for tonight; approving it makes it go now
  const hr = new Date().getHours();
  if (hr < 2 || hr >= 5) T('outside the overnight window the PC schedules it for tonight', !!await until(async () => (await agentRow()).update_state === 'scheduled', 15000));
  T('HCI approves the PC to install now', (await api('POST', '/api/agents/' + en.agentId + '/approve', {})).ok);
  const p1 = await until(async () => { const p = await ver(); return p && p.version === '2.2.0' ? p : null; }, 60000);
  T('the service installs 2.2.0 and Board Remote answers as 2.2.0', !!p1);
  const a1 = await until(async () => { const a = await agentRow(); return a.update_state === 'done' ? a : null; }, 30000);
  T('the PC reports the update done; the cloud shows 2.2.0', a1 && a1.version === '2.2.0', a1);
  const st1 = JSON.parse(fs.readFileSync(path.join(DATA, 'service.json'), 'utf8'));
  T('the service records 2.2.0 as current and 2.1.0 as the one to go back to', st1.current === '2.2.0' && st1.previous === '2.1.0');
  T('the data survived the update (the cloud link is still there)', !!JSON.parse(fs.readFileSync(path.join(DATA, 'boards.json'), 'utf8')).settings.cloud.agentId);

  // 2. a broken update rolls back
  const v230 = mk('2.3.0', s => s.replace("'use strict';", "'use strict';\nprocess.exit(7);"));
  const up3 = await upload(v230, 'Broken on purpose');
  await api('POST', '/api/releases/' + up3.id + '/status', { status: 'everyone' });
  await api('POST', '/api/agents/' + en.agentId + '/approve', {});
  const a2 = await until(async () => { const a = await agentRow(); return a.update_state === 'rolled_back' ? a : null; }, 90000);
  T('2.3.0 does not start, so the service rolls back and reports it', !!a2, await agentRow());
  T('the rollback reason is reported', a2 && /did not answer/.test(a2.update_detail), a2 && a2.update_detail);
  const p2 = await ver();
  T('Board Remote is running 2.2.0 again', p2 && p2.version === '2.2.0', p2);
  const st2 = JSON.parse(fs.readFileSync(path.join(DATA, 'service.json'), 'utf8'));
  T('2.3.0 is marked bad so it is not tried again on its own', st2.current === '2.2.0' && st2.bad.indexOf('2.3.0') >= 0);
  await sleep(5000);
  T('it is not retried every check', (await agentRow()).update_state === 'rolled_back' && (await ver()).version === '2.2.0');
  const log = (await db.tx(db.SYSTEM, c => c.query("select action from br.audit_log where action like 'update.%' order by id"))).rows.map(r => r.action);
  T('the audit log has the approvals, the success and the rollback', ['update.approved', 'update.done', 'update.rolled_back'].every(a => log.indexOf(a) >= 0), log);

  // 3. Board Remote dies: the service restarts it
  const pid = await until(async () => { try { return Number(execSync("pgrep -f '" + path.join(INSTALL, 'versions', '2.2.0', 'server.js') + "'").toString().trim().split('\n')[0]); } catch (e) { return null; } }, 5000);
  if (pid) process.kill(pid, 'SIGKILL');
  await sleep(1000);
  const p3 = await until(async () => { const p = await ver(); return p && p.version === '2.2.0' ? p : null; }, 20000);
  T('killed, Board Remote is restarted by the service', !!pid && !!p3);

  // 4. the PC itself refuses anything not signed by HCI
  const pkgBuf = fs.readFileSync(v220.zip);
  const meta = { version: '2.2.0', size: pkgBuf.length, sha256: v220.sha256 };
  // checkPackage reads the key next to supervisor.js, which for this module is the source folder; use the installed key's logic directly
  const keyFile = path.join(ROOT, 'board-remote', 'service', 'release-key.pub'), hadKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null;
  fs.writeFileSync(keyFile, pubPem);
  try {
    T('a correctly signed package passes', checkPackage(pkgBuf, Object.assign({ signature: v220.signature }, meta)) === null);
    T('a package signed with another key is refused', /not signed by HCI/.test(checkPackage(pkgBuf, Object.assign({ signature: pkgr.sign('2.2.0', v220.sha256, wrong) }, meta))));
    const tampered = Buffer.from(pkgBuf); tampered[tampered.length - 30] ^= 1;
    T('a tampered package is refused', /checksum/.test(checkPackage(tampered, Object.assign({ signature: v220.signature }, meta))));
    T('a signature for another version is refused', /not signed by HCI/.test(checkPackage(pkgBuf, Object.assign({ signature: pkgr.sign('2.9.9', v220.sha256, privPem) }, meta))));
  } finally { if (hadKey) fs.writeFileSync(keyFile, hadKey); else fs.rmSync(keyFile, { force: true }); }

  svc.kill('SIGTERM');
  await sleep(2000);
  T('stopping the service stops Board Remote too', !(await ver()));
  await new Promise(r => app.server.close(r)); await db.pool.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
