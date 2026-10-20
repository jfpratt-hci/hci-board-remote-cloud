'use strict';
// Two PCs hammering the same 40 boards with state updates in opposite orders, at the same time:
// the case that deadlocks without the fixed lock order and the retry. Nothing may be lost.
const db = require('../src/db');
const ws = require('../src/ws');
const { start } = require('../src/server');
module.exports = async function (T, url) {
  const PORT = 7812;
  const app = start({ DATABASE_URL: url, PUBLIC_URL: 'http://localhost:' + PORT, SESSION_SECRET: 't', BR_DEV_LOGIN: '1' });
  await new Promise(r => app.server.listen(PORT, r));
  const h = (await db.tx(db.SYSTEM, c => c.query("insert into br.hospitals (name) values ('Stress') returning id"))).rows[0].id;
  const enroll = async () => { const code = await app.agents.makeCode(db.SYSTEM, h, 'pc'); return app.agents.enroll(code, 'pc', '1.9'); };
  const [e1, e2] = [await enroll(), await enroll()];
  const errs = [];
  const open = async e => { const s = await ws.connect('ws://localhost:' + PORT + '/agent', { Authorization: 'Bearer ' + e.agentId + '.' + e.secret }); s.on('message', m => { const j = JSON.parse(m); if (j.t === 'error') errs.push(j.message); }); return s; };
  const a = await open(e1), b = await open(e2);
  const N = 40, ident = i => 'ff:00:00:00:00:' + String(i).padStart(2, '0');
  const boards = p => Array.from({ length: N }, (_, i) => ({ localId: p + i, identity: ident(i), kind: 'wb', room: String(500 + i), online: true, state: 'online' }));
  a.send(JSON.stringify({ t: 'hello', boards: boards('a') }));
  b.send(JSON.stringify({ t: 'hello', boards: boards('b').reverse() }));
  await new Promise(r => setTimeout(r, 800));
  for (let round = 0; round < 30; round++) {
    const up = (p, online) => ({ t: 'state', updates: Array.from({ length: N }, (_, i) => ({ localId: p + i, online, state: online ? 'online' : 'offline' })) });
    const ua = up('a', round % 2 === 0), ub = up('b', round % 2 === 1); ub.updates.reverse();
    a.send(JSON.stringify(ua)); b.send(JSON.stringify(ub));
  }
  // last round: a offline, b online. Wait until both PCs' message queues have drained.
  const drained = () => Promise.all([...app.agents._conns.values()].map(k => k.queue));
  let rows = [];
  const t0 = Date.now();
  do {
    await new Promise(r => setTimeout(r, 300)); await drained();
    rows = (await db.tx(db.SYSTEM, c => c.query(`select d.identity, s.state, (select count(*)::int from br.device_reach r where r.device_id = d.id) reach
       from br.devices d left join br.device_state s on s.device_id = d.id where d.hospital_id = $1`, [h]))).rows;
  } while (Date.now() - t0 < 20000 && !(rows.length === N && rows.every(r => r.state === 'online')));
  console.log('    (settled in ' + (Date.now() - t0) + ' ms)');
  T('40 shared boards are 40 devices, each reached by both PCs', rows.length === N && rows.every(r => r.reach === 2));
  T('no update was lost to a deadlock (all online via the PC that still reaches them)', rows.every(r => r.state === 'online'), rows.filter(r => r.state !== 'online').length);
  T('no errors came back to either PC', errs.length === 0, errs.slice(0, 3));
  a.close(); b.close();
  await new Promise(r => app.server.close(r));
};
