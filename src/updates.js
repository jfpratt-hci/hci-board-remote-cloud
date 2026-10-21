'use strict';
/* Board Remote program updates.
   HCI admin uploads a signed package (the zip CI builds, plus its .sig). The cloud checks the
   signature against HCI's release public key before it accepts it, keeps it as a draft, and HCI
   moves it to pilot, then everyone, or pauses it.
   Each Board Remote PC asks GET /api/agent/update with its own agent credential. The answer depends
   on its hospital: ring (pilot or normal) picks the release; mode (auto or approve) decides when.
     auto     install in the overnight window (02:00 to 05:00 on that PC), or at once if approved
     approve  wait until someone approves that PC (or the whole hospital) in the web app
   The PC downloads the package, checks the sha256 and HCI's signature itself, installs it beside
   the running version, checks it starts, and rolls back on its own if it does not. It reports each
   step to POST /api/agent/update-status, which lands in the audit log. */
const crypto = require('crypto');
const db = require('./db');

const SIGN_PREFIX = 'HCI-ONE-BOARD-REMOTE|';
const VER = /^\d+\.\d+\.\d+$/;
const STATES = ['waiting', 'scheduled', 'downloading', 'installing', 'done', 'failed', 'rolled_back'];
const bad = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

function publicKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/BEGIN PUBLIC KEY/.test(s)) return crypto.createPublicKey(s);
  // base64 of the 32 raw ed25519 bytes
  const k = Buffer.from(s, 'base64');
  if (k.length !== 32) throw new Error('BR_RELEASE_PUBKEY must be a PEM public key or 32 base64 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), k]), format: 'der', type: 'spki' });
}
function verify(key, version, sha, sigB64) {
  if (!key) return false;
  try { return crypto.verify(null, Buffer.from(SIGN_PREFIX + version + '|' + sha), key, Buffer.from(String(sigB64 || '').trim(), 'base64')); }
  catch (e) { return false; }
}

