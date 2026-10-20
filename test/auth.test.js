'use strict';
// Sign in: a fake Microsoft that signs real RS256 tokens, so the signature, issuer, audience, nonce
// and tenant checks are all exercised, plus who gets admitted.
const crypto = require('crypto');
const db = require('../src/db');
const A = require('../src/auth');
module.exports = async function (T, url) {
  db.init(url);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', use: 'sig', alg: 'RS256' });
  const HCI = '11111111-1111-1111-1111-111111111111', GOSHEN = '22222222-2222-2222-2222-222222222222', EVIL = '99999999-9999-9999-9999-999999999999', PAVION = '33333333-3333-3333-3333-333333333333';
  const auth = A.create({ publicUrl: 'http://localhost:7800', clientId: 'app-id', clientSecret: 's', hciTenantId: HCI, sessionSecret: 'x', bootstrapAdmin: 'john@hcic.com',
    fetchJson: async () => ({ keys: [jwk] }) });
  const sign = (claims, key) => { const h = A.b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })), p = A.b64u(JSON.stringify(claims)); return h + '.' + p + '.' + A.b64u(crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key || privateKey)); };
  const now = Math.floor(Date.now() / 1000);
  const claims = (tid, oid, email, extra) => Object.assign({ aud: 'app-id', iss: 'https://login.microsoftonline.com/' + tid + '/v2.0', tid, oid, email, name: email.split('@')[0], nonce: 'n1', exp: now + 600, iat: now }, extra || {});
  const login = async c => auth.admit(await auth.verifyIdToken(sign(c), 'n1'));
  const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

  T('good token verifies', (await auth.verifyIdToken(sign(claims(HCI, 'o1', 'a@hcic.com')), 'n1')).tid === HCI);
  T('wrong nonce refused', await rejects(() => auth.verifyIdToken(sign(claims(HCI, 'o1', 'a@hcic.com')), 'other'), /did not match/));
  T('token for another app refused', await rejects(() => auth.verifyIdToken(sign(claims(HCI, 'o1', 'a@hcic.com', { aud: 'x' })), 'n1'), /another app/));
  T('forged signature refused', await rejects(() => auth.verifyIdToken(sign(claims(HCI, 'o1', 'a@hcic.com'), crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), 'n1'), /signature/));
  T('expired token refused', await rejects(() => auth.verifyIdToken(sign(claims(HCI, 'o1', 'a@hcic.com', { exp: now - 3600 })), 'n1'), /expired/));
  T('issuer must match its tenant', await rejects(() => auth.verifyIdToken(sign(claims(HCI, 'o1', 'a@hcic.com', { iss: 'https://login.microsoftonline.com/' + EVIL + '/v2.0' })), 'n1'), /issuer/));

  const john = await login(claims(HCI, 'oj', 'john@hcic.com'));
  const m = await db.tx(db.SYSTEM, c => c.query('select role, hospital_id from br.memberships where user_id = $1', [john.id])).then(r => r.rows);
  T('first admin is created from BR_BOOTSTRAP_ADMIN', john.is_hci && m.length === 1 && m[0].role === 'hci_admin' && m[0].hospital_id === null);
  const sam = await login(claims(HCI, 'os', 'sam@hcic.com'));
  const ms = await db.tx(db.SYSTEM, c => c.query('select count(*)::int n from br.memberships where user_id = $1', [sam.id])).then(r => r.rows[0].n);
  T('other HCI staff get in with no access until given a role', sam.is_hci && ms === 0);
  T('a stranger from another tenant is refused', await rejects(() => login(claims(EVIL, 'ox', 'x@evil.com')), /not been invited/));

  // Goshen with its own tenant, an invited IT person, and a dealer invited with their own tenant
  const ids = await db.tx(db.SYSTEM, async c => {
    const g = (await c.query("insert into br.hospitals (name, entra_tenant_id) values ('Goshen Auth Test', $1) returning id", [GOSHEN])).rows[0].id;
    const it = (await c.query("insert into br.users (email) values ('kim@goshenhealth.com') returning id")).rows[0].id;
    const dl = (await c.query("insert into br.users (email, entra_tid) values ('dan@pavion.com', $1) returning id", [PAVION])).rows[0].id;
    await c.query("insert into br.memberships (user_id, hospital_id, role) values ($1, $3, 'hospital_it'), ($2, $3, 'dealer')", [it, dl, g]);
    return { g, it, dl };
  });
  T('invite claimed from the wrong tenant is refused (spoofed email)', await rejects(() => login(claims(EVIL, 'oe', 'kim@goshenhealth.com')), /not been invited/));
  const kim = await login(claims(GOSHEN, 'ok', 'kim@goshenhealth.com'));
  T('invited hospital IT signs in from the hospital tenant', kim.id === ids.it);
  T('after that, matched by Microsoft id even if email changes', (await login(claims(GOSHEN, 'ok', 'kim.renamed@goshenhealth.com'))).id === ids.it);
  T('dealer must sign in from the tenant on the invite', await rejects(() => login(claims(GOSHEN, 'od', 'dan@pavion.com')), /not been invited/) && (await login(claims(PAVION, 'od', 'dan@pavion.com'))).id === ids.dl);
  await db.tx(db.SYSTEM, c => c.query('update br.users set disabled = true where id = $1', [ids.it]));
  T('a turned off account is refused', await rejects(() => login(claims(GOSHEN, 'ok', 'kim@goshenhealth.com')), /turned off/));

  // the login state cookie
  const sealed = auth._seal({ state: 's', exp: Date.now() + 1000 });
  T('login cookie round trips', auth._unseal(sealed).state === 's');
  T('tampered login cookie refused', auth._unseal(sealed.replace(/.$/, c => c === 'A' ? 'B' : 'A')) === null);
  T('expired login cookie refused', auth._unseal(auth._seal({ state: 's', exp: Date.now() - 1 })) === null);
};
