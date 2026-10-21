'use strict';
/*
  HCI ONE Board Remote · Deploy
  1. Room list import: paste or drop a list of rooms and IP addresses and it builds the Boards page.
  2. App push: an APK library and a bulk install to door signs, whiteboards or any set of boards,
     with a live row per board, version checks, clear failure reasons and retry.
  3. Rooms in MediaCare: finds each device's record in MediaCare's Kuzzle database by an identity
     read from the board over ADB (MAC, serial, Android ID, IP), writes the room from the list,
     reads it back, restarts the app, and keeps every old value so a batch can be undone.
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

module.exports = function createDeploy(ctx) {
  const { store, saveStore, R, serialOf, adb, shell, log, ROOT, APP = ROOT, send, readJson, normBoard, connect, resetInfo } = ctx;
  const note = (b, text) => { try { if (ctx.health && ctx.health.note) ctx.health.note(b, text); } catch (e) { /* health is optional */ } };

  const FILE = path.join(ROOT, 'deploy.json');
  const LIB = path.join(ROOT, 'apks', 'library');
  const KINDS = { wb: 'Whiteboard', ds: 'Door sign', tv: 'Patient TV', cam: 'Camera', tab: 'Tablet', usb: 'Unit Status Board', other: 'Device' };
  const KIND_ORDER = ['wb', 'ds', 'tv', 'cam', 'tab', 'usb', 'other'];
  const KEEPER_PKG = 'com.hci.one.adb';
  const KEEPER_APK = path.join(APP, 'apks', 'HCI_ONE_ADB.apk');
  const ROOMSIGN_PKG = 'com.hci.one.roomsign';
  const ROOMSIGN_APK = path.join(APP, 'apks', 'HCI_ONE_Room_Sign.apk');
  const PKG_RE = /^[A-Za-z][\w]*(\.[\w]+)+$/;
  const now = () => Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const newId = () => crypto.randomBytes(4).toString('hex');
  const isFile = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
  const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  const MC_DEF = { url: '', user: '', pass: '', apiKey: '', insecure: false, index: '', collection: '', idPath: '', idSource: '', writes: [], roomsCollection: '', roomsPath: '', linkedAt: 0 };
  store.settings.deploy = Object.assign({ parallel: 6 }, store.settings.deploy || {});
  store.settings.deploy.mc = Object.assign({}, MC_DEF, store.settings.deploy.mc || {});
  const mc = () => store.settings.deploy.mc;

  /* ---------------- saved state ---------------- */
  let D = { apps: [], history: [], changes: [], idents: {} };
  function load() {
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); D = Object.assign(D, j); }
    catch (e) { if (e.code !== 'ENOENT') log('deploy.json could not be read:', e.message); }
    D.apps = (D.apps || []).filter(a => a && a.file && isFile(path.join(LIB, a.file)));
  }
  // The HCI ONE ADB keeper ships with Board Remote, so it is in the library from the first start.
  function seedKeeper() {
    if (!isFile(KEEPER_APK)) return;
    try {
      const buf = fs.readFileSync(KEEPER_APK);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const have = D.apps.find(x => x.sha === sha);
      if (have) { if (!have.builtin) { have.builtin = true; save(); } return; }
      for (const old of D.apps.filter(x => x.builtin && x.pkg === KEEPER_PKG)) { try { fs.unlinkSync(path.join(LIB, old.file)); } catch (e) { /* already gone */ } }
      D.apps = D.apps.filter(x => !(x.builtin && x.pkg === KEEPER_PKG));
      fs.mkdirSync(LIB, { recursive: true });
      const id = sha.slice(0, 12), file = id + '_HCI_ONE_ADB.apk';
      fs.copyFileSync(KEEPER_APK, path.join(LIB, file));
      const info = readApk(path.join(LIB, file));
      D.apps.push(Object.assign({ id, sha, file, name: 'HCI_ONE_ADB.apk', size: buf.length, addedAt: now(), kind: '', builtin: true }, info, { label: 'HCI ONE ADB' }));
      save();
      log('deploy: HCI ONE ADB keeper', info.versionName, 'added to the app library');
    } catch (e) { log('deploy: keeper seed', e.message); }
  }
  // The HCI ONE Room Sign ships with Board Remote too, so door signs can be set up from the first start.
  function seedRoomSign() {
    if (!isFile(ROOMSIGN_APK)) return;
    try {
      const buf = fs.readFileSync(ROOMSIGN_APK);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const have = D.apps.find(x => x.sha === sha);
      if (have) { if (!have.builtin) { have.builtin = true; save(); } return; }
      for (const old of D.apps.filter(x => x.builtin && x.pkg === ROOMSIGN_PKG)) { try { fs.unlinkSync(path.join(LIB, old.file)); } catch (e) { /* already gone */ } }
      D.apps = D.apps.filter(x => !(x.builtin && x.pkg === ROOMSIGN_PKG));
      fs.mkdirSync(LIB, { recursive: true });
      const id = sha.slice(0, 12), file = id + '_HCI_ONE_Room_Sign.apk';
      fs.copyFileSync(ROOMSIGN_APK, path.join(LIB, file));
      const info = readApk(path.join(LIB, file));
      D.apps.push(Object.assign({ id, sha, file, name: 'HCI_ONE_Room_Sign.apk', size: buf.length, addedAt: now(), kind: 'ds', builtin: true }, info, { label: 'HCI ONE Room Sign' }));
      save();
      log('deploy: HCI ONE Room Sign', info.versionName, 'added to the app library');
    } catch (e) { log('deploy: room sign seed', e.message); }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer); saveTimer = null;
    try {
      D.history = D.history.slice(0, 40); D.changes = D.changes.slice(-2000);
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(D, null, 1)); fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { log('deploy save', e.message); }
  }
  const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(save, 1500); };

  /* =========================================================================
     APK reader: zip directory, binary AndroidManifest.xml and resources.arsc,
     so the dashboard knows the package, version and launch screen of every APK.
     ========================================================================= */
  function readApk(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const tailLen = Math.min(size, 65557 + 22);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      let e = -1;
      for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
      if (e < 0) throw new Error('That file is not an APK.');
      const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
      if (cdOff + cdSize > size) throw new Error('That APK is damaged.');
      const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
      const ents = {}; let p = 0;
      for (let n = 0; n < count && p + 46 <= cd.length; n++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) break;
        const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
        const name = cd.toString('utf8', p + 46, p + 46 + nl);
        ents[name] = { method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), lho: cd.readUInt32LE(p + 42) };
        p += 46 + nl + xl + cl;
      }
      const read = name => {
        const en = ents[name]; if (!en) return null;
        if (en.usize > 64 * 1024 * 1024) return null;
        const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, en.lho);
        const start = en.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
        const data = Buffer.alloc(en.csize); fs.readSync(fd, data, 0, en.csize, start);
        return en.method === 0 ? data : zlib.inflateRawSync(data);
      };
      const man = read('AndroidManifest.xml');
      if (!man) throw new Error('That APK has no Android manifest.');
      const info = parseManifest(man);
      if (!info.pkg) throw new Error('Could not read the package name from that APK.');
      let arsc = null;
      const resolve = v => {
        if (typeof v !== 'string' || v[0] !== '@') return v;
        try { if (arsc === null) arsc = parseArsc(read('resources.arsc')); return arsc(parseInt(v.slice(1), 16)) || ''; } catch (err) { arsc = () => ''; return ''; }
      };
      info.label = resolve(info.label);
      info.versionName = String(resolve(info.versionName) || '');
      const abis = new Set();
      Object.keys(ents).forEach(n => { const m = /^lib\/([^/]+)\/[^/]+\.so$/.exec(n); if (m) abis.add(m[1]); });
      info.abis = Array.from(abis).sort();
      info.signed = Object.keys(ents).some(n => /^META-INF\/.+\.(RSA|DSA|EC)$/i.test(n)) || hasV2Block(fd, cdOff);
      return info;
    } finally { fs.closeSync(fd); }
  }
  function hasV2Block(fd, cdOff) {
    if (cdOff < 32) return false;
    const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, cdOff - 16);
    return b.toString('latin1') === 'APK Sig Block 42';
  }
  function readPool(buf, off) {
    const hsize = buf.readUInt16LE(off + 2), count = buf.readUInt32LE(off + 8), flags = buf.readUInt32LE(off + 16), start = buf.readUInt32LE(off + 20);
    const utf8 = (flags & 0x100) !== 0, out = new Array(count);
    for (let i = 0; i < count; i++) {
      let p = off + start + buf.readUInt32LE(off + hsize + i * 4);
      if (utf8) {
        let n = buf[p++]; if (n & 0x80) p++;
        let len = buf[p++]; if (len & 0x80) len = ((len & 0x7f) << 8) | buf[p++];
        out[i] = buf.toString('utf8', p, p + len);
      } else {
        let len = buf.readUInt16LE(p); p += 2;
        if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
        out[i] = buf.toString('utf16le', p, p + len * 2);
      }
    }
    return out;
  }
  const RID = { 0x01010003: 'name', 0x01010001: 'label', 0x0101021b: 'versionCode', 0x0101021c: 'versionName', 0x0101020c: 'minSdkVersion', 0x01010270: 'targetSdkVersion' };
  function parseManifest(buf) {
    const info = { pkg: '', versionCode: 0, versionName: '', minSdk: 0, targetSdk: 0, label: '', launcher: '', home: '' };
    let strings = [], ids = [], off = buf.readUInt16LE(2) || 8;
    let act = null, filter = null;
    const full = n => !n ? '' : n[0] === '.' ? info.pkg + n : n.indexOf('.') < 0 ? info.pkg + '.' + n : n;
    while (off + 8 <= buf.length) {
      const type = buf.readUInt16LE(off), hs = buf.readUInt16LE(off + 2), size = buf.readUInt32LE(off + 4);
      if (size < 8 || off + size > buf.length) break;
      if (type === 0x0001) strings = readPool(buf, off);
      else if (type === 0x0180) { ids = []; for (let i = off + hs; i < off + size; i += 4) ids.push(buf.readUInt32LE(i)); }
      else if (type === 0x0102) {
        const x = off + hs;
        const tag = strings[buf.readUInt32LE(x + 4)];
        const aStart = buf.readUInt16LE(x + 8), aSize = buf.readUInt16LE(x + 10), aCount = buf.readUInt16LE(x + 12);
        const at = {};
        for (let i = 0, a = x + aStart; i < aCount; i++, a += aSize) {
          const ni = buf.readUInt32LE(a + 4), raw = buf.readUInt32LE(a + 8), dt = buf[a + 15], data = buf.readUInt32LE(a + 16);
          const name = RID[ids[ni]] || strings[ni] || '';
          let v;
          if (dt === 0x03) v = strings[raw !== 0xffffffff ? raw : data];
          else if (dt === 0x10) v = data | 0;
          else if (dt === 0x11) v = data >>> 0;
          else if (dt === 0x12) v = data !== 0;
          else if (dt === 0x01) v = '@' + data.toString(16);
          else v = raw !== 0xffffffff ? strings[raw] : data;
          at[name] = v;
        }
        if (tag === 'manifest') { info.pkg = String(at.package || ''); info.versionCode = Number(at.versionCode) || 0; info.versionName = at.versionName === undefined ? '' : at.versionName; }
        else if (tag === 'uses-sdk') { info.minSdk = Number(at.minSdkVersion) || 0; info.targetSdk = Number(at.targetSdkVersion) || 0; }
        else if (tag === 'application') info.label = at.label || '';
        else if (tag === 'activity' || tag === 'activity-alias') act = full(String(at.name || ''));
        else if (tag === 'intent-filter') filter = { actions: [], cats: [] };
        else if (tag === 'action' && filter) filter.actions.push(String(at.name || ''));
        else if (tag === 'category' && filter) filter.cats.push(String(at.name || ''));
      } else if (type === 0x0103) {
        const tag = strings[buf.readUInt32LE(off + hs + 4)];
        if (tag === 'intent-filter' && filter && act && filter.actions.indexOf('android.intent.action.MAIN') >= 0) {
          if (!info.launcher && filter.cats.indexOf('android.intent.category.LAUNCHER') >= 0) info.launcher = act;
          if (!info.home && filter.cats.indexOf('android.intent.category.HOME') >= 0) info.home = act;
        }
        if (tag === 'intent-filter') filter = null;
        if (tag === 'activity' || tag === 'activity-alias') act = null;
      }
      off += size;
    }
    return info;
  }
  // Minimal resources.arsc lookup: enough to turn @string/app_name into the app's name.
  function parseArsc(buf) {
    if (!buf || buf.readUInt16LE(0) !== 0x0002) return () => '';
    let off = buf.readUInt16LE(2), gstr = [];
    const pkgs = {};
    while (off + 8 <= buf.length) {
      const type = buf.readUInt16LE(off), hs = buf.readUInt16LE(off + 2), size = buf.readUInt32LE(off + 4);
      if (size < 8) break;
      if (type === 0x0001) gstr = readPool(buf, off);
      else if (type === 0x0200) {
        const pid = buf.readUInt32LE(off + 8), types = {};
        pkgs[pid] = types;
        let p = off + hs;
        while (p + 8 <= off + size) {
          const t = buf.readUInt16LE(p), th = buf.readUInt16LE(p + 2), ts = buf.readUInt32LE(p + 4);
          if (ts < 8) break;
          if (t === 0x0201) (types[buf[p + 8]] = types[buf[p + 8]] || []).push({ p, th, flags: buf[p + 9], count: buf.readUInt32LE(p + 12), estart: buf.readUInt32LE(p + 16) });
          p += ts;
        }
      }
      off += size;
    }
    return id => {
      const types = pkgs[(id >>> 24) & 0xff]; if (!types) return '';
      const list = types[(id >>> 16) & 0xff] || [], idx = id & 0xffff;
      for (const c of list) {
        let eoff = -1;
        if (c.flags & 0x01) {           // sparse
          for (let i = 0; i < c.count; i++) { const q = c.p + c.th + i * 4; if (buf.readUInt16LE(q) === idx) { eoff = buf.readUInt16LE(q + 2) * 4; break; } }
        } else if (c.flags & 0x02) {    // 16 bit offsets
          if (idx < c.count) { const o = buf.readUInt16LE(c.p + c.th + idx * 2); if (o !== 0xffff) eoff = o * 4; }
        } else if (idx < c.count) { const o = buf.readUInt32LE(c.p + c.th + idx * 4); if (o !== 0xffffffff) eoff = o; }
        if (eoff < 0) continue;
        const e = c.p + c.estart + eoff, ef = buf.readUInt16LE(e + 2);
        if (ef & 0x0008) { if ((ef >> 8) === 0x03) return gstr[buf.readUInt32LE(e + 4)] || ''; continue; }   // compact entry
        if (ef & 0x0001) continue;      // a style or array, not a plain value
        const v = e + buf.readUInt16LE(e);
        if (buf[v + 3] === 0x03) return gstr[buf.readUInt32LE(v + 4)] || '';
      }
      return '';
    };
  }
  const SDK_NAMES = { 19: '4.4', 21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };
  const androidName = sdk => SDK_NAMES[sdk] ? 'Android ' + SDK_NAMES[sdk] : 'API ' + sdk;
  function guessKind(pkg, label) {
    const t = (pkg + ' ' + label).toLowerCase();
    if (/status ?board|unit ?board|unitstatus|\busb\b/.test(t)) return 'usb';
    if (/door|sign/.test(t)) return 'ds';
    if (/white ?board|\bwb\b|\.board\b|board$/.test(t)) return 'wb';
    if (/\btv\b|\.tv\b|television|launcher/.test(t)) return 'tv';
    return '';
  }
  function appPublic(a) {
    return { id: a.id, label: a.label, pkg: a.pkg, versionName: a.versionName, versionCode: a.versionCode, minSdk: a.minSdk, minAndroid: a.minSdk ? androidName(a.minSdk) : '',
      targetSdk: a.targetSdk, size: a.size, kind: a.kind, launcher: a.launcher, home: a.home, abis: a.abis, signed: a.signed, name: a.name, addedAt: a.addedAt, builtin: !!a.builtin };
  }

  async function addApp(req) {
    const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'app.apk'));
    const base = path.basename(rawName).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'app.apk';
    if (!/\.apk$/i.test(base)) { req.resume(); return { ok: false, message: 'Drop an .apk file.' }; }
    fs.mkdirSync(LIB, { recursive: true });
    const tmp = path.join(LIB, '.upload_' + newId());
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        req.on('data', c => { size += c.length; hash.update(c); if (size > 700 * 1024 * 1024) { req.destroy(); reject(new Error('That file is larger than 700 MB.')); } });
        req.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
        req.pipe(ws);
      });
      const sha = hash.digest('hex');
      const have = D.apps.find(a => a.sha === sha);
      if (have) { fs.unlinkSync(tmp); return { ok: true, app: appPublic(have), message: have.label + ' ' + have.versionName + ' is already in the library.' }; }
      let info;
      try { info = readApk(tmp); } catch (e) { fs.unlinkSync(tmp); return { ok: false, message: e.message }; }
      const id = sha.slice(0, 12);
      const file = id + '_' + base.replace(/ /g, '_');
      fs.renameSync(tmp, path.join(LIB, file));
      const label = clip(info.label && !/^@/.test(info.label) ? info.label : base.replace(/\.apk$/i, '').replace(/[_-]+/g, ' '), 60);
      const a = Object.assign({ id, sha, file, name: base, size, addedAt: now(), kind: guessKind(info.pkg, label) }, info, { label });
      D.apps.unshift(a); save();
      log('deploy: added', a.pkg, a.versionName, '(' + a.versionCode + ')', base);
      const older = D.apps.filter(x => x.pkg === a.pkg && x.id !== a.id).length;
      return { ok: true, app: appPublic(a), message: 'Added ' + a.label + ' ' + (a.versionName || a.versionCode) + '.' + (older ? ' Older versions stay in the library.' : '') + (a.signed ? '' : ' This APK does not look signed, so boards may refuse it.') };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) { /* already gone */ }
      return { ok: false, message: e.message };
    }
  }

  /* =========================================================================
     Room list import
     ========================================================================= */
  const TYPE_WORDS = [
    ['usb', /\b(unit status boards?|status boards?|unit boards?|usbs?)\b/i],
    ['ds', /\b(door ?signs?|doorsigns?|door|signs?|ds)\b/i],
    ['wb', /\b(white ?boards?|whiteboards?|wb|boards?)\b/i],
    ['tv', /\b(patient ?tvs?|tvs?|televisions?)\b/i],
    ['cam', /\b(cameras?|cams?)\b/i],
    ['tab', /\b(tablets?|tabs?|ipads?)\b/i]
  ];
  const kindOf = t => { for (const [k, re] of TYPE_WORDS) if (re.test(String(t || ''))) return k; return ''; };
  const IP_ONE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/;
  const IP_ANY = /\b(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\b/g;
  const validIp = ip => ip.split('.').every(o => Number(o) <= 255 && String(Number(o)) === o.replace(/^0+(?=\d)/, ''));
  const cleanRoom = r => clip(String(r || '').replace(/^\s*(room|rm\.?|#)\s*/i, ''), 20);
  function splitLine(line, delim) {
    if (delim === 'ws') return line.trim().split(/\s+/);
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }
  function headerRole(h) {
    const t = String(h || '').toLowerCase().trim();
    if (!t) return { role: 'skip' };
    const kind = kindOf(t);
    if (/\bmac\b|serial/.test(t)) return { role: 'skip' };
    if (/\b(ip|ips|address|addr|host)\b/.test(t)) return { role: 'ip', kind };
    if (/name|label|description/.test(t)) return { role: 'name' };
    if (kind === 'usb') return { role: 'ip', kind };   // "Unit Status Board" is a device column, not the unit
    if (/room|\brm\b|\bbed\b|location/.test(t)) return { role: 'room' };
    if (/unit|floor|dept|department|wing|nursing/.test(t)) return { role: 'unit' };
    if (/closet|idf|mdf|switch|rack/.test(t)) return { role: 'closet' };
    if (/type|kind|device|role/.test(t)) return { role: 'type' };
    if (/\bport\b/.test(t)) return { role: 'port' };
    if (kind) return { role: 'ip', kind };
    return { role: 'skip' };
  }
  const stripKind = t => { let s = String(t); for (const [, re] of TYPE_WORDS) s = s.replace(new RegExp(re.source, 'gi'), ' '); return s.replace(/\s+/g, ' ').trim(); };
  const autoName = (room, kind) => (/^\d/.test(room) ? 'Room ' + room : room) + ' ' + KINDS[kind];

  function parseRooms(text, opt) {
    opt = opt || {};
    const defKind = KIND_ORDER.indexOf(opt.kind) >= 0 ? opt.kind : 'wb';
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(s => s.replace(/ /g, ' ')).filter(s => s.trim() && !/^\s*#/.test(s));
    const items = [], notes = [];
    if (!lines.length) return { items, notes, header: null };
    const delim = lines.some(l => l.indexOf('\t') >= 0) ? '\t' : lines.some(l => l.indexOf(',') >= 0) ? ',' : lines.some(l => l.indexOf(';') >= 0) ? ';' : 'ws';
    const first = splitLine(lines[0], delim);
    let header = null;
    if (!IP_ANY.test(lines[0]) && first.some(c => headerRole(c).role !== 'skip')) header = first.map(headerRole);
    IP_ANY.lastIndex = 0;
    const rows = (header ? lines.slice(1) : lines).map((l, i) => ({ n: i + (header ? 2 : 1), cells: splitLine(l, delim), raw: l }));
    let guessedPair = false;
    for (const row of rows) {
      const base = { line: row.n, room: '', unit: '', closet: '', name: '', kindCell: '' };
      const ips = [];
      if (header) {
        let typeKind = '';
        header.forEach((h, i) => {
          const v = (row.cells[i] || '').trim(); if (!v) return;
          if (h.role === 'room') base.room = cleanRoom(v);
          else if (h.role === 'unit') base.unit = clip(v, 40);
          else if (h.role === 'closet') base.closet = clip(v, 40);
          else if (h.role === 'name') base.name = clip(v, 60);
          else if (h.role === 'type') typeKind = kindOf(v);
          else if (h.role === 'port') base.port = Number(v) || 0;
        });
        header.forEach((h, i) => {
          if (h.role !== 'ip') return;
          const v = (row.cells[i] || '').trim(); if (!v) return;
          const m = IP_ONE.exec(v);
          if (!m) { ips.push({ bad: v, kind: h.kind || typeKind || defKind }); return; }
          ips.push({ host: m[1], port: Number(m[2]) || 0, kind: h.kind || typeKind || defKind });
        });
      } else {
        let rowKind = '';
        const rest = [];
        // A space separated line is one cell; split it so a type word sits next to its address.
        const cells = delim === 'ws' ? [row.cells.join(' ')] : row.cells.length === 1 && /\s/.test(row.cells[0]) ? [row.cells[0]] : row.cells;
        for (const cell of cells) {
          // a cell may hold an address plus words ("Room 414 door sign 10.0.4.114")
          const mine = [];
          const t = cell.replace(IP_ANY, (s, ip, port) => { const x = { host: ip, port: Number(port) || 0 }; ips.push(x); mine.push(x); return ' '; }).replace(/\s+/g, ' ').trim();
          if (!t) continue;
          const k = kindOf(t);
          if (k && mine.length === 1) mine[0].kind = k;
          else if (k) rowKind = rowKind || k;
          const left = k ? stripKind(t) : t;
          if (left) rest.push(left);
        }
        if (cells.length === 1) { base.room = cleanRoom(rest.join(' ')); }
        else { base.room = cleanRoom(rest[0] || ''); if (rest[1]) base.unit = clip(rest[1], 40); if (rest[2]) base.closet = clip(rest[2], 40); }
        const untyped = ips.filter(x => !x.kind);
        if (untyped.length >= 2 && !rowKind && untyped.length === ips.length) { guessedPair = true; ips.forEach((x, i) => { x.kind = i === 0 ? 'wb' : i === 1 ? 'ds' : defKind; }); }
        else untyped.forEach(x => { x.kind = rowKind || defKind; });
      }
      if (!ips.length) { items.push(Object.assign({}, base, { err: row.cells.join('').trim() ? 'No IP address on this line' : 'Empty line', kind: defKind, host: '', port: 0 })); continue; }
      for (const x of ips) {
        const it = Object.assign({}, base, { kind: x.kind || defKind, host: x.host || '', port: x.port || base.port || Number(opt.port) || 5555 });
        if (!it.unit && opt.unit) it.unit = clip(opt.unit, 40);
        if (!it.closet && opt.closet) it.closet = clip(opt.closet, 40);
        if (x.bad) it.err = '"' + clip(x.bad, 24) + '" is not an IP address';
        else if (!validIp(it.host)) it.err = it.host + ' is not a valid IP address';
        else if (!(it.port >= 1 && it.port <= 65535)) it.err = 'Port must be 1 to 65535';
        else if (!it.room) it.err = 'No room number';
        items.push(it);
      }
    }
    if (guessedPair) notes.push('Rows with two addresses and no header: the first is taken as the whiteboard and the second as the door sign. Add a header row (Room, Whiteboard IP, Door sign IP) to change this.');
    return { items, notes, header: header ? header.map(h => h.role + (h.kind ? ':' + h.kind : '')) : null };
  }

  function planImport(text, opt) {
    const { items, notes, header } = parseRooms(text, opt);
    const seen = new Map(), claimed = new Set();
    const plan = items.map(it => {
      const p = Object.assign({}, it, { act: 'error', changes: [], boardId: '' });
      if (it.err) return p;
      const key = it.host + ':' + it.port;
      if (seen.has(key)) { p.err = it.host + ' is already on line ' + seen.get(key); return p; }
      seen.set(key, it.line);
      const sameRoom = items.filter(x => !x.err && x !== it && x.room === it.room && x.kind === it.kind && (x.unit || '') === (it.unit || ''));
      if (sameRoom.length && sameRoom[0].line < it.line) p.warn = 'Room ' + it.room + ' already has a ' + KINDS[it.kind].toLowerCase() + ' on line ' + sameRoom[0].line;
      let b = store.boards.find(x => x.host === it.host && x.port === it.port);
      let moved = false;
      if (!b) {
        b = store.boards.find(x => x.room === it.room && x.kind === it.kind && (x.unit || '') === (it.unit || '') && !claimed.has(x.id) && !items.some(y => !y.err && y.host === x.host && y.port === x.port));
        if (b) moved = true;
      }
      const name = it.name || (opt.rename !== false || !b ? autoName(it.room, it.kind) : b.name);
      if (!b) { p.act = 'new'; p.name = name; return p; }
      claimed.add(b.id);
      p.boardId = b.id;
      const ch = [];
      if (moved) ch.push('IP ' + b.host + (b.port !== 5555 ? ':' + b.port : '') + ' to ' + it.host + (it.port !== 5555 ? ':' + it.port : ''));
      if ((b.room || '') !== it.room) ch.push('room ' + (b.room || 'none') + ' to ' + it.room);
      if (b.kind !== it.kind) ch.push(KINDS[b.kind] + ' to ' + KINDS[it.kind]);
      if (it.unit && (b.unit || '') !== it.unit) ch.push('unit ' + (b.unit || 'none') + ' to ' + it.unit);
      if (it.closet && (b.closet || '') !== it.closet) ch.push('closet ' + (b.closet || 'none') + ' to ' + it.closet);
      if (name !== b.name) ch.push('name to ' + name);
      p.name = name; p.changes = ch; p.was = b.name;
      p.act = ch.length ? (moved ? 'move' : 'update') : 'same';
      return p;
    });
    const count = k => plan.filter(x => x.act === k).length;
    const summary = { total: plan.length, new: count('new'), update: count('update') + count('move'), same: count('same'), error: count('error'), rooms: new Set(plan.filter(x => x.act !== 'error').map(x => (x.unit || '') + '|' + x.room)).size };
    return { plan, notes, header, summary };
  }

  function applyImport(text, opt) {
    const { plan, summary } = planImport(text, opt);
    const toConnect = [];
    for (const p of plan) {
      if (p.act === 'new') {
        const b = normBoard({ name: p.name, host: p.host, port: p.port, unit: p.unit, closet: p.closet, room: p.room, kind: p.kind, auto: true });
        store.boards.push(b); toConnect.push(b);
      } else if (p.act === 'update' || p.act === 'move') {
        const b = store.boards.find(x => x.id === p.boardId); if (!b) continue;
        if (p.act === 'move') {
          adb(['disconnect', serialOf(b)], { timeout: 5000 }).catch(() => {});
          b.host = p.host; b.port = p.port;
          const r = R(b); resetInfo(r); r.status = 'starting'; r.paused = false; toConnect.push(b);
        }
        b.room = p.room; b.kind = p.kind; b.name = p.name;
        if (p.unit) b.unit = p.unit; if (p.closet) b.closet = p.closet;
      }
    }
    saveStore();
    (async () => {
      let i = 0;
      const worker = async () => { while (i < toConnect.length) { const b = toConnect[i++]; await connect(b).catch(() => {}); } };
      await Promise.all(Array.from({ length: Math.min(12, toConnect.length) }, worker));
    })();
    log('deploy: room list import', JSON.stringify(summary));
    const parts = [];
    if (summary.new) parts.push('added ' + plural(summary.new, 'board'));
    if (summary.update) parts.push('updated ' + summary.update);
    const msg = parts.length ? parts.join(' and ').replace(/^./, c => c.toUpperCase()) + '.' + (summary.new ? ' Connecting to them now.' : '') : 'Nothing to change. The Boards page already matches this list.';
    return { ok: true, message: msg + (summary.error ? ' ' + plural(summary.error, 'line') + ' skipped.' : ''), summary };
  }

  /* =========================================================================
     Reading boards: installed versions, identities, launching apps
     ========================================================================= */
  const inst = new Map();     // boardId -> { pkg: { vc, vn, at } | { none: true, at } }
  async function installedVersion(b, pkg) {
    const r = await shell(b, 'dumpsys package ' + pkg, 15000);
    const out = String(r.out || '');
    const vc = /versionCode=(\d+)/.exec(out), vn = /versionName=([^\s]+)/.exec(out);
    const rec = vc ? { vc: Number(vc[1]), vn: vn ? vn[1] : '', at: now() } : { none: true, at: now() };
    if (!vc && !r.ok && !/Unable to find package/.test(out + r.err)) rec.err = true;
    if (!inst.has(b.id)) inst.set(b.id, {});
    if (!rec.err) inst.get(b.id)[pkg] = rec;
    return rec.none ? null : rec;
  }
  let checking = null;
  function checkVersions(pkg, ids) {
    if (checking) return { ok: true, message: 'Already checking.' };
    const list = store.boards.filter(b => ids.indexOf(b.id) >= 0 && R(b).status === 'online');
    if (!list.length) return { ok: false, message: 'None of those boards is connected.' };
    checking = { pkg, total: list.length, done: 0 };
    (async () => {
      let i = 0;
      const worker = async () => { while (i < list.length) { const b = list[i++]; await installedVersion(b, pkg).catch(() => {}); checking.done++; } };
      await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
      checking = null;
    })();
    return { ok: true, message: 'Checking ' + plural(list.length, 'board') + '.' };
  }

  const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
  async function readIdent(b, force) {
    const cur = D.idents[b.id];
    if (!force && cur && now() - cur.at < 10 * 60000 && cur.host === b.host) return cur;
    if (R(b).status !== 'online') return cur && cur.host === b.host ? cur : { host: b.host, ip: b.host, at: 0 };
    const cmd = ['getprop ro.serialno', 'settings get secure android_id', 'cat /sys/class/net/eth0/address 2>/dev/null', 'cat /sys/class/net/wlan0/address 2>/dev/null',
      'getprop net.hostname', 'settings get global device_name', 'getprop ro.build.version.sdk', 'getprop ro.product.cpu.abilist', 'ip -o link 2>/dev/null'].join('; echo @@; ');
    const r = await shell(b, cmd, 10000);
    if (!r.ok && !r.out) return cur || { host: b.host, ip: b.host, at: 0 };
    const P = String(r.out).split(/\r?\n?@@\r?\n?/).map(s => s.trim());
    const mac = v => { v = String(v || '').trim().toLowerCase(); return MAC_RE.test(v) && !/^(00[:-]){5}00$|^02[:-]00[:-]00[:-]00[:-]00[:-]00$/.test(v) ? v.replace(/-/g, ':') : ''; };
    const id = { host: b.host, ip: b.host, at: now(), serial: /^[\w-]{3,}$/.test(P[0] || '') && P[0] !== 'unknown' ? P[0] : '', androidId: /^[0-9a-f]{8,}$/i.test(P[1] || '') ? P[1] : '',
      ethMac: mac(P[2]), wifiMac: mac(P[3]), hostname: /^[\w.-]{2,}$/.test(P[4] || '') ? P[4] : '', deviceName: P[5] && P[5] !== 'null' ? clip(P[5], 80) : '', sdk: Number(P[6]) || 0, abis: String(P[7] || '').split(',').filter(Boolean) };
    if (!id.ethMac || !id.wifiMac) {
      String(P[8] || '').split(/\r?\n/).forEach(l => {
        const m = /^\d+:\s*(\w+)[:@].*link\/ether\s+([0-9a-f:]{17})/i.exec(l); if (!m) return;
        if (!id.ethMac && /^eth/.test(m[1])) id.ethMac = mac(m[2]);
        if (!id.wifiMac && /^wlan/.test(m[1])) id.wifiMac = mac(m[2]);
      });
    }
    D.idents[b.id] = id; saveSoon();
    return id;
  }

  async function launchPkg(b, pkg, act) {
    if (act) {
      const r = await shell(b, 'am start -n ' + pkg + '/' + act, 12000);
      if (r.ok && !/Error|does not exist|Exception/i.test(String(r.out) + r.err)) return true;
    }
    const r = await shell(b, 'monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1', 12000);
    return !/No activities found|aborted/i.test(String(r.out) + r.err);
  }
  async function isRunning(b, pkg) {
    const r = await shell(b, 'pidof ' + pkg + ' 2>/dev/null || ps | grep ' + pkg, 6000);
    return /\d/.test(String(r.out || ''));
  }

  /* =========================================================================
     Jobs (one push and one room job may run at the same time)
     ========================================================================= */
  const jobs = { push: null, rooms: null, setrooms: null };
  function runJob(job, worker, parallel) {
    job.running = true; job.startedAt = now();
    (async () => {
      const queue = job.rows.slice();
      const one = async () => {
        while (queue.length) {
          const row = queue.shift();
          if (job.stop) { row.st = 'skip'; row.step = ''; row.msg = 'Stopped before it started'; continue; }
          row.st = 'run'; row.t0 = now();
          try { await worker(row); } catch (e) { row.st = 'fail'; row.msg = e.message || String(e); }
          if (row.st === 'run') row.st = 'ok';
          row.step = ''; row.t1 = now();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, job.rows.length)) }, one));
      job.running = false; job.endedAt = now();
      const c = k => job.rows.filter(r => r.st === k).length;
      const h = { id: job.id, type: job.type, at: job.startedAt, ms: job.endedAt - job.startedAt, title: job.title, total: job.rows.length, ok: c('ok'), skip: c('skip'), fail: c('fail'), stopped: !!job.stop };
      D.history.unshift(h); save();
      log('deploy:', job.type, job.title, JSON.stringify({ ok: h.ok, skip: h.skip, fail: h.fail }));
      if (job.done) job.done(job);
    })();
  }
  function jobPublic(job) {
    if (!job) return null;
    const c = k => job.rows.filter(r => r.st === k).length;
    return { id: job.id, type: job.type, title: job.title, running: job.running, stop: !!job.stop, startedAt: job.startedAt, endedAt: job.endedAt || 0, appId: job.appId || '', mode: job.mode || '',
      counts: { total: job.rows.length, wait: c('wait'), run: c('run'), ok: c('ok'), skip: c('skip'), fail: c('fail') },
      rows: job.rows.map(r => ({ id: r.id, st: r.st, step: r.step, msg: r.msg, from: r.from || '', code: r.code || '', t0: r.t0 || 0, t1: r.t1 || 0 })) };
  }

  /* ---------------- app push ---------------- */
  const INSTALL_ERRORS = [
    ['sig', /UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES|signatures do not match|SHARED_USER_INCOMPATIBLE/i, 'The app on the board is signed with a different key. Remove the old app from the board first (its data is cleared), then install.'],
    ['down', /VERSION_DOWNGRADE/i, 'The board has a newer version. Tick Allow an older version to replace it.'],
    ['space', /INSUFFICIENT_STORAGE|No space left|ENOSPC/i, 'The board is out of storage. Free storage in Device health, then retry.'],
    ['sdk', /OLDER_SDK/i, 'This board\'s Android is too old for this app.'],
    ['abi', /NO_MATCHING_ABIS|CPU_ABI_INCOMPATIBLE/i, 'This app was not built for this board\'s processor.'],
    ['bad', /INVALID_APK|PARSE_FAILED|NO_CERTIFICATES|INVALID_URI/i, 'The board could not read the APK. It may be unsigned or damaged.'],
    ['test', /TEST_ONLY/i, 'This APK is marked test only. Build a release APK.'],
    ['blocked', /USER_RESTRICTED|VERIFICATION_FAILURE|INSTALL_FAILED_ABORTED|INSTALL_FAILED_INTERNAL_ERROR/i, 'The board blocked the install. On the board turn off Verify apps over USB, or allow installs from this PC.'],
    ['perm', /DUPLICATE_PERMISSION/i, 'Another app on the board already defines one of this app\'s permissions.']
  ];
  function installError(text) {
    for (const [code, re, msg] of INSTALL_ERRORS) if (re.test(text)) return { code, msg };
    const f = /Failure \[([^\]]+)\]/.exec(text) || /(Failure.*|Error.*|Exception.*)$/m.exec(text);
    return { code: 'other', msg: 'Install failed: ' + clip(f ? f[1] : text.split(/\r?\n/).filter(Boolean).pop() || 'no answer', 160) };
  }

  function startPush(body) {
    if (jobs.push && jobs.push.running) return { ok: false, message: 'A push is already running. Wait for it or stop it first.' };
    const app = D.apps.find(a => a.id === body.appId);
    if (!app) return { ok: false, message: 'Pick an app from the library first.' };
    const file = path.join(LIB, app.file);
    if (!isFile(file)) return { ok: false, message: 'The APK file is missing from the apks folder. Add it again.' };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const targets = store.boards.filter(b => ids.indexOf(b.id) >= 0);
    if (!targets.length) return { ok: false, message: 'Pick at least one board.' };
    const o = body.opts || {};
    const opts = { downgrade: !!o.downgrade, grant: o.grant !== false, launch: o.launch !== false, skipSame: o.skipSame !== false, watch: o.watch !== false, removeFirst: !!o.removeFirst };
    const parallel = Math.max(1, Math.min(16, Number(o.parallel) || store.settings.deploy.parallel || 6));
    store.settings.deploy.parallel = parallel; saveStore();
    const job = { id: newId(), type: 'push', appId: app.id, title: app.label + ' ' + (app.versionName || app.versionCode), rows: targets.map(b => ({ id: b.id, st: 'wait', step: 'Waiting', msg: '' })) };
    jobs.push = job;
    let storeDirty = false;
    job.done = () => { if (storeDirty) saveStore(); };
    runJob(job, async row => {
      const b = store.boards.find(x => x.id === row.id);
      const fail = (msg, code) => { row.st = 'fail'; row.msg = msg; row.code = code || ''; };
      if (!b) return fail('No longer on the list');
      row.step = 'Connecting';
      if (R(b).status !== 'online') { R(b).paused = false; await connect(b).catch(() => {}); }
      const st = R(b).status;
      if (st === 'unauthorized') return fail('Waiting for Allow on the board. Tap Allow, then retry.', 'auth');
      if (st !== 'online') return fail(R(b).error || 'Not reachable on the network.', 'offline');
      row.step = 'Checking';
      const id = await readIdent(b, false);
      if (app.minSdk && id.sdk && id.sdk < app.minSdk) return fail('Needs ' + androidName(app.minSdk) + ' or newer. This board runs ' + androidName(id.sdk) + '.', 'sdk');
      if (app.abis.length && id.abis && id.abis.length && !app.abis.some(a => id.abis.indexOf(a) >= 0)) return fail('Built for ' + app.abis.join(', ') + '. This board is ' + id.abis.join(', ') + '.', 'abi');
      const cur = await installedVersion(b, app.pkg);
      row.from = cur ? (cur.vn || String(cur.vc)) : 'not installed';
      if (cur && cur.vc === app.versionCode && opts.skipSame) { row.st = 'skip'; row.msg = 'Already on ' + (app.versionName || app.versionCode); return; }
      if (cur && cur.vc > app.versionCode && !opts.downgrade) return fail('The board has a newer version (' + (cur.vn || cur.vc) + '). Tick Allow an older version to replace it.', 'down');
      if (opts.removeFirst && cur) {
        row.step = 'Removing old app';
        const u = await shell(b, 'pm uninstall ' + app.pkg, 60000);
        if (!/Success/.test(String(u.out) + u.err)) return fail('Could not remove the old app: ' + clip(String(u.out || u.err), 120));
        row.from = 'removed ' + row.from;
      }
      row.step = 'Sending';
      note(b);
      const remote = '/data/local/tmp/hci_deploy_' + app.id + '.apk';
      const pr = await adb(['-s', serialOf(b), 'push', file, remote], { timeout: Math.max(120000, Math.round(app.size / 50)) });
      if (!pr.ok) { const e = installError(String(pr.out) + '\n' + pr.err); return fail(e.code === 'other' ? 'Could not send the APK: ' + clip(pr.err || String(pr.out), 140) : e.msg, e.code); }
      row.step = 'Installing';
      const flags = ['-r'];
      if (opts.downgrade) flags.push('-d');
      if (opts.grant && (id.sdk || 23) >= 23) flags.push('-g');
      const ir = await shell(b, 'pm install ' + flags.join(' ') + ' ' + remote, 300000);
      await shell(b, 'rm -f ' + remote, 8000);
      const text = String(ir.out || '') + '\n' + (ir.err || '');
      if (!/\bSuccess\b/.test(text)) { const e = installError(text); return fail(e.msg, e.code); }
      row.step = 'Checking version';
      const after = await installedVersion(b, app.pkg);
      if (!after || after.vc !== app.versionCode) return fail('Installed, but the board reports ' + (after ? 'version ' + (after.vn || after.vc) : 'no version') + '.', 'verify');
      let running = null;
      const keeper = app.pkg === KEEPER_PKG;
      if (opts.launch || keeper) {
        row.step = keeper ? 'Starting the keeper' : 'Opening';
        await launchPkg(b, app.pkg, app.launcher || app.home);
        await sleep(keeper ? 1500 : 2500);
        if (keeper) await shell(b, 'input keyevent 4', 5000);   // back to the app that was on screen
        running = await isRunning(b, app.pkg);
        if (keeper) { try { ctx.health.H(b).keeperAt = 0; } catch (e) { /* health is optional */ } }
      }
      if (opts.watch && !keeper && b.app !== app.pkg) { b.app = app.pkg; storeDirty = true; }
      note(b, b.name + ': ' + app.label + ' ' + (app.versionName || app.versionCode) + ' installed by Deploy' + (row.from && row.from !== 'not installed' ? ' (was ' + row.from + ')' : '') + '.');
      row.msg = keeper
        ? (running ? 'Keeper ' + (app.versionName || '') + ' running. Network ADB now stays on through reboots.' : 'Keeper installed. Open HCI ONE ADB on the board once to start it.')
        : (row.from === 'not installed' || /^removed/.test(row.from) ? 'Installed ' : 'Updated ' + row.from + ' to ') + (app.versionName || app.versionCode) + (running === null ? '' : running ? ', running' : ', installed but not running yet');
    }, parallel);
    return { ok: true, message: 'Pushing ' + job.title + ' to ' + plural(targets.length, 'board') + ', ' + parallel + ' at a time.' };
  }

  /* ---------------- room signs (HCI ONE Room Sign over ADB) ----------------
     Sets each board's room on the HCI ONE Room Sign app by sending the number
     it already carries on the Boards page. No MediaCare, nothing on the wire
     but a local broadcast to the sign on that one board. */
  const safeRoom = r => String(r === undefined || r === null ? '' : r).trim().replace(/[^\w \-/.#]/g, '').slice(0, 24);
  function startSetRooms(body) {
    if (jobs.setrooms && jobs.setrooms.running) return { ok: false, message: 'Room signs are already being set. Wait for that to finish or stop it.' };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const targets = store.boards.filter(b => ids.indexOf(b.id) >= 0);
    if (!targets.length) return { ok: false, message: 'Pick at least one board.' };
    const o = body.opts || {};
    const launch = o.launch !== false;
    const parallel = Math.max(1, Math.min(16, Number(o.parallel) || store.settings.deploy.parallel || 6));
    const job = { id: newId(), type: 'setrooms', title: 'Room on ' + plural(targets.length, 'sign'), rows: targets.map(b => ({ id: b.id, st: 'wait', step: 'Waiting', msg: '' })) };
    jobs.setrooms = job;
    runJob(job, async row => {
      const b = store.boards.find(x => x.id === row.id);
      const fail = (msg, code) => { row.st = 'fail'; row.msg = msg; row.code = code || ''; };
      if (!b) return fail('No longer on the list');
      const room = safeRoom(b.room);
      row.from = room || '(none)';
      if (!room) return fail('No room set for this board. Set it on the Boards page, then try again.', 'noroom');
      row.step = 'Connecting';
      if (R(b).status !== 'online') { R(b).paused = false; await connect(b).catch(() => {}); }
      const st = R(b).status;
      if (st === 'unauthorized') return fail('Waiting for Allow on the board. Tap Allow, then retry.', 'auth');
      if (st !== 'online') return fail(R(b).error || 'Not reachable on the network.', 'offline');
      row.step = 'Checking the sign app';
      const pathr = await shell(b, 'pm path ' + ROOMSIGN_PKG, 10000);
      if (!/package:/.test(String(pathr.out) + pathr.err)) return fail('HCI ONE Room Sign is not on this board. Push it from the app library first.', 'missing');
      row.step = 'Setting room ' + room;
      note(b, b.name + ': setting the door sign to room ' + room + '.');
      const r = await shell(b, 'am broadcast -a ' + ROOMSIGN_PKG + '.SET_ROOM -n ' + ROOMSIGN_PKG + '/.SetRoomReceiver --es room \'' + room + '\'', 15000);
      const text = String(r.out || '') + '\n' + (r.err || '');
      if (/result=0/.test(text)) {
        if (launch) { row.step = 'Opening'; await launchPkg(b, ROOMSIGN_PKG, ''); }
        row.msg = 'Sign now shows room ' + room + '.';
        return;
      }
      if (/does not exist|no receivers|Exception|Error:/i.test(text)) return fail('The board would not take it. Make sure HCI ONE Room Sign is installed and up to date, then retry.', 'reject');
      return fail('No confirmation from the board: ' + clip(text.split(/\r?\n/).filter(Boolean).pop() || 'no answer', 140), 'other');
    }, parallel);
    return { ok: true, message: 'Setting the room on ' + plural(targets.length, 'sign') + ', ' + parallel + ' at a time.' };
  }

  /* =========================================================================
     MediaCare link (Kuzzle HTTP API)
     ========================================================================= */
  let jwt = null;
  let mcCache = null;         // { at, key, docs, rooms }
  let discovered = null;      // last discovery result (names and paths only)
  const SOURCES = { mac: 'MAC address', serial: 'Serial number', androidId: 'Android ID', ip: 'IP address', hostname: 'Host name', deviceName: 'Device name' };
  // every value a board can be known by for one source (a board may have a wired and a WiFi MAC)
  const srcText = k => k === 'mac' ? 'MAC address' : k === 'androidId' ? 'Android ID' : (SOURCES[k] || 'identity').toLowerCase();
  const identVals = (b, id, src) => src === 'ip' ? [b.host] : src === 'mac' ? [id.ethMac, id.wifiMac].filter(Boolean) : [id[src]].filter(Boolean);
  const SAFE_COLL = /device|screen|board|display|sign|tv|terminal|endpoint|tablet|hardware|equipment|asset|room|bed|location|player|client|kiosk|unit|ward|floor/i;
  const SKIP_COLL = /patient|person|people|user|staff|nurse|doctor|physician|encounter|visit|admission|order|note|message|chat|alert|vital|med|allerg|diet|result|lab|history|log|audit|session|token|education|survey|request/i;
  const DEVICE_COLL = /device|screen|board|display|sign|tv|terminal|endpoint|tablet|hardware|equipment|asset|player|client|kiosk/i;
  const ROOM_COLL = /room|bed|location/i;

  function netError(e, u) {
    const c = e.code || '';
    const where = u ? u.host : 'MediaCare';
    if (c === 'ECONNREFUSED') return new Error('Nothing is answering at ' + where + '. Check the address and port (Kuzzle is usually on 7512).');
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new Error('This PC cannot find ' + where + '. Check the address.');
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(c)) return new Error('MediaCare\'s certificate is not trusted by this PC. If this is your MediaCare server, tick Trust its certificate.');
    if (/timeout|ETIMEDOUT/i.test(c + e.message)) return new Error(where + ' did not answer in time.');
    if (c === 'EPROTO' || /wrong version number/i.test(e.message)) return new Error(where + ' does not speak https. Try http:// instead.');
    return new Error('MediaCare: ' + e.message);
  }
  function mcReq(method, route, body, noAuth) {
    const c = mc();
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(String(c.url).replace(/\/+$/, '') + route); } catch (e) { return reject(new Error('Enter MediaCare\'s address, for example http://10.20.0.5:7512')); }
      if (!/^https?:$/.test(u.protocol)) return reject(new Error('The MediaCare address must start with http:// or https://'));
      const lib = u.protocol === 'https:' ? https : http;
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Accept: 'application/json' };
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
      if (jwt && !noAuth) headers.Authorization = 'Bearer ' + jwt;
      if (c.apiKey) headers.apikey = c.apiKey;
      const req = lib.request(u, { method, headers, timeout: 20000, rejectUnauthorized: !c.insecure }, res => {
        const chunks = []; let n = 0;
        res.on('data', d => { n += d.length; if (n > 96 * 1024 * 1024) req.destroy(new Error('answer too large')); else chunks.push(d); });
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          let j = null; try { j = JSON.parse(txt); } catch (e) { /* not json */ }
          resolve({ status: res.statusCode, j, txt });
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', e => reject(netError(e, u)));
      if (data) req.write(data);
      req.end();
    });
  }
  async function mcLogin() {
    const c = mc();
    jwt = null;
    if (!c.user) return;
    const r = await mcReq('POST', '/_login/local', { username: c.user, password: c.pass }, true);
    if (r.status === 401 || r.status === 403 || (r.j && r.j.error && r.j.status === 401)) throw new Error('MediaCare did not accept that login.');
    if (!r.j || !r.j.result || !r.j.result.jwt) throw new Error(r.status === 404 ? 'That address answered, but it is not Kuzzle (no login route). Check the port or path.' : 'MediaCare login failed (' + r.status + ').');
    jwt = r.j.result.jwt;
  }
  async function kz(method, route, body) {
    if (!jwt && mc().user) await mcLogin();
    let r = await mcReq(method, route, body);
    if (r.status === 401 && mc().user) { await mcLogin(); r = await mcReq(method, route, body); }
    if (r.status >= 400 || !r.j || (r.j.error && r.j.status >= 400)) {
      const msg = r.j && r.j.error && r.j.error.message;
      if (r.status === 401) throw new Error(mc().user ? 'MediaCare did not accept that login.' : 'MediaCare needs a login.');
      if (r.status === 403) throw Object.assign(new Error('This MediaCare login is not allowed to ' + (method === 'PATCH' || method === 'PUT' ? 'change' : 'read') + ' ' + route.split('/').slice(1, 3).join('/') + '.'), { status: 403 });
      if (r.status === 404) throw Object.assign(new Error(msg || 'Not found on MediaCare: ' + route), { status: 404 });
      throw Object.assign(new Error(msg || 'MediaCare answered ' + r.status + '.'), { status: r.status });
    }
    return r.j.result;
  }
  const enc = s => encodeURIComponent(s);
  async function listIndexes() {
    try { const r = await kz('GET', '/_list'); if (r && Array.isArray(r.indexes)) return r.indexes; } catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }
    const r = await kz('GET', '/_listIndexes');
    return (r && r.indexes) || [];
  }
  async function listCollections(index) {
    const r = await kz('GET', '/' + enc(index) + '/_list');
    return ((r && r.collections) || []).filter(c => !c.type || c.type === 'stored').map(c => c.name || c);
  }
  async function searchAll(index, coll, cap) {
    const out = []; let from = 0; const size = 1000; cap = cap || 10000;
    while (out.length < cap) {
      const r = await kz('POST', '/' + enc(index) + '/' + enc(coll) + '/_search?from=' + from + '&size=' + size, { query: { match_all: {} } });
      const hits = (r && r.hits) || [];
      hits.forEach(h => out.push({ _id: h._id, s: h._source || {} }));
      if (hits.length < size || out.length >= (r.total && r.total.value !== undefined ? r.total.value : r.total || 0)) break;
      from += size;
    }
    return out;
  }
  function flat(o, pre, out, depth) {
    out = out || {}; depth = depth || 0;
    if (!o || typeof o !== 'object' || depth > 4) return out;
    for (const k of Object.keys(o)) {
      if (k === '_kuzzle_info') continue;
      const v = o[k], p = pre ? pre + '.' + k : k;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) { const sc = v.filter(x => x === null || typeof x !== 'object'); if (sc.length) out[p] = sc; }
      else if (typeof v === 'object') flat(v, p, out, depth + 1);
      else out[p] = v;
    }
    return out;
  }
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
  function setBody(p, v) { const parts = p.split('.'); const root = {}; let cur = root; parts.forEach((k, i) => { if (i === parts.length - 1) cur[k] = v; else cur = cur[k] = {}; }); return root; }
  const normFor = (src, v) => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return '';
    if (src === 'ip') return s;
    if (src === 'mac' || src === 'ethMac' || src === 'wifiMac') return s.toLowerCase().replace(/[^0-9a-f]/g, '');
    return s.toLowerCase().replace(/[^0-9a-z]/g, '');
  };
  const normRoom = v => String(v === undefined || v === null ? '' : v).toLowerCase().replace(/^\s*(room|rm\.?|#)\s*/, '').replace(/[^0-9a-z]/g, '');
  const idLike = v => typeof v === 'string' && (/^[A-Za-z0-9_-]{16,}$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) && /\d/.test(v) && /[a-z]/i.test(v);
  function vals(v) { return Array.isArray(v) ? v : [v]; }

  async function identsFor(boards) {
    const out = {};
    let i = 0;
    const worker = async () => { while (i < boards.length) { const b = boards[i++]; out[b.id] = await readIdent(b, false).catch(() => D.idents[b.id] || { ip: b.host }); } };
    await Promise.all(Array.from({ length: Math.min(8, boards.length) }, worker));
    return out;
  }
  function recordLabel(s, id) {
    for (const k of ['name', 'label', 'displayName', 'deviceName', 'hostname', 'title', 'description', 'serial', 'serialNumber']) { const v = getPath(s, k); if (v && typeof v !== 'object') return clip(v, 40); }
    return 'record ' + String(id).slice(0, 10);
  }

  async function discover() {
    const c = mc();
    jwt = null; mcCache = null;
    const idx = await listIndexes();
    const all = [];
    for (const i of idx) { if (/^%|^\./.test(i)) continue; for (const name of await listCollections(i)) all.push({ index: i, name }); }
    if (!all.length) throw new Error('MediaCare answered, but this login cannot see any collections.');
    const boards = store.boards.slice();
    const ids = await identsFor(boards);
    const sets = {};
    Object.keys(SOURCES).forEach(src => { sets[src] = new Map(); boards.forEach(b => { identVals(b, ids[b.id] || {}, src).forEach(x => { const v = normFor(src, x); if (v) sets[src].set(v, b.id); }); }); });
    const safe = all.filter(x => SAFE_COLL.test(x.name) && !SKIP_COLL.test(x.name));
    const ordered = safe.filter(x => DEVICE_COLL.test(x.name)).concat(safe.filter(x => !DEVICE_COLL.test(x.name)));
    let best = null;
    const cand = [];
    for (const col of ordered.slice(0, 25)) {
      let docs;
      try { docs = await searchAll(col.index, col.name, 3000); } catch (e) { cand.push({ index: col.index, name: col.name, err: e.message }); continue; }
      const hits = {};
      for (const d of docs) {
        const f = flat(d.s);
        for (const p of Object.keys(f)) for (const v of vals(f[p])) for (const src of Object.keys(SOURCES)) {
          const bid = sets[src].get(normFor(src, v)); if (!bid) continue;
          const k = p + '|' + src; (hits[k] = hits[k] || new Set()).add(bid);
        }
      }
      for (const k of Object.keys(hits)) {
        const [p, src] = k.split('|'); const n = hits[k].size;
        // MAC, serial and Android ID stay with the device; an IP can change, so it must match clearly more boards to win
        const rank = n * (src === 'ip' ? 0.8 : 1) + (src === 'ip' ? 0 : 0.01);
        if (!best || rank > best.rank) best = { rank, n, index: col.index, collection: col.name, idPath: p, idSource: src, docs };
      }
      cand.push({ index: col.index, name: col.name, count: docs.length });
    }
    const result = { collections: all.map(x => ({ index: x.index, name: x.name, kind: DEVICE_COLL.test(x.name) && !SKIP_COLL.test(x.name) ? 'devices' : ROOM_COLL.test(x.name) && !SKIP_COLL.test(x.name) ? 'rooms' : SKIP_COLL.test(x.name) ? 'private' : 'other' })), scanned: cand, mapping: null, matched: 0, boards: boards.length, notes: [] };
    if (!best) {
      result.notes.push('None of your boards\' MAC addresses, serial numbers or IP addresses appear in MediaCare\'s device records yet. Pick the devices collection and fields by hand, or check that the boards have registered with MediaCare.');
      discovered = result; return result;
    }
    const m = { index: best.index, collection: best.collection, idPath: best.idPath, idSource: best.idSource, writes: [], roomsCollection: '', roomsPath: '' };
    Object.assign(m, await guessRoom(best.index, best.docs, best.idPath, all));
    result.mapping = m; result.matched = best.n;
    result.fields = fieldsOf(best.docs);
    discovered = result;
    return result;
  }
  function fieldsOf(docs) {
    const cnt = {};
    docs.slice(0, 500).forEach(d => { const f = flat(d.s); Object.keys(f).forEach(p => { cnt[p] = (cnt[p] || 0) + 1; }); });
    return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 80);
  }
  function guessFormat(values) {
    const strs = values.filter(v => v !== undefined && v !== null && v !== '');
    if (!strs.length) return { format: '{room}', asNumber: false };
    const nums = strs.filter(v => typeof v === 'number').length;
    if (nums / strs.length >= 0.6) return { format: '{room}', asNumber: true };
    const pre = {};
    strs.forEach(v => { const m = /^(\D*?)(\d[\w-]*)$/.exec(String(v)); if (m) pre[m[1]] = (pre[m[1]] || 0) + 1; });
    const top = Object.keys(pre).sort((a, b) => pre[b] - pre[a])[0];
    if (top && pre[top] / strs.length >= 0.6) return { format: top + '{room}', asNumber: false };
    return { format: '{room}', asNumber: false };
  }
  async function guessRoom(index, docs, idPath, all) {
    const cnt = {}, samples = {};
    docs.forEach(d => { const f = flat(d.s); Object.keys(f).forEach(p => { if (p === idPath) return; const last = p.split('.').pop(); if (!/room|bed|location/i.test(last) || /type|status|count|capacity/i.test(last)) return; cnt[p] = (cnt[p] || 0) + 1; (samples[p] = samples[p] || []).push(f[p]); }); });
    const paths = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
    const linkPaths = paths.filter(p => samples[p].filter(idLike).length / samples[p].length >= 0.6);
    const textPaths = paths.filter(p => linkPaths.indexOf(p) < 0);
    const pref = (list, re) => list.slice().sort((a, b) => (re.test(b) ? 1 : 0) - (re.test(a) ? 1 : 0) || cnt[b] - cnt[a])[0];
    const out = { writes: [], roomsCollection: '', roomsPath: '' };
    const linkPath = pref(linkPaths, /id$/i);
    if (linkPath) {
      const want = new Set(samples[linkPath].map(String));
      const roomCols = all.filter(x => x.index === index && ROOM_COLL.test(x.name) && !SKIP_COLL.test(x.name));
      for (const col of roomCols) {
        let rdocs; try { rdocs = await searchAll(col.index, col.name, 5000); } catch (e) { continue; }
        if (!rdocs.some(r => want.has(String(r._id)))) continue;
        const roomsWanted = new Set(store.boards.map(b => normRoom(b.room)).filter(Boolean));
        const score = {};
        rdocs.forEach(r => { const f = flat(r.s); Object.keys(f).forEach(p => { if (typeof f[p] === 'object') return; const n = normRoom(f[p]); if (n && roomsWanted.has(n)) score[p] = (score[p] || 0) + 1; else if (/number|num|^no$|name|label/i.test(p.split('.').pop())) score[p] = (score[p] || 0) + 0.01; }); });
        const rp = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
        if (!rp) continue;
        out.roomsCollection = col.name; out.roomsPath = rp;
        out.writes.push({ path: linkPath, mode: 'link' });
        mcCache = null;
        break;
      }
    }
    const textPath = pref(textPaths, /number|num|^room$|name/i);
    if (textPath) out.writes.push(Object.assign({ path: textPath, mode: 'text' }, guessFormat(samples[textPath])));
    if (!out.writes.length) out.notes = ['Could not find a room field in the device records. Pick it by hand.'];
    return out;
  }

  async function fieldsFor(index, coll) {
    if (SKIP_COLL.test(coll)) return { ok: false, message: 'That collection looks like it holds patient or staff data, so Board Remote will not read it.' };
    const docs = await searchAll(index, coll, 500);
    return { ok: true, fields: fieldsOf(docs), count: docs.length };
  }

  function mappingOk(m) {
    m = m || mc();
    if (m.idSource === 'ethMac' || m.idSource === 'wifiMac') m.idSource = 'mac';
    if (!m.index || !m.collection || !m.idPath || !SOURCES[m.idSource]) return 'Pick the devices collection and how to match each device.';
    if (!m.writes || !m.writes.length) return 'Pick the room field to write.';
    if (m.writes.some(w => w.mode === 'link') && (!m.roomsCollection || !m.roomsPath)) return 'Pick the rooms collection and its room number field.';
    return '';
  }
  async function loadRecords(force) {
    const m = mc();
    const key = [m.url, m.index, m.collection, m.roomsCollection].join('|');
    if (!force && mcCache && mcCache.key === key && now() - mcCache.at < 60000) return mcCache;
    const docs = await searchAll(m.index, m.collection, 10000);
    const rooms = m.roomsCollection ? await searchAll(m.index, m.roomsCollection, 10000) : [];
    mcCache = { key, at: now(), docs, rooms };
    return mcCache;
  }
  const fmtRoom = (w, b) => { const s = String(w.format || '{room}').replace(/\{room\}/g, b.room).replace(/\{unit\}/g, b.unit || ''); return w.asNumber && /^\d+$/.test(s) ? Number(s) : s; };

  let preview = null;   // { at, rows }
  async function buildPreview(ids, picks) {
    const bad = mappingOk(); if (bad) return { ok: false, message: bad };
    const m = mc();
    const boards = sortedBoards().filter(b => ids.indexOf(b.id) >= 0);
    if (!boards.length) return { ok: false, message: 'Pick at least one board.' };
    const recs = await loadRecords(true);
    const idents = await identsFor(boards);
    const byId = new Map();
    const srcM = m.idSource === 'ethMac' || m.idSource === 'wifiMac' ? 'mac' : m.idSource;
    recs.docs.forEach(d => { for (const v of vals(getPath(d.s, m.idPath))) { const n = normFor(srcM, v); if (!n) continue; if (!byId.has(n)) byId.set(n, []); byId.get(n).push(d); } });
    const roomIdx = new Map();
    recs.rooms.forEach(r => { const n = normRoom(getPath(r.s, m.roomsPath)); if (!n) return; if (!roomIdx.has(n)) roomIdx.set(n, []); roomIdx.get(n).push(r); });
    const roomLabel = r => { const f = flat(r.s); const bits = [getPath(r.s, m.roomsPath)]; for (const k of Object.keys(f)) { if (/unit|floor|wing|dept|building/i.test(k) && typeof f[k] !== 'object' && !idLike(f[k])) { bits.push(f[k]); break; } } return bits.filter(Boolean).join(' · '); };
    const rows = boards.map(b => {
      const id = idents[b.id] || {};
      const src = m.idSource === 'ethMac' || m.idSource === 'wifiMac' ? 'mac' : m.idSource;
      const mine = identVals(b, id, src);
      const what = srcText(src);
      const row = { id: b.id, ident: mine.join(' / '), st: '', msg: '', docId: '', record: '', now: '', next: '', warn: '', options: null };
      if (!b.room) { row.st = 'noroom'; row.msg = 'No room on this board. Add it in the room list.'; return row; }
      if (!mine.length) {
        const st = R(b).status;
        row.st = 'noid';
        row.msg = st === 'online' ? 'The board did not report its ' + what + '.' : st === 'unauthorized' ? 'Waiting for Allow on the board, so its ' + what + ' cannot be read yet.' : 'Not reachable, so its ' + what + ' cannot be read yet.';
        return row;
      }
      const found = [];
      mine.forEach(x => (byId.get(normFor(src, x)) || []).forEach(d => { if (found.indexOf(d) < 0) found.push(d); }));
      const ident = mine[0];
      if (!found.length) { row.st = 'notfound'; row.msg = 'No MediaCare record has ' + what + ' ' + mine.join(' or ') + '. The device may not have registered yet.'; return row; }
      if (found.length > 1) { row.st = 'dupe'; row.msg = found.length + ' MediaCare records have ' + ident + '. Clean up the extra records first.'; return row; }
      const doc = found[0];
      row.docId = doc._id; row.record = recordLabel(doc.s, doc._id);
      const writes = [], nowBits = [], nextBits = [];
      for (const w of m.writes) {
        const cur = getPath(doc.s, w.path);
        if (w.mode === 'link') {
          const cands = roomIdx.get(normRoom(b.room)) || [];
          let target = null;
          if (picks && picks[b.id]) target = cands.find(r => r._id === picks[b.id]) || null;
          else if (cands.length === 1) target = cands[0];
          else if (cands.length > 1 && b.unit) { const u = normRoom(b.unit); const f = cands.filter(r => Object.values(flat(r.s)).some(v => typeof v === 'string' && normRoom(v) === u)); if (f.length === 1) target = f[0]; }
          if (!cands.length) { row.st = 'noroom'; row.msg = 'MediaCare has no room ' + b.room + ' in ' + m.roomsCollection + '. Add the room in MediaCare first.'; return row; }
          if (!target) { row.st = 'pick'; row.msg = cands.length + ' rooms in MediaCare are called ' + b.room + '. Pick one.'; row.options = cands.map(r => ({ id: r._id, label: roomLabel(r) })); return row; }
          const curRoom = recs.rooms.find(r => String(r._id) === String(cur));
          nowBits.push(curRoom ? roomLabel(curRoom) : cur ? 'unknown room' : 'none');
          nextBits.push(roomLabel(target));
          if (String(cur) !== String(target._id)) writes.push({ path: w.path, from: cur === undefined ? null : cur, to: target._id });
        } else {
          const v = fmtRoom(w, b);
          if (!nowBits.length) nowBits.push(cur === undefined || cur === '' ? 'none' : String(cur));
          if (!nextBits.length) nextBits.push(String(v));
          if (String(cur) !== String(v)) writes.push({ path: w.path, from: cur === undefined ? null : cur, to: v });
        }
      }
      row.now = nowBits[0]; row.next = nextBits[0];
      row.writes = writes;
      if (!writes.length) { row.st = 'same'; row.msg = 'Already room ' + row.next + ' in MediaCare.'; return row; }
      row.st = 'change'; row.doc = doc;
      return row;
    });
    // Warn when another device of the same type already holds that room and is not being moved in this batch.
    const moving = new Map(rows.filter(r => r.st === 'change').map(r => [r.docId, r]));
    const typePath = docs => { const f = flat(docs[0] ? docs[0].s : {}); return Object.keys(f).find(k => /(^|\.)(device_?type|type|kind|category|role)$/i.test(k) && typeof f[k] !== 'object') || ''; };
    const tp = typePath(recs.docs);
    for (const row of rows) {
      if (row.st !== 'change') continue;
      const w0 = row.writes[0], myType = tp ? String(getPath(row.doc.s, tp)) : null;
      const others = recs.docs.filter(d => d._id !== row.docId && String(getPath(d.s, w0.path)) === String(w0.to) &&
        (!tp || String(getPath(d.s, tp)) === myType) && !(moving.has(d._id) && String(moving.get(d._id).writes[0].to) !== String(w0.to)));
      if (others.length) row.warn = others.slice(0, 2).map(d => recordLabel(d.s, d._id)).join(', ') + (others.length > 2 ? ' and ' + (others.length - 2) + ' more' : '') + (others.length === 1 ? ' also has' : ' also have') + ' this room in MediaCare. Clear it if that device is gone.';
      delete row.doc;
    }
    preview = { at: now(), rows, ids, picks: picks || {} };
    const c = k => rows.filter(r => r.st === k).length;
    return { ok: true, message: plural(c('change'), 'change') + ' ready' + (c('same') ? ', ' + c('same') + ' already right' : '') + (rows.length - c('change') - c('same') ? ', ' + (rows.length - c('change') - c('same')) + ' need a look' : '') + '.' };
  }

  function startRooms(body) {
    if (jobs.rooms && jobs.rooms.running) return { ok: false, message: 'Rooms are already being written. Wait for that to finish.' };
    if (!preview) return { ok: false, message: 'Preview the changes first.' };
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const rows = preview.rows.filter(r => ids.indexOf(r.id) >= 0 && r.st === 'change');
    if (!rows.length) return { ok: false, message: 'Nothing to change for those boards.' };
    const m = JSON.parse(JSON.stringify(mc()));
    const restart = body.restart !== false;
    const job = { id: newId(), type: 'rooms', mode: 'apply', title: 'Rooms for ' + plural(rows.length, 'device'), rows: rows.map(r => ({ id: r.id, st: 'wait', step: 'Waiting', msg: '', plan: r })) };
    jobs.rooms = job;
    job.done = () => { mcCache = null; };
    runJob(job, async row => {
      const b = store.boards.find(x => x.id === row.id);
      const p = row.plan;
      row.step = 'Writing to MediaCare';
      let body2 = {};
      p.writes.forEach(w => { body2 = deepMerge(body2, setBody(w.path, w.to)); });
      await kzUpdate(m.index, m.collection, p.docId, body2);
      row.step = 'Reading back';
      const doc = await kz('GET', '/' + enc(m.index) + '/' + enc(m.collection) + '/' + enc(p.docId));
      const src = (doc && doc._source) || {};
      const wrong = p.writes.filter(w => String(getPath(src, w.path)) !== String(w.to));
      D.changes.push({ batch: job.id, at: now(), boardId: row.id, index: m.index, collection: m.collection, docId: p.docId, writes: p.writes.map(w => ({ path: w.path, from: w.from, to: w.to })), undone: false });
      saveSoon();
      if (wrong.length) { row.st = 'fail'; row.msg = 'MediaCare took the change but now shows ' + String(getPath(src, wrong[0].path)) + '.'; return; }
      let restarted = '';
      if (restart && b && R(b).status === 'online') {
        row.step = 'Restarting the app';
        const pkg = b.app || R(b).app;
        if (pkg && PKG_RE.test(pkg) && !/launcher|systemui|settings/i.test(pkg)) {
          note(b, b.name + ': room ' + p.next + ' set in MediaCare by Deploy, app restarted.');
          await shell(b, 'am force-stop ' + pkg, 8000);
          await launchPkg(b, pkg, '');
          restarted = ', app restarted';
        }
      } else if (restart && b) restarted = ', board offline so the app picks it up on its next start';
      row.msg = 'MediaCare now has room ' + p.next + restarted;
    }, 4);
    return { ok: true, message: 'Writing ' + plural(rows.length, 'room') + ' to MediaCare.' };
  }
  function deepMerge(a, b) {
    for (const k of Object.keys(b)) a[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]) : b[k];
    return a;
  }
  async function kzUpdate(index, coll, id, body) {
    const route = '/' + enc(index) + '/' + enc(coll) + '/' + enc(id) + '/_update?refresh=wait_for';
    try { return await kz('PATCH', route, body); }
    catch (e) { if (e.status === 404 && /route|not found|unknown/i.test(e.message) && !/document/i.test(e.message)) return kz('PUT', route, body); if (e.status === 405 || e.status === 400) return kz('PUT', route, body); throw e; }
  }
  function startUndo(batch) {
    if (jobs.rooms && jobs.rooms.running) return { ok: false, message: 'Rooms are being written. Wait for that to finish.' };
    const list = D.changes.filter(c => c.batch === batch && !c.undone);
    if (!list.length) return { ok: false, message: 'Nothing left to undo in that batch.' };
    const job = { id: newId(), type: 'rooms', mode: 'undo', title: 'Undo rooms for ' + plural(list.length, 'device'), rows: list.map(c => ({ id: c.boardId, st: 'wait', step: 'Waiting', msg: '', ch: c })) };
    jobs.rooms = job;
    job.done = () => { mcCache = null; preview = null; save(); };
    runJob(job, async row => {
      const c = row.ch;
      row.step = 'Putting back the old room';
      let body = {};
      c.writes.forEach(w => { body = deepMerge(body, setBody(w.path, w.from === undefined ? null : w.from)); });
      await kzUpdate(c.index, c.collection, c.docId, body);
      c.undone = true;
      row.msg = 'Back to ' + c.writes.map(w => w.from === null || w.from === undefined ? 'none' : String(w.from)).join(', ');
    }, 4);
    return { ok: true, message: 'Undoing ' + plural(list.length, 'change') + '.' };
  }

  function exportCsv() {
    const q = v => { const s = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['Room', 'Unit', 'Type', 'Name', 'IP', 'Wired MAC', 'WiFi MAC', 'Serial', 'Android ID', 'Host name'];
    const lines = [head.join(',')];
    sortedBoards().forEach(b => { const i = D.idents[b.id] || {}; lines.push([b.room, b.unit, KINDS[b.kind], b.name, b.host, i.ethMac, i.wifiMac, i.serial, i.androidId, i.hostname].map(q).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }
  function sortedBoards() {
    return store.boards.slice().sort((a, b) => (a.room ? 0 : 1) - (b.room ? 0 : 1) || String(a.unit || '').localeCompare(String(b.unit || ''), undefined, { numeric: true }) ||
      String(a.room || '').localeCompare(String(b.room || ''), undefined, { numeric: true }) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  }

  /* ---------------- state for the page ---------------- */
  function publicState() {
    const m = mc();
    const lastBatch = D.changes.length ? D.changes[D.changes.length - 1].batch : '';
    const undoable = lastBatch ? D.changes.filter(c => c.batch === lastBatch && !c.undone).length : 0;
    return {
      ok: true,
      apps: D.apps.map(appPublic),
      boards: sortedBoards().map(b => {
        const r = R(b), id = D.idents[b.id] || {};
        return { id: b.id, name: b.name, host: b.host, port: b.port, room: b.room || '', unit: b.unit || '', closet: b.closet || '', kind: b.kind, status: r.paused && r.status !== 'online' ? 'disconnected' : r.status, app: b.app || '', fg: r.app || '', model: r.model || '', android: r.android || '',
          inst: inst.get(b.id) || {}, ident: { ethMac: id.ethMac || '', wifiMac: id.wifiMac || '', serial: id.serial || '', androidId: id.androidId || '', hostname: id.hostname || '', at: id.at || 0 } };
      }),
      jobs: { push: jobPublic(jobs.push), rooms: jobPublic(jobs.rooms), setrooms: jobPublic(jobs.setrooms) },
      checking,
      history: D.history.slice(0, 12),
      parallel: store.settings.deploy.parallel || 6,
      mc: { url: m.url, user: m.user, hasPass: !!m.pass, hasKey: !!m.apiKey, insecure: !!m.insecure, index: m.index, collection: m.collection, idPath: m.idPath, idSource: m.idSource, writes: m.writes, roomsCollection: m.roomsCollection, roomsPath: m.roomsPath, linkedAt: m.linkedAt, ready: !mappingOk(), sources: SOURCES },
      discovered,
      preview: preview ? { at: preview.at, rows: preview.rows.map(r => ({ id: r.id, st: r.st, msg: r.msg, ident: r.ident, record: r.record, now: r.now, next: r.next, warn: r.warn, options: r.options })) } : null,
      undo: undoable ? { batch: lastBatch, count: undoable, at: D.changes[D.changes.length - 1].at } : null
    };
  }

  /* ---------------- routes ---------------- */
  async function handle(req, res, p, url) {
    if (!/^\/api\/deploy\b/.test(p)) return false;
    if (req.method === 'GET' && p === '/api/deploy') return send(res, 200, publicState()), true;
    if (req.method === 'GET' && p === '/api/deploy/rooms.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rooms_and_devices.csv"', 'Cache-Control': 'no-store' });
      return res.end(exportCsv()), true;
    }
    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' }), true;
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' }), true;
    if (p === '/api/deploy/apps') return send(res, 200, await addApp(req)), true;
    const body = await readJson(req);
    try {
      if (p === '/api/deploy/import') {
        const opt = { kind: body.kind, unit: body.unit, closet: body.closet, port: body.port, rename: body.rename !== false };
        if (body.apply) return send(res, 200, applyImport(body.text, opt)), true;
        const pl = planImport(body.text, opt);
        return send(res, 200, Object.assign({ ok: true }, pl)), true;
      }
      let m = /^\/api\/deploy\/apps\/([a-f0-9]{12})\/(edit|remove)$/.exec(p);
      if (m) {
        const a = D.apps.find(x => x.id === m[1]);
        if (!a) return send(res, 404, { ok: false, message: 'That app is no longer in the library.' }), true;
        if (m[2] === 'remove') {
          if (a.builtin) return send(res, 400, { ok: false, message: 'HCI ONE ADB comes with Board Remote and stays in the library.' }), true;
          if (jobs.push && jobs.push.running && jobs.push.appId === a.id) return send(res, 409, { ok: false, message: 'That app is being pushed right now.' }), true;
          D.apps = D.apps.filter(x => x.id !== a.id); save();
          fs.unlink(path.join(LIB, a.file), () => {});
          return send(res, 200, { ok: true, message: a.label + ' ' + a.versionName + ' removed from the library.' }), true;
        }
        if (body.label !== undefined) a.label = clip(body.label, 60) || a.label;
        if (body.kind !== undefined) a.kind = KIND_ORDER.indexOf(body.kind) >= 0 ? body.kind : '';
        save();
        return send(res, 200, { ok: true, message: 'Saved.' }), true;
      }
      if (p === '/api/deploy/versions') {
        const a = D.apps.find(x => x.id === body.appId);
        if (!a) return send(res, 400, { ok: false, message: 'Pick an app first.' }), true;
        return send(res, 200, checkVersions(a.pkg, Array.isArray(body.ids) ? body.ids : [])), true;
      }
      if (p === '/api/deploy/push') return send(res, 200, startPush(body)), true;
      if (p === '/api/deploy/setrooms') return send(res, 200, startSetRooms(body)), true;
      if (p === '/api/deploy/stop') {
        const j = jobs[body.type === 'rooms' ? 'rooms' : body.type === 'setrooms' ? 'setrooms' : 'push'];
        if (!j || !j.running) return send(res, 200, { ok: false, message: 'Nothing is running.' }), true;
        j.stop = true;
        return send(res, 200, { ok: true, message: 'Stopping. Boards already started will finish.' }), true;
      }
      if (p === '/api/deploy/retry') {
        if (body.type === 'setrooms') {
          const j = jobs.setrooms;
          if (!j || j.running) return send(res, 200, { ok: false, message: 'Nothing to retry.' }), true;
          const ids = j.rows.filter(r => r.st === 'fail' || (r.st === 'skip' && /Stopped/.test(r.msg))).map(r => r.id);
          if (!ids.length) return send(res, 200, { ok: false, message: 'Nothing failed.' }), true;
          return send(res, 200, startSetRooms({ ids: body.ids && body.ids.length ? body.ids : ids, opts: body.opts || {} })), true;
        }
        const j = jobs.push;
        if (!j || j.running) return send(res, 200, { ok: false, message: 'Nothing to retry.' }), true;
        const ids = j.rows.filter(r => r.st === 'fail' || (r.st === 'skip' && /Stopped/.test(r.msg))).map(r => r.id);
        if (!ids.length) return send(res, 200, { ok: false, message: 'Nothing failed.' }), true;
        const o = Object.assign({}, body.opts || {}, { removeFirst: !!body.removeFirst });
        return send(res, 200, startPush({ appId: j.appId, ids: body.ids && body.ids.length ? body.ids : ids, opts: o })), true;
      }
      if (p === '/api/deploy/idents') {
        const list = store.boards.filter(b => (Array.isArray(body.ids) ? body.ids : []).indexOf(b.id) >= 0 && R(b).status === 'online');
        await Promise.all(list.map(b => readIdent(b, true).catch(() => {})));
        return send(res, 200, { ok: true, message: 'Read ' + plural(list.length, 'board') + '.' }), true;
      }
      /* MediaCare */
      if (p === '/api/deploy/mc/settings') {
        const c = mc();
        const url2 = clip(body.url, 300).replace(/\/+$/, '');
        if (url2 && !/^https?:\/\/[^\s/]+/i.test(url2)) return send(res, 400, { ok: false, message: 'The address must look like http://10.20.0.5:7512' }), true;
        c.url = url2; c.user = clip(body.user, 120);
        if (body.pass !== undefined && !/^••••/.test(body.pass)) c.pass = String(body.pass).slice(0, 300);
        if (body.apiKey !== undefined && !/^••••/.test(body.apiKey)) c.apiKey = clip(body.apiKey, 300);
        c.insecure = !!body.insecure;
        saveStore(); jwt = null; mcCache = null;
        if (!c.url) return send(res, 200, { ok: true, message: 'MediaCare link cleared.' }), true;
        try { await listIndexes(); } catch (e) { return send(res, 200, { ok: false, message: e.message }), true; }
        return send(res, 200, { ok: true, message: 'Connected to MediaCare.' }), true;
      }
      if (p === '/api/deploy/mc/discover') {
        if (!mc().url) return send(res, 400, { ok: false, message: 'Enter MediaCare\'s address first.' }), true;
        const r = await discover();
        if (r.mapping) {
          const c = mc();
          Object.assign(c, r.mapping, { linkedAt: now() }); delete c.notes; saveStore();
          return send(res, 200, { ok: true, message: 'Found ' + plural(r.matched, 'board') + ' of ' + r.boards + ' in ' + r.mapping.index + '/' + r.mapping.collection + ', matched by ' + srcText(r.mapping.idSource) + '. Check the fields, then preview.' }), true;
        }
        return send(res, 200, { ok: false, message: r.notes[0] || 'No match found.' }), true;
      }
      if (p === '/api/deploy/mc/fields') return send(res, 200, await fieldsFor(String(body.index || ''), String(body.collection || ''))), true;
      if (p === '/api/deploy/mc/mapping') {
        const c = mc();
        const w = (Array.isArray(body.writes) ? body.writes : []).slice(0, 2).filter(x => x && x.path).map(x => ({ path: clip(x.path, 200), mode: x.mode === 'link' ? 'link' : 'text', format: clip(x.format || '{room}', 60), asNumber: !!x.asNumber }));
        const m2 = { index: clip(body.index, 120), collection: clip(body.collection, 120), idPath: clip(body.idPath, 200), idSource: SOURCES[body.idSource] ? body.idSource : /^(eth|wifi)Mac$/.test(body.idSource || '') ? 'mac' : '', writes: w, roomsCollection: clip(body.roomsCollection, 120), roomsPath: clip(body.roomsPath, 200) };
        if (SKIP_COLL.test(m2.collection)) return send(res, 400, { ok: false, message: 'That collection looks like patient or staff data. Pick the devices collection.' }), true;
        const bad = mappingOk(m2);
        Object.assign(c, m2, { linkedAt: c.linkedAt || now() }); saveStore(); mcCache = null; preview = null;
        return send(res, 200, { ok: !bad, message: bad || 'Saved. Preview the changes next.' }), true;
      }
      if (p === '/api/deploy/mc/preview') return send(res, 200, await buildPreview(Array.isArray(body.ids) ? body.ids : [], body.picks || {})), true;
      if (p === '/api/deploy/mc/apply') return send(res, 200, startRooms(body)), true;
      if (p === '/api/deploy/mc/undo') return send(res, 200, startUndo(String(body.batch || ''))), true;
    } catch (e) {
      log('deploy', p, e.stack || e.message);
      return send(res, 200, { ok: false, message: e.message }), true;
    }
    return send(res, 404, { ok: false, message: 'Not found' }), true;
  }

  function forget(id) { inst.delete(id); delete D.idents[id]; saveSoon(); }

  load();
  seedKeeper();
  seedRoomSign();
  return { handle, forget, save, readApk, parseRooms, planImport, ident: readIdent, identCached: id => D.idents[id] || null };
};
