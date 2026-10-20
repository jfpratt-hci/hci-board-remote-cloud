'use strict';
// Signing in to Postgres with an Azure identity token instead of a password, against a stand in for
// the Container Apps identity endpoint. Local Postgres plays Azure by using the token as the password.
const http = require('http');
const { execSync } = require('child_process');
const az = require('../src/aztoken');
module.exports = async function (T) {
  let calls = 0, ttl = 3600, tok = { owner: 'TOK_OWNER_A', app: 'TOK_APP_A' };
  const srv = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    if (req.headers['x-identity-header'] !== 'hdr') { res.writeHead(401); return res.end('no'); }
    const t = tok[u.searchParams.get('client_id')];
    if (u.searchParams.get('resource') !== 'https://ossrdbms-aad.database.windows.net' || !t) { res.writeHead(400); return res.end('bad'); }
    res.writeHead(200); res.end(JSON.stringify({ access_token: t, expires_on: String(Math.floor(Date.now() / 1000) + ttl) }));
  });
  await new Promise(r => srv.listen(8098, r));
  const env = { IDENTITY_ENDPOINT: 'http://127.0.0.1:8098/msi/token', IDENTITY_HEADER: 'hdr' };
  T('gets a token for the right identity', await az.tokenFor('app', env) === 'TOK_APP_A');
  await Promise.all([1, 2, 3, 4, 5].map(() => az.tokenFor('app', env)));
  T('reuses the token instead of asking again', calls === 1, calls);
  let err = null; try { await az.tokenFor('nobody', env); } catch (e) { err = e; }
  T('an unknown identity fails clearly and is not cached', err && /400/.test(err.message) && !az._cache.has('nobody'));
  // a token near expiry is renewed
  az._cache.clear(); ttl = 60; tok.app = 'TOK_APP_B';
  await az.tokenFor('app', env); tok.app = 'TOK_APP_C';
  T('a token within 5 minutes of expiry is renewed', await az.tokenFor('app', env) === 'TOK_APP_C');
  // real connection: the URL has no password; the token must reach Postgres (pg would drop it from a connectionString)
  ttl = 3600; az._cache.clear(); tok.app = 'TOK_APP_REAL';
  // here: as the postgres OS user; in GitHub's runner: PGHOST/PGUSER/PGPASSWORD point at the service container
  const psql = s => execSync(process.env.PGHOST ? 'psql -q -v ON_ERROR_STOP=1 ' + s : 'su postgres -c ' + JSON.stringify('psql -q -v ON_ERROR_STOP=1 ' + s), { stdio: 'pipe' });
  psql("-c \"alter role br_app password 'TOK_APP_REAL'\"");
  try {
    const { Client } = require('pg');
    const saved = process.env.IDENTITY_ENDPOINT, savedH = process.env.IDENTITY_HEADER;
    Object.assign(process.env, env);
    const c = new Client(az.pgConfig('postgres://br_app@localhost/brtest', 'app', { ssl: false }));
    await c.connect();
    const who = (await c.query('select current_user u')).rows[0].u; await c.end();
    T('connects to Postgres with the token as br_app', who === 'br_app', who);
    tok.app = 'WRONG'; az._cache.clear();
    let bad = null; const c2 = new Client(az.pgConfig('postgres://br_app@localhost/brtest', 'app', { ssl: false }));
    try { await c2.connect(); await c2.end(); } catch (e) { bad = e; }
    T('a wrong token is refused by Postgres', bad && /password authentication failed/.test(bad.message), bad && bad.message);
    if (saved === undefined) delete process.env.IDENTITY_ENDPOINT; else process.env.IDENTITY_ENDPOINT = saved;
    if (savedH === undefined) delete process.env.IDENTITY_HEADER; else process.env.IDENTITY_HEADER = savedH;
  } finally {
    psql("-c \"alter role br_app password 'apppw'\"");
    srv.close();
  }
  T('without an identity, a normal URL with a password is used as is', az.pgConfig('postgres://u:p@h/d', null, {}).connectionString === 'postgres://u:p@h/d');
};
