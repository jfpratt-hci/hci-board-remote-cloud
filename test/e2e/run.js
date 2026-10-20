'use strict';
// End to end: one cloud (in process, local Postgres) and two real Board Remote copies (child processes,
// fake adb) watching the same two boards. Proves: enroll, dedupe, placement sync both ways, lock, commands.
const { execSync, spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');
// node test/e2e/run.js   (needs local Postgres, and Board Remote next to this project or at BR_DIR)
// SHOTS=1 also saves screenshots of the web app here.
const CLOUD = path.join(__dirname, '..', '..'), BR = process.env.BR_DIR || path.join(CLOUD, '..', 'HCI ONE Board Remote'), HERE = path.join(require('os').tmpdir(), 'br-e2e');
const { migrate } = require(CLOUD + '/src/migrate');
const db = require(CLOUD + '/src/db');
const { start } = require(CLOUD + '/src/server');
let pass = 0, fail = 0;
const T = (n, ok, x) => { ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + n + (ok || x === undefined ? '' : ' ' + JSON.stringify(x))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { try { v = await fn(); if (v) return v; } catch (e) { /* not yet */ } await sleep(400); } return v; };
const req = (base, method, p, body, headers) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, res => {
    let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* html */ } resolve({ status: res.statusCode, headers: res.headers, json: j }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});

