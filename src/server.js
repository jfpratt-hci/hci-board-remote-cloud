'use strict';
/* HCI ONE Board Remote Cloud
   Environment:
     DATABASE_URL          postgres://br_app:...@host/db?sslmode=require   (the service role)
     DATABASE_URL_OWNER    postgres://br_owner:...  (only to run migrations at start; optional)
     PUBLIC_URL            https://boardremote.hci-tv.com
     ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET   the multi tenant app registration
     HCI_TENANT_ID         HCI's own Microsoft tenant
     SESSION_SECRET        long random string
     BR_BOOTSTRAP_ADMIN    email of the first HCI admin (only used while no HCI admin exists)
     PORT                  default 8080
     BR_DEV_LOGIN=1        local testing only: sign in by email from this machine */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const Auth = require('./auth');
const Agents = require('./agents');
const Api = require('./api');

const VERSION = '0.1.0';
const PUB = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://login.microsoftonline.com"
};

function start(env) {
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const need = ['DATABASE_URL', 'PUBLIC_URL', 'SESSION_SECRET'].concat(env.BR_DEV_LOGIN === '1' ? [] : ['ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'HCI_TENANT_ID']);
  const missing = need.filter(k => !env[k]);
  if (missing.length) throw new Error('Missing settings: ' + missing.join(', '));
  if (/^https:/.test(env.PUBLIC_URL)) SEC['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  if (env.BR_DEV_LOGIN === '1' && /^https:/.test(env.PUBLIC_URL)) throw new Error('BR_DEV_LOGIN is for local testing and cannot run on a public https address.');
  db.init(env.DATABASE_URL, env.DB_IDENTITY_APP);
  const auth = Auth.create({ publicUrl: env.PUBLIC_URL, clientId: env.ENTRA_CLIENT_ID || 'dev', clientSecret: env.ENTRA_CLIENT_SECRET || '', hciTenantId: env.HCI_TENANT_ID || '',
    sessionSecret: env.SESSION_SECRET, bootstrapAdmin: env.BR_BOOTSTRAP_ADMIN || '', devLogin: env.BR_DEV_LOGIN === '1' });
  const agents = Agents.create(log);
  const api = Api.create(agents);

  const json = (res, code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SEC)); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > 1024 * 1024) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { if (!n) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  const sameOrigin = req => { const o = req.headers.origin; return !o || o === new URL(env.PUBLIC_URL).origin; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/healthz') return json(res, 200, { ok: true, version: VERSION });
      if (p.startsWith('/auth/')) { if (await auth.handle(req, res, url)) return; return json(res, 404, { ok: false }); }
      if (p === '/api/agent/enroll' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, await agents.enroll(b.code, b.pcName, b.version));
      }
      if (p.startsWith('/api/')) {
        const A = await auth.actorFor(req);
        if (!A) return json(res, 401, { ok: false, message: 'Please sign in.', signIn: '/auth/login' });
        if (req.method !== 'GET' && (req.headers['x-br'] !== '1' || !sameOrigin(req))) return json(res, 403, { ok: false, message: 'Forbidden' });
        // live updates: a nudge (no data) when this hospital's fleet changes; the page then refetches
        // through the normal API, so what it sees is still decided by row level security
        const ev = req.method === 'GET' && /^\/api\/hospitals\/([0-9a-f-]{36})\/events$/.exec(p);
        if (ev) {
          const can = await db.tx(A, c => c.query('select 1 from br.hospitals where id = $1', [ev[1]])).then(r => r.rowCount);
          if (!can) return json(res, 404, { ok: false, message: 'Unknown hospital.' });
          res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }, SEC));
          res.write('retry: 5000\n\n');
          let pend = null;
          const off = agents.onEvent((h, e) => {
            if (h !== ev[1]) return;
            if (e.t === 'command') return res.write('event: command\ndata: ' + JSON.stringify({ id: e.id }) + '\n\n');
            if (!pend) pend = setTimeout(() => { pend = null; res.write('event: fleet\ndata: {}\n\n'); }, 300);
          });
          const ping = setInterval(() => res.write(': ping\n\n'), 25000);
          req.on('close', () => { off(); clearInterval(ping); if (pend) clearTimeout(pend); });
          return;
        }
        const body = req.method === 'GET' ? {} : await readBody(req);
        const out = await api.handle(req, res, url, A, body);
        if (out === undefined) return json(res, 404, { ok: false, message: 'Not found' });
        return json(res, out.ok === false ? 400 : 200, out);
      }
      // the web app: static files, and index.html for its own routes
      let f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : p));
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
      res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }, SEC));
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      const st = e.status || (/row-level security|insufficient_privilege|locked by HCI|Only HCI/.test(e.message) ? 403 : 500);
      if (st === 500) log('error', req.method, p, e.stack || e.message);
      const msg = st === 500 ? 'Something went wrong on the server.' : e.message.replace(/^new row violates row-level security policy.*$/, 'You do not have access to do that.');
      json(res, st, { ok: false, message: msg });
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname === '/agent') agents.upgrade(req, socket, head).catch(e => { log('upgrade', e.message); socket.destroy(); });
    else socket.destroy();
  });
  return { server, agents, auth, log };
}

module.exports = { start, VERSION };
if (require.main === module) {
  (async () => {
    if (process.env.DATABASE_URL_OWNER) await require('./migrate').migrate(process.env.DATABASE_URL_OWNER, null, process.env.DB_IDENTITY_OWNER);
    const { server, log } = start(process.env);
    const port = Number(process.env.PORT) || 8080;
    server.listen(port, () => log('HCI ONE Board Remote Cloud ' + VERSION + ' on port ' + port));
    // Azure stops a replica with SIGTERM: stop taking new work, let open requests finish, then exit
    process.on('SIGTERM', () => { log('stopping'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
  })().catch(e => { console.error(e.message); process.exit(1); });
}
