'use strict';
// Proves the database rules themselves, as the service role: tenant isolation, roles, the HCI
// location lock, and the append only audit log.
const db = require('../src/db');
module.exports = async function (T, url) {
  db.init(url);
  const S = db.SYSTEM;
  // two hospitals, an HCI admin, an HCI tech, a Goshen IT person, a dealer for Ball only, and an agent per hospital
  const ids = await db.tx(S, async c => {
    const q = (sql, p) => c.query(sql, p).then(r => r.rows[0]);
    const g = await q("insert into br.hospitals (name) values ('Goshen Health') returning id");
    const b = await q("insert into br.hospitals (name) values ('Ball Health') returning id");
    const admin = await q("insert into br.users (email, name, is_hci) values ('admin@hci-tv.com', 'Admin', true) returning id");
    const tech = await q("insert into br.users (email, name, is_hci) values ('tech@hci-tv.com', 'Tech', true) returning id");
    const it = await q("insert into br.users (email, name) values ('it@goshenhealth.com', 'Goshen IT') returning id");
    const dealer = await q("insert into br.users (email, name) values ('dealer@pavion.com', 'Dealer') returning id");
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin'), ($2, null, 'hci_tech'), ($3, $5, 'hospital_it'), ($4, $6, 'dealer')", [admin.id, tech.id, it.id, dealer.id, g.id, b.id]);
    const ag = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Goshen PC', '\\x00') returning id", [g.id]);
    const ab = await q("insert into br.agents (hospital_id, name, credential_hash) values ($1, 'Ball PC', '\\x00') returning id", [b.id]);
    const dg = await q("insert into br.devices (hospital_id, identity, kind, room) values ($1, 'aa:bb:cc:00:00:01', 'wb', '401') returning id", [g.id]);
    await c.query("insert into br.devices (hospital_id, identity, kind, room) values ($1, 'aa:bb:cc:00:00:99', 'wb', '101')", [b.id]);
    return { g: g.id, b: b.id, admin: admin.id, tech: tech.id, it: it.id, dealer: dealer.id, ag: ag.id, ab: ab.id, dg: dg.id };
  });
  const U = (id, lock) => ({ kind: 'user', userId: id, canLock: !!lock });
  const A = id => ({ kind: 'agent', agentId: id });
  const devs = actor => db.tx(actor, c => c.query('select room from br.devices order by room')).then(r => r.rows.map(x => x.room).join(','));
  const fails = async (actor, sql, p, re) => { try { await db.tx(actor, c => c.query(sql, p)); return false; } catch (e) { return re ? re.test(e.message) : true; } };

  T('nobody set: sees nothing', (await devs({ kind: 'none' })) === '');
  T('Goshen IT sees only Goshen', (await devs(U(ids.it))) === '401');
  T('dealer for Ball sees only Ball', (await devs(U(ids.dealer))) === '101');
  T('HCI tech sees every hospital', (await devs(U(ids.tech))) === '101,401');
  T('Goshen agent sees only Goshen', (await devs(A(ids.ag))) === '401');
  T('Goshen IT cannot read Ball even by id', (await db.tx(U(ids.it), c => c.query('select count(*)::int n from br.devices where hospital_id = $1', [ids.b]))).rows[0].n === 0);
  T('Goshen IT cannot write into Ball', await fails(U(ids.it), "insert into br.devices (hospital_id, identity) values ($1, 'x')", [ids.b], /row-level security/));
  T('Goshen agent cannot see the Ball agent', (await db.tx(A(ids.ag), c => c.query('select count(*)::int n from br.agents'))).rows[0].n === 1);
  T('Goshen IT cannot make anyone HCI admin', await fails(U(ids.it), "insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin')", [ids.it], /row-level security/));
  const newbie = (await db.tx(S, c => c.query("insert into br.users (email, name) values ('newbie@goshenhealth.com', 'New IT') returning id"))).rows[0].id;
  T('Goshen IT can add hospital IT to Goshen', !(await fails(U(ids.it), "insert into br.memberships (user_id, hospital_id, role) values ($1, $2, 'hospital_it')", [newbie, ids.g])));
  T('Goshen IT cannot add people to Ball', await fails(U(ids.it), "insert into br.memberships (user_id, hospital_id, role) values ($1, $2, 'hospital_it')", [ids.it, ids.b]));
  T('HCI tech cannot create HCI admins', await fails(U(ids.tech), "insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin')", [ids.it]));
  T('only HCI admin may add a hospital', await fails(U(ids.tech), "insert into br.hospitals (name) values ('X')", []) && !(await fails(U(ids.admin), "insert into br.hospitals (name) values ('Arrowhead')", [])));

  // the location lock
  const room = actor => db.tx(actor, c => c.query('select room, location_locked, locked_by from br.devices where id = $1', [ids.dg])).then(r => r.rows[0]);
  T('Goshen IT can move an unlocked board', !(await fails(U(ids.it), "update br.devices set room = '402' where id = $1", [ids.dg])));
  T('Goshen IT cannot lock', await fails(U(ids.it), 'update br.devices set location_locked = true where id = $1', [ids.dg], /Only HCI/));
  T('HCI tech locks it, and who is recorded', !(await fails(U(ids.tech, true), 'update br.devices set location_locked = true where id = $1', [ids.dg])) && (await room(S)).locked_by === ids.tech);
  T('locked: Goshen IT cannot change the room', await fails(U(ids.it), "update br.devices set room = '403' where id = $1", [ids.dg], /locked by HCI/));
  T('locked: the Goshen agent cannot change the room', await fails(A(ids.ag), "update br.devices set room = '403' where id = $1", [ids.dg], /locked by HCI/));
  T('locked: even HCI must unlock first', await fails(U(ids.tech, true), "update br.devices set room = '403' where id = $1", [ids.dg], /locked by HCI/));
  T('locked: other fields still update (model)', !(await fails(A(ids.ag), "update br.devices set model = 'RK3568' where id = $1", [ids.dg])));
  T('Goshen IT cannot unlock', await fails(U(ids.it), 'update br.devices set location_locked = false where id = $1', [ids.dg], /Only HCI/));
  await db.tx(U(ids.tech, true), async c => {
    await c.query('update br.devices set location_locked = false where id = $1', [ids.dg]);
    await c.query("update br.devices set room = '403' where id = $1", [ids.dg]);
    await c.query('update br.devices set location_locked = true where id = $1', [ids.dg]);
  });
  const r2 = await room(S);
  T('HCI unlock, change, relock works', r2.room === '403' && r2.location_locked);

  // the audit log
  await db.tx(U(ids.it), c => db.audit(c, U(ids.it), { hospitalId: ids.g, deviceId: ids.dg, action: 'test' }));
  T('audit rows are written', (await db.tx(U(ids.it), c => c.query("select count(*)::int n from br.audit_log where action = 'test'"))).rows[0].n === 1);
  T('audit rows cannot be edited', await fails(S, "update br.audit_log set action = 'x'", []));
  T('audit rows cannot be deleted', await fails(S, 'delete from br.audit_log', []));
  T('a user cannot write an audit row as someone else', await fails(U(ids.it), "insert into br.audit_log (hospital_id, actor_kind, actor_user, action) values ($1, 'user', $2, 'forged')", [ids.g, ids.tech]));
  T('Ball cannot read Goshen audit rows', (await db.tx(U(ids.dealer), c => c.query("select count(*)::int n from br.audit_log where action = 'test'"))).rows[0].n === 0);
  return ids;
};