(async () => {
  fs.mkdirSync(HERE, { recursive: true });
  const psql = s => execSync('su postgres -c ' + JSON.stringify('psql -q -v ON_ERROR_STOP=1 ' + s), { stdio: 'pipe' });
  psql("-c 'drop database if exists bre2e' -c 'create database bre2e'");
  psql("-d bre2e -v owner_pw=ownerpw -v app_pw=apppw -f " + JSON.stringify(CLOUD + '/db/bootstrap.sql'));
  psql("-d bre2e -c 'alter database bre2e owner to br_owner'");
  await migrate('postgres://br_owner:ownerpw@localhost/bre2e', () => {});
  const CP = 7900, CB = 'http://localhost:' + CP;
  const app = start({ DATABASE_URL: 'postgres://br_app:apppw@localhost/bre2e', PUBLIC_URL: CB, SESSION_SECRET: 'e2e', BR_DEV_LOGIN: '1' });
  await new Promise(r => app.server.listen(CP, r));

  const { h, }= await db.tx(db.SYSTEM, async c => {
    const h = (await c.query("insert into br.hospitals (name) values ('Goshen Hospital') returning id")).rows[0].id;
    const tech = (await c.query("insert into br.users (email, name, is_hci) values ('tech@hci-tv.com', 'HCI Tech', true) returning id")).rows[0].id;
    const it = (await c.query("insert into br.users (email, name) values ('it@goshenhealth.com', 'Goshen IT') returning id")).rows[0].id;
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_tech'), ($2, $3, 'hospital_it')", [tech, it, h]);
    return { h };
  });
  const signIn = async email => String((await req(CB, 'GET', '/auth/dev?email=' + email)).headers['set-cookie']).split(';')[0];
  const techC = await signIn('tech@hci-tv.com'), itC = await signIn('it@goshenhealth.com');
  const cloud = (cookie, m, p, b) => req(CB, m, p, b, { Cookie: cookie, 'X-BR': '1', Origin: CB });

  for (const ip of ['127.0.0.2', '127.0.0.3']) require('net').createServer(s => s.end()).listen(5555, ip);
  // two Board Remote PCs
  const pcs = [];
  for (const [name, port] of [['A', 7761], ['B', 7762]]) {
    const dir = path.join(HERE, 'pc' + name), st = path.join(HERE, 'st' + name);
    execSync('rm -rf ' + JSON.stringify(dir) + ' ' + JSON.stringify(st) + ' && mkdir -p ' + JSON.stringify(st));
    execSync('cp -r ' + JSON.stringify(BR) + ' ' + JSON.stringify(dir) + ' && rm -f ' + JSON.stringify(dir) + '/boards.json');
    fs.writeFileSync(path.join(st, 'boards.cfg'), '127.0.0.2 device\n127.0.0.3 device\n'); fs.writeFileSync(path.join(st, 'connected'), '');
    const p = spawn('node', ['server.js'], { cwd: dir, env: Object.assign({}, process.env, { BOARD_REMOTE_PORT: String(port), ADB: path.join(__dirname, 'fake-adb'), FAKE_ADB_STATE: st, BOARD_REMOTE_NO_BROWSER: '1' }), stdio: ['ignore', fs.openSync(path.join(HERE, 'pc' + name + '.log'), 'w'), 'pipe'] });
    p.stderr.on('data', d => fs.appendFileSync(path.join(HERE, 'pc' + name + '.log'), d));
    pcs.push({ name, port, base: 'http://127.0.0.1:' + port, proc: p });
  }
  const L = (pc, m, p, b) => req(pc.base, m, p, b, { 'X-Board-Remote': '1' });
  for (const pc of pcs) await until(() => L(pc, 'GET', '/api/cloud/state').then(r => r.json && r.json.ok));
  const [A, B] = pcs;
  // the same two boards on both PCs
  for (const pc of pcs) {
    await L(pc, 'POST', '/api/boards', { name: 'WB 401', host: '127.0.0.2', port: 5555, kind: 'wb', room: '401', unit: '4 West', closet: 'IDF 4' });
    await L(pc, 'POST', '/api/boards', { name: 'DS 402', host: '127.0.0.3', port: 5555, kind: 'ds', room: '402', unit: '4 West', closet: 'IDF 4' });
  }
  const boardsOf = async pc => (await L(pc, 'GET', '/api/state')).json.boards;
  T('both PCs see both boards online', await until(async () => { for (const pc of pcs) { const b = await boardsOf(pc); if (b.length !== 2 || b.some(x => x.status !== 'online')) return false; } return true; }, 30000));

  // enrollment
  const codeA = (await cloud(techC, 'POST', '/api/hospitals/' + h + '/codes', { label: 'Nurse station 4W' })).json;
  const codeB = (await cloud(itC, 'POST', '/api/hospitals/' + h + '/codes', { label: 'IT desk' })).json;
  T('HCI and hospital IT can both make an enrollment code', codeA && codeA.code && codeB && codeB.code, [codeA, codeB]);
  const bad = (await L(A, 'POST', '/api/cloud/enroll', { url: CB, code: 'AAAA BBBB CCCC' })).json;
  T('a wrong code is refused', bad && !bad.ok, bad);
  const eA = (await L(A, 'POST', '/api/cloud/enroll', { url: CB, code: codeA.code })).json, eB = (await L(B, 'POST', '/api/cloud/enroll', { url: CB, code: codeB.code })).json;
  T('both PCs enroll', eA.ok && eB.ok, [eA, eB]);
  const reuse = (await L(B, 'POST', '/api/cloud/enroll', { url: CB, code: codeA.code })).json;
  T('a used code cannot be used again', reuse && !reuse.ok);
  if (!reuse.ok) { /* B is still enrolled from before */ }
  T('both PCs are connected', await until(async () => (await L(A, 'GET', '/api/cloud/state')).json.connected && (await L(B, 'GET', '/api/cloud/state')).json.connected));
  const fleet = async cookie => (await cloud(cookie, 'GET', '/api/hospitals/' + h + '/fleet')).json;
  const f1 = await until(async () => { const f = await fleet(itC); return f && f.devices && f.devices.length === 2 && f.devices.every(d => (d.reach || []).length === 2) && f.devices.every(d => d.reach.every(r => r.online)) ? f : null; }, 30000);
  T('the cloud shows 2 boards (not 4), each reached by both PCs, online', !!f1, await fleet(itC));
  const fl = f1 || await fleet(itC);
  const dev = id => fl.devices.find(d => d.room === id);
  T('room, unit and closet came up from the PCs', dev('401') && dev('401').unit === '4 West' && dev('402') && dev('402').closet === 'IDF 4');
  T('the door sign is a door sign in the cloud', dev('402') && dev('402').kind === 'ds');

  // placement: edit on PC A, it reaches the cloud and PC B
  const a401 = (await boardsOf(A)).find(b => b.room === '401'), b401 = (await boardsOf(B)).find(b => b.room === '401');
  await L(A, 'POST', '/api/boards/' + a401.id + '/edit', { room: '401A' });
  T('a room changed on PC A reaches the cloud', await until(async () => (await fleet(itC)).devices.some(d => d.room === '401A')));
  T('and reaches PC B', await until(async () => (await boardsOf(B)).find(b => b.id === b401.id).room === '401A'));
  // edit in the web app reaches both PCs
  const d401 = (await fleet(itC)).devices.find(d => d.room === '401A');
  const w = (await cloud(itC, 'PATCH', '/api/devices/' + d401.id, { unit: '4 East' })).json;
  T('hospital IT changes the unit in the web app', w && w.ok, w);
  T('it reaches both PCs', await until(async () => (await boardsOf(A)).find(b => b.id === a401.id).unit === '4 East' && (await boardsOf(B)).find(b => b.id === b401.id).unit === '4 East'));

  // the HCI lock
  const noLock = await cloud(itC, 'POST', '/api/devices/' + d401.id + '/lock', { locked: true });
  T('hospital IT cannot lock a location', !(noLock.json && noLock.json.ok), noLock.status);
  const lk = (await cloud(techC, 'POST', '/api/devices/' + d401.id + '/lock', { locked: true })).json;
  T('HCI locks the location', lk && lk.ok, lk);
  T('both PCs learn about the lock', await until(async () => (await L(A, 'GET', '/api/cloud/state')).json.locked === 1 && (await L(B, 'GET', '/api/cloud/state')).json.locked === 1));
  const le = await L(B, 'POST', '/api/boards/' + b401.id + '/edit', { room: '999' });
  T('a locked room cannot be changed on a PC', le.status === 423 && (await boardsOf(B)).find(b => b.id === b401.id).room === '401A', le.json);
  const ln = await L(B, 'POST', '/api/boards/' + b401.id + '/edit', { name: 'WB 401 renamed' });
  T('the name of a locked board can still be changed on a PC', ln.json && ln.json.ok);
  const wl = await cloud(itC, 'PATCH', '/api/devices/' + d401.id, { room: '999' });
  T('hospital IT cannot change a locked room in the web app', !(wl.json && wl.json.ok) && (await fleet(itC)).devices.find(d => d.id === d401.id).room === '401A', wl.json);
  const ul = (await cloud(techC, 'POST', '/api/devices/' + d401.id + '/lock', { locked: false })).json;
  T('HCI unlocks it, and the PCs can edit again', ul && ul.ok && await until(async () => (await L(B, 'GET', '/api/cloud/state')).json.locked === 0) && (await L(B, 'POST', '/api/boards/' + b401.id + '/edit', { room: '401' })).json.ok);

  // commands
  const ds = (await fleet(itC)).devices.find(d => d.kind === 'ds');
  const cmd = (await cloud(itC, 'POST', '/api/devices/' + ds.id + '/command', { action: 'probe' })).json;
  T('a health check is queued from the web app', cmd && cmd.ok && cmd.id, cmd);
  const done = await until(async () => { const r = (await cloud(itC, 'GET', '/api/commands/' + cmd.id)).json; const c = r && r.command; return c && c.result && (c.status === 'done' || c.status === 'failed') ? c : null; });
  T('a PC runs it and the board\'s answer comes back', !!done, (await cloud(itC, 'GET', '/api/commands/' + cmd.id)).json);
  const led = (await cloud(itC, 'POST', '/api/devices/' + ds.id + '/command', { action: 'led', args: { color: 'red', mode: 'solid' } })).json;
  const ledDone = await until(async () => { const r = (await cloud(itC, 'GET', '/api/commands/' + led.id)).json; const c = r && (r.command || r); return c && (c.status === 'done' || c.status === 'failed') ? c : null; });
  T('the door sign LED command reaches the PC and comes back with an answer', !!ledDone, ledDone);
  const wbLed = (await cloud(itC, 'POST', '/api/devices/' + d401.id + '/command', { action: 'led', args: { color: 'red' } })).json;
  T('LED is refused for a whiteboard', wbLed && !wbLed.ok, wbLed);
  const shellCmd = (await cloud(techC, 'POST', '/api/devices/' + ds.id + '/command', { action: 'shell', args: { cmd: 'rm -rf /' } })).json;
  T('anything outside the allowed actions is refused', shellCmd && !shellCmd.ok);

  // a PC goes away: the boards stay online through the other PC
  A.proc.kill();
  const f2 = await until(async () => { const f = await fleet(itC); return f.devices.every(d => d.reach.some(r => r.online) && d.reach[0].pc === 'IT desk') ? f : null; }, 20000);
  T('with PC A gone, both boards are still online through PC B', !!f2);
  const gone = await until(async () => { const f = await fleet(itC); const a = f.pcs.find(p => p.name === 'Nurse station 4W'); return a && !a.online && f.devices.every(d => d.reach.find(r => r.pc === 'Nurse station 4W' && !r.online)); }, 10000);
  T('the cloud sees PC A gone within 10 seconds, and its reach goes offline', !!gone);
  const cmd2 = (await cloud(itC, 'POST', '/api/devices/' + ds.id + '/command', { action: 'act', args: { key: 'wake' } })).json;
  const d2 = cmd2.ok && await until(async () => { const r = (await cloud(itC, 'GET', '/api/commands/' + cmd2.id)).json; return r && r.command.status === 'done' ? r.command : null; });
  T('and a wake command runs to done, through PC B', !!d2, (await cloud(itC, 'GET', '/api/commands/' + cmd2.id)).json);

  // no PHI: nothing that looks like screen content in the cloud
  const cols = (await db.tx(db.SYSTEM, c => c.query("select table_name, column_name from information_schema.columns where table_schema = 'br' and (column_name ~ 'shot|screen|snap|image|png|logcat|text$')"))).rows;
  T('the cloud database has no column for screens, snapshots, screen text or logs', cols.length === 0, cols);
  const audit = (await cloud(itC, 'GET', '/api/hospitals/' + h + '/audit')).json;
  T('the audit log recorded the edits, lock and commands', audit && (audit.rows || audit.entries || []).length >= 6, audit && Object.keys(audit));

  if (process.env.SHOTS) {
    const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
    const br = await chromium.launch();
    for (const [w, hh] of [[1440, 900], [1280, 800]]) {
      const pg = await br.newPage({ viewport: { width: w, height: hh } });
      pg.on('console', m => { if (m.type() === 'error') console.log('    console:', m.text()); });
      pg.on('pageerror', e => console.log('    pageerror:', e.message));
      await pg.goto(CB + '/auth/dev?email=tech@hci-tv.com&next=/'); await pg.waitForTimeout(1200);
      await pg.screenshot({ path: HERE + '/w_boards_' + w + '.png' });
      await pg.click('.b.ok'); await pg.waitForTimeout(500); await pg.screenshot({ path: HERE + '/w_drawer_' + w + '.png' });
      await pg.click('#dClose');
      for (const v of ['pcs', 'people', 'log', 'hci']) { await pg.goto(CB + '/#' + v); await pg.waitForTimeout(900); await pg.screenshot({ path: HERE + '/w_' + v + '_' + w + '.png' }); console.log('   ', v, w, await pg.evaluate(() => [document.documentElement.scrollHeight, innerHeight, document.documentElement.scrollWidth, innerWidth].join(' '))); }
      await pg.close();
    }
    const it = await br.newPage({ viewport: { width: 1440, height: 900 } });
    await it.goto(CB + '/auth/dev?email=it@goshenhealth.com&next=/'); await it.waitForTimeout(1000);
    await it.click('.b'); await it.waitForTimeout(400); await it.screenshot({ path: HERE + '/w_it_drawer.png' });
    console.log('    IT sees Hospitals tab:', await it.evaluate(() => !document.querySelector('#navHci').hidden));
    await br.close();
  }
  B.proc.kill();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await new Promise(r => app.server.close(r)); await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); for (const p of []) p.kill(); process.exit(2); });
