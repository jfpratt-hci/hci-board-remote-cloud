'use strict';
// Every query runs inside a transaction that first says who is asking. Row level security in the
// database then decides what that actor may see or change. The service connects as br_app, which
// is not the table owner and has no BYPASSRLS, so there is no way around those rules from here.
const { Pool } = require('pg');
const { sslFor } = require('./migrate');

let pool = null;
// identity: the client ID of the Azure identity to sign in as (no password), or nothing for a URL with a password
function init(url, identity) {
  pool = new Pool(require('./aztoken').pgConfig(url, identity, { ssl: sslFor(url), max: 12, idleTimeoutMillis: 30000 }));
  pool.on('error', e => console.error('db pool', e.message));
  return pool;
}

// actor: { kind: 'user', userId, canLock } | { kind: 'agent', agentId } | { kind: 'system' }
// Two Board Remote PCs reporting on the same board at the same moment can make Postgres pick one
// transaction to cancel (a deadlock or serialization failure). That is safe to simply run again,
// because nothing outside the database happens until a transaction commits.
async function tx(actor, fn) {
  for (let i = 0; ; i++) {
    try { return await tx1(actor, fn); }
    catch (e) {
      if ((e.code === '40P01' || e.code === '40001') && i < 4) { await new Promise(r => setTimeout(r, 20 + Math.random() * 80 * (i + 1))); continue; }
      throw e;
    }
  }
}
async function tx1(actor, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('br.actor_kind', $1, true), set_config('br.user_id', $2, true), set_config('br.agent_id', $3, true), set_config('br.can_lock', $4, true)",
      [actor.kind, actor.userId || '', actor.agentId || '', actor.canLock ? 'on' : '']);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch (e2) { /* connection gone */ }
    throw e;
  } finally { c.release(); }
}

// One audit row, written in the same transaction as the change it records, so a change can never
// land without its record (or the record without the change).
function audit(c, actor, row) {
  return c.query('insert into br.audit_log (hospital_id, actor_kind, actor_user, actor_agent, device_id, action, details, origin, result) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [row.hospitalId || null, actor.kind, actor.kind === 'user' ? actor.userId : null, actor.kind === 'agent' ? actor.agentId : null,
     row.deviceId || null, row.action, row.details || {}, row.origin || (actor.kind === 'agent' ? 'agent' : 'cloud'), row.result || 'ok']);
}

const SYSTEM = Object.freeze({ kind: 'system' });
module.exports = { init, tx, audit, SYSTEM, get pool() { return pool; } };
