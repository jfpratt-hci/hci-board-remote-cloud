'use strict';
/*
  HCI ONE Board Remote · Device logs
  Keeps a rolling window (48 hours by default) of each board's logcat on this PC, so you can
  review advanced device logs long after the board's own small buffer has rolled over. The
  collector pulls only the new lines on each pass. Camera and LED are the same log, filtered
  to the lines those parts write. Built to grow: other sources and device types slot in here.

  Storage: one text file per board under logs/devices/<boardId>.log, each line a logcat line in
  epoch format (the epoch seconds are the first token, so time trims and filters are cheap).
*/
const fs = require('fs');
const path = require('path');

module.exports = function createLogs(ctx) {
  const { store, saveStore, R, serialOf, adb, log, ROOT, send, readJson } = ctx;

  const DIR = path.join(ROOT, 'logs', 'devices');
  const now = () => Date.now();
  const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);

  const DEFAULTS = {
    collect: true,
    retentionHours: 48,        // how far back to keep; start at 48, can go higher
    everySeconds: 60,          // smallest gap between pulls of one board
    maxBytesPerBoard: 5 * 1024 * 1024,
    camera: 'cam camera uvc v4l2 video hanwha aver onvif rtsp esitter sitter',
    led: 'led ring ledring gpio neopixel ws281 backlight indicator lamp'
  };
  store.settings.logs = Object.assign({}, DEFAULTS, store.settings.logs || {});
  const cfg = () => store.settings.logs;
  const MAX_PULL = 4;          // boards pulled at once
  const READ_CAP = 8 * 1024 * 1024;
  const SEND_CAP = 3000;       // lines returned to the page at most

  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { log('logs mkdir', e.message); }

  const fileOf = id => path.join(DIR, id + '.log');
  const mem = new Map();       // boardId -> { pulling, lastPullAt, lastEpoch, lastRaw, bytesSince }

  // A logcat epoch line: "1518481159.210  1587  1587 D Tag: message"
  const LINE = /^\s*(\d{9,}\.\d+)\s+(\d+)\s+\d+\s+([VDIWEFS])\s+([^:]*?)\s*:\s?(.*)$/;
  function parse(line) {
    const m = LINE.exec(line);
    if (!m) return null;
    return { t: Math.round(parseFloat(m[1]) * 1000), lv: m[3], tag: m[4], pid: m[2], msg: m[5] };
  }
  const LV = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

  /* ---------------- collection ---------------- */
  async function pull(b) {
    const id = b.id;
    let s = mem.get(id);
    if (!s) { s = { pulling: false, lastPullAt: 0, lastEpoch: 0, lastRaw: '', bytesSince: 0 }; mem.set(id, s); }
    if (s.pulling) return;
    s.pulling = true;
    try {
      const args = ['-s', serialOf(b), 'logcat', '-d', '-v', 'epoch'];
      if (s.lastEpoch) args.push('-T', s.lastEpoch.toFixed(3));
      else args.push('-t', '500');            // first pass: seed with the last 500 lines
      const r = await adb(args, { timeout: 15000 });
      if (!r.ok && !r.out) return;
      const raw = String(r.out || '').split(/\r?\n/);
      const keep = [];
      let maxEp = s.lastEpoch;
      for (const line of raw) {
        if (!line) continue;
        const m = LINE.exec(line);
        if (!m) continue;
        const ep = parseFloat(m[1]);
        if (s.lastEpoch && ep < s.lastEpoch) continue;             // already have older lines
        if (s.lastEpoch && ep === s.lastEpoch && line === s.lastRaw) continue;  // the boundary line
        keep.push(line);
        if (ep > maxEp) maxEp = ep;
      }
      if (keep.length) {
        const text = keep.join('\n') + '\n';
        fs.appendFileSync(fileOf(id), text);
        s.lastEpoch = maxEp;
        s.lastRaw = keep[keep.length - 1];
        s.bytesSince += Buffer.byteLength(text);
        if (s.bytesSince > cfg().maxBytesPerBoard / 2) { compactOne(id); s.bytesSince = 0; }
      }
      s.lastPullAt = now();
    } catch (e) {
      log('logs pull', b.name, e.message);
    } finally {
      s.pulling = false;
    }
  }

  function onTick(devs) {
    if (!cfg().collect) return;
    const every = Math.max(15, Number(cfg().everySeconds) || 60) * 1000;
    const due = store.boards.filter(b => {
      if (R(b).status !== 'online') return false;
      const s = mem.get(b.id);
      return !s || (!s.pulling && now() - s.lastPullAt >= every);
    });
    let started = 0;
    for (const b of due) {
      const active = Array.from(mem.values()).filter(x => x.pulling).length;
      if (active + started >= MAX_PULL) break;
      started++;
      pull(b);
    }
  }

  /* ---------------- pruning ---------------- */
  function compactOne(id) {
    const f = fileOf(id);
    let data;
    try { data = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
    const cutoff = now() - Math.max(1, Number(cfg().retentionHours) || 48) * 3600000;
    let lines = data.split('\n').filter(Boolean).filter(l => {
      const i = l.indexOf('.');
      const ep = parseFloat(l);
      return !(ep && i > 0) || ep * 1000 >= cutoff;
    });
    // enforce the byte cap by keeping the newest lines
    let out = lines.join('\n') + '\n';
    const cap = Math.max(256 * 1024, Number(cfg().maxBytesPerBoard) || 5 * 1024 * 1024);
    if (Buffer.byteLength(out) > cap) {
      while (lines.length && Buffer.byteLength(out) > cap) { lines.splice(0, Math.ceil(lines.length * 0.1)); out = lines.join('\n') + '\n'; }
    }
    try { const tmp = f + '.tmp'; fs.writeFileSync(tmp, out); fs.renameSync(tmp, f); } catch (e) { log('logs compact', id, e.message); }
  }
  function compactAll() {
    let files = [];
    try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.log')); } catch (e) { return; }
    for (const f of files) compactOne(f.replace(/\.log$/, ''));
  }
  const compactTimer = setInterval(compactAll, 15 * 60000);
  if (compactTimer.unref) compactTimer.unref();
  setTimeout(compactAll, 20000);

  /* ---------------- reading ---------------- */
  function words(s) { return String(s || '').toLowerCase().split(/[\s,]+/).filter(Boolean); }
  function matchSource(rec, source) {
    if (source === 'all') return true;
    const kws = source === 'camera' ? words(cfg().camera) : source === 'led' ? words(cfg().led) : [];
    if (!kws.length) return true;
    const hay = (rec.tag + ' ' + rec.msg).toLowerCase();
    return kws.some(k => hay.indexOf(k) >= 0);
  }
  function readStored(id) {
    const f = fileOf(id);
    let data;
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, 'r');
      const len = Math.min(st.size, READ_CAP);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);   // the newest bytes
      fs.closeSync(fd);
      data = buf.toString('utf8');
    } catch (e) { return []; }
    return data.split('\n').filter(Boolean);
  }
  function query(opts) {
    const since = opts.sinceMs || 0;
    const minLv = LV[opts.minLevel] || 0;
    const q = String(opts.q || '').toLowerCase();
    const out = [];
    for (const line of readStored(opts.id)) {
      const rec = parse(line);
      if (!rec) continue;
      if (since && rec.t < since) continue;
      if ((LV[rec.lv] || 0) < minLv) continue;
      if (!matchSource(rec, opts.source)) continue;
      if (q && (rec.tag + ' ' + rec.msg).toLowerCase().indexOf(q) < 0) continue;
      out.push(rec);
    }
    const total = out.length;
    const lines = out.slice(-SEND_CAP).reverse();   // newest first for the viewer
    return { lines, total, truncated: total > lines.length };
  }

  // the crash buffer lives on the board and survives reboots; pulled live, not stored
  async function pullCrash(b) {
    const r = await adb(['-s', serialOf(b), 'logcat', '-b', 'crash', '-d', '-v', 'epoch', '-t', '400'], { timeout: 15000 });
    const lines = String(r.out || '').split(/\r?\n/).map(parse).filter(Boolean);
    return lines;
  }

  function stats(id) {
    try {
      const st = fs.statSync(fileOf(id));
      const lines = readStored(id);
      const first = lines.length ? parse(lines[0]) : null;
      const last = lines.length ? parse(lines[lines.length - 1]) : null;
      const s = mem.get(id);
      return { bytes: st.size, lines: lines.length, oldest: first ? first.t : 0, newest: last ? last.t : 0, lastPullAt: s ? s.lastPullAt : 0 };
    } catch (e) { return { bytes: 0, lines: 0, oldest: 0, newest: 0, lastPullAt: 0 }; }
  }

  const RANGE = { '1h': 3600000, '6h': 6 * 3600000, '24h': 24 * 3600000, '48h': 48 * 3600000 };

  /* ---------------- routes ---------------- */
  async function handle(req, res, p, url) {
    if (!/^\/api\/logs\b/.test(p)) return false;

    if (req.method === 'GET' && p === '/api/logs/state') {
      const c = cfg();
      return send(res, 200, { ok: true, settings: { collect: c.collect, retentionHours: c.retentionHours, everySeconds: c.everySeconds, camera: c.camera, led: c.led },
        boards: store.boards.map(b => Object.assign({ id: b.id }, stats(b.id))) }), true;
    }

    if (req.method === 'GET' && p === '/api/logs') {
      const id = String(url.searchParams.get('board') || '');
      const b = store.boards.find(x => x.id === id);
      if (!b) return send(res, 404, { ok: false, message: 'Unknown board' }), true;
      const source = ['all', 'camera', 'led', 'crash'].indexOf(url.searchParams.get('source')) >= 0 ? url.searchParams.get('source') : 'all';
      const range = RANGE[url.searchParams.get('range')] || RANGE['48h'];
      const minLevel = ['V', 'D', 'I', 'W', 'E', 'F'].indexOf(url.searchParams.get('level')) >= 0 ? url.searchParams.get('level') : 'V';
      const q = clip(url.searchParams.get('q'), 200);
      if (source === 'crash') {
        if (R(b).status !== 'online') return send(res, 409, { ok: false, message: 'Connect the board to read its crash log.' }), true;
        try {
          let lines = await pullCrash(b);
          if (q) lines = lines.filter(r => (r.tag + ' ' + r.msg).toLowerCase().indexOf(q.toLowerCase()) >= 0);
          return send(res, 200, { ok: true, source, lines: lines.slice(-SEND_CAP).reverse(), total: lines.length, truncated: false, live: true }), true;
        } catch (e) { return send(res, 502, { ok: false, message: e.message }), true; }
      }
      const r = query({ id, source, sinceMs: now() - range, minLevel, q });
      const s = stats(id);
      return send(res, 200, { ok: true, source, lines: r.lines, total: r.total, truncated: r.truncated, newest: s.newest, oldest: s.oldest, lastPullAt: s.lastPullAt, collecting: !!cfg().collect }), true;
    }

    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' }), true;
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' }), true;

    if (p === '/api/logs/pull') {
      const body = await readJson(req);
      const b = store.boards.find(x => x.id === body.board);
      if (!b) return send(res, 404, { ok: false, message: 'Unknown board' }), true;
      if (R(b).status !== 'online') return send(res, 409, { ok: false, message: 'The board is not connected.' }), true;
      await pull(b);
      return send(res, 200, { ok: true, message: 'Pulled the latest log from ' + b.name + '.', stats: stats(b.id) }), true;
    }

    if (p === '/api/logs/settings') {
      const body = await readJson(req);
      const c = cfg();
      if (body.collect !== undefined) c.collect = !!body.collect;
      if (body.retentionHours !== undefined) c.retentionHours = Math.min(336, Math.max(1, Number(body.retentionHours) || 48));
      if (body.everySeconds !== undefined) c.everySeconds = Math.min(3600, Math.max(15, Number(body.everySeconds) || 60));
      if (body.camera !== undefined) c.camera = clip(body.camera, 400);
      if (body.led !== undefined) c.led = clip(body.led, 400);
      saveStore();
      return send(res, 200, { ok: true, message: 'Saved.', settings: { collect: c.collect, retentionHours: c.retentionHours, everySeconds: c.everySeconds, camera: c.camera, led: c.led } }), true;
    }

    return send(res, 404, { ok: false, message: 'Not found' }), true;
  }

  function forget(id) {
    mem.delete(id);
    try { fs.unlinkSync(fileOf(id)); } catch (e) { /* nothing to remove */ }
  }
  function save() { /* settings persist through saveStore; log files are already on disk */ }

  return { handle, onTick, forget, save, _query: query, _parse: parse, _stats: stats, _compactOne: compactOne, _pull: pull };
};
