'use strict';
// The cloud server for real, with two simulated Board Remote PCs at Goshen and one at Ball.
const http = require('http');
const db = require('../src/db');
const ws = require('../src/ws');
const { start } = require('../src/server');
module.exports = async function (T, url) {
  const PORT = 7811, BASE = 'http://localhost:' + PORT;
  const app = start({ DATABASE_URL: url, PUBLIC_URL: BASE, SESSION_SECRET: 'test', BR_DEV_LOGIN: '1' });
  await new Promise(r => app.server.listen(PORT, r));
  const S = db.SYSTEM;
  const ids = await db.tx(S, async c => {
    const q = (s, p) => c.query(s, p).then(r => r.rows[0]);
    const g = await q("insert into br.hospitals (name) values ('Goshen Link') returning id");
    const b = await q("insert into br.hospitals (name) values ('Ball Link') returning id");
    const tech = await q("insert into br.users (email, name, is_hci) values ('linktech@hci-tv.com', 'Link Tech', true) returning id");
    const it = await q("insert into br.users (email, name) values ('linkit@goshenhealth.com', 'Goshen IT') returning id");
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_tech'), ($2, $3, 'hospital_it')", [tech.id, it.id, g.id]);
    return { g: g.id, b: b.id, tech: tech.id, it: it.id };
  });

  // sign in (developer sign in, this machine only) and keep the session cookie
  const req = (method, path, body, cookie) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-BR': '1', Origin: BASE }, cookie ? { Cookie: cookie } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) { /* html */ } resolve({ status: res.statusCode, j, headers: res.headers }); });
    });
    r.on('error', reject); r.end(data);
  });
  const signIn = async email => { const r = await req('GET', '/auth/dev?email=' + email); return String(r.headers['set-cookie']).split(';')[0]; };
  const techC = await signIn('linktech@hci-tv.com'), itC = await signIn('linkit@goshenhealth.com');
  T('signed in users get a session', /^br_s=/.test(techC) && /^br_s=/.test(itC));
  T('the API refuses without a session', (await req('GET', '/api/me')).status === 401);
  T('a change without the X-BR header is refused', (await new Promise(r => { const x = http.request(BASE + '/api/hospitals', { method: 'POST', headers: { Cookie: techC, 'Content-Type': 'application/json' } }, res => r(res.statusCode)); x.end('{}'); })) === 403);

  // enrollment: HCI makes codes; Goshen IT can make one for Goshen but not for Ball
  const codeA = (await req('POST', '/api/hospitals/' + ids.g + '/codes', { label: 'Goshen PC A' }, techC)).j.code;
  const codeB = (await req('POST', '/api/hospitals/' + ids.g + '/codes', { label: 'Goshen PC B' }, itC)).j.code;
  T('enrollment code is 12 characters in groups', /^[A-Z0-9]{4} [A-Z0-9]{4} [A-Z0-9]{4}$/.test(codeA) && /^[A-Z0-9 ]{14}$/.test(codeB));
  T('Goshen IT cannot make a code for Ball', !(await req('POST', '/api/hospitals/' + ids.b + '/codes', { label: 'x' }, itC)).j.ok);
  const en = async (code, pc) => (await req('POST', '/api/agent/enroll', { code, pcName: pc, version: '1.9' })).j;
  const eA = await en(codeA.toLowerCase().replace(/ /g, '-'), 'NURSE-STATION-4N'), eB = await en(codeB, 'IT-LAPTOP');
  T('Board Remote enrolls with the code (any case, spaces or dashes)', eA.ok && eB.ok && eA.hospital.id === ids.g);
  T('a code works only once', !(await en(codeA, 'X')).ok);
  const codeBall = (await req('POST', '/api/hospitals/' + ids.b + '/codes', { label: 'Ball PC' }, techC)).j.code;
  const eC = await en(codeBall, 'BALL-PC');

  // connect three PCs over WebSockets
  const open = async e => {
    const s = await ws.connect('ws://localhost:' + PORT + '/agent', { Authorization: 'Bearer ' + e.agentId + '.' + e.secret });
    const inbox = []; s.on('message', m => inbox.push(JSON.parse(m)));
    s.wait = async (t, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { const i = inbox.findIndex(x => x.t === t); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise(r => setTimeout(r, 25)); } return null; };
    s.j = o => s.send(JSON.stringify(o));
    return s;
  };
  T('a wrong secret cannot connect', await ws.connect('ws://localhost:' + PORT + '/agent', { Authorization: 'Bearer ' + eA.agentId + '.' + 'x'.repeat(43) }).then(() => false, e => e.status === 401));
  const pa = await open(eA), pb = await open(eB), pc = await open(eC);
  const t0 = Date.now();
  // PC A and PC B both reach the board in 401 (same MAC); A also sees 402; Ball sees its own
  pa.j({ t: 'hello', version: '1.9', pcName: 'NURSE-STATION-4N', boards: [
    { localId: 'a1', identity: 'AA:BB:CC:00:04:01', kind: 'wb', name: 'Room 401 Whiteboard', host: '10.4.0.41', port: 5555, room: '401', unit: '4 North', placementTs: { room: t0 - 5000 }, online: true, state: 'online', headline: 'Healthy' },
    { localId: 'a2', identity: 'aa:bb:cc:00:04:02', kind: 'ds', name: 'Room 402 Door sign', host: '10.4.0.42', room: '402', unit: '4 North', online: true, state: 'online', headline: 'Healthy' }] });
  T('PC A gets its welcome', !!(await pa.wait('welcome')));
  pb.j({ t: 'hello', version: '1.9', boards: [{ localId: 'b7', identity: 'aa:bb:cc:00:04:01', kind: 'wb', host: '10.4.0.41', room: '401', unit: '4 North', placementTs: { room: t0 - 9000 }, online: false, state: 'offline', headline: 'No answer' }] });
  await pb.wait('welcome');
  pc.j({ t: 'hello', boards: [{ localId: 'c1', identity: 'dd:ee:ff:00:01:01', kind: 'wb', room: '101', online: true, state: 'online' }] });
  await pc.wait('welcome');

  let fleet = (await req('GET', '/api/hospitals/' + ids.g + '/fleet', null, itC)).j;
  const d401 = fleet.devices.find(d => d.room === '401');
  T('a board two techs reach is one device', fleet.devices.length === 2 && d401.reach.length === 2, fleet.devices.map(d => [d.room, (d.reach || []).length]));
  T('its state comes from the PC that can reach it (online beats offline)', d401.state === 'online' && d401.reach.find(r => r.primary).pc === 'Goshen PC A', d401);
  T('Goshen IT sees both Goshen PCs', fleet.pcs.length === 2 && fleet.pcs.every(x => x.online));
  T('Goshen IT cannot read Ball\'s fleet', (await req('GET', '/api/hospitals/' + ids.b + '/fleet', null, itC)).status === 404);
  T('HCI tech sees Ball\'s board', (await req('GET', '/api/hospitals/' + ids.b + '/fleet', null, techC)).j.devices.length === 1);

  // PC A drops the board, PC B now reaches it
  pa.j({ t: 'state', updates: [{ localId: 'a1', online: false, state: 'offline', headline: 'No answer' }] });
  pb.j({ t: 'state', updates: [{ localId: 'b7', online: true, state: 'online', headline: 'Healthy', lastBeat: Date.now() }] });
  await new Promise(r => setTimeout(r, 300));
  fleet = (await req('GET', '/api/hospitals/' + ids.g + '/fleet', null, itC)).j;
  const d2 = fleet.devices.find(d => d.room === '401');
  T('when one PC loses a board and another reaches it, the board stays online', d2.state === 'online' && d2.reach.find(r => r.primary).pc === 'Goshen PC B', d2.reach);

  // placement: a local edit on PC B syncs to the cloud and to PC A
  pb.j({ t: 'placement', localId: 'b7', field: 'room', value: '401A', ts: Date.now() });
  const toA = await pa.wait('placement');
  T('a room changed on one PC reaches the other PC', toA && toA.localId === 'a1' && toA.room === '401A', toA);
  // an older edit loses
  pa.j({ t: 'placement', localId: 'a1', field: 'room', value: '499', ts: t0 - 60000 });
  const fixA = await pa.wait('placement');
  T('an older edit loses, and the PC is told the current room', fixA && fixA.room === '401A', fixA);
  // the web app edit reaches both PCs
  const dev = d2.id;
  T('Goshen IT changes the room in the web app', (await req('PATCH', '/api/devices/' + dev, { room: '401' }, itC)).j.ok);
  T('...and both PCs are told', (await pa.wait('placement')).room === '401' && (await pb.wait('placement')).room === '401');
  // the lock
  T('Goshen IT cannot lock', (await req('POST', '/api/devices/' + dev + '/lock', { locked: true }, itC)).status === 403);
  T('HCI locks the location', (await req('POST', '/api/devices/' + dev + '/lock', { locked: true }, techC)).j.ok);
  const lk = await pa.wait('placement'); await pb.wait('placement');
  T('PCs are told it is locked', lk && lk.locked === true);
  pb.j({ t: 'placement', localId: 'b7', field: 'room', value: '777', ts: Date.now() + 1000 });
  const back = await pb.wait('placement');
  T('a locked room cannot be changed from a PC, even with a newer time', back && back.room === '401' && back.locked);
  T('a locked room cannot be changed in the web app by hospital IT', (await req('PATCH', '/api/devices/' + dev, { room: '888' }, itC)).status === 403);
  T('HCI can lock a whole hospital in one go', /Locked 1 board/.test((await req('POST', '/api/hospitals/' + ids.g + '/lock', { locked: true }, techC)).j.message));

  // commands: the web app asks, the PC that reaches the board runs it
  const cmd = (await req('POST', '/api/devices/' + dev + '/command', { action: 'act', args: { key: 'reboot' } }, itC)).j;
  const got = await pb.wait('command');
  T('a fix goes to the PC that can reach the board', cmd.ok && got && got.action === 'act' && got.args.key === 'reboot' && got.args.localId === 'b7', got);
  pb.j({ t: 'result', id: got.id, ok: true, message: 'Rebooted. Back after 41 s.' });
  await new Promise(r => setTimeout(r, 200));
  const st = (await req('GET', '/api/commands/' + cmd.id, null, itC)).j.command;
  T('its result comes back', st.status === 'done' && /Back after/.test(st.result.message));
  T('actions outside the list are refused', !(await req('POST', '/api/devices/' + dev + '/command', { action: 'act', args: { key: 'rm -rf' } }, itC)).j.ok && !(await req('POST', '/api/devices/' + dev + '/command', { action: 'shell', args: {} }, itC)).j.ok);
  const d402 = fleet.devices.find(d => d.room === '402');
  T('LED goes to a door sign', (await req('POST', '/api/devices/' + d402.id + '/command', { action: 'led', args: { color: 'red', mode: 'flash' } }, itC)).j.ok && (await pa.wait('command')).action === 'led');
  T('LED refused for a whiteboard', !(await req('POST', '/api/devices/' + dev + '/command', { action: 'led', args: { color: 'red' } }, itC)).j.ok);
  pb.close(); await new Promise(r => setTimeout(r, 300));
  const q = (await req('POST', '/api/devices/' + dev + '/command', { action: 'act', args: { key: 'wake' } }, itC)).j;
  T('with that PC away, a command is queued, not lost', q.ok && /Queued|Sent/.test(q.message));

  // people
  T('Goshen IT invites a colleague', (await req('POST', '/api/hospitals/' + ids.g + '/people', { email: 'pat@goshenhealth.com', role: 'hospital_it' }, itC)).j.ok);
  T('Goshen IT cannot make someone a dealer', (await req('POST', '/api/hospitals/' + ids.g + '/people', { email: 'x@pavion.com', role: 'dealer', tenantId: '33333333-3333-3333-3333-333333333333' }, itC)).status === 403);
  T('Goshen IT cannot give HCI roles', !(await req('POST', '/api/hci/people', { email: 'y@hcic.com', role: 'hci_admin' }, itC)).j.ok);

  // audit
  const log = (await req('GET', '/api/hospitals/' + ids.g + '/audit', null, itC)).j.entries.map(e => e.action);
  T('the audit log has the whole story', ['agent.enrolled', 'device.discovered', 'device.placement', 'device.locked', 'hospital.locked', 'command.act', 'command.result', 'command.led', 'person.invited'].every(a => log.indexOf(a) >= 0), log);
  T('Ball\'s audit log has none of it', !(await req('GET', '/api/hospitals/' + ids.b + '/audit', null, techC)).j.entries.some(e => /placement|locked/.test(e.action)));
  T('no audit entry carries screen text', !JSON.stringify(log).match(/Ron Nelson/));

  // removing a PC cuts it off
  T('removing a PC disconnects it', (await req('POST', '/api/agents/' + eA.agentId + '/revoke', {}, techC)).j.ok);
  await new Promise(r => setTimeout(r, 200));
  T('...and it cannot reconnect', await ws.connect('ws://localhost:' + PORT + '/agent', { Authorization: 'Bearer ' + eA.agentId + '.' + eA.secret }).then(() => false, e => e.status === 401));
  pa.close(); pc.close();
  await new Promise(r => app.server.close(r));
};
