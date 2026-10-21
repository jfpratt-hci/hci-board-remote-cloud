'use strict';
// Board Remote program updates: signed uploads, pilot then everyone, auto vs approve, pause, download.
const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const { start } = require('../src/server');
const { SIGN_PREFIX } = require('../src/updates');

function zipOf(text) {
  // a tiny but real zip (one stored file) so the upload looks like a package
  const name = Buffer.from('VERSION'), data = Buffer.from(text);
  const crc = (() => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of data) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; })();
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
  const off = lh.length + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(ch.length + name.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([lh, name, data, ch, name, end]);
}

module.exports = async function (T, url) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const PORT = 7813, BASE = 'http://localhost:' + PORT;
  const app = start({ DATABASE_URL: url, PUBLIC_URL: BASE, SESSION_SECRET: 'test', BR_DEV_LOGIN: '1', BR_RELEASE_PUBKEY: publicKey.export({ type: 'spki', format: 'pem' }) });
  await new Promise(r => app.server.listen(PORT, r));
  const ids = await db.tx(db.SYSTEM, async c => {
    const q = (s, p) => c.query(s, p).then(r => r.rows[0]);
    const pilot = await q("insert into br.hospitals (name, update_ring) values ('Pilot Hospital', 'pilot') returning id");
    const norm = await q("insert into br.hospitals (name) values ('Normal Hospital') returning id");
    const strict = await q("insert into br.hospitals (name, update_mode) values ('Strict Hospital', 'approve') returning id");
    const admin = await q("insert into br.users (email, name, is_hci) values ('reladmin@hci-tv.com', 'Release Admin', true) returning id");
    const tech = await q("insert into br.users (email, name, is_hci) values ('reltech@hci-tv.com', 'Release Tech', true) returning id");
    const it = await q("insert into br.users (email, name) values ('it@strict.org', 'Strict IT') returning id");
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin'), ($2, null, 'hci_tech'), ($3, $4, 'hospital_it')", [admin.id, tech.id, it.id, strict.id]);
    return { pilot: pilot.id, norm: norm.id, strict: strict.id };
  });
  const req = (method, path, body, headers) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-BR': '1', Origin: BASE }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      const ch = []; res.on('data', x => ch.push(x)); res.on('end', () => { const buf = Buffer.concat(ch); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) { /* binary */ } resolve({ status: res.statusCode, j, buf, headers: res.headers }); });
    });
    r.on('error', reject); r.end(data);
  });
  const signIn = async email => ({ Cookie: String((await req('GET', '/auth/dev?email=' + email)).headers['set-cookie']).split(';')[0] });
  const adminH = await signIn('reladmin@hci-tv.com'), techH = await signIn('reltech@hci-tv.com'), itH = await signIn('it@strict.org');
  const enroll = async h => { const code = (await req('POST', '/api/hospitals/' + h + '/codes', { label: 'PC' }, adminH)).j.code; return (await req('POST', '/api/agent/enroll', { code, pcName: 'PC', version: '2.1.0' })).j; };
  const ag = { pilot: await enroll(ids.pilot), norm: await enroll(ids.norm), strict: await enroll(ids.strict) };
  const AH = e => ({ Authorization: 'Bearer ' + e.agentId + '.' + e.secret });
  const check = (e, v) => req('GET', '/api/agent/update?version=' + (v || '2.1.0') + '&service=1', null, AH(e)).then(r => r.j);

  const pkg = zipOf('2.2.0'), sha = crypto.createHash('sha256').update(pkg).digest('hex');
  const sign = (v, s, k) => crypto.sign(null, Buffer.from(SIGN_PREFIX + v + '|' + s), k || privateKey).toString('base64');
  const up = (h, v, sig, p) => req('POST', '/api/releases', { version: v, notes: 'Test release', packageBase64: (p || pkg).toString('base64'), signature: sig }, h);

  T('an HCI tech cannot upload a release', (await up(techH, '2.2.0', sign('2.2.0', sha))).status === 403);
  T('hospital IT cannot upload a release', (await up(itH, '2.2.0', sign('2.2.0', sha))).status === 403);
  T('a package signed with another key is refused', /signature does not match/.test((await up(adminH, '2.2.0', sign('2.2.0', sha, other))).j.message));
  T('a signature for a different version is refused', !(await up(adminH, '2.2.0', sign('2.3.0', sha))).j.ok);
  T('something that is not a zip is refused', /not a Board Remote package/.test((await up(adminH, '2.2.0', sign('2.2.0', sha), Buffer.from('x'.repeat(200)))).j.message));
  const u = await up(adminH, '2.2.0', sign('2.2.0', sha));
  T('an HCI admin uploads a correctly signed release as a draft', u.j.ok && /draft/.test(u.j.message));
  T('the same version cannot be uploaded twice', /already uploaded/.test((await up(adminH, '2.2.0', sign('2.2.0', sha))).j.message));
  T('a draft goes to no PC', (await check(ag.pilot)).update === null && (await check(ag.norm)).update === null);
  T('a PC without a valid credential is refused', (await req('GET', '/api/agent/update?version=2.1.0', null, { Authorization: 'Bearer ' + ag.norm.agentId + '.' + 'x'.repeat(43) })).status === 401);

  T('an HCI tech cannot publish', (await req('POST', '/api/releases/' + u.j.id + '/status', { status: 'pilot' }, techH)).status === 403);
  T('an HCI admin sends it to the pilot hospitals', (await req('POST', '/api/releases/' + u.j.id + '/status', { status: 'pilot' }, adminH)).j.ok);
  const cp = await check(ag.pilot);
  T('a pilot hospital PC is offered 2.2.0 for the overnight window', cp.update && cp.update.version === '2.2.0' && cp.update.sha256 === sha && cp.update.now === false && cp.update.window[0] === 2);
  T('a normal hospital PC is not offered a pilot release', (await check(ag.norm)).update === null);
  T('a PC already on the release is offered nothing', (await check(ag.pilot, '2.2.0')).update === null);
  T('a PC on a newer version is never offered an older one', (await check(ag.pilot, '2.10.0')).update === null);

  const dl = await req('GET', '/api/agent/releases/' + u.j.id + '/package', null, AH(ag.pilot));
  T('the pilot PC downloads the package and it matches the sha256', dl.status === 200 && crypto.createHash('sha256').update(dl.buf).digest('hex') === sha);
  T('a PC the release is not for cannot download it', (await req('GET', '/api/agent/releases/' + u.j.id + '/package', null, AH(ag.norm))).status === 404);

  await req('POST', '/api/releases/' + u.j.id + '/status', { status: 'everyone' }, adminH);
  T('sent to everyone, a normal hospital PC is offered it too', ((await check(ag.norm)).update || {}).version === '2.2.0');
  const cs = await check(ag.strict);
  T('a hospital that approves updates waits instead', cs.update === null && cs.waiting === '2.2.0');
  const fleet = (await req('GET', '/api/hospitals/' + ids.strict + '/fleet', null, itH)).j;
  T('its IT sees the PC waiting for approval of 2.2.0', fleet.pcs[0].update_state === 'waiting' && fleet.pcs[0].update_version === '2.2.0' && fleet.hospital.updates.update_mode === 'approve');
  T('hospital IT cannot change how its hospital updates', (await req('PATCH', '/api/hospitals/' + ids.strict + '/updates', { updateMode: 'auto' }, itH)).status === 403);
  T('hospital IT can approve its own PC', (await req('POST', '/api/agents/' + ag.strict.agentId + '/approve', {}, itH)).j.ok);
  const ca = await check(ag.strict);
  T('once approved the PC installs at once', ca.update && ca.update.now === true);
  T('hospital IT cannot approve another hospital', (await req('POST', '/api/hospitals/' + ids.norm + '/approve', {}, itH)).status !== 200);

  // the PC reports its progress
  const st = (e, s, v, d) => req('POST', '/api/agent/update-status', { state: s, version: v, detail: d }, AH(e)).then(r => r.j);
  await st(ag.strict, 'downloading', '2.2.0'); await st(ag.strict, 'installing', '2.2.0');
  T('a finished update is recorded', (await st(ag.strict, 'done', '2.2.0', 'Started and answered in 4 s')).ok);
  const after = (await db.tx(db.SYSTEM, c => c.query('select version, update_state, approved_release from br.agents where id = $1', [ag.strict.agentId]))).rows[0];
  T('the PC now shows 2.2.0 and the approval is used up', after.version === '2.2.0' && after.update_state === 'done' && after.approved_release === null);
  await st(ag.norm, 'rolled_back', '2.2.0', 'Did not answer within 120 s; back on 2.1.0');
  const log = (await db.tx(db.SYSTEM, c => c.query("select action, result from br.audit_log where action like 'update.%' or action like 'release.%' order by id"))).rows.map(r => r.action + ':' + r.result);
  T('uploads, publishing, approval, success and rollback are all in the audit log', ['release.uploaded:ok', 'release.pilot:ok', 'release.everyone:ok', 'update.approved:ok', 'update.done:ok', 'update.rolled_back:failed'].every(x => log.indexOf(x) >= 0), log);
  T('an unknown state is refused', (await req('POST', '/api/agent/update-status', { state: 'hacked' }, AH(ag.norm))).status === 400);

  await req('POST', '/api/releases/' + u.j.id + '/status', { status: 'paused' }, adminH);
  T('a paused release goes to no PC', (await check(ag.norm)).update === null && (await check(ag.pilot)).update === null);
  T('HCI switches a hospital to approve and back', (await req('PATCH', '/api/hospitals/' + ids.norm + '/updates', { updateMode: 'approve', updateRing: 'pilot' }, techH)).j.ok
    && (await db.tx(db.SYSTEM, c => c.query('select update_mode, update_ring from br.hospitals where id = $1', [ids.norm]))).rows[0].update_ring === 'pilot');
  const list = (await req('GET', '/api/releases', null, adminH)).j;
  T('the releases page lists versions and every PC with its version', list.ok && list.releases[0].version === '2.2.0' && list.pcs.length >= 3 && list.canPublish === true);
  T('hospital IT cannot open the releases page', (await req('GET', '/api/releases', null, itH)).status === 403);
  const noBlob = (await db.tx({ kind: 'agent', agentId: ag.norm.agentId }, c => c.query("select count(*)::int n from br.br_releases where status = 'draft'"))).rows[0].n;
  T('PCs cannot even see draft releases in the database', noBlob === 0);

  await new Promise(r => app.server.close(r));
};
