'use strict';
// Applies db/migrations/*.sql in order, each in its own transaction, as the owner role.
// DATABASE_URL_OWNER=postgres://br_owner:...@host/db node src/migrate.js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function migrate(url, log, identity) {
  log = log || console.log;
  const c = new Client(require('./aztoken').pgConfig(url, identity, { ssl: sslFor(url) }));
  await c.connect();
  try {
    const have = new Set();
    const t = await c.query("select to_regclass('br.schema_migrations') as t");
    if (t.rows[0].t) (await c.query('select version from br.schema_migrations')).rows.forEach(r => have.add(r.version));
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter(f => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
    let n = 0;
    for (const f of files) {
      const v = f.replace(/\.sql$/, '');
      if (have.has(v)) continue;
      // 004_reports shipped without recording itself: a database that already has its table is marked done, not run again
      if (v === '004_reports' && (await c.query("select to_regclass('br.state_log') as t")).rows[0].t) {
        await c.query('insert into br.schema_migrations (version) values ($1) on conflict do nothing', [v]); log('recorded ' + v + ' (already applied)'); continue;
      }
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('insert into br.schema_migrations (version) values ($1) on conflict do nothing', [v]);   // every file is recorded, whether or not it records itself
        await c.query('commit'); n++; log('applied ' + v);
      }
      catch (e) { await c.query('rollback'); throw new Error(v + ': ' + e.message); }
    }
    if (!n) log('database is up to date');
    return n;
  } finally { await c.end(); }
}
// Azure Database for PostgreSQL requires TLS; a local database does not have it.
function sslFor(url) { return /sslmode=disable|@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: true }; }

module.exports = { migrate, sslFor };
if (require.main === module) {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) { console.error('Set DATABASE_URL_OWNER to the br_owner connection string.'); process.exit(1); }
  migrate(url, null, process.env.DB_IDENTITY_OWNER).catch(e => { console.error(e.message); process.exit(1); });
}
