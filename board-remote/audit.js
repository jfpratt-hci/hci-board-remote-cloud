'use strict';
/* HCI ONE Board Remote: morning audit
   1. Uptime: every minute each board with a room is sampled, so the record shows exactly when a
      board dropped and when it came back. Gaps when Board Remote itself was not running are
      recorded too, so the report never claims a board was up when nobody was watching.
   2. Morning run: at the set time (and on demand) every audited board gets a snapshot and its
      on screen words are read (uiautomator). Only the precaution labels that match (fall risk,
      contact) are kept; the words themselves, which can include patient names, are thrown away.
   3. Expected list: the hospital's morning list of rooms that should show fall risk or contact,
      pasted, uploaded or dropped in audit\inbox. Each day's report compares it room by room.
   Everything stays on this PC under audit\<date>. Reports hold room numbers and yes or no flags. */
const fs = require('fs');
const path = require('path');

module.exports = function createAudit(ctx) {
  const { store, saveStore, R, serialOf, shell, capture, log, ROOT, send, readJson, health } = ctx;
  const DIR = path.join(ROOT, 'audit');
  const INBOX = path.join(DIR, 'inbox');
  const UPTIME_FILE = path.join(DIR, 'uptime.json');
  const DEFAULTS = {
    enabled: true, time: '06:30', kinds: ['wb', 'ds'], keepDays: 90, teams: true,
    fall: 'fall risk, fall risk precautions, fall precautions, high fall risk, fall',
    contact: 'contact precautions, contact isolation, contact'
  };
  store.settings.audit = Object.assign({}, DEFAULTS, store.settings.audit || {});
  const cfg = () => store.settings.audit;
  const now = () => Date.now();
  const pad2 = n => String(n).padStart(2, '0');
  const dayOf = t => { const d = new Date(t); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const hm = t => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const normRoom = v => String(v || '').toUpperCase().replace(/^\s*(ROOM|RM)\b\.?/, '').replace(/[^A-Z0-9]/g, '').replace(/^0+(?=\d)/, '');
  const mkdir = d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* exists */ } };
  const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const writeJ = (f, v) => { mkdir(path.dirname(f)); fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); };
  mkdir(INBOX);

  const audited = () => store.boards.filter(b => b.room && (cfg().kinds || []).indexOf(b.kind || 'other') >= 0);

  /* ---------------- uptime ---------------- */
  const U = readJ(UPTIME_FILE, { boards: {}, gaps: [], lastSample: 0 });
  U.boards = U.boards || {}; U.gaps = U.gaps || [];
  let uDirty = false;
  function sampleUptime() {
    const t = now();
    if (U.lastSample && t - U.lastSample > 5 * 60000) { U.gaps.push({ from: U.lastSample, to: t }); }
    for (const b of audited()) {
      const u = U.boards[b.id] || (U.boards[b.id] = { up: null, downs: [] });
      // Device Health's state is the judge: a board is down once its heartbeat is missed (90 s by
      // default), dated from its last heartbeat. While Board Remote is still starting up the state is
      // unknown, and a paused board is not being watched, so neither counts as down.
      const h = health && health.H ? health.H(b) : null;
      const st = h ? h.state : (R(b).status === 'online' ? 'online' : R(b).paused ? 'paused' : 'offline');
      if (st === 'unknown' || st === 'paused') continue;
      const up = st !== 'offline';
      const downFrom = h && h.offlineAt ? Math.min(h.offlineAt, t) : t;
      if (u.up === null) { u.up = up; if (!up) u.downs.push({ from: downFrom, to: 0 }); uDirty = true; continue; }
      if (u.up && !up) { u.downs.push({ from: downFrom, to: 0 }); u.up = false; uDirty = true; }
      else if (!u.up && up) { const last = u.downs[u.downs.length - 1]; if (last && !last.to) last.to = t; u.up = true; uDirty = true; }
    }
    U.lastSample = t;
    const cut = t - (cfg().keepDays || 90) * 86400000;
    for (const id of Object.keys(U.boards)) U.boards[id].downs = U.boards[id].downs.filter(d => !d.to || d.to > cut);
    U.gaps = U.gaps.filter(g => g.to > cut).slice(-500);
  }
  function downsIn(id, from, to) {
    const u = U.boards[id]; if (!u) return [];
    return u.downs.filter(d => (d.to || to) > from && d.from < to).map(d => ({ from: Math.max(d.from, from), to: d.to ? Math.min(d.to, to) : 0 }));
  }

  /* ---------------- reading the screen ---------------- */
  const keyList = s => String(s || '').toLowerCase().split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const decode = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  // A label counts only when a whole piece of on screen text is the label, so "Contact your nurse" is not "contact".
  function findLabels(xml) {
    const texts = [];
    xml.replace(/\s(?:text|content-desc)="([^"]*)"/g, (m, v) => { const t = decode(v).trim(); if (t) texts.push(t); return m; });
    const clean = t => t.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[:.!*•·]+$/g, '').trim();
    const F = keyList(cfg().fall), C = keyList(cfg().contact);
    let fall = false, contact = false; const matched = [];
    for (const t of texts) {
      const c = clean(t);
      if (F.indexOf(c) >= 0) { fall = true; if (matched.indexOf(t) < 0) matched.push(t); }
      if (C.indexOf(c) >= 0) { contact = true; if (matched.indexOf(t) < 0) matched.push(t); }
    }
    return { fall, contact, matched: matched.slice(0, 6), words: texts.length };
  }
  async function readScreen(b) {
    const f = '/sdcard/hci_audit.xml';
    let xml = '';
    // uiautomator refuses while the screen is mid animation ("could not get idle state"), so try twice
    for (let i = 0; i < 2 && xml.indexOf('<hierarchy') < 0; i++) {
      const r = await shell(b, 'uiautomator dump ' + (i ? '--compressed ' : '') + f + ' >/dev/null 2>&1; cat ' + f + ' 2>/dev/null; rm -f ' + f, 30000);
      xml = String(r.out || '');
    }
    if (xml.indexOf('<hierarchy') < 0) return { readable: false, why: 'Could not read the screen text. Check the snapshot.' };
    const L = findLabels(xml);
    if (!L.words) return { readable: false, why: 'The screen shows no readable text (it may be an image or video). Check the snapshot.' };
    return Object.assign({ readable: true }, L);
  }

  /* ---------------- expected list (the hospital's morning list) ---------------- */
  function parseExpected(text) {
    const rooms = {}, lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const ROOM = /\b(?:room|rm)?\s*([A-Za-z]{0,3}\d{1,5}[A-Za-z]?)\b/gi;
    const isFall = s => /fall/i.test(s), isContact = s => /contact|isolation|\bcp\b/i.test(s);
    const truthy = v => { v = String(v || '').trim().toLowerCase(); return !!v && !/^(n|no|0|false|-|none|x?no)$/.test(v); };
    const set = (room, k) => { const n = normRoom(room); if (!n || !/\d/.test(n)) return; const e = rooms[n] || (rooms[n] = { room: String(room).trim(), fall: false, contact: false }); e[k] = true; };
    const touch = room => { const n = normRoom(room); if (n && /\d/.test(n) && !rooms[n]) rooms[n] = { room: String(room).trim(), fall: false, contact: false }; };
    // a table with a header row: Room, Fall risk, Contact (any order, tab or comma separated)
    const split = l => l.split(l.indexOf('\t') >= 0 ? '\t' : ',').map(c => c.trim().replace(/^"|"$/g, ''));
    if (lines.length) {
      const h = split(lines[0]).map(c => c.toLowerCase());
      const ri = h.findIndex(c => /^(room|rm|room ?number|location|bed)$/.test(c)), fi = h.findIndex(c => /fall/.test(c)), ci = h.findIndex(c => /contact|isolation/.test(c));
      if (ri >= 0 && (fi >= 0 || ci >= 0)) {
        for (const l of lines.slice(1)) {
          const c = split(l); const room = c[ri]; if (!room) continue;
          touch(room);
          if (fi >= 0 && truthy(c[fi])) set(room, 'fall');
          if (ci >= 0 && truthy(c[ci])) set(room, 'contact');
        }
        return finish(rooms, 'table');
      }
    }
    // free text: "401 fall contact", "Fall risk: 401, 402", or a heading line then one room per line
    let section = null;
    const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?(,?\s+\d{4})?\b/gi;
    for (const l of lines) {
      const f = isFall(l), c = isContact(l);
      // dates and times on a list ("Oct 20", "10/20/2026", "6:30") are not rooms
      const rest = l.replace(MONTH, ' ').replace(/\b\d{1,4}[\/.]\d{1,2}([\/.]\d{2,4})?\b/g, ' ').replace(/\b\d{1,2}:\d{2}(\s*[ap]m)?\b/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/fall\s*risk|fall\s*precautions?|fall|contact\s*precautions?|contact\s*isolation|contact|isolation|\bcp\b/gi, ' ');
      const ids = []; let m; ROOM.lastIndex = 0;
      while ((m = ROOM.exec(rest))) { if (/\d/.test(m[1])) ids.push(m[1]); }
      if (!ids.length) { if (f || c) section = { fall: f, contact: c }; continue; }
      const use = (f || c) ? { fall: f, contact: c } : section;
      if (!use) continue;
      for (const id of ids) { if (use.fall) set(id, 'fall'); if (use.contact) set(id, 'contact'); }
    }
    return finish(rooms, 'text');
  }
  function finish(rooms, kind) {
    const list = Object.values(rooms);
    return { kind, rooms, count: list.length, fall: list.filter(r => r.fall).length, contact: list.filter(r => r.contact).length };
  }
  const expFile = day => path.join(DIR, day, 'expected.json');
  function saveExpected(day, text, source, name) {
    const p = parseExpected(text);
    if (!p.count) return { ok: false, message: 'No rooms found. Paste one room per line with fall risk or contact, or a table with Room, Fall risk and Contact columns.' };
    writeJ(expFile(day), { day, at: now(), source, name: name || '', parsed: p });
    return { ok: true, message: 'List for ' + day + ': ' + p.count + ' rooms, ' + p.fall + ' fall risk, ' + p.contact + ' contact.', parsed: p };
  }
  function checkInbox() {
    let files = [];
    try { files = fs.readdirSync(INBOX).filter(n => /\.(csv|txt|tsv)$/i.test(n)); } catch (e) { return; }
    for (const n of files) {
      const f = path.join(INBOX, n);
      try {
        const st = fs.statSync(f); if (now() - st.mtimeMs < 5000) continue;   // still being written
        const day = (n.match(/\d{4}-\d{2}-\d{2}/) || [dayOf(now())])[0];
        const r = saveExpected(day, fs.readFileSync(f, 'utf8'), 'inbox', n);
        mkdir(path.join(DIR, day));
        fs.renameSync(f, path.join(DIR, day, 'list_' + n.replace(/[^\w.\-]/g, '_')));
        log('audit inbox', n, r.message);
        if (r.ok) afterList(day);
      } catch (e) { log('audit inbox', n, e.message); }
    }
  }

  /* ---------------- the run ---------------- */
  let running = null, lastRunDay = (store.settings.audit.lastRunDay || '');
  const runsOf = day => { try { return fs.readdirSync(path.join(DIR, day)).filter(n => /^run_\d{4}\.json$/.test(n)).sort(); } catch (e) { return []; } };
  async function run(reason) {
    if (running) return { ok: false, message: 'An audit is already running.' };
    const targets = audited();
    if (!targets.length) return { ok: false, message: 'No boards to audit. Give boards a room, and check the types to audit in Settings.' };
    const t0 = now(), day = dayOf(t0), stamp = hm(t0).replace(':', '');
    const prev = latestRun(dayOf(t0 - 86400000), day);
    const from = prev ? prev.at : t0 - 24 * 3600000;
    running = { at: t0, total: targets.length, done: 0 };
    const shots = path.join(DIR, day, 'shots'); mkdir(shots);
    const out = [];
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const b = targets[i++];
        const row = { id: b.id, name: b.name, room: b.room, kind: b.kind, unit: b.unit || '', host: serialOf(b), online: R(b).status === 'online' };
        if (row.online) {
          try {
            const s = await capture(b, 1000, false);
            const file = 'r' + String(b.room).replace(/[^\w]/g, '') + '_' + b.kind + '_' + b.id + '_' + stamp + '.png';
            fs.writeFileSync(path.join(shots, file), s.buf); row.shot = file;
          } catch (e) { row.shotError = e.message; }
          try { Object.assign(row, await readScreen(b)); } catch (e) { row.readable = false; row.why = e.message; }
        } else { row.readable = false; row.why = 'Board not connected at audit time.'; }
        row.downs = downsIn(b.id, from, t0);
        out.push(row); running.done++;
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
      const gaps = U.gaps.filter(g => g.to > from && g.from < t0);
      const rec = { day, at: t0, from, reason: reason || 'manual', boards: out.sort((a, b) => normRoom(a.room).localeCompare(normRoom(b.room), undefined, { numeric: true })), gaps };
      writeJ(path.join(DIR, day, 'run_' + stamp + '.json'), rec);
      lastRunDay = day; store.settings.audit.lastRunDay = day; saveStore();
      const rep = report(day);
      notifyTeams(rep);
      return { ok: true, message: 'Audit done: ' + out.length + ' boards in ' + rep.rooms.length + ' rooms.' + (rep.hasList ? ' ' + rep.counts.mismatch + ' room' + (rep.counts.mismatch === 1 ? '' : 's') + ' not matching the list.' : ' No list for today yet.'), day };
    } finally { running = null; }
  }
  function latestRun(...days) {
    for (const d of days.reverse()) { const r = runsOf(d); if (r.length) return readJ(path.join(DIR, d, r[r.length - 1]), null); }
    return null;
  }

  /* ---------------- the report ---------------- */
  function report(day, runName) {
    const runs = runsOf(day);
    const pick = runName && runs.indexOf(runName) >= 0 ? runName : runs[runs.length - 1];
    const r = pick ? readJ(path.join(DIR, day, pick), null) : null;
    const ex = readJ(expFile(day), null);
    const exp = ex && ex.parsed ? ex.parsed.rooms : null;
    const byRoom = {};
    for (const b of (r ? r.boards : [])) { const k = normRoom(b.room); (byRoom[k] = byRoom[k] || { room: b.room, unit: b.unit, boards: [] }).boards.push(b); }
    if (exp) for (const k of Object.keys(exp)) if (!byRoom[k]) byRoom[k] = { room: exp[k].room, unit: '', boards: [] };
    const rooms = Object.keys(byRoom).map(k => {
      const R0 = byRoom[k], read = R0.boards.filter(b => b.readable);
      const shown = { fall: read.some(b => b.fall), contact: read.some(b => b.contact) };
      const want = exp ? (exp[k] || { fall: false, contact: false }) : null;
      const downMin = R0.boards.reduce((s, b) => s + (b.downs || []).reduce((x, d) => x + ((d.to || (r ? r.at : now())) - d.from), 0), 0) / 60000;
      let status, issues = [];
      if (!R0.boards.length) { status = 'nodevice'; issues.push('No audited board in this room'); }
      else if (!read.length) { status = 'unknown'; issues.push(R0.boards[0].why || 'Could not check'); }
      else if (!want) status = 'nolist';
      else {
        if (want.fall && !shown.fall) issues.push('Fall risk missing');
        if (want.contact && !shown.contact) issues.push('Contact missing');
        if (!want.fall && shown.fall) issues.push('Fall risk showing, not on list');
        if (!want.contact && shown.contact) issues.push('Contact showing, not on list');
        status = issues.length ? (issues.some(x => /missing/.test(x)) ? 'missing' : 'extra') : 'match';
      }
      return { key: k, room: R0.room, unit: R0.unit, want, shown, status, issues, downMin: Math.round(downMin),
        boards: R0.boards.map(b => ({ id: b.id, name: b.name, kind: b.kind, online: b.online, readable: b.readable, fall: !!b.fall, contact: !!b.contact, matched: b.matched || [], why: b.why || '', shot: b.shot || '', downs: b.downs || [] })) };
    }).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const c = s => rooms.filter(x => x.status === s).length;
    const counts = { rooms: rooms.length, match: c('match'), missing: c('missing'), extra: c('extra'), unknown: c('unknown') + c('nodevice'), nolist: c('nolist'), droppedBoards: (r ? r.boards : []).filter(b => (b.downs || []).length).length };
    counts.mismatch = counts.missing + counts.extra;
    return { ok: true, day, run: r ? { at: r.at, from: r.from, reason: r.reason, gaps: r.gaps || [], name: pick } : null, runs, hasList: !!exp,
      list: ex ? { at: ex.at, source: ex.source, name: ex.name, count: ex.parsed.count, fall: ex.parsed.fall, contact: ex.parsed.contact } : null, counts, rooms };
  }
  function notifyTeams(rep) {
    if (!cfg().teams || !health || !health.teams || !rep.run) return;
    const site = (store.settings.health && store.settings.health.site) || 'this site';
    const bad = rep.rooms.filter(r => r.status === 'missing' || r.status === 'extra').map(r => r.room + ' ' + r.issues.join(', ').toLowerCase());
    const drops = rep.counts.droppedBoards;
    const text = rep.counts.rooms + ' rooms checked at ' + hm(rep.run.at) + '. '
      + (rep.hasList ? (bad.length ? bad.length + ' not matching the list: ' + bad.slice(0, 12).join('; ') + (bad.length > 12 ? '; and ' + (bad.length - 12) + ' more' : '') + '.' : 'Every room matches the list.') : 'Waiting for today\'s fall risk and contact list.')
      + (drops ? ' ' + drops + ' board' + (drops > 1 ? 's' : '') + ' dropped overnight.' : ' No board dropped overnight.')
      + (rep.counts.unknown ? ' ' + rep.counts.unknown + ' room' + (rep.counts.unknown > 1 ? 's' : '') + ' could not be checked.' : '');
    health.teams('Morning audit, ' + site + ', ' + rep.day, text).catch(() => {});
  }
  function afterList(day) { if (runsOf(day).length) notifyTeams(report(day)); }

  function csv(day) {
    const rep = report(day);
    const q = v => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const rows = [['Room', 'Unit', 'Fall risk expected', 'Fall risk on screen', 'Contact expected', 'Contact on screen', 'Result', 'Notes', 'Minutes offline overnight', 'Boards']];
    for (const r of rep.rooms) rows.push([r.room, r.unit, r.want ? (r.want.fall ? 'yes' : 'no') : '', r.shown.fall ? 'yes' : 'no', r.want ? (r.want.contact ? 'yes' : 'no') : '', r.shown.contact ? 'yes' : 'no', r.status, r.issues.join('; '), r.downMin, r.boards.map(b => b.name).join('; ')]);
    return rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  }

  function days() {
    let d = []; try { d = fs.readdirSync(DIR).filter(n => DAY_RE.test(n)).sort().reverse(); } catch (e) { /* none */ }
    return d.slice(0, 45).map(day => {
      const runs = runsOf(day), hasList = fs.existsSync(expFile(day));
      let s = null; if (runs.length) { const r = report(day); s = { rooms: r.counts.rooms, mismatch: r.counts.mismatch, unknown: r.counts.unknown, drops: r.counts.droppedBoards }; }
      return { day, runs: runs.length, hasList, summary: s };
    });
  }
  function prune() {
    const cut = dayOf(now() - (cfg().keepDays || 90) * 86400000);
    let d = []; try { d = fs.readdirSync(DIR).filter(n => DAY_RE.test(n)); } catch (e) { return; }
    for (const day of d) if (day < cut) { try { fs.rmSync(path.join(DIR, day), { recursive: true, force: true }); } catch (e) { /* leave */ } }
  }
  function nextRunAt() {
    const c = cfg(); if (!c.enabled) return 0;
    const [h, m] = String(c.time || '06:30').split(':').map(Number);
    const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
    if (lastRunDay === dayOf(now()) || now() > d.getTime() + 3 * 3600000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /* ---------------- tick ---------------- */
  let sampleAt = 0, inboxAt = 0, pruneAt = 0;
  function onTick() {
    const t = now();
    if (t - sampleAt >= 60000) { sampleAt = t; try { sampleUptime(); if (uDirty || t % 600000 < 60000) { writeJ(UPTIME_FILE, U); uDirty = false; } } catch (e) { log('audit uptime', e.message); } }
    if (t - inboxAt >= 30000) { inboxAt = t; checkInbox(); }
    if (t - pruneAt >= 3600000) { pruneAt = t; prune(); }
    const c = cfg();
    if (c.enabled && !running && lastRunDay !== dayOf(t)) {
      const [h, m] = String(c.time || '06:30').split(':').map(Number);
      const due = new Date(t); due.setHours(h || 0, m || 0, 0, 0);
      // run once a day at the set time; if this PC was off at that time, run when it comes back, up to three hours late
      if (t >= due.getTime() && t - due.getTime() < 3 * 3600000) run('morning').then(r => log('audit', r.message)).catch(e => log('audit', e.message));
    }
  }
  function save() { try { writeJ(UPTIME_FILE, U); } catch (e) { /* next time */ } }
  function forget(id) { delete U.boards[id]; }

  /* ---------------- routes ---------------- */
  const pubCfg = () => { const c = cfg(); return { enabled: c.enabled, time: c.time, kinds: c.kinds, keepDays: c.keepDays, teams: c.teams, fall: c.fall, contact: c.contact }; };
  async function handle(req, res, p, url) {
    if (!/^\/api\/audit\b/.test(p)) return false;
    const day = DAY_RE.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : dayOf(now());
    if (req.method === 'GET') {
      if (p === '/api/audit/state') return send(res, 200, { ok: true, settings: pubCfg(), today: dayOf(now()), days: days(), running, nextRunAt: nextRunAt(), audited: audited().length, inbox: INBOX, hasTeams: !!(store.settings.health && (store.settings.health.teamsHci || store.settings.health.teamsIt)) }), true;
      if (p === '/api/audit/day') return send(res, 200, report(day, url.searchParams.get('run') || '')), true;
      if (p === '/api/audit/list') { const ex = readJ(expFile(day), null); return send(res, 200, { ok: true, day, list: ex ? ex.parsed : null }), true; }
      if (p === '/api/audit/report.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit_' + day + '.csv"', 'Cache-Control': 'no-store' });
        return res.end(csv(day)), true;
      }
      if (p === '/api/audit/shot') {
        const f = String(url.searchParams.get('f') || '');
        if (!/^[\w.\-]+\.png$/.test(f)) return send(res, 400, { ok: false, message: 'Bad file' }), true;
        try { const buf = fs.readFileSync(path.join(DIR, day, 'shots', f)); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(buf), true; }
        catch (e) { return send(res, 404, { ok: false, message: 'Snapshot not found' }), true; }
      }
      return send(res, 404, { ok: false, message: 'Not found' }), true;
    }
    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' }), true;
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' }), true;
    const body = await readJson(req);
    if (p === '/api/audit/run') { run('manual').then(r => log('audit', r.message)).catch(e => log('audit', e.message)); return send(res, 200, { ok: true, message: 'Audit started. It takes about a minute for every 30 boards.' }), true; }
    if (p === '/api/audit/expected') {
      const d = DAY_RE.test(body.day || '') ? body.day : dayOf(now());
      if (body.preview) { const pr = parseExpected(body.text); return send(res, 200, { ok: !!pr.count, parsed: pr, message: pr.count ? pr.count + ' rooms found.' : 'No rooms found yet.' }), true; }
      const r = saveExpected(d, body.text, body.source === 'file' ? 'file' : 'paste', String(body.name || '').slice(0, 120));
      if (r.ok) afterList(d);
      return send(res, 200, r), true;
    }
    if (p === '/api/audit/expected/clear') { const d = DAY_RE.test(body.day || '') ? body.day : dayOf(now()); try { fs.unlinkSync(expFile(d)); } catch (e) { /* none */ } return send(res, 200, { ok: true, message: 'List removed for ' + d + '.' }), true; }
    if (p === '/api/audit/settings') {
      const c = cfg();
      if (body.enabled !== undefined) c.enabled = !!body.enabled;
      if (body.time !== undefined && /^\d{1,2}:\d{2}$/.test(String(body.time))) { const [h, m] = String(body.time).split(':').map(Number); if (h < 24 && m < 60) c.time = pad2(h) + ':' + pad2(m); }
      if (Array.isArray(body.kinds)) c.kinds = body.kinds.filter(k => /^(wb|ds|tv|cam|tab|usb|other)$/.test(k));
      if (body.keepDays !== undefined) c.keepDays = Math.min(730, Math.max(7, Number(body.keepDays) || 90));
      if (body.teams !== undefined) c.teams = !!body.teams;
      if (body.fall !== undefined) c.fall = String(body.fall).slice(0, 400);
      if (body.contact !== undefined) c.contact = String(body.contact).slice(0, 400);
      saveStore();
      return send(res, 200, { ok: true, message: 'Audit settings saved.', settings: pubCfg() }), true;
    }
    return send(res, 404, { ok: false, message: 'Not found' }), true;
  }

  return { handle, onTick, save, forget, _parseExpected: parseExpected, _findLabels: findLabels, _run: run, _report: report, _sample: sampleUptime, _U: U };
};
