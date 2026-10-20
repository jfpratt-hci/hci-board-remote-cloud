'use strict';
/* Microsoft sign in (Entra ID, OpenID Connect, authorization code with PKCE) and sessions.
   One multi tenant app registration serves everyone:
     HCI staff sign in from HCI's own tenant (HCI_TENANT_ID).
     Hospital IT sign in with their hospital's own Microsoft account; the hospital's tenant is
     registered on the hospital (hospitals.entra_tenant_id).
     Dealers sign in from their company's tenant, written on their invite.
   Nobody gets in without an invite (a user row with a membership), except HCI staff, who land with
   no access until an HCI admin gives them a role, and the first admin named in BR_BOOTSTRAP_ADMIN.
   An invite is matched by email only once, at first sign in, and only from a tenant we trust for
   that person. After that the account is matched by its Microsoft object id, never by email.
   Passwords are never seen or stored here, and MFA is enforced by each tenant's own policy. */
const crypto = require('crypto');
const https = require('https');
const db = require('./db');

const AUTHORITY = 'https://login.microsoftonline.com';
const SESSION_HOURS = 12, IDLE_HOURS = 8;
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = v => crypto.createHash('sha256').update(v).digest();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function create(cfg) {
  // cfg: { publicUrl, clientId, clientSecret, hciTenantId, sessionSecret, bootstrapAdmin, devLogin, fetchJson }
  const secure = /^https:/.test(cfg.publicUrl);
  const redirectUri = cfg.publicUrl.replace(/\/$/, '') + '/auth/callback';
  const key = sha256('br-cookie:' + cfg.sessionSecret);
  const fetchJson = cfg.fetchJson || httpsJson;

  /* ---------- small signed cookie that carries the login state across the Microsoft redirect ---------- */
  function seal(obj) { const body = b64u(JSON.stringify(obj)); return body + '.' + b64u(crypto.createHmac('sha256', key).update(body).digest()); }
  function unseal(v) {
    const [body, mac] = String(v || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', key).update(body).digest();
    const got = unb64u(mac);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    try { const o = JSON.parse(unb64u(body).toString()); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
  }
  const cookie = (name, value, maxAgeS) => name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') + '; Max-Age=' + maxAgeS;

  /* ---------- id token checking ---------- */
  let jwks = { at: 0, keys: [] };
  async function keyFor(kid) {
    if (!jwks.keys.some(k => k.kid === kid) || Date.now() - jwks.at > 24 * 3600000) {
      const j = await fetchJson(AUTHORITY + '/common/discovery/v2.0/keys');
      jwks = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
    }
    const k = jwks.keys.find(x => x.kid === kid);
    if (!k) throw new Error('Unknown signing key');
    return crypto.createPublicKey({ key: k, format: 'jwk' });
  }
  async function verifyIdToken(tok, nonce) {
    const [h, p, s] = String(tok || '').split('.');
    if (!h || !p || !s) throw new Error('Malformed token');
    const head = JSON.parse(unb64u(h).toString());
    if (head.alg !== 'RS256') throw new Error('Unexpected algorithm');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), await keyFor(head.kid), unb64u(s));
    if (!ok) throw new Error('Bad signature');
    const c = JSON.parse(unb64u(p).toString());
    const now = Math.floor(Date.now() / 1000);
    if (c.aud !== cfg.clientId) throw new Error('Token is for another app');
    if (!GUID.test(c.tid || '') || c.iss !== AUTHORITY + '/' + c.tid + '/v2.0') throw new Error('Unexpected issuer');
    if (!(c.exp > now - 120) || (c.nbf && c.nbf > now + 120)) throw new Error('Token expired');
    if (c.nonce !== nonce) throw new Error('Sign in did not match this browser');
    if (!c.oid) throw new Error('No account id');
    return { tid: c.tid.toLowerCase(), oid: c.oid, email: String(c.email || c.preferred_username || '').toLowerCase(), name: c.name || '' };
  }

  /* ---------- who may sign in ---------- */
  async function admit(idt) {
    return db.tx(db.SYSTEM, async c => {
      const one = (sql, p) => c.query(sql, p).then(r => r.rows[0]);
      const isHciTenant = cfg.hciTenantId && idt.tid === cfg.hciTenantId.toLowerCase();
      let u = await one('select * from br.users where entra_tid = $1 and entra_oid = $2', [idt.tid, idt.oid]);
      if (!u && idt.email) {
        // first sign in: match the invite by email, but only from a tenant trusted for this person
        const inv = await one('select * from br.users where lower(email) = $1 and entra_oid is null', [idt.email]);
        if (inv) {
          const trusted = inv.entra_tid ? inv.entra_tid.toLowerCase() === idt.tid
            : (inv.is_hci ? isHciTenant : !!(await one(`select 1 from br.memberships m join br.hospitals h on h.id = m.hospital_id
                                                         where m.user_id = $1 and lower(h.entra_tenant_id) = $2`, [inv.id, idt.tid])));
          if (trusted) u = await one('update br.users set entra_tid = $1, entra_oid = $2, name = case when name = \'\' then $3 else name end where id = $4 returning *', [idt.tid, idt.oid, idt.name, inv.id]);
        }
      }
      if (!u && isHciTenant) {
        const bootstrap = cfg.bootstrapAdmin && idt.email === cfg.bootstrapAdmin.toLowerCase()
          && !(await one("select 1 from br.memberships where role = 'hci_admin'"));
        u = await one('insert into br.users (email, name, entra_tid, entra_oid, is_hci) values ($1, $2, $3, $4, true) on conflict do nothing returning *', [idt.email, idt.name, idt.tid, idt.oid]);
        if (!u) throw Object.assign(new Error('An account with this email already exists from another Microsoft tenant. Ask an HCI admin.'), { code: 'conflict' });
        if (bootstrap) await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, null, 'hci_admin')", [u.id]);
        await db.audit(c, db.SYSTEM, { action: bootstrap ? 'user.bootstrap_admin' : 'user.first_sign_in', details: { email: idt.email } });
      }
      if (!u) throw Object.assign(new Error('You have not been invited to HCI ONE Board Remote. Ask your hospital IT lead or HCI to invite ' + (idt.email || 'your account') + '.'), { code: 'not_invited' });
      if (u.disabled) throw Object.assign(new Error('This account is turned off. Ask an HCI admin.'), { code: 'disabled' });
      // an account is only for the tenant it first signed in from; another tenant claiming it is refused
      if (u.entra_tid && u.entra_tid !== idt.tid) throw Object.assign(new Error('This account belongs to another Microsoft tenant.'), { code: 'tenant' });
      await c.query('update br.users set last_login = now(), name = case when $2 <> \'\' then $2 else name end where id = $1', [u.id, idt.name]);
      return u;
    });
  }

  async function startSession(res, user, req) {
    const token = crypto.randomBytes(32);
    await db.tx(db.SYSTEM, async c => {
      await c.query("delete from br.sessions where user_id = $1 and (expires_at < now() or last_seen < now() - interval '" + IDLE_HOURS + " hours')", [user.id]);
      await c.query("insert into br.sessions (user_id, token_hash, expires_at, ip, ua) values ($1, $2, now() + interval '" + SESSION_HOURS + " hours', $3, $4)",
        [user.id, sha256(token), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200)]);
      await db.audit(c, db.SYSTEM, { action: 'user.sign_in', details: { user: user.id, email: user.email, ip: clientIp(req) } });
    });
    return cookie('br_s', b64u(token), SESSION_HOURS * 3600);
  }

  /* ---------- the current user for a request ---------- */
  async function actorFor(req) {
    const tok = parseCookies(req.headers.cookie).br_s;
    if (!tok) return null;
    return db.tx(db.SYSTEM, async c => {
      const r = await c.query(`update br.sessions s set last_seen = now() from br.users u
         where s.token_hash = $1 and u.id = s.user_id and s.expires_at > now() and s.last_seen > now() - interval '${IDLE_HOURS} hours' and not u.disabled
         returning u.id, u.email, u.name, u.is_hci`, [sha256(unb64u(tok))]);
      const u = r.rows[0];
      if (!u) return null;
      const m = (await c.query('select hospital_id, role from br.memberships where user_id = $1', [u.id])).rows;
      const hciRole = u.is_hci && m.find(x => !x.hospital_id) ? m.find(x => !x.hospital_id && x.role === 'hci_admin') ? 'hci_admin' : 'hci_tech' : null;
      return { kind: 'user', userId: u.id, canLock: !!hciRole, user: { id: u.id, email: u.email, name: u.name, isHci: u.is_hci, hciRole, memberships: m } };
    });
  }

  /* ---------- routes ---------- */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p === '/auth/login') {
      const st = { state: b64u(crypto.randomBytes(16)), nonce: b64u(crypto.randomBytes(16)), verifier: b64u(crypto.randomBytes(32)), next: safeNext(url.searchParams.get('next')), exp: Date.now() + 10 * 60000 };
      const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: 'openid profile email',
        state: st.state, nonce: st.nonce, code_challenge: b64u(sha256(st.verifier)), code_challenge_method: 'S256', prompt: 'select_account' });
      res.writeHead(302, { Location: AUTHORITY + '/organizations/oauth2/v2.0/authorize?' + q, 'Set-Cookie': cookie('br_oidc', seal(st), 600), 'Cache-Control': 'no-store' });
      return res.end(), true;
    }
    if (p === '/auth/callback') {
      const st = unseal(parseCookies(req.headers.cookie).br_oidc);
      const clear = cookie('br_oidc', '', 0);
      if (url.searchParams.get('error')) return page(res, 'Microsoft sign in was not finished', url.searchParams.get('error_description') || url.searchParams.get('error'), clear), true;
      if (!st || st.state !== url.searchParams.get('state')) return page(res, 'Sign in expired', 'Please start the sign in again.', clear), true;
      try {
        const tok = await postForm(AUTHORITY + '/organizations/oauth2/v2.0/token', { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code',
          code: String(url.searchParams.get('code') || ''), redirect_uri: redirectUri, code_verifier: st.verifier, scope: 'openid profile email' }, cfg.postForm);
        if (!tok.id_token) throw new Error(tok.error_description || 'Microsoft did not return a sign in token');
        const idt = await verifyIdToken(tok.id_token, st.nonce);
        const u = await admit(idt);
        const sc = await startSession(res, u, req);
        res.writeHead(302, { Location: st.next, 'Set-Cookie': [clear, sc], 'Cache-Control': 'no-store' });
        return res.end(), true;
      } catch (e) {
        return page(res, 'You could not be signed in', e.message, clear), true;
      }
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      const tok = parseCookies(req.headers.cookie).br_s;
      if (tok) await db.tx(db.SYSTEM, c => c.query('delete from br.sessions where token_hash = $1', [sha256(unb64u(tok))]));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie('br_s', '', 0) });
      return res.end('{"ok":true}'), true;
    }
    // Local testing only: never on a public address, and only from this machine.
    if (p === '/auth/dev' && cfg.devLogin) {
      if (!isLoopback(req) || secure) return page(res, 'Not available', 'Developer sign in only works on this computer.'), true;
      const email = String(url.searchParams.get('email') || '').toLowerCase();
      const u = await db.tx(db.SYSTEM, c => c.query('select * from br.users where lower(email) = $1 and not disabled', [email])).then(r => r.rows[0]);
      if (!u) return page(res, 'No such user', email), true;
      const sc = await startSession(res, u, req);
      res.writeHead(302, { Location: safeNext(url.searchParams.get('next')), 'Set-Cookie': sc });
      return res.end(), true;
    }
    return false;
  }

  return { handle, actorFor, verifyIdToken, admit, _seal: seal, _unseal: unseal };
}

