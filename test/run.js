'use strict';
// node test/run.js  (needs a local Postgres; recreates database brtest)
const { execSync } = require('child_process');
const path = require('path');
const { migrate } = require('../src/migrate');
let pass = 0, fail = 0;
const T = (name, ok, extra) => { if (ok) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
global.T = T;

(async () => {
  // here: as the postgres OS user; in GitHub's runner: PGHOST/PGUSER/PGPASSWORD point at the service container
  const psql = s => execSync(process.env.PGHOST ? 'psql -q -v ON_ERROR_STOP=1 ' + s : 'su postgres -c ' + JSON.stringify('psql -q -v ON_ERROR_STOP=1 ' + s), { stdio: 'pipe' });
  const db = require('../src/db');
  const only = process.argv[2];
  for (const name of ['db', 'auth', 'agent', 'stress', 'api', 'aztoken']) {
    if (only && only !== name) continue;
    let f; try { f = require('./' + name + '.test.js'); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') continue; throw e; }
    // each file gets a fresh database, built the same way production is: bootstrap, then migrations
    if (db.pool) await db.pool.end();
    psql("-c 'drop database if exists brtest' -c 'create database brtest'");
    psql("-d brtest -v owner_pw=ownerpw -v app_pw=apppw -f " + JSON.stringify(path.join(__dirname, '..', 'db', 'bootstrap.sql')));
    psql("-d brtest -c 'alter database brtest owner to br_owner'");
    await migrate('postgres://br_owner:ownerpw@localhost/brtest', () => {});
    console.log('\n' + name);
    await f(T, 'postgres://br_app:apppw@localhost/brtest');
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
