'use strict';
/* Signing in to Azure Database for PostgreSQL with the container's own Azure identity: no database
   password exists anywhere. Each connection gets a Microsoft token (valid about an hour) as its
   password. Tokens are cached and renewed 5 minutes before they expire.
   Container Apps provides IDENTITY_ENDPOINT and IDENTITY_HEADER; a VM uses the IMDS address. */
const http = require('http');
const RESOURCE = 'https://ossrdbms-aad.database.windows.net';
const cache = new Map();   // clientId -> { token, until, pending }

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers, timeout: 10000 }, res => {
      let d = ''; res.on('data', x => { d += x; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Azure identity answered ' + res.statusCode + ': ' + d.slice(0, 200)));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Azure identity gave no JSON.')); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('Azure identity did not answer.'))); r.on('error', reject);
  });
}

async function fetchToken(clientId, env) {
  const ep = env.IDENTITY_ENDPOINT, hdr = env.IDENTITY_HEADER;
  const q = 'resource=' + encodeURIComponent(RESOURCE) + (clientId ? '&client_id=' + encodeURIComponent(clientId) : '');
  const j = ep && hdr
    ? await fetchJson(ep + (ep.indexOf('?') >= 0 ? '&' : '?') + 'api-version=2019-08-01&' + q, { 'X-IDENTITY-HEADER': hdr })
    : await fetchJson('http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&' + q, { Metadata: 'true' });
  if (!j.access_token) throw new Error('Azure identity gave no token.');
  const exp = Number(j.expires_on) ? Number(j.expires_on) * 1000 : Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return { token: j.access_token, until: exp - 5 * 60000 };
}

function tokenFor(clientId, env) {
  env = env || process.env;
  const c = cache.get(clientId);
  if (c && c.token && Date.now() < c.until) return Promise.resolve(c.token);
  if (c && c.pending) return c.pending;
  const pending = fetchToken(clientId, env).then(t => { cache.set(clientId, t); return t.token; }, e => { cache.delete(clientId); throw e; });
  cache.set(clientId, Object.assign({}, c, { pending }));
  return pending;
}

// pg accepts a function for the password, called for every new connection. A connectionString would
// overwrite it (pg copies the URL's empty password over ours), so the URL is split into parts here.
function pgConfig(url, clientId, extra) {
  const base = Object.assign({}, extra);
  if (!clientId) return Object.assign(base, { connectionString: url });
  const c = require('pg-connection-string').parse(url);
  for (const k of ['host', 'port', 'database', 'user']) if (c[k]) base[k] = k === 'port' ? Number(c[k]) : c[k];
  base.password = () => tokenFor(clientId);
  return base;
}

module.exports = { tokenFor, pgConfig, _cache: cache };