/* ---------- helpers ---------- */
function parseCookies(h) { const o = {}; String(h || '').split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); }); return o; }
function safeNext(n) { n = String(n || '/'); return /^\/(?!\/)[\w\-./?=&#%]*$/.test(n) ? n : '/'; }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60); }
function isLoopback(req) { const a = req.socket.remoteAddress || ''; return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !req.headers['x-forwarded-for']; }
function page(res, title, text, setCookie) {
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }; if (setCookie) h['Set-Cookie'] = setCookie;
  res.writeHead(200, h);
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Board Remote</title><body style="font:500 15px/1.5 Segoe UI,system-ui,sans-serif;background:#F2EFE9;color:#1E1C19;display:grid;place-items:center;min-height:100vh;margin:0"><div style="background:#fff;border-radius:16px;padding:28px 32px;max-width:480px"><div style="font-size:11px;font-weight:800;letter-spacing:.16em;color:#7A766F">HCI ONE BOARD REMOTE</div><h1 style="font-size:20px;margin:6px 0 10px">' + esc(title) + '</h1><p style="margin:0 0 18px;color:#3A3733">' + esc(text) + '</p><a href="/auth/login" style="display:inline-block;background:#1E1C19;color:#fff;padding:10px 16px;border-radius:12px;font-weight:700;text-decoration:none">Sign in with Microsoft</a></div></body>');
}
function httpsJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, r => { let d = ''; r.on('data', x => { d += x; }); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Bad answer from Microsoft')); } }); })
      .on('error', reject).on('timeout', function () { this.destroy(new Error('Microsoft did not answer')); });
  });
}
function postForm(url, form, override) {
  if (override) return override(url, form);
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let d = ''; res.on('data', x => { d += x; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Bad answer from Microsoft')); } });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('Microsoft did not answer'))); r.end(body);
  });
}

module.exports = { create, parseCookies, sha256, b64u, unb64u };