function create(opts) {
  const key = publicKey(opts.publicKey);
  const agents = opts.agents;

  /* ---------- web app (HCI admin) ---------- */
  async function upload(A, b) {
    if (!A.user || A.user.hciRole !== 'hci_admin') throw bad(403, 'Only an HCI admin can add a Board Remote release.');
    if (!key) throw bad(400, 'The release key is not set up on the cloud (BR_RELEASE_PUBKEY).');
    const version = clip(b.version, 20);
    if (!VER.test(version)) throw bad(400, 'The version looks like 2.1.0.');
    const pkg = Buffer.from(String(b.packageBase64 || ''), 'base64');
    if (pkg.length < 100 || pkg.readUInt32LE(0) !== 0x04034b50) throw bad(400, 'That is not a Board Remote package (a .zip from the build).');
    const sha = crypto.createHash('sha256').update(pkg).digest('hex');
    const sig = clip(b.signature, 200);
    if (!verify(key, version, sha, sig)) throw bad(400, 'The signature does not match. Use the .zip and the .sig from the same build, and check the version number.');
    return db.tx(A, async c => {
      const r = (await c.query('insert into br.br_releases (version, notes, sha256, signature, size, package, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [version, clip(b.notes, 2000), sha, sig, pkg.length, pkg, A.userId]).catch(e => { if (/unique/.test(e.message)) throw bad(400, 'Version ' + version + ' is already uploaded.'); throw e; })).rows[0];
      await db.audit(c, A, { action: 'release.uploaded', details: { version, sha256: sha, size: pkg.length } });
      return { ok: true, id: r.id, message: 'Board Remote ' + version + ' uploaded as a draft. Send it to the pilot hospitals when ready.' };
    });
  }
  async function list(A) {
    const r = await db.tx(A, async c => {
      const releases = (await c.query(`select r.id, r.version, r.status, r.notes, r.sha256, r.size, r.created_at, r.status_at, u.name created_by_name,
          (select count(*)::int from br.agents a where a.version = r.version and a.revoked_at is null) on_version
        from br.br_releases r left join br.users u on u.id = r.created_by`)).rows.sort((a, b) => cmpVer(b.version, a.version));
      const pcs = (await c.query(`select a.id, a.name, a.pc_name, a.version, a.service, a.update_state, a.update_version, a.update_detail, a.update_at, h.name hospital, h.update_mode, h.update_ring
        from br.agents a join br.hospitals h on h.id = a.hospital_id where a.revoked_at is null order by h.name, a.name`)).rows;
      return { releases, pcs: pcs.map(p => Object.assign(p, { online: agents.isOnline(p.id) })) };
    });
    return Object.assign({ ok: true, canPublish: !!(A.user && A.user.hciRole === 'hci_admin') }, r);
  }
  async function setStatus(A, id, status) {
    if (['draft', 'pilot', 'everyone', 'paused'].indexOf(status) < 0) throw bad(400, 'Unknown status.');
    return db.tx(A, async c => {
      const r = (await c.query('update br.br_releases set status = $2, status_at = now() where id = $1 returning version', [id, status])).rows[0];
      if (!r) throw bad(403, 'Only an HCI admin can change a release.');
      await db.audit(c, A, { action: 'release.' + status, details: { version: r.version } });
      const say = { draft: 'back to draft', pilot: 'sent to the pilot hospitals', everyone: 'sent to every hospital', paused: 'paused. No PC will install it.' };
      return { ok: true, message: 'Board Remote ' + r.version + ' ' + say[status] + (status === 'pilot' || status === 'everyone' ? '. PCs on automatic install it tonight between 2 and 5 am.' : '') };
    });
  }
  async function setHospital(A, id, b) {
    const mode = b.updateMode, ring = b.updateRing;
    if (mode !== undefined && ['auto', 'approve'].indexOf(mode) < 0) throw bad(400, 'Unknown update mode.');
    if (ring !== undefined && ['pilot', 'normal'].indexOf(ring) < 0) throw bad(400, 'Unknown ring.');
    return db.tx(A, async c => {
      const r = await c.query('update br.hospitals set update_mode = coalesce($2, update_mode), update_ring = coalesce($3, update_ring) where id = $1 returning name, update_mode, update_ring', [id, mode || null, ring || null]);
      if (!r.rowCount) throw bad(403, 'Only HCI can change how a hospital updates.');
      await db.audit(c, A, { hospitalId: id, action: 'hospital.update_settings', details: { mode, ring } });
      const h = r.rows[0];
      return { ok: true, message: h.name + ': ' + (h.update_mode === 'auto' ? 'updates install automatically overnight' : 'each update waits for approval') + (h.update_ring === 'pilot' ? ', and it gets new versions first (pilot).' : '.') };
    });
  }
  // Approve one PC, or every PC in a hospital, for the release it should be on. It installs at once.
  async function approve(A, b) {
    return db.tx(A, async c => {
      const where = b.agentId ? 'a.id = $1' : 'a.hospital_id = $1';
      const rows = (await c.query(`update br.agents a set approved_release = br.target_release(a.hospital_id), approved_by = $2
          where ${where} and a.revoked_at is null and br.target_release(a.hospital_id) is not null returning a.id, a.hospital_id, a.version,
          (select version from br.br_releases where id = br.target_release(a.hospital_id)) target`, [b.agentId || b.hospitalId, A.userId])).rows;
      if (!rows.length) throw bad(400, 'There is no release to approve yet.');
      for (const r of rows) await db.audit(c, A, { hospitalId: r.hospital_id, action: 'update.approved', details: { agent: r.id, from: r.version, to: r.target } });
      return { ok: true, message: 'Approved. ' + (rows.length === 1 ? 'That PC installs' : rows.length + ' PCs install') + ' Board Remote ' + rows[0].target + ' within a few minutes.' };
    });
  }

  /* ---------- Board Remote PCs ---------- */
  async function check(a, q) {
    const have = clip(q.get('version'), 20), service = q.get('service') === '1';
    const actor = { kind: 'agent', agentId: a.id };
    return db.tx(actor, async c => {
      const x = (await c.query(`select h.update_mode mode, ag.approved_release, r.id, r.version, r.sha256, r.signature, r.size, r.notes
        from br.agents ag join br.hospitals h on h.id = ag.hospital_id left join br.br_releases r on r.id = br.target_release(ag.hospital_id)
        where ag.id = $1`, [a.id])).rows[0];
      await c.query('update br.agents set version = case when $2 <> \'\' then $2 else version end, service = $3, last_seen = now() where id = $1', [a.id, have, service]);
      if (!x || !x.id || !VER.test(have) || cmpVer(x.version, have) <= 0) {
        if (x && x.id && VER.test(have) && cmpVer(x.version, have) <= 0) await c.query("update br.agents set update_state = case when update_state in ('waiting', 'scheduled') then '' else update_state end where id = $1", [a.id]);
        return { ok: true, update: null };
      }
      const approved = x.approved_release === x.id;
      if (x.mode === 'approve' && !approved) {
        await c.query("update br.agents set update_state = 'waiting', update_version = $2, update_detail = 'Waiting for approval', update_at = now() where id = $1 and (update_state <> 'waiting' or update_version <> $2)", [a.id, x.version]);
        return { ok: true, update: null, waiting: x.version };
      }
      return { ok: true, update: { id: x.id, version: x.version, sha256: x.sha256, signature: x.signature, size: x.size, notes: x.notes, now: approved, window: [2, 5] } };
    });
  }
  async function file(a, id) {
    const r = (await db.tx({ kind: 'agent', agentId: a.id }, c => c.query('select version, package from br.br_releases where id = $1 and id = br.target_release($2)', [id, a.hospital_id]))).rows[0];
    return r || null;
  }
  async function status(a, b) {
    const state = String(b.state || '');
    if (STATES.indexOf(state) < 0) throw bad(400, 'Unknown state.');
    const version = clip(b.version, 20), detail = clip(b.detail, 300);
    await db.tx({ kind: 'agent', agentId: a.id }, async c => {
      await c.query('update br.agents set update_state = $2, update_version = $3, update_detail = $4, update_at = now(), version = case when $2 = \'done\' then $3 else version end, approved_release = case when $2 in (\'done\', \'rolled_back\', \'failed\') then null else approved_release end where id = $1',
        [a.id, state, version, detail]);
      if (['done', 'failed', 'rolled_back'].indexOf(state) >= 0) await db.audit(c, { kind: 'agent', agentId: a.id }, { hospitalId: a.hospital_id, action: 'update.' + state, result: state === 'done' ? 'ok' : 'failed', details: { version, detail } });
    });
    agents.emit(a.hospital_id, { t: 'fleet' });
    return { ok: true };
  }

  return { upload, list, setStatus, setHospital, approve, check, file, status, verify: (v, s, g) => verify(key, v, s, g) };
}

module.exports = { create, publicKey, verify, cmpVer, SIGN_PREFIX };
