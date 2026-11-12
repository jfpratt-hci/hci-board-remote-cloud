'use strict';
/*
  HCI ONE Board Remote · Device Health
  Real heartbeat for every board (one ADB check every 30 s), a 30 minute beat history,
  a power to screen check chain, a first read of what is wrong and who owns it, issues
  and alerts (Teams links and Windows pop ups), remote fixes that check their own result,
  discovery and claim of new boards, and an optional Claude diagnosis.
  Everything here comes from the boards themselves; nothing is simulated.
*/
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

module.exports = function createHealth(ctx) {
  const { store, saveStore, R, serialOf, adb, shell, log, ROOT, APP = ROOT, IS_WIN } = ctx;

  const BEAT = 30000;           // one heartbeat slot
  const SLOTS = 60;             // 30 minutes of history
  const LATE = 45000;           // a beat is late after 1.5 slots
  const EVERY = BEAT - 3000;    // each board is checked about every 27 s, so every 30 s slot gets a beat
  const FILE = path.join(ROOT, 'health.json');
  const KEEPER_PKG = 'com.hci.one.adb';
  const KEEPER_APK = path.join(APP, 'apks', 'HCI_ONE_ADB.apk');
  const startedAt = Date.now();
  const KINDS = { wb: 'Whiteboard', ds: 'Door sign', tv: 'Patient TV', cam: 'Camera', tab: 'Tablet', usb: 'Unit Status Board', other: 'Device' };
  const DEFAULTS = {
    site: 'Demo lab', serverHost: '', teamsHci: '', teamsIt: '', popups: true,
    offlineSeconds: 90, escalateMinutes: 5, clockDriftSeconds: 60, sweepMinutes: 5, ntpServer: '',
    claudeKey: '', claudeModel: 'claude-sonnet-5-5', claudeLogs: false,
    ledCommand: "am broadcast -a com.hci.one.roomsign.SET_LED -n com.hci.one.roomsign/.SetLedReceiver --es color '{color}' --es mode '{mode}'"
  };
  store.settings.health = Object.assign({}, DEFAULTS, store.settings.health || {});
  const cfg = () => store.settings.health;

  const PKG_RE = /^[A-Za-z][\w]*(\.[\w]+)+$/;
  const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$/;
  const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
  const now = () => Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const hms = t => new Date(t).toTimeString().slice(0, 8);
  function dur(ms) {
    ms = Math.max(0, ms); const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' s'; const m = Math.floor(s / 60);
    if (m < 60) return m + ' min'; const h = Math.floor(m / 60);
    if (h < 24) return h + ' h ' + (m % 60) + ' min'; return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
  }
  function skewText(sec) {
    const a = Math.abs(sec), dir = sec < 0 ? 'behind' : 'ahead of';
    if (a < 1.5) return 'within 1 s of this PC';
    if (a < 90) return Math.round(a) + ' s ' + dir + ' this PC';
    if (a < 5400) return Math.floor(a / 60) + ' min ' + Math.round(a % 60) + ' s ' + dir + ' this PC';
    return dur(a * 1000) + ' ' + dir + ' this PC';
  }
  const label = b => b.name;
  const kindName = b => KINDS[b.kind] || 'Device';
  const where = b => [b.unit, b.closet].filter(Boolean).join(' · ') || b.host;
  const monitored = b => b.auto && !R(b).paused;
  const listJoin = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

  /* ---------------- per board records ---------------- */
  const HS = new Map();
  function H(b) {
    let h = HS.get(b.id);
    if (!h) {
      h = { beats: Array(SLOTS).fill(-1), acc: { ok: false, restart: false, fault: false }, lastBeat: 0, state: 'unknown', since: now(),
        facts: null, faults: [], streak: {}, crashKeys: [], crashes: [], probeAt: 0, probing: false, reach: null, reachAt: 0, connectMs: null,
        log: [], busy: null, ai: null, prevPid: null, prevUptime: null, lastLogs: null, actAt: 0, keeper: null, keeperAt: 0, offlineAt: 0 };
      HS.set(b.id, h);
    }
    return h;
  }
  let slotStart = Math.floor(now() / BEAT) * BEAT;
  let events = [], notices = [], issues = [];
  const found = new Map();
  let lastSweep = 0, sweeping = false, nextSweep = now() + 20000, saveAt = 0;

  function ev(kind, text, boardId) {
    events.push({ at: now(), kind, text, board: boardId || null });
    if (events.length > 400) events = events.slice(-300);
  }
  function stamp(h, text, cls) {
    h.log.push({ at: now(), text, cls: cls || '' });
    if (h.log.length > 40) h.log = h.log.slice(-30);
  }

  /* ---------------- persistence ---------------- */
  function load() {
    let j;
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log('health.json could not be read:', e.message); return; }
    const gap = Math.max(0, Math.floor((now() - (j.slotStart || now())) / BEAT));
    for (const b of store.boards) {
      const s = j.boards && j.boards[b.id];
      if (!s) continue;
      const h = H(b);
      const beats = Array.isArray(s.beats) && s.beats.length === SLOTS ? s.beats.slice() : Array(SLOTS).fill(-1);
      for (let i = 0; i < Math.min(gap, SLOTS); i++) { beats.shift(); beats.push(-1); }
      h.beats = beats;
      h.lastBeat = s.lastBeat || 0; h.since = s.since || now(); h.crashKeys = s.crashKeys || []; h.crashes = s.crashes || [];
      h.keeper = s.keeper === undefined ? null : s.keeper; h.facts = s.facts || null; h.offlineAt = s.offlineAt || 0;
    }
    events = Array.isArray(j.events) ? j.events : [];
    notices = Array.isArray(j.notices) ? j.notices : [];
    issues = Array.isArray(j.issues) ? j.issues : [];
    for (const f of Array.isArray(j.found) ? j.found : []) if (f && f.id) { if (f.status === 'claiming') f.status = 'found'; found.set(f.id, f); }
    slotStart = Math.floor(now() / BEAT) * BEAT;
  }
  function save() {
    const data = { savedAt: now(), slotStart, boards: {}, issues: issues.slice(-200), notices: notices.slice(-300), events: events.slice(-300),
      found: Array.from(found.values()).slice(-200) };
    for (const b of store.boards) {
      const h = HS.get(b.id);
      if (h) data.boards[b.id] = { beats: h.beats, lastBeat: h.lastBeat, since: h.since, crashKeys: h.crashKeys.slice(-60), crashes: h.crashes.slice(-60), keeper: h.keeper, facts: h.facts, offlineAt: h.offlineAt };
    }
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(data)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { log('health save failed', e.message); }
  }

  /* ---------------- reachability ---------------- */
  function probeKind(host, port, ms) {
    return new Promise(resolve => {
      const t0 = now(); let done = false;
      const s = net.connect({ host, port });
      const fin = kind => { if (done) return; done = true; s.destroy(); resolve({ kind, ms: now() - t0 }); };
      s.setTimeout(ms, () => fin('timeout'));
      s.once('connect', () => fin('open'));
      s.once('error', e => {
        const c = e && e.code;
        fin(c === 'ECONNREFUSED' || c === 'ECONNRESET' ? 'refused' : c === 'ENETUNREACH' ? 'nonet' : 'timeout');
      });
    });
  }

  /* ---------------- the heartbeat check (one adb shell call) ---------------- */
  function sections(out) {
    const S = {}; let cur = null;
    for (const raw of String(out).split(/\r?\n/)) {
      const m = /^@@(\w+)\s*$/.exec(raw.trim());
      if (m) { cur = m[1]; S[cur] = []; continue; }
      if (cur && raw.trim()) S[cur].push(raw.replace(/\r$/, ''));
    }
    return S;
  }
  function parseDf(lines) {
    if (!lines || !lines.length) return null;
    const line = lines.filter(l => /\/data/.test(l)).pop() || lines[lines.length - 1];
    const tok = line.trim().split(/\s+/);
    const pct = /(\d+)%/.exec(line);
    if (pct) {
      const r = { freePct: 100 - Number(pct[1]), totalKb: null, freeKb: null };
      if (tok.length >= 6 && /^\d+$/.test(tok[1])) { r.totalKb = +tok[1]; r.freeKb = +tok[3]; }
      return r;
    }
    const sz = s => { const m = /^([\d.]+)([KMGT]?)/.exec(s || ''); return m ? +m[1] * ({ '': 1 / 1024, K: 1, M: 1024, G: 1048576, T: 1073741824 })[m[2]] : null; };
    if (tok.length >= 4) { const t = sz(tok[1]), f = sz(tok[3]); if (t && f !== null) return { freePct: Math.round(f / t * 100), totalKb: t, freeKb: f }; }
    return null;
  }
  function parseFacts(S, t0, t1, pkg, server, checkKeeper) {
    const f = {};
    const dev = Number((S.T || [])[0]);
    f.skew = Number.isFinite(dev) ? Math.round((dev - (t0 + Math.min(600, (t1 - t0) / 2)) / 1000) * 10) / 10 : 0;
    const up = parseFloat((S.UP || [])[0]);
    f.uptime = Number.isFinite(up) ? up : null;
    const win = (S.WIN || []).join('\n');
    const foc = /mCurrentFocus=Window\{[^}]*?\s([A-Za-z]\w*(?:\.\w+)+)\/([\w.$]+)/.exec(win) || /mFocusedApp=.*?\s([A-Za-z]\w*(?:\.\w+)+)\/([\w.$]+)/.exec(win);
    f.fgPkg = foc ? foc[1] : ''; f.fgAct = foc ? foc[2] : '';
    const dlg = /(Application (?:Error|Not Responding)[^}]*)/.exec(win);
    f.dialog = dlg ? dlg[1].trim() : '';
    const w = /mWakefulness=(\w+)/.exec((S.PWR || []).join(' '));
    f.wake = w ? w[1] : ''; f.awake = w ? w[1] === 'Awake' : null;
    const df = parseDf(S.DF);
    f.freePct = df ? df.freePct : null; f.totalKb = df ? df.totalKb : null; f.freeKb = df ? df.freeKb : null;
    const mem = (S.MEM || []).join(' ');
    const mt = /MemTotal:\s+(\d+)/.exec(mem), ma = /MemAvailable:\s+(\d+)/.exec(mem);
    f.memTotalKb = mt ? +mt[1] : null; f.memAvailKb = ma ? +ma[1] : null;
    f.ifaces = [];
    for (const l of S.IP || []) { const m = /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(l.trim()); if (m && m[1] !== 'lo') f.ifaces.push({ name: m[1], ip: m[2], bits: +m[3] }); }
    f.wifiLevel = null;
    for (const l of S.WL || []) { const tok = l.trim().split(/\s+/); if (/^wlan\d*:$/.test(tok[0]) && tok.length > 3) { const v = parseFloat(tok[3]); if (Number.isFinite(v) && v < 0 && v > -120) f.wifiLevel = v; } }
    const spd = parseInt((S.SPD || [])[0], 10);
    f.ethSpeed = Number.isFinite(spd) && spd > 0 ? spd : null;
    f.wired = f.ifaces.some(i => /^eth/.test(i.name));
    f.pid = null;
    if (pkg) {
      const p = (S.PID || []).join(' ').trim();
      const d = /^(\d+)/.exec(p) || /^\S+\s+(\d+)/.exec(p);
      f.pid = d ? d[1] : null;
    }
    f.crashLines = [];
    for (const l of S.CR || []) {
      const m = /^\s*(\d+)(?:\.\d+)?\s.*Process:\s*([\w.]+),\s*PID:\s*(\d+)/.exec(l);
      if (m) f.crashLines.push({ t: (+m[1] - f.skew) * 1000, pkg: m[2], pid: m[3] });
    }
    f.serverTried = !!server;
    const sm = /time[=<]([\d.]+)\s*ms/.exec((S.SRV || []).join(' '));
    f.serverMs = sm ? Math.round(+sm[1]) : null;
    if (checkKeeper) f.keeper = /package:/.test((S.KP || []).join(' '));
    f.at = now();
    return f;
  }

  async function probeBoard(b) {
    const h = H(b), r = R(b), c = cfg();
    if (h.probing) return false;
    h.probing = true; h.probeAt = now();
    try {
      const k = await probeKind(b.host, b.port, 2500);
      h.reach = k.kind; h.connectMs = k.kind === 'open' || k.kind === 'refused' ? k.ms : null; h.reachAt = now();
      const pkg = PKG_RE.test(b.app || '') ? b.app : '';
      const server = HOST_RE.test(c.serverHost || '') ? c.serverHost : '';
      const checkKeeper = now() - h.keeperAt > 10 * 60000;
      const parts = ['echo @@T', 'date +%s', 'echo @@UP', 'cat /proc/uptime',
        'echo @@WIN', "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'",
        'echo @@PWR', "dumpsys power | grep -m 1 'mWakefulness='",
        'echo @@DF', 'df /data 2>/dev/null', 'echo @@MEM', "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
        'echo @@IP', 'ip -o -4 addr show 2>/dev/null', 'echo @@WL', 'cat /proc/net/wireless 2>/dev/null',
        'echo @@SPD', 'cat /sys/class/net/eth0/speed 2>/dev/null'];
      if (pkg) parts.push('echo @@PID', 'pidof ' + pkg + ' 2>/dev/null || ps 2>/dev/null | grep ' + pkg);
      parts.push('echo @@CR', "logcat -b crash -d -v epoch -t 80 2>/dev/null | grep 'Process: '");
      if (server) parts.push('echo @@SRV', 'ping -c 1 -W 2 ' + server + ' 2>/dev/null | grep time');
      if (checkKeeper) parts.push('echo @@KP', 'pm path ' + KEEPER_PKG + ' 2>/dev/null');
      parts.push('echo @@END');
      const t0 = now();
      const res = await shell(b, parts.join('; '), 15000);
      const t1 = now();
      const out = String(res.out || '');
      if (!/@@END/.test(out)) {
        h.probeError = (res.err || 'The board did not answer the check.').split(/\r?\n/)[0].slice(0, 200);
        h.probeAt = now() - EVERY + 6000;  // try again in about 6 s, not a full beat later
        return false;
      }
      h.probeError = '';
      const f = parseFacts(sections(out), t0, t1, pkg, server, checkKeeper);
      if (checkKeeper) { h.keeper = f.keeper; h.keeperAt = now(); }
      // restarts the board or app did on their own
      const ours = now() - h.actAt < 3 * 60000;
      if (h.prevUptime !== null && f.uptime !== null && f.uptime + 5 < h.prevUptime) {
        h.acc.restart = true;
        if (!ours) ev('info', label(b) + ' rebooted on its own and was back after ' + dur(f.uptime * 1000) + '.', b.id);
      }
      if (pkg && h.prevPid && f.pid && f.pid !== h.prevPid) {
        h.acc.restart = true;
        if (!ours) ev('info', label(b) + ': ' + pkg + ' restarted on its own.', b.id);
      }
      h.prevUptime = f.uptime; if (f.pid) h.prevPid = f.pid;
      for (const cr of f.crashLines) {
        const key = cr.pid + ':' + Math.round(cr.t / 1000);
        if (h.crashKeys.indexOf(key) >= 0) continue;
        h.crashKeys.push(key);
        h.crashes.push({ t: cr.t, pkg: cr.pkg });
        if (now() - cr.t < 2 * 60000) h.acc.restart = true;
      }
      if (h.crashKeys.length > 80) h.crashKeys = h.crashKeys.slice(-60);
      h.crashes = h.crashes.filter(x => now() - x.t < 60 * 60000);
      h.facts = f; h.lastBeat = now(); h.acc.ok = true;
      r.app = f.fgPkg || r.app; r.activity = f.fgAct || r.activity; r.awake = f.awake; r.liveAt = now();
      const faults = computeFaults(b, h, f);
      const seen = {};
      for (const x of faults) { seen[x.kind] = 1; h.streak[x.kind] = (h.streak[x.kind] || 0) + 1; }
      for (const k of Object.keys(h.streak)) if (!seen[k]) delete h.streak[k];
      h.faults = faults;
      if (faults.length) h.acc.fault = true;
      return true;
    } catch (e) {
      log('health probe', b.name, e.stack || e);
      return false;
    } finally {
      h.probing = false;
    }
  }

  function computeFaults(b, h, f) {
    const c = cfg(), out = [];
    const pkg = PKG_RE.test(b.app || '') ? b.app : '';
    if (Math.abs(f.skew) > c.clockDriftSeconds) out.push({ kind: 'clock', sev: 'caution', title: 'Clock ' + skewText(f.skew) });
    const watch = pkg || f.fgPkg;
    const n = watch ? h.crashes.filter(x => x.pkg === watch && now() - x.t < 10 * 60000).length : 0;
    if (n >= 3) out.push({ kind: 'crash', sev: 'urgent', title: 'App crashed ' + n + ' times in 10 min', n });
    if (f.dialog) out.push({ kind: 'dialog', sev: 'caution', title: 'Crash dialog on screen' });
    if (pkg && !f.pid && f.fgPkg !== pkg) out.push({ kind: 'appdown', sev: 'caution', title: 'App not running' });
    else if (pkg && f.awake && f.fgPkg && f.fgPkg !== pkg && !f.dialog) out.push({ kind: 'apphidden', sev: 'caution', title: 'Another app in front' });
    if (f.awake === false && b.kind !== 'tv') out.push({ kind: 'asleep', sev: 'caution', title: 'Screen asleep' });
    if (f.freePct !== null && f.freePct < 5) out.push({ kind: 'storage', sev: 'caution', title: 'Storage ' + f.freePct + '% free' });
    if (f.serverTried && f.serverMs === null) out.push({ kind: 'server', sev: 'caution', title: 'Cannot reach the HCI ONE server' });
    return out;
  }

  /* ---------------- state ---------------- */
  function evaluate(b, t) {
    const h = H(b), r = R(b), c = cfg();
    const offMs = Math.max(30, Number(c.offlineSeconds) || 90) * 1000;
    let st;
    if (!monitored(b)) st = 'paused';
    else if (r.status === 'unauthorized') {
      st = 'degraded';
      h.faults = [{ kind: 'auth', sev: 'caution', title: 'Waiting for Allow on the board' }];
      if (t - (h.authAt || 0) >= BEAT) { h.authAt = t; h.streak.auth = (h.streak.auth || 0) + 1; }
    }
    else if (h.lastBeat >= startedAt) {
      const age = t - h.lastBeat;
      st = age < LATE ? (h.faults.length ? 'degraded' : 'online') : age < offMs ? 'late' : 'offline';
    } else st = t - startedAt < offMs ? 'unknown' : 'offline';
    if (st !== 'degraded' && h.streak.auth) { delete h.streak.auth; h.authAt = 0; h.faults = h.faults.filter(x => x.kind !== 'auth'); }
    if (st !== h.state) {
      const prev = h.state;
      h.state = st;
      h.since = st === 'offline' && h.lastBeat ? h.lastBeat : t;
      if (st === 'offline') { h.offlineAt = h.lastBeat || t; if (prev !== 'unknown') ev('bad', label(b) + ' stopped answering. Last heartbeat ' + (h.lastBeat ? clock(h.lastBeat) : 'unknown') + '.', b.id); }
      if ((st === 'online' || st === 'degraded') && prev === 'offline') ev('ok', label(b) + ' is answering again after ' + dur(t - (h.offlineAt || t)) + '.', b.id);
    }
  }

  function rollSlots(t) {
    let n = 0;
    while (t - slotStart >= BEAT && n < SLOTS + 1) {
      for (const b of store.boards) {
        const h = H(b);
        let code;
        if (h.acc.ok) code = h.acc.restart ? 2 : h.acc.fault ? 3 : 1;
        else code = monitored(b) && slotStart >= startedAt - 1000 && h.state !== 'unknown' ? 0 : -1;
        h.beats.push(code); h.beats.shift();
        h.acc = { ok: false, restart: false, fault: false };
      }
      slotStart += BEAT; n++;
    }
    if (t - slotStart >= BEAT) slotStart = Math.floor(t / BEAT) * BEAT;
    return n > 0;
  }

  /* ---------------- groups (one closet or one network going down together) ---------------- */
  function groupKey(b) {
    if (b.closet) return 'closet:' + b.closet.trim().toLowerCase();
    if (IPV4_RE.test(b.host)) return 'net:' + b.host.split('.').slice(0, 3).join('.');
    return null;
  }
  function groupLabel(b) { return b.closet ? b.closet : IPV4_RE.test(b.host) ? 'Network ' + b.host.split('.').slice(0, 3).join('.') + '.x' : b.host; }
  function groupsDown() {
    const map = new Map();
    for (const b of store.boards) {
      if (!monitored(b)) continue;
      const k = groupKey(b); if (!k) continue;
      if (!map.has(k)) map.set(k, { key: k, label: groupLabel(b), all: [], down: [] });
      const g = map.get(k); g.all.push(b);
      if (H(b).state === 'offline') g.down.push(b);
    }
    const out = [];
    for (const g of map.values()) {
      if (g.down.length < 3) continue;
      const times = g.down.map(b => H(b).offlineAt || 0).sort((a, b) => a - b);
      const span = times[times.length - 1] - times[0];
      if (span <= 120000) out.push(Object.assign(g, { span }));
    }
    return out;
  }
  function peersUp(b) {
    const k = groupKey(b); if (!k) return 0;
    return store.boards.filter(x => x.id !== b.id && monitored(x) && groupKey(x) === k && (H(x).state === 'online' || H(x).state === 'degraded')).length;
  }

  /* ---------------- first read: what is wrong, who owns it ---------------- */
  const ORDER = ['auth', 'crash', 'dialog', 'appdown', 'clock', 'apphidden', 'server', 'asleep', 'storage'];
  function readFor(b, grp) {
    const h = H(b), r = R(b), c = cfg(), f = h.facts || {};
    const pkg = b.app || '';
    if (h.state === 'paused') return { headline: 'Paused. Board Remote is not watching this board.', detail: 'You disconnected it, or Keep connected is off, so nothing is checked and no alerts go out.', owner: [], fix: null, fixNote: 'Click Connect on the Boards view to watch it again.', conf: '' };
    if (h.state === 'unknown') return { headline: 'Checking this board.', detail: 'Board Remote just started. The first heartbeat arrives within about 30 seconds.', owner: [], fix: null, fixNote: '', conf: '' };
    if (h.state === 'offline' || h.state === 'late') {
      grp = grp || groupsDown().find(g => g.down.indexOf(b) >= 0);
      if (grp) return { headline: grp.label + ' is down, not ' + grp.down.length + ' boards.', detail: grp.down.length + ' of ' + grp.all.length + ' boards on ' + grp.label + ' stopped answering within ' + Math.max(1, Math.round(grp.span / 1000)) + ' s of each other. That points at the switch, its uplink or the network, not the boards. Remote fixes cannot reach them.', owner: ['Hospital IT'], fix: null, fixNote: 'No remote fix. Needs hands at the closet or on the network.', conf: 'High' };
      if (h.reach === 'nonet') return { headline: 'This PC has no route to the board.', detail: b.host + ' is on a network this PC is not connected to right now. Check that this PC is on the device network or its VPN.', owner: ['HCI'], fix: null, fixNote: 'Connect this PC to the device network.', conf: 'High' };
      if (h.reach === 'refused') return { headline: 'The board is on, but network ADB is off.', detail: b.host + ' answers on the network, but nothing is listening on port ' + b.port + '. That usually happens after a reboot on a board without the HCI ONE ADB keeper or the persist.adb.tcp.port setting.', owner: ['HCI'], fix: null, fixNote: 'Plug it into this PC by USB, use USB to WiFi on the Boards view, then install the ADB keeper.', conf: 'High' };
      if (h.state === 'late') return { headline: 'Heartbeat late. Watching, no alert yet.', detail: 'Last heartbeat ' + dur(now() - h.lastBeat) + ' ago. Expected every 30 s. An alert goes out at ' + c.offlineSeconds + ' s.', owner: [], fix: null, fixNote: 'Nothing to do yet.', conf: 'Medium' };
      if (h.reach === 'open' && r.status === 'online') return { headline: 'ADB is connected, but the board stopped answering commands.', detail: 'The network and the ADB link are up, but the board did not run the heartbeat check' + (h.probeError ? ' (' + h.probeError + ')' : '') + '. It may be frozen or very busy.', owner: ['HCI'], fix: 'reboot', fixNote: 'Remote fix: Reboot board.', conf: 'Medium' };
      const up = peersUp(b);
      return { headline: 'No answer from the board. Power or network.', detail: 'Last heartbeat ' + (h.lastBeat ? 'at ' + clock(h.lastBeat) : 'unknown') + '. ' + b.host + ' does not answer this PC at all' + (up ? ', while ' + up + ' other board' + (up > 1 ? 's' : '') + ' on the same network still answer, so the problem is at this board: power, cable or its switch port.' : '.'), owner: ['Hospital IT', 'HCI'], fix: null, fixNote: 'No remote fix. Check power and the network cable at the board, or its switch port.', conf: up ? 'High' : 'Medium' };
    }
    const faults = h.faults.slice().sort((a, x) => ORDER.indexOf(a.kind) - ORDER.indexOf(x.kind));
    const top = faults[0];
    const also = faults.slice(1).map(x => x.title);
    const withAlso = d => also.length ? d + ' Also: ' + also.join(', ') + '.' : d;
    if (!top) return { headline: 'Healthy. Every layer checks out.', detail: 'Heartbeat is steady every 30 s.' + (pkg ? '' : ' Set the board app in Edit so Board Remote watches it too.'), owner: [], fix: null, fixNote: '', conf: '' };
    const app = pkg || f.fgPkg || 'The app';
    const R2 = {
      auth: { headline: 'Waiting for someone to tap Allow on the board.', detail: 'The board answers on ' + b.port + ' but has not approved this PC yet. Tap Allow and tick Always allow from this computer.', owner: ['HCI'], fix: null, fixNote: 'Needs a person at the board, once.' },
      crash: { headline: 'The app keeps crashing.', detail: app + ' crashed ' + top.n + ' times in the last 10 minutes. Pull logs to see the error. If it started after an update, drop the last good APK on the board card to roll back.', owner: ['HCI'], fix: 'restart', fixNote: 'Remote fix: Restart app. If it crashes again, roll back the APK.' },
      dialog: { headline: 'A crash dialog is covering the screen.', detail: 'Android is showing "' + f.dialog + '". The app stopped or froze.', owner: ['HCI'], fix: 'restart', fixNote: 'Remote fix: Restart app.' },
      appdown: { headline: 'The HCI app is not running.', detail: pkg + ' is not running' + (f.fgPkg ? '. ' + f.fgPkg + ' is on screen instead.' : '.'), owner: ['HCI'], fix: 'restart', fixNote: 'Remote fix: Restart app.' },
      clock: { headline: 'The clock is off by ' + (Math.abs(f.skew) >= 90 ? Math.round(Math.abs(f.skew) / 60) + ' min.' : Math.round(Math.abs(f.skew)) + ' s.'), detail: 'The board clock is ' + skewText(f.skew) + '. Apps that sign in to the HCI ONE server can be locked out when the clock is off by minutes. Time server traffic (NTP) may be blocked on this network.', owner: ['HCI', 'Hospital IT'], fix: 'clock', fixNote: 'Remote fix: Sync clock. If it drifts again, ask Hospital IT to allow NTP (UDP 123).' },
      apphidden: { headline: 'Another app is in front of the HCI app.', detail: f.fgPkg + ' is on screen. ' + pkg + ' is running behind it.', owner: ['HCI'], fix: 'restart', fixNote: 'Remote fix: Restart app brings it back to the front.' },
      server: { headline: 'The board cannot reach the HCI ONE server.', detail: 'A ping from the board to ' + c.serverHost + ' got no answer, while this PC reaches the board fine. Routing or a firewall between the device network and the server is the likely cause.', owner: ['Hospital IT', 'HCI'], fix: null, fixNote: 'No remote fix. Check the route and firewall to the server.' },
      asleep: { headline: 'The screen is asleep.', detail: 'The board is up and answering, but its screen is off (' + (f.wake || 'asleep') + ').', owner: ['HCI'], fix: 'wake', fixNote: 'Remote fix: Wake screen.' },
      storage: { headline: 'Storage is almost full.', detail: 'Only ' + f.freePct + '% of storage is free. Apps can fail to update or save data.', owner: ['HCI'], fix: 'storage', fixNote: 'Remote fix: Free up storage clears app caches.' }
    }[top.kind];
    return Object.assign({ conf: 'High' }, R2, { detail: withAlso(R2.detail) });
  }

  /* ---------------- check chain: power up to the screen ---------------- */
  function chainFor(b) {
    const h = H(b), r = R(b), c = cfg(), f = h.facts || {}, t = now();
    const fresh = h.lastBeat >= startedAt && t - h.lastBeat < LATE;
    const pkg = b.app || '';
    const last = h.lastBeat ? 'Last report at ' + clock(h.lastBeat) : 'No report yet';
    if (h.state === 'paused') return ['Power', 'Link', 'Network', 'Network ADB', 'Clock', 'HCI ONE server', 'App', 'Screen'].map(n => ['skip', n, 'Paused. Not checked.', '']);
    if (!fresh && h.state !== 'unknown') {
      const grp = groupsDown().find(g => g.down.indexOf(b) >= 0);
      const refused = h.reach === 'refused', nonet = h.reach === 'nonet';
      const auth = r.status === 'unauthorized';
      const ans = refused || auth || (h.reach === 'open');
      return [
        ans ? ['pass', 'Power', 'Powered. The board answers on the network.', ''] : ['skip', 'Power', 'Unknown. The board does not answer.', ''],
        ans ? ['pass', 'Link', 'Network link up.', ''] : grp ? ['fail', 'Link', grp.down.length + ' of ' + grp.all.length + ' boards on ' + grp.label + ' went quiet within ' + Math.max(1, Math.round(grp.span / 1000)) + ' s of each other.', grp.down.length + ' of ' + grp.all.length + ' down'] : ['fail', 'Link', 'Stopped answering at ' + (h.lastBeat ? clock(h.lastBeat) : 'unknown') + '.' + (peersUp(b) ? ' Others on the same network still answer.' : ''), peersUp(b) ? 'others up' : ''],
        ans ? ['pass', 'Network', 'Answers this PC in ' + (h.connectMs || 0) + ' ms.', b.host] : nonet ? ['fail', 'Network', 'This PC has no route to ' + b.host + '.', 'no route'] : ['fail', 'Network', 'No answer from ' + b.host + ' to any check from this PC.', 'no answer'],
        refused ? ['fail', 'Network ADB', 'Nothing listening on port ' + b.port + '. Network ADB is off, usually after a reboot.', 'refused'] : auth ? ['warn', 'Network ADB', 'Answering, but waiting for someone to tap Allow on the board.', 'not approved'] : h.reach === 'open' ? ['fail', 'Network ADB', 'Connected, but the board did not answer the heartbeat check.', 'no reply'] : ['skip', 'Network ADB', 'Not tested. Nothing below it answers.', ''],
        ['skip', 'Clock', last + '.', ''],
        ['skip', 'HCI ONE server', 'Not tested.', ''],
        ['skip', 'App', f.fgPkg ? last + ': ' + (pkg || f.fgPkg) + ' running.' : last + '.', ''],
        ['skip', 'Screen', f.awake === null || f.awake === undefined ? last + '.' : last + ': screen ' + (f.awake ? 'on' : 'off') + '.', '']
      ];
    }
    if (h.state === 'unknown') return ['Power', 'Link', 'Network', 'Network ADB', 'Clock', 'HCI ONE server', 'App', 'Screen'].map(n => ['skip', n, 'Checking.', '']);
    const has = k => h.faults.some(x => x.kind === k);
    const rows = [];
    rows.push(f.freePct !== null && f.freePct < 5 ? ['warn', 'Power', 'Powered on, up ' + dur((f.uptime || 0) * 1000) + '. Storage only ' + f.freePct + '% free.', f.freePct + '% free'] : ['pass', 'Power', 'Powered on, up ' + dur((f.uptime || 0) * 1000) + (f.freePct !== null ? ' · storage ' + f.freePct + '% free' : '') + '.', f.uptime ? 'booted ' + clock(t - f.uptime * 1000) : '']);
    if (f.wired) rows.push(['pass', 'Link', 'Wired' + (f.ethSpeed ? ' at ' + (f.ethSpeed >= 1000 ? f.ethSpeed / 1000 + ' Gbps' : f.ethSpeed + ' Mbps') : '') + '.', f.ethSpeed ? (f.ethSpeed >= 1000 ? f.ethSpeed / 1000 + ' Gbps' : f.ethSpeed + ' Mbps') : 'wired']);
    else if (f.wifiLevel !== null) rows.push([f.wifiLevel < -78 ? 'warn' : 'pass', 'Link', 'WiFi, signal ' + f.wifiLevel + ' dBm' + (f.wifiLevel < -78 ? '. Weak; drops are likely.' : '.'), f.wifiLevel + ' dBm']);
    else rows.push(['pass', 'Link', 'Network link up.', '']);
    const ip = (f.ifaces || [])[0];
    rows.push(['pass', 'Network', 'Answers this PC in ' + (h.connectMs === null ? '?' : h.connectMs) + ' ms' + (ip ? ' · ' + ip.name + ' ' + ip.ip : '') + '.', b.host]);
    rows.push(['pass', 'Network ADB', 'Answering on ' + b.port + ' and approved for this PC.' + (b.port === ctx.CAMERA_PORT ? ' Camera port, no keeper needed.' : h.keeper ? ' ADB keeper installed.' : h.keeper === false ? ' No ADB keeper on this board.' : ''), 'port ' + b.port]);
    rows.push(has('clock') ? ['fail', 'Clock', 'The clock is ' + skewText(f.skew) + '. Sign ins can be refused.', (f.skew > 0 ? '+' : '') + Math.round(f.skew) + ' s'] : ['pass', 'Clock', 'Within ' + Math.max(1, Math.round(Math.abs(f.skew || 0))) + ' s of this PC.', '']);
    if (!c.serverHost) rows.push(['skip', 'HCI ONE server', 'Not set up. Add the server address in Settings to test it from every board.', '']);
    else rows.push(has('server') ? ['warn', 'HCI ONE server', 'The board cannot reach ' + c.serverHost + '.', 'no reply'] : ['pass', 'HCI ONE server', 'The board reaches ' + c.serverHost + ' in ' + f.serverMs + ' ms.', f.serverMs + ' ms']);
    const crashes = (pkg || f.fgPkg) ? h.crashes.filter(x => x.pkg === (pkg || f.fgPkg) && t - x.t < 10 * 60000).length : 0;
    if (!pkg) rows.push(['skip', 'App', 'On screen: ' + (f.fgPkg || 'unknown') + '. Set the board app in Edit to watch it.', crashes ? crashes + ' crashes' : '']);
    else if (has('crash')) rows.push(['fail', 'App', pkg + ' crashed ' + crashes + ' times in 10 min.', crashes + ' crashes']);
    else if (has('appdown')) rows.push(['fail', 'App', pkg + ' is not running.', 'not running']);
    else if (has('apphidden')) rows.push(['warn', 'App', pkg + ' is running, but ' + f.fgPkg + ' is in front.', 'behind']);
    else rows.push(['pass', 'App', pkg + ' running and in front.', crashes + ' crashes']);
    if (has('dialog')) rows.push(['fail', 'Screen', 'Crash dialog on screen: ' + f.dialog + '.', 'dialog']);
    else if (has('asleep')) rows.push(['warn', 'Screen', 'Screen is off (' + (f.wake || 'asleep') + ').', 'off']);
    else rows.push(['pass', 'Screen', f.awake === false ? 'Screen off. Normal for a TV.' : 'Awake. Nothing covering the app.', '']);
    return rows;
  }

  /* ---------------- issues and alerts ---------------- */
  const TITLES = { clock: 'Clock off', crash: 'App crash loop', dialog: 'Crash dialog on screen', appdown: 'App not running', apphidden: 'Another app in front', asleep: 'Screen asleep', storage: 'Storage almost full', server: 'Cannot reach the HCI ONE server', auth: 'Waiting for Allow on the board' };
  function openIssue(key, o) {
    const i = Object.assign({ id: crypto.randomBytes(4).toString('hex'), key, openedAt: now(), resolvedAt: 0, told: [], escAt: 0, escalated: false, acked: false }, o);
    issues.push(i);
    if (issues.length > 300) issues = issues.slice(-200);
    return i;
  }
  function evaluateIssues(t) {
    const c = cfg();
    const want = new Map();
    const grouped = new Set();
    for (const g of groupsDown()) {
      g.down.forEach(b => grouped.add(b.id));
      const rd = readFor(g.down[0], g);
      want.set('group:' + g.key, { kind: 'group', sev: 'urgent', title: g.label + ' not answering', where: g.down.length + ' boards · ' + listJoin(g.down.slice(0, 4).map(label)) + (g.down.length > 4 ? ' and more' : ''), boards: g.down.map(b => b.id), owner: rd.owner, headline: rd.headline, esc: true });
    }
    // A closet alert that is already open keeps covering its boards until each one is back. After a power or switch
    // outage boards boot at different times, and the last few back should not each raise a new alert of their own.
    for (const i of issues) {
      if (i.resolvedAt || i.kind !== 'group' || want.has(i.key)) continue;
      const still = (i.boards || []).map(id => store.boards.find(x => x.id === id)).filter(b => b && monitored(b) && !grouped.has(b.id) && (H(b).state === 'offline' || H(b).state === 'late'));
      if (!still.length) continue;
      still.forEach(b => grouped.add(b.id));
      want.set(i.key, { kind: 'group', sev: 'urgent', title: i.title, where: (still.length === 1 ? '1 board' : still.length + ' boards') + ' still down · ' + listJoin(still.slice(0, 4).map(label)) + (still.length > 4 ? ' and more' : ''), boards: still.map(b => b.id), owner: i.owner, headline: i.headline, esc: true });
    }
    for (const b of store.boards) {
      if (!monitored(b) || grouped.has(b.id)) continue;
      const h = H(b);
      if (h.state === 'offline') {
        const rd = readFor(b);
        want.set('offline:' + b.id, { kind: 'offline', sev: 'urgent', title: kindName(b) + ' offline', where: label(b) + ' · ' + where(b), boards: [b.id], owner: rd.owner.length ? rd.owner : ['HCI'], headline: rd.headline, esc: true });
      } else if (h.state === 'degraded') {
        for (const x of h.faults) {
          if ((h.streak[x.kind] || 0) < (x.kind === 'crash' ? 1 : 2)) continue;
          const rd = readFor(b);
          const own = x.kind === 'server' ? ['Hospital IT', 'HCI'] : x.kind === 'clock' ? ['HCI'] : ['HCI'];
          want.set('fault:' + x.kind + ':' + b.id, { kind: x.kind, sev: x.sev, title: TITLES[x.kind] || x.title, where: label(b) + ' · ' + x.title, boards: [b.id], owner: own, headline: rd.headline, esc: false });
        }
      }
    }
    const open = issues.filter(i => !i.resolvedAt);
    for (const i of open) {
      if (want.has(i.key)) { const w = want.get(i.key); i.where = w.where; i.boards = w.boards; i.headline = w.headline; continue; }
      i.resolvedAt = t;
      const watched = (i.boards || []).map(id => store.boards.find(x => x.id === id)).filter(x => x && monitored(x));
      if (!watched.length) { i.stopped = true; ev('info', 'Stopped watching ' + i.where.split(' · ')[0] + ', so ' + i.title.toLowerCase() + ' was closed without an all clear.'); continue; }
      ev('ok', i.title + ' is fixed (' + i.where.split(' · ')[0] + ').');
      if (i.told.length) notify(i, 'clear');
    }
    for (const [key, w] of want) {
      if (open.some(i => i.key === key)) continue;
      const i = openIssue(key, w);
      if (w.esc) i.escAt = t + Math.max(1, Number(c.escalateMinutes) || 5) * 60000;
      notify(i, 'alert');
    }
    for (const i of issues) {
      if (i.resolvedAt || !i.escAt || i.escalated || i.acked || t < i.escAt) continue;
      i.escalated = true;
      notify(i, 'escalation');
    }
  }

  function recipients(owners) {
    const c = cfg(), out = new Map();
    const add = (name, url) => { const k = url || ''; if (!out.has(k)) out.set(k, { url, names: [] }); if (out.get(k).names.indexOf(name) < 0) out.get(k).names.push(name); };
    for (const o of owners.length ? owners : ['HCI']) {
      if (/hospital it/i.test(o)) add('Hospital IT', c.teamsIt || c.teamsHci);
      else add('HCI Support', c.teamsHci);
    }
    return Array.from(out.values());
  }
  function messageFor(i, type) {
    const site = cfg().site ? ' at ' + cfg().site : '';
    if (type === 'clear') return { title: 'All clear: ' + i.title, text: i.where + ' is healthy again' + site + '. Open for ' + dur(now() - i.openedAt) + '.' };
    if (type === 'escalation') return { title: 'Escalated: ' + i.title, text: 'Nobody has acknowledged this for ' + dur(now() - i.openedAt) + '. ' + i.where + site + '. ' + (i.headline || '') };
    if (type === 'found') return { title: i.title, text: i.where };
    return { title: (i.sev === 'urgent' ? 'Urgent: ' : '') + i.title, text: i.where + site + '. First read: ' + (i.headline || '') };
  }
  function notify(i, type) {
    const c = cfg();
    const msg = messageFor(i, type);
    let owners = type === 'escalation' ? ['Hospital IT', 'HCI'] : (i.owner || ['HCI']);
    if (type === 'clear') owners = i.told.slice();
    const list = recipients(owners.map(x => x === 'HCI Support' ? 'HCI' : x));
    const pop = popup(msg.title, msg.text);
    list.forEach((rcp, idx) => {
      const n = { id: crypto.randomBytes(4).toString('hex'), issue: i.id || null, type, to: listJoin(rcp.names), at: now(), title: msg.title, msg: msg.text, ch: [], delivery: {}, ack: null };
      if (rcp.url) { n.ch.push('Teams'); n.delivery.Teams = 'sending'; postWebhook(rcp.url, msg.title, msg.text).then(s => { n.delivery.Teams = s; if (s !== 'sent') log('Teams post failed', s); }); }
      else { n.ch.push('Board Remote'); n.delivery['Board Remote'] = 'logged here, no Teams link set'; }
      if (idx === 0 && pop !== 'off') { n.ch.push('Pop up'); n.delivery['Pop up'] = pop; }
      notices.push(n);
      if (i.told) for (const nm of rcp.names) if (i.told.indexOf(nm) < 0 && type !== 'clear') i.told.push(nm === 'HCI Support' ? 'HCI Support' : nm);
    });
    if (notices.length > 400) notices = notices.slice(-300);
  }

  function postWebhook(url, title, text) {
    return new Promise(resolve => {
      let u;
      try { u = new URL(url); } catch (e) { return resolve('failed: not a valid link'); }
      if (u.protocol !== 'https:') return resolve('failed: the link must start with https');
      const teams = /office\.com|logic\.azure\.com|powerplatform\.com|powerautomate|microsoft\.com/i.test(u.hostname);
      const body = teams
        ? JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true }, { type: 'TextBlock', text, wrap: true }, { type: 'TextBlock', text: 'HCI ONE Board Remote', isSubtle: true, size: 'Small' }] } }] })
        : JSON.stringify({ text: title + '\n' + text });
      const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 12000 }, res => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300 ? 'sent' : 'failed: answered ' + res.statusCode);
      });
      req.on('timeout', () => { req.destroy(); resolve('failed: timed out'); });
      req.on('error', e => resolve('failed: ' + (e.code || e.message)));
      req.end(body);
    });
  }

  function popup(title, text) {
    if (!cfg().popups) return 'off';
    if (!IS_WIN) return 'off';
    const ps = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;" +
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;" +
      "$e = [System.Security.SecurityElement]; $x = New-Object Windows.Data.Xml.Dom.XmlDocument;" +
      "$x.LoadXml('<toast><visual><binding template=''ToastGeneric''><text>' + $e::Escape($env:BR_T) + '</text><text>' + $e::Escape($env:BR_B) + '</text></binding></visual></toast>');" +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))";
    try {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
        { env: Object.assign({}, process.env, { BR_T: String(title).slice(0, 120), BR_B: String(text).slice(0, 300) }), windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return 'shown';
    } catch (e) { return 'failed'; }
  }

  /* ---------------- remote console ---------------- */
  const ACTIONS = {
    restart: { label: 'Restart app', note: 'The app closes and opens again in about 10 s.' },
    wake: { label: 'Wake screen', note: 'Turns the screen on.' },
    clock: { label: 'Sync clock', note: 'Sets the board clock from this PC, then checks it.' },
    storage: { label: 'Free up storage', note: 'Clears app caches on the board. App data is kept.' },
    reconnect: { label: 'Reconnect ADB', note: 'Drops the ADB link and opens it again.' },
    keeper: { label: 'Install ADB keeper', note: 'Installs HCI ONE ADB so network ADB stays on through reboots.' },
    reboot: { label: 'Reboot board', note: 'The screen goes dark for about a minute.' }
  };
  function actionsFor(b) {
    const h = H(b), r = R(b);
    const fresh = h.lastBeat >= startedAt && now() - h.lastBeat < LATE && r.status === 'online';
    const list = ['restart', 'reboot', 'wake', 'clock', 'storage', 'reconnect'];
    if (fs.existsSync(KEEPER_APK) && h.keeper !== true && b.port !== ctx.CAMERA_PORT) list.push('keeper');   // cameras keep 65037 on their own
    return list.map(a => {
      let block = '';
      if (h.busy) block = 'A command is already running on this board.';
      else if (a === 'reconnect') block = monitored(b) ? '' : 'Connect the board on the Boards view first.';
      else if (!fresh) block = h.reach === 'refused' ? 'Network ADB is off on this board, so remote fixes cannot reach it.' : 'The board is not answering ADB, so remote fixes cannot reach it.';
      else if (a === 'restart' && !(b.app || (h.facts && h.facts.fgPkg))) block = 'Board Remote does not know which app to restart. Set the app in Edit.';
      return { key: a, label: ACTIONS[a].label, note: ACTIONS[a].note, block };
    });
  }
  async function cmd(b, h, args, timeout) {
    stamp(h, '$ adb -s ' + serialOf(b) + ' ' + args.join(' '), 'cmd');
    const res = await adb(['-s', serialOf(b)].concat(args), { timeout: timeout || 12000 });
    const text = (String(res.out || '') + (res.err ? '\n' + res.err : '')).trim();
    if (text) stamp(h, text.split(/\r?\n/).slice(0, 4).join('\n'));
    return res;
  }
  function pc2board(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return { toybox: p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + d.getUTCFullYear() + '.' + p(d.getUTCSeconds()), epoch: Math.floor(t / 1000) };
  }
  async function runAction(b, act) {
    const h = H(b);
    if (h.busy) return { ok: false, message: 'A command is already running on this board.' };
    const a = actionsFor(b).find(x => x.key === act);
    if (!a) return { ok: false, message: 'Unknown fix.' };
    if (a.block) return { ok: false, message: a.block };
    h.busy = act; h.actAt = now();
    stamp(h, hms(now()) + '  ' + ACTIONS[act].label + ' on ' + label(b));
    (async () => {
      let ok = false, fin = '';
      try {
        const pkg = b.app || (h.facts && h.facts.fgPkg) || '';
        if (act === 'restart') {
          await cmd(b, h, ['shell', 'am force-stop ' + pkg]);
          const res = await cmd(b, h, ['shell', 'monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1'], 15000);
          if (/No activities found|aborted/i.test(String(res.out) + res.err)) await cmd(b, h, ['shell', 'input keyevent 3']);
          await sleep(4000); await probeBoard(b);
          const f = h.facts || {};
          ok = !!(f.pid || f.fgPkg === pkg) && !h.faults.some(x => ['appdown', 'apphidden', 'dialog'].indexOf(x.kind) >= 0);
          fin = ok ? pkg + ' is running and in front again.' : pkg + ' did not come back to the front. Pull logs to see why.';
        } else if (act === 'wake') {
          await cmd(b, h, ['shell', 'input keyevent 224']);
          await sleep(1500); await probeBoard(b);
          ok = h.facts && h.facts.awake === true;
          fin = ok ? 'Screen is on.' : 'The screen did not turn on. Some panels need their power button or a timer setting.';
        } else if (act === 'clock') {
          const before = h.facts ? h.facts.skew : null;
          const s = pc2board(now());
          const rr = await cmd(b, h, ['shell', 'su -c "date -u ' + s.toybox + ' || date @' + s.epoch + '; am broadcast -a android.intent.action.TIME_SET" 2>&1'], 15000);
          await sleep(1200); await probeBoard(b);
          let after = h.facts ? h.facts.skew : null;
          if (after !== null && Math.abs(after) > 5) {
            stamp(h, 'No root, or the date was not accepted. Trying automatic time instead.');
            const c = cfg();
            if (c.ntpServer && HOST_RE.test(c.ntpServer)) await cmd(b, h, ['shell', 'settings put global ntp_server ' + c.ntpServer]);
            await cmd(b, h, ['shell', 'settings put global auto_time 0; settings put global auto_time 1']);
            await sleep(6000); await probeBoard(b);
            after = h.facts ? h.facts.skew : null;
          }
          ok = after !== null && Math.abs(after) <= Math.min(10, cfg().clockDriftSeconds);
          fin = ok ? 'Clock is ' + skewText(after) + ' now' + (before !== null ? ' (was ' + skewText(before) + ').' : '.') : 'The clock is still ' + (after !== null ? skewText(after) : 'off') + '. Setting it needs root, or a time server the board can reach. Ask Hospital IT to allow NTP (UDP 123).' + (/not found|permission/i.test(String(rr.out) + rr.err) ? ' This board has no root.' : '');
        } else if (act === 'storage') {
          const before = h.facts ? h.facts.freePct : null;
          await cmd(b, h, ['shell', 'pm trim-caches 999G'], 60000);
          await probeBoard(b);
          const after = h.facts ? h.facts.freePct : null;
          ok = after !== null && after >= 5;
          fin = 'Storage ' + (after === null ? 'unknown' : after + '% free') + (before !== null ? ' (was ' + before + '%).' : '.') + (ok ? '' : ' Still low. Large app data or files need a person to clear them.');
        } else if (act === 'reconnect') {
          await cmd(b, h, ['disconnect']).catch(() => {});
          const res = await adb(['connect', serialOf(b)], { timeout: 12000 });
          stamp(h, '$ adb connect ' + serialOf(b), 'cmd'); stamp(h, String(res.out || res.err || '').trim());
          await sleep(1500);
          ok = await probeBoard(b);
          fin = ok ? 'ADB link is back and the board answered its heartbeat.' : 'ADB did not come back. ' + (h.reach === 'refused' ? 'Network ADB is off on the board.' : 'The board is not answering.');
        } else if (act === 'keeper') {
          const res = await cmd(b, h, ['install', '-r', KEEPER_APK], 180000);
          if (/Success/.test(String(res.out) + res.err)) {
            await cmd(b, h, ['shell', 'am start -n ' + KEEPER_PKG + '/.MainActivity']);
            await sleep(1500);
            await cmd(b, h, ['shell', 'input keyevent 4']);
            h.keeperAt = 0; await probeBoard(b);
            ok = h.keeper === true;
            fin = ok ? 'HCI ONE ADB keeper installed and started. Network ADB now stays on through reboots (root or the factory setting is still needed on some boards).' : 'Installed, but the keeper did not show up. Open HCI ONE ADB on the board once.';
          } else fin = 'Install failed. ' + ((/Failure.*$/m.exec(String(res.out) + res.err) || [''])[0]);
        } else if (act === 'reboot') {
          if (ctx.stopLive) ctx.stopLive(b.id, 'Rebooting');
          await cmd(b, h, ['reboot']);
          const t0 = now();
          stamp(h, 'Waiting for the board to come back (up to 3 min).');
          await sleep(15000);
          while (now() - t0 < 180000) {
            if (R(b).status === 'online' && await probeBoard(b)) { ok = true; break; }
            await sleep(5000);
          }
          fin = ok ? 'Back in ' + dur(now() - t0) + ' and answering its heartbeat.' : 'Not back after 3 min. ' + (h.reach === 'refused' ? 'It is on the network, but network ADB is off. It needs the ADB keeper or the factory setting.' : 'Check the board in person.');
        }
      } catch (e) {
        fin = 'The fix stopped: ' + e.message;
      }
      stamp(h, fin, ok ? 'fin' : 'fin bad');
      ev(ok ? 'ok' : 'info', ACTIONS[act].label + ' on ' + label(b) + ': ' + fin, b.id);
      h.busy = null; h.actAt = now();
    })().catch(e => { h.busy = null; log('action', e.stack || e); });
    return { ok: true, message: ACTIONS[act].label + ' started on ' + label(b) + '.' };
  }

  async function look(b, view) {
    const h = H(b);
    if (R(b).status !== 'online') return { ok: false, message: 'The board is not connected.' };
    if (view === 'logs') {
      const res = await adb(['-s', serialOf(b), 'logcat', '-d', '-v', 'time', '-t', '200'], { timeout: 15000 });
      const lines = String(res.out || '').split(/\r?\n/).filter(Boolean).slice(-200).map(l => {
        const m = /^\S+\s+\S+\s+([VDIWEF])\//.exec(l);
        return { lv: m ? m[1] : 'I', text: l };
      });
      h.lastLogs = { at: now(), lines: lines.map(x => x.text) };
      return { ok: true, view, at: now(), cmd: 'adb -s ' + serialOf(b) + ' logcat -d -v time -t 200', lines };
    }
    if (view === 'info') {
      const pkg = PKG_RE.test(b.app || '') ? b.app : '';
      const q = ['getprop ro.product.manufacturer', 'getprop ro.product.model', 'getprop ro.serialno', 'getprop ro.build.version.release', 'getprop ro.build.version.sdk', 'getprop ro.build.display.id', 'getprop persist.adb.tcp.port',
        'cat /sys/class/net/wlan0/address 2>/dev/null || echo', 'cat /sys/class/net/eth0/address 2>/dev/null || echo', 'wm size | tail -n 1',
        pkg ? "dumpsys package " + pkg + " | grep -m 1 versionName" : 'echo', 'pm path ' + KEEPER_PKG + ' 2>/dev/null || echo'];
      const res = await shell(b, q.join('; echo @@; '), 15000);
      const v = String(res.out || '').split('@@').map(s => s.trim());
      const f = h.facts || {};
      const kb = k => k === null || k === undefined ? '' : (k / 1048576).toFixed(1) + ' GB';
      const rows = [
        ['Model', [v[0], v[1]].filter(Boolean).join(' ')], ['Serial', v[2] || ''], ['Android', (v[3] || '') + (v[4] ? ' (API ' + v[4] + ')' : '')], ['Build', v[5] || ''],
        ['Uptime', f.uptime ? dur(f.uptime * 1000) : ''], ['Network', (f.ifaces || []).map(i => i.name + ' ' + i.ip).join(', ')],
        ['MAC', [v[7] && 'WiFi ' + v[7].toUpperCase(), v[8] && 'Wired ' + v[8].toUpperCase()].filter(Boolean).join(' · ')],
        ['Network ADB', serialOf(b) + (v[6] ? ' · persist port ' + v[6] : ' · not set to persist')], ['ADB keeper', /package:/.test(v[11] || '') ? 'Installed' : 'Not installed'],
        ['Storage free', f.freeKb ? kb(f.freeKb) + ' of ' + kb(f.totalKb) : (f.freePct !== null && f.freePct !== undefined ? f.freePct + '%' : '')],
        ['Memory free', f.memAvailKb ? kb(f.memAvailKb) + ' of ' + kb(f.memTotalKb) : ''], ['Screen', (v[9] || '').replace(/^.*size:\s*/, '')],
        ['App', pkg ? pkg + ' ' + ((v[10] || '').replace(/^.*versionName=/, '')) : (f.fgPkg || '') + ' (on screen)']
      ].filter(r => r[1]);
      return { ok: true, view, at: now(), cmd: 'adb -s ' + serialOf(b) + ' shell getprop', rows };
    }
    return { ok: false, message: 'Unknown view' };
  }

  /* ---------------- discovery and claim ---------------- */
  const fidFor = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  // A host is known on its own port, or on any ADB port (5555 or the camera port 65037), so a
  // camera saved on 65037 never shows up again as new because it also answers on 5555.
  const ADB_PORTS = ctx.ADB_PORTS || [5555, 65037];
  function knownHost(host, port) {
    port = port || 5555;
    return store.boards.some(b => b.host === host && (b.port === port || (ADB_PORTS.indexOf(b.port) >= 0 && ADB_PORTS.indexOf(port) >= 0)));
  }
  // A device waiting to be claimed drops off New devices the moment a board with its
  // address (or, over USB, its serial) exists, however that board was added: claimed
  // here, typed in by IP on Boards, or brought in by a room list import.
  function pruneKnown() {
    for (const e of found.values()) {
      if (e.status !== 'found') continue;              // never touch claiming/claimed/ignored
      const gone = e.via === 'usb'
        ? !!(e.serial && store.boards.some(b => (H(b).facts || {}).serial === e.serial))
        : !!(e.host && knownHost(e.host, e.port || 5555));
      if (gone) e.status = 'gone';
    }
  }
  function addFound(o) {
    const id = fidFor(o.key);
    let e = found.get(id);
    if (e) { e.lastSeen = now(); if (o.model && !e.model) e.model = o.model; if (o.mac && !e.mac) e.mac = o.mac; if (e.status === 'gone') e.status = 'found'; return e; }
    e = Object.assign({ id, firstSeen: now(), lastSeen: now(), status: 'found', steps: [], model: '', mac: '' }, o);
    found.set(id, e);
    const where2 = e.via === 'usb' ? 'on USB (' + (e.model || e.serial) + ')' : e.host + ':' + e.port;
    ev('info', 'New device found ' + where2 + '. Waiting for claim.');
    notify({ id: null, title: 'New device found', where: 'Found ' + where2 + (cfg().site ? ' at ' + cfg().site : '') + '. Open Board Remote, New devices, to claim it.', owner: ['HCI'], told: [] }, 'found');
    return e;
  }
  function arpTable() {
    return new Promise(resolve => {
      const c = IS_WIN ? ['arp', ['-a']] : ['ip', ['neigh']];
      execFile(c[0], c[1], { timeout: 6000, windowsHide: true }, (e, out) => {
        const map = {};
        String(out || '').split(/\r?\n/).forEach(l => {
          const m = /(\d+\.\d+\.\d+\.\d+)\D+?([0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2})/i.exec(l);
          if (m) map[m[1]] = m[2].replace(/-/g, ':').toUpperCase();
        });
        resolve(map);
      });
    });
  }
  async function sweep() {
    if (sweeping) return { ok: false, message: 'A sweep is already running.' };
    sweeping = true;
    try {
      // 5555 first; addresses that miss get a second look on the camera port 65037
      const hits = ctx.scanAdb ? await ctx.scanAdb() : (await ctx.scanHosts(5555)).map(host => ({ host, port: 5555 }));
      const arp = hits.length ? await arpTable() : {};
      let n = 0;
      for (const { host, port } of hits) {
        if (knownHost(host, port)) continue;
        const e = found.get(fidFor(host + ':' + port));
        if (e && (e.status === 'ignored' || e.status === 'claimed')) { e.lastSeen = now(); continue; }
        addFound({ key: host + ':' + port, host, port, via: 'network', camera: port === ctx.CAMERA_PORT, mac: arp[host] || '' }); n++;
      }
      lastSweep = now();
      const cams = hits.filter(x => x.port !== 5555).length;
      const said = (hits.length - cams) + ' on 5555' + (cams ? ', ' + cams + ' camera' + (cams > 1 ? 's' : '') + ' on 65037' : '');
      return { ok: true, message: hits.length ? 'Sweep done. ' + said + (n ? ', ' + n + ' new.' : ', nothing new.') : 'Sweep done. Nothing new answered on 5555 or 65037.' };
    } finally { sweeping = false; }
  }
  function onDevices(devs) {
    if (!devs) return;
    for (const s of Object.keys(devs)) {
      const d = devs[s];
      if (ctx.isUsbSerial(s)) {
        if (store.boards.some(b => H(b).facts && H(b).facts.serial === s)) continue;
        const e = found.get(fidFor('usb:' + s));
        if (e && (e.status === 'ignored' || e.status === 'claimed')) continue;
        addFound({ key: 'usb:' + s, serial: s, via: 'usb', model: String(d.model || '').replace(/_/g, ' ') });
      } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) {
        const [host, port] = s.split(':');
        if (knownHost(host, +port)) continue;
        const e = found.get(fidFor(host + ':' + port));
        if (e && (e.status === 'ignored' || e.status === 'claimed')) continue;
        if (e && e.status === 'claiming') continue;
        addFound({ key: host + ':' + port, host, port: +port, via: 'adb', model: String(d.model || '').replace(/_/g, ' ') });
      }
    }
    for (const e of found.values()) {
      if (e.via === 'usb' && e.status === 'found' && !devs[e.serial] && now() - e.lastSeen > 30000) e.status = 'gone';
      if (e.via === 'usb' && devs[e.serial]) e.lastSeen = now();
    }
  }
  function fingerprint() {
    for (const dir of [process.env.ANDROID_USER_HOME, path.join(os.homedir(), '.android')]) {
      if (!dir) continue;
      try {
        const blob = fs.readFileSync(path.join(dir, 'adbkey.pub'), 'utf8').trim().split(/\s+/)[0];
        return crypto.createHash('md5').update(Buffer.from(blob, 'base64')).digest('hex').toUpperCase().match(/../g).join(':');
      } catch (e) { /* try the next place */ }
    }
    return '';
  }

  const CLAIM_STEPS = [
    ['connect', 'Connect over the network'], ['approve', 'Approved on the board'], ['identify', 'Read who it is'],
    ['keep', 'Keep network ADB on'], ['clock', 'Check the clock'], ['app', 'Note the app on screen'],
    ['place', 'Place it'], ['beat', 'First heartbeat']
  ];
  async function claim(e, o) {
    if (e.status === 'claiming') return { ok: false, message: 'Already claiming this device.' };
    if (o.mode === 'replace' && !store.boards.find(x => x.id === o.replaceId)) return { ok: false, message: 'Pick the board to replace.' };
    e.status = 'claiming'; e.error = '';
    e.steps = CLAIM_STEPS.map(s => ({ key: s[0], name: s[1], state: 'pending', text: '', at: 0 }));
    const step = (k, st, text) => { const s = e.steps.find(x => x.key === k); s.state = st; if (text) s.text = text; if (st !== 'now') s.at = now(); };
    (async () => {
      let cur = 'connect';
      try {
        let host = e.host, port = e.port || 5555;
        step('connect', 'now', 'Connecting');
        if (e.via === 'usb') {
          const ipr = await adb(['-s', e.serial, 'shell', 'ip -o -4 addr show'], { timeout: 8000 });
          if (/unauthorized/i.test(ipr.err)) {
            cur = 'approve'; step('connect', 'done', 'On USB.'); step('approve', 'now', 'Tap Allow on the board and tick Always allow from this computer.');
            const t0 = now();
            while (now() - t0 < 120000) { const d = await ctx.listDevices(); if (d && d[e.serial] && d[e.serial].state === 'device') break; await sleep(2000); }
            cur = 'connect'; step('approve', 'pending', '');
          }
          const ipr2 = await adb(['-s', e.serial, 'shell', 'ip -o -4 addr show'], { timeout: 8000 });
          const ips = [];
          for (const l of String(ipr2.out || '').split(/\r?\n/)) {
            const m2 = /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//.exec(l.trim());
            if (m2 && m2[1] !== 'lo' && !/^169\.254\./.test(m2[2])) ips.push(m2[2]);
          }
          if (!ips.length) throw new Error('The board has no network address. Connect it to the network first.');
          host = ips[0];
          port = ctx.usbNetPort ? await ctx.usbNetPort(e.serial, host) : 5555;   // a camera already on 65037 stays there
          if (!ctx.usbNetPort) { await adb(['-s', e.serial, 'tcpip', '5555'], { timeout: 12000 }); await sleep(2500); }
          e.host = host; e.port = port;
        }
        const serial = host + ':' + port;
        let res = await adb(['connect', serial], { timeout: 12000 });
        let text = (String(res.out || '') + ' ' + (res.err || '')).trim();
        if (!/connected to/i.test(text) || /failed|cannot|unable/i.test(text)) throw new Error('Could not connect to ' + serial + '. ' + text.split(/\r?\n/)[0]);
        step('connect', 'done', 'Connected to ' + serial + '.');
        cur = 'approve';
        step('approve', 'now', 'Tap Allow on the board and tick Always allow from this computer. Waiting up to 2 min.');
        const t0 = now(); let ok = false, lastTry = now();
        while (now() - t0 < 120000) {
          const d = await ctx.listDevices();
          const st = d && d[serial] ? d[serial].state : '';
          if (st === 'device') { ok = true; break; }
          if (!st && now() - lastTry > 8000) { lastTry = now(); await adb(['connect', serial], { timeout: 10000 }); }
          await sleep(2000);
        }
        if (!ok) throw new Error('Nobody tapped Allow on the board within 2 minutes.');
        step('approve', 'done', 'Someone at the board approved this PC.');
        cur = 'identify'; step('identify', 'now');
        const idr = await adb(['-s', serial, 'shell', 'getprop ro.product.manufacturer; echo @@; getprop ro.product.model; echo @@; getprop ro.serialno; echo @@; getprop ro.build.version.release; echo @@; cat /sys/class/net/wlan0/address 2>/dev/null; echo @@; cat /sys/class/net/eth0/address 2>/dev/null'], { timeout: 10000 });
        const v = String(idr.out || '').split('@@').map(s => s.trim());
        e.make = v[0] || ''; e.model = v[1] || e.model || ''; e.serialNo = v[2] || ''; e.android = v[3] || '';
        e.mac = e.mac || (v[5] || v[4] || '').toUpperCase();
        step('identify', 'done', [e.make, e.model].filter(Boolean).join(' ') + (e.serialNo ? ', serial ' + e.serialNo : '') + (e.android ? ', Android ' + e.android : '') + (e.mac ? ', MAC ' + e.mac : '') + '.');
        cur = 'keep'; step('keep', 'now');
        if (port === ctx.CAMERA_PORT) step('keep', 'done', 'Camera on port ' + port + '. It keeps its own network ADB, so no keeper is installed.');
        else {
        const has = /package:/.test(String((await adb(['-s', serial, 'shell', 'pm path ' + KEEPER_PKG], { timeout: 8000 })).out || ''));
        if (has) step('keep', 'done', 'HCI ONE ADB keeper is already on this board.');
        else if (fs.existsSync(KEEPER_APK)) {
          const ir = await adb(['-s', serial, 'install', '-r', KEEPER_APK], { timeout: 180000 });
          if (/Success/.test(String(ir.out) + ir.err)) {
            await adb(['-s', serial, 'shell', 'am start -n ' + KEEPER_PKG + '/.MainActivity'], { timeout: 8000 });
            await sleep(1200); await adb(['-s', serial, 'shell', 'input keyevent 4'], { timeout: 6000 });
            step('keep', 'done', 'Installed and started the HCI ONE ADB keeper.');
          } else step('keep', 'warn', 'Could not install the ADB keeper. ' + ((/Failure.*$/m.exec(String(ir.out) + ir.err) || [''])[0]));
        } else {
          const sr = await adb(['-s', serial, 'shell', 'su -c "setprop persist.adb.tcp.port 5555" 2>&1'], { timeout: 8000 });
          step('keep', /not found|denied|permission/i.test(String(sr.out) + sr.err) ? 'warn' : 'done', /not found|denied|permission/i.test(String(sr.out) + sr.err) ? 'No keeper APK in the apks folder and no root. Network ADB may turn off after a reboot.' : 'Set persist.adb.tcp.port to 5555.');
        }
        }
        cur = 'clock'; step('clock', 'now');
        const t1 = now();
        const dr = await adb(['-s', serial, 'shell', 'date +%s'], { timeout: 8000 });
        const skew = Number(String(dr.out).trim()) - (t1 + (now() - t1) / 2) / 1000;
        if (Number.isFinite(skew) && Math.abs(skew) > cfg().clockDriftSeconds) {
          const s = pc2board(now());
          await adb(['-s', serial, 'shell', 'su -c "date -u ' + s.toybox + ' || date @' + s.epoch + '" 2>&1; settings put global auto_time 1'], { timeout: 10000 });
          const t2 = now(); const d2 = await adb(['-s', serial, 'shell', 'date +%s'], { timeout: 8000 });
          const sk2 = Number(String(d2.out).trim()) - (t2 + (now() - t2) / 2) / 1000;
          step('clock', Math.abs(sk2) <= cfg().clockDriftSeconds ? 'done' : 'warn', Math.abs(sk2) <= cfg().clockDriftSeconds ? 'Was ' + skewText(skew) + '. Synced.' : 'The clock is ' + skewText(sk2) + ' and could not be set without root. Automatic time is on.');
        } else step('clock', 'done', Number.isFinite(skew) ? 'Within ' + Math.max(1, Math.round(Math.abs(skew))) + ' s of this PC.' : 'Could not read the clock.');
        cur = 'app'; step('app', 'now');
        const wr = await adb(['-s', serial, 'shell', "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"], { timeout: 8000 });
        const fm = /mCurrentFocus=Window\{[^}]*?\s([A-Za-z]\w*(?:\.\w+)+)\//.exec(String(wr.out)) || /mFocusedApp=.*?\s([A-Za-z]\w*(?:\.\w+)+)\//.exec(String(wr.out));
        const fg = fm ? fm[1] : '';
        const app = PKG_RE.test(o.app || '') ? o.app : (fg && !/launcher|systemui|settings|com\.hci\.one\.adb/i.test(fg) ? fg : '');
        step('app', app ? 'done' : 'warn', app ? 'Watching ' + app + '.' : 'No app picked. ' + (fg ? fg + ' is on screen, which looks like a launcher.' : '') + ' Set it in Edit later.');
        cur = 'place'; step('place', 'now');
        let b;
        const fields = { name: String(o.name || '').trim().slice(0, 60), unit: String(o.unit || '').trim().slice(0, 40), closet: String(o.closet || '').trim().slice(0, 40), room: String(o.room || '').trim().slice(0, 20), kind: KINDS[o.kind] ? o.kind : 'other', app };
        if (o.mode === 'replace') {
          b = store.boards.find(x => x.id === o.replaceId);
          const old = b.host + ':' + b.port;
          await adb(['disconnect', old], { timeout: 5000 });
          b.host = host; b.port = port; b.auto = true;
          if (fields.app) b.app = fields.app;
          if (fields.name) b.name = fields.name;
          R(b).paused = false; R(b).status = 'starting';
          H(b).keeperAt = 0;
          step('place', 'done', 'Replaced ' + old + ' as ' + b.name + '. Its history and alerts carry over.');
        } else {
          b = ctx.normBoard(Object.assign({ host, port, auto: true }, fields, { name: fields.name || [e.model || 'Board', host.split('.').pop()].join(' ') }));
          store.boards.push(b);
          step('place', 'done', 'Added as ' + b.name + (b.room ? ' in Room ' + b.room : '') + (b.unit ? ', ' + b.unit : '') + '.');
        }
        saveStore();
        cur = 'beat'; step('beat', 'now');
        await ctx.connect(b);
        const okBeat = await probeBoard(b);
        step('beat', okBeat ? 'done' : 'warn', okBeat ? 'Heartbeat received. It is on the Device health wall now.' : 'No heartbeat yet. It will keep trying every 30 s.');
        e.status = 'claimed'; e.claimedAt = now(); e.boardId = b.id;
        ev('ok', 'Claimed ' + [e.make, e.model].filter(Boolean).join(' ') + ' at ' + host + ' as ' + b.name + (o.mode === 'replace' ? ' (replacement)' : '') + '.', b.id);
      } catch (err) {
        step(cur, 'fail', err.message);
        e.status = 'found'; e.error = err.message;
        ev('bad', 'Claim stopped for ' + (e.host || e.serial) + ': ' + err.message);
      }
    })().catch(err => log('claim', err.stack || err));
    return { ok: true, message: 'Claiming. Watch the steps.' };
  }

  /* ---------------- Claude diagnosis (optional, needs an API key) ---------------- */
  function evidence(b) {
    const h = H(b), r = R(b), f = h.facts || {}, t = now(), c = cfg();
    const k = groupKey(b);
    const peers = store.boards.filter(x => x.id !== b.id && k && groupKey(x) === k);
    const ctx2 = {
      board: { name: b.name, type: kindName(b), unit: b.unit || '', closet: b.closet || '', room: b.room || '', address: serialOf(b), make_model: [r.make, r.model].filter(Boolean).join(' '), android: r.android || '', watched_app: b.app || 'not set', state: h.state, in_this_state_for: dur(t - h.since), last_heartbeat: h.lastBeat ? dur(t - h.lastBeat) + ' ago' : 'none yet', adb_link: r.status, tcp_check_from_pc: h.reach },
      heartbeat_last_30_min: 'oldest to newest, one character per 30 s. | beat, . missed, R restart or crash in that slot, F beat with a fault, blank no data: ' + h.beats.map(x => x === 1 ? '|' : x === 0 ? '.' : x === 2 ? 'R' : x === 3 ? 'F' : ' ').join(''),
      check_chain_power_to_screen: chainFor(b).map(x => ({ layer: x[1], result: x[0], evidence: x[2], metric: x[3] })),
      faults_now: h.faults.map(x => x.title),
      latest_facts: h.facts ? { clock_offset_s: f.skew, uptime: f.uptime ? dur(f.uptime * 1000) : '', on_screen: f.fgPkg, screen: f.wake, storage_free_pct: f.freePct, wifi_dbm: f.wifiLevel, wired: f.wired, crashes_10_min: h.crashes.filter(x => t - x.t < 600000).length, adb_keeper_installed: h.keeper } : null,
      same_closet_or_network: { boards: peers.length, offline: peers.filter(x => H(x).state === 'offline').length, degraded: peers.filter(x => H(x).state === 'degraded').length },
      remote_fixes_available: actionsFor(b).filter(a => !a.block).map(a => a.label),
      recent_fix_log: h.log.slice(-12).map(l => l.text),
      board_remote_first_read: readFor(b).headline
    };
    if (c.claudeLogs && h.lastLogs && t - h.lastLogs.at < 30 * 60000) ctx2.log_lines_pulled = h.lastLogs.lines.slice(-80);
    return ctx2;
  }
  const SYSTEM = 'You are the Device Health diagnostician in HCI ONE Board Remote. HCI ONE is a smart patient room platform that runs on premise in the hospital. Board Remote runs on a PC and reaches each Android board (whiteboards, door signs, patient TVs, tablets) over network ADB on port 5555, checks it every 30 seconds, and can restart the app, reboot, wake the screen, sync the clock, free storage and reconnect ADB. Hospital IT owns switches, VLANs, DHCP and NTP. HCI owns the boards, the apps and the HCI ONE server. Write for a nurse manager and a hospital IT tech at the same time: plain words, short sentences. Never use hyphens or dashes in your text.';
  function diagPrompt(b) {
    return 'Using only the evidence below, find the most likely root cause for this board, the layer where it breaks, who owns the fix, and whether a remote fix will solve it. If the evidence is thin, say what would confirm it, including whether to pull the screen, the logs or device info. If the board is healthy, say so.\n\nReply with only one JSON object of this shape:\n{"headline":"one sentence under 14 words","cause":"two or three sentences","layer":"power | link | network | network adb | clock | server | app | screen | none","owner":"Hospital IT | HCI | Hospital IT and HCI | none","confidence":"high | medium | low","reset_will_fix":false,"steps":[{"do":"what to do","who":"Hospital IT | HCI | Remote fix"}],"alert":"message to post in Teams to the owners, under 280 characters"}\nGive at most 4 steps, most important first.\n\nEVIDENCE\n' + JSON.stringify(evidence(b), null, 1);
  }
  function callClaude(messages, maxTokens) {
    const c = cfg();
    return new Promise((resolve, reject) => {
      if (!c.claudeKey) return reject(new Error('Add a Claude API key in Settings to use this.'));
      const body = JSON.stringify({ model: c.claudeModel || 'claude-sonnet-5-5', max_tokens: maxTokens || 1500, system: SYSTEM, messages });
      const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 120000,
        headers: { 'x-api-key': c.claudeKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let s = ''; res.setEncoding('utf8');
        res.on('data', d => { s += d; });
        res.on('end', () => {
          let j; try { j = JSON.parse(s); } catch (e) { return reject(new Error('Claude answered with something unreadable.')); }
          if (res.statusCode >= 300) {
            const m = res.statusCode === 401 ? 'The Claude API key was not accepted. Check it in Settings.' : res.statusCode === 429 ? 'Claude is busy for this account. Try again in a minute.' : res.statusCode === 529 ? 'Claude is overloaded right now. Try again shortly.' : 'Claude said: ' + ((j.error && j.error.message) || res.statusCode);
            return reject(new Error(m));
          }
          resolve((j.content || []).filter(x => x.type === 'text').map(x => x.text).join(''));
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Claude took too long to answer.')); });
      req.on('error', e => reject(new Error('Could not reach Claude: ' + (e.code || e.message))));
      req.end(body);
    });
  }
  function parseJson(text) {
    const s = String(text || ''); const a = s.indexOf('{'), z = s.lastIndexOf('}');
    if (a < 0 || z < a) throw new Error('Claude did not answer in the expected shape. Try again.');
    const r = JSON.parse(s.slice(a, z + 1));
    const steps = Array.isArray(r.steps) ? r.steps.slice(0, 5).map(x => typeof x === 'string' ? { do: x, who: '' } : { do: String(x && x.do || ''), who: String(x && x.who || '') }).filter(x => x.do) : [];
    return { headline: String(r.headline || 'Diagnosis'), cause: String(r.cause || ''), layer: String(r.layer || ''), owner: String(r.owner || ''), confidence: String(r.confidence || ''), reset_will_fix: r.reset_will_fix === true, steps, alert: String(r.alert || '') };
  }
  async function diagnose(b) {
    const h = H(b);
    h.ai = { st: 'run', chat: [], at: now() };
    try {
      const text = await callClaude([{ role: 'user', content: diagPrompt(b) }], 1500);
      h.ai = { st: 'done', res: parseJson(text), chat: [], at: now(), sent: false, prompt: diagPrompt(b), raw: text };
      return { ok: true };
    } catch (e) {
      h.ai = { st: 'err', err: e.message, chat: [], at: now() };
      return { ok: false, message: e.message };
    }
  }
  async function ask(b, q) {
    const h = H(b);
    if (!h.ai || h.ai.st !== 'done') return { ok: false, message: 'Run the diagnosis first.' };
    q = String(q || '').trim().slice(0, 600);
    if (!q) return { ok: false, message: 'Type a question.' };
    const turn = { q, a: '', st: 'run' };
    h.ai.chat.push(turn);
    const msgs = [{ role: 'user', content: h.ai.prompt }, { role: 'assistant', content: h.ai.raw }];
    h.ai.chat.slice(0, -1).forEach(cx => { if (cx.st === 'done') { msgs.push({ role: 'user', content: cx.q }); msgs.push({ role: 'assistant', content: cx.a }); } });
    msgs.push({ role: 'user', content: q + '\n\nAnswer in plain text, under 120 words, plain words, no hyphens or dashes, no JSON.' });
    try { turn.a = await callClaude(msgs, 600); turn.st = 'done'; return { ok: true }; } catch (e) { turn.st = 'err'; turn.err = e.message; return { ok: false, message: e.message }; }
  }
  function sendAiAlert(b) {
    const h = H(b);
    if (!h.ai || h.ai.st !== 'done' || h.ai.sent) return { ok: false, message: 'Nothing to send.' };
    const owner = /hospital it/i.test(h.ai.res.owner) && /hci/i.test(h.ai.res.owner) ? ['Hospital IT', 'HCI'] : /hospital it/i.test(h.ai.res.owner) ? ['Hospital IT'] : ['HCI'];
    const open = issues.find(i => !i.resolvedAt && i.boards && i.boards.indexOf(b.id) >= 0);
    const i = { id: open ? open.id : null, title: 'Claude diagnosis: ' + label(b), where: h.ai.res.alert, owner, told: open ? open.told : [], sev: 'caution', headline: h.ai.res.headline };
    const before = notices.length;
    notify(i, 'ai');
    notices.slice(before).forEach(n => { n.title = 'Claude diagnosis: ' + label(b); n.msg = h.ai.res.alert; });
    h.ai.sent = true;
    return { ok: true, message: 'Sent to ' + listJoin(recipients(owner).map(r => listJoin(r.names))) + '.' };
  }

  /* ---------------- tick, rules, public state ---------------- */
  function rules() {
    const c = cfg();
    const hci = c.teamsHci ? 'Teams' : 'logged here (no Teams link yet)';
    const it = c.teamsIt ? 'Teams' : c.teamsHci ? 'the HCI Support Teams channel' : 'logged here (no Teams link yet)';
    const pop = c.popups && IS_WIN ? ' and a pop up on this PC' : '';
    return [
      ['heart', 'Board misses heartbeats for ' + c.offlineSeconds + ' s', 'Whoever the first read names: HCI Support by ' + hci + ', Hospital IT by ' + it + pop + '.'],
      ['clock', 'Still down after ' + c.escalateMinutes + ' min and nobody acknowledged', 'Escalates to Hospital IT and HCI Support.'],
      ['server', '3 or more boards in one closet or network drop within 2 min', 'Hospital IT, one grouped alert, not one per board.'],
      ['alert', 'App crashes 3 times in 10 min', 'HCI Support right away.'],
      ['board', 'Clock off by ' + c.clockDriftSeconds + ' s, app not running or behind, crash dialog, screen asleep, storage under 5%', 'HCI Support after 2 checks in a row (about 1 min).'],
      ['check', 'Problem clears', 'All clear to everyone who was told.'],
      ['plug', 'New device answers on 5555 (cameras on 65037)' + (c.sweepMinutes > 0 ? ' (sweep every ' + c.sweepMinutes + ' min)' : ' (sweep is off)'), 'HCI Support. It waits until someone claims it.']
    ];
  }
  function onTick(devs) {
    const t = now();
    onDevices(devs);
    pruneKnown();
    // heartbeats for online boards are paced by pace() below; boards that are not online get a quick TCP check
    for (const b of store.boards) {
      const h = H(b), r = R(b);
      if (!monitored(b) || r.status === 'online') continue;
      if (t - h.reachAt >= 20000) {
        h.reachAt = t;
        probeKind(b.host, b.port, 2000).then(k => {
          h.reach = k.kind; h.connectMs = k.kind === 'open' || k.kind === 'refused' ? k.ms : null;
          // the ADB port answers again: reconnect now rather than wait for the slower retry of a board that was down a while
          if (k.kind === 'open' && R(b).status === 'unreachable' && !R(b).connecting && monitored(b)) ctx.connect(b).catch(() => {});
        });
      }
    }
    const rolled = rollSlots(t);
    for (const b of store.boards) evaluate(b, t);
    evaluateIssues(t);
    const c = cfg();
    if (c.sweepMinutes > 0 && !sweeping && t >= nextSweep) { nextSweep = t + c.sweepMinutes * 60000; sweep().catch(e => log('sweep', e.message)); }
    if (rolled || t - saveAt > 60000) { saveAt = t; save(); }
  }

  /* Heartbeat pacing. Every online board is checked about every 27 s (so no 30 s slot goes without a beat),
     spread evenly across the slot: 150 boards come to about 6 small checks a second, never a burst.
     A token bucket sets the rate from the number of boards; a cap on checks in flight protects adb when boards are slow. */
  const MAX_INFLIGHT = 16;
  let inflight = 0, tokens = 1, paceAt = now();
  function pace() {
    const t = now(), dt = Math.min(2000, t - paceAt); paceAt = t;
    const due = [];
    let online = 0;
    for (const b of store.boards) {
      if (!monitored(b) || R(b).status !== 'online') continue;
      online++;
      const h = H(b);
      if (!h.probing && t - h.probeAt >= EVERY) due.push(b);
    }
    // finish a full round in about 22 s, leaving room for retries and slow boards
    const rate = online / ((EVERY - 5000) / 1000) + 1;
    tokens = Math.min(Math.max(1, rate), tokens + rate * dt / 1000);
    if (!due.length) return;
    due.sort((a, b) => H(a).probeAt - H(b).probeAt);
    for (const b of due) {
      if (tokens < 1 || inflight >= MAX_INFLIGHT) break;
      tokens -= 1; inflight++;
      probeBoard(b).catch(e => log('probe', b.name, e.message)).finally(() => { inflight--; });
    }
  }
  setInterval(pace, 250);

  function masked(s) { return s ? '•••• ' + String(s).slice(-4) : ''; }
  function publicSettings() {
    const c = cfg();
    return { site: c.site, serverHost: c.serverHost, ntpServer: c.ntpServer, popups: c.popups, offlineSeconds: c.offlineSeconds, escalateMinutes: c.escalateMinutes, clockDriftSeconds: c.clockDriftSeconds, sweepMinutes: c.sweepMinutes,
      teamsHci: masked(c.teamsHci), teamsIt: masked(c.teamsIt), claudeKey: masked(c.claudeKey), claudeModel: c.claudeModel, claudeLogs: c.claudeLogs, ledCommand: c.ledCommand || '', hasTeams: !!(c.teamsHci || c.teamsIt), hasClaude: !!c.claudeKey, windows: IS_WIN };
  }
  function boardHealth(b, detail) {
    const h = H(b), t = now();
    const o = { state: h.state, since: h.since, lastBeat: h.lastBeat, beats: h.beats, faults: h.faults.map(x => ({ kind: x.kind, sev: x.sev, title: x.title })), busy: h.busy, keeper: h.keeper,
      headline: readFor(b).headline };
    if (detail) {
      const f = h.facts || {};
      o.chain = chainFor(b); o.read = readFor(b); o.actions = actionsFor(b); o.log = h.log.slice(-20);
      o.facts = { skew: f.skew, uptime: f.uptime, fgPkg: f.fgPkg, wake: f.wake, freePct: f.freePct, ifaces: f.ifaces || [], wifiLevel: f.wifiLevel, ethSpeed: f.ethSpeed, crashes10: h.crashes.filter(x => t - x.t < 600000).length };
      o.ai = h.ai ? { st: h.ai.st, res: h.ai.res, err: h.ai.err, chat: h.ai.chat, sent: h.ai.sent, at: h.ai.at } : null;
      o.reach = h.reach; o.connectMs = h.connectMs;
    }
    return o;
  }
  function publicState(sel) {
    pruneKnown();
    return {
      beatMs: BEAT, slots: SLOTS, slotStart, now: now(), startedAt, settings: publicSettings(), kinds: KINDS,
      boards: store.boards.map(b => Object.assign(ctx.publicBoard(b), { unit: b.unit || '', closet: b.closet || '', room: b.room || '', kind: b.kind || 'other', app: b.app || '', health: boardHealth(b, b.id === sel) })),
      issues: issues.filter(i => !i.resolvedAt || now() - i.resolvedAt < 12 * 3600000).slice(-60),
      notices: notices.slice(-80), events: events.slice(-80), rules: rules(),
      found: Array.from(found.values()).filter(e => e.status !== 'gone').slice(-60),
      sweeping, lastSweep, nextSweep, fingerprint: fingerprint(), keeperBundled: fs.existsSync(KEEPER_APK)
    };
  }

  /* ---------------- http routes ---------------- */
  /* ---------------- LED bezel (door signs only) ----------------
     Sends the LED command set in Settings to one board over ADB. The command is a
     broadcast to the HCI ONE Room Sign app by default; {color} and {mode} are filled
     in from the picks in the console. Colour and mode are whitelisted so nothing from
     the page can slip into the shell command. */
  const LED_COLORS = ['off', 'white', 'red', 'amber', 'green', 'blue'];
  const LED_MODES = ['solid', 'flash'];
  async function setLed(b, color, mode) {
    if (b.kind !== 'ds') return { ok: false, message: 'LED control is for door signs only.' };
    if (R(b).status !== 'online') return { ok: false, message: 'The door sign is not connected.' };
    color = String(color || '').toLowerCase(); mode = String(mode || 'solid').toLowerCase();
    if (LED_COLORS.indexOf(color) < 0) return { ok: false, message: 'Unknown LED colour.' };
    if (LED_MODES.indexOf(mode) < 0) mode = 'solid';
    const tmpl = (cfg().ledCommand || DEFAULTS.ledCommand).trim();
    if (!tmpl) return { ok: false, message: 'No LED command is set. Add one under the gear in Settings.' };
    const cmd = tmpl.replace(/\{color\}/g, color).replace(/\{mode\}/g, mode);
    const r = await shell(b, cmd, 15000);
    const text = String(r.out) + r.err;
    if (/does not exist|no receivers|not found|Exception|Error:|Security|Denial/i.test(text))
      return { ok: false, message: 'The door sign did not accept the LED command. Make sure the HCI ONE Room Sign app on this board supports LED control, or correct the LED command under the gear in Settings.' };
    note(b, b.name + ': LED set to ' + (color === 'off' ? 'off' : color + (mode === 'flash' ? ', flashing' : '')) + '.');
    return { ok: true, message: color === 'off' ? 'LED turned off.' : 'LED set to ' + color + (mode === 'flash' ? ', flashing.' : '.') };
  }

  async function handle(req, res, p, url) {
    const { send, readJson } = ctx;
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, publicState(url.searchParams.get('sel') || '')), true;
    if (!/^\/api\/(health|found)\b/.test(p)) return false;
    if (req.method !== 'POST') return send(res, 404, { ok: false, message: 'Not found' }), true;
    if (req.headers['x-board-remote'] !== '1') return send(res, 403, { ok: false, message: 'Forbidden' }), true;
    const body = await readJson(req);
    if (p === '/api/health/settings') {
      const c = cfg();
      const str = (k, max) => { if (body[k] !== undefined) c[k] = String(body[k]).trim().slice(0, max || 500); };
      const num = (k, lo, hi) => { if (body[k] !== undefined) { const n = Math.round(Number(body[k])); if (Number.isFinite(n)) c[k] = Math.min(hi, Math.max(lo, n)); } };
      str('site', 60); str('serverHost', 200); str('ntpServer', 200); str('claudeModel', 80); str('ledCommand', 400);
      for (const k of ['teamsHci', 'teamsIt', 'claudeKey']) if (body[k] !== undefined && !/^••••/.test(body[k])) c[k] = String(body[k]).trim().slice(0, 1000);
      if (body.popups !== undefined) c.popups = !!body.popups;
      if (body.claudeLogs !== undefined) c.claudeLogs = !!body.claudeLogs;
      num('offlineSeconds', 30, 3600); num('escalateMinutes', 1, 240); num('clockDriftSeconds', 5, 3600); num('sweepMinutes', 0, 1440);
      if (c.serverHost && !HOST_RE.test(c.serverHost)) { c.serverHost = ''; saveStore(); return send(res, 400, { ok: false, message: 'The HCI ONE server must be a host name or IP address only.' }), true; }
      nextSweep = Math.min(nextSweep, now() + (c.sweepMinutes > 0 ? c.sweepMinutes * 60000 : 1e12));
      saveStore();
      return send(res, 200, { ok: true, message: 'Settings saved.' }), true;
    }
    if (p === '/api/health/test') {
      const c = cfg(); const out = [];
      for (const [nm, url2] of [['HCI Support', c.teamsHci], ['Hospital IT', c.teamsIt]]) if (url2) out.push(nm + ': ' + await postWebhook(url2, 'Test from Board Remote', 'If you can read this, Board Remote alerts reach this channel' + (c.site ? ' for ' + c.site : '') + '.'));
      const pop = popup('Test from Board Remote', 'Pop ups work on this PC.');
      if (!out.length && pop === 'off') return send(res, 200, { ok: false, message: 'No Teams link is set and pop ups are off.' }), true;
      return send(res, 200, { ok: !out.some(x => /failed/.test(x)), message: out.concat(pop === 'shown' ? ['Pop up shown on this PC.'] : []).join('\n') }), true;
    }
    if (p === '/api/found/sweep') return send(res, 200, await sweep()), true;
    let m = /^\/api\/found\/([a-f0-9]{8})\/(claim|ignore|restore)$/.exec(p);
    if (m) {
      const e = found.get(m[1]);
      if (!e) return send(res, 404, { ok: false, message: 'That device is no longer listed.' }), true;
      if (m[2] === 'ignore') { e.status = 'ignored'; return send(res, 200, { ok: true, message: 'Hidden. It will not be listed again.' }), true; }
      if (m[2] === 'restore') { e.status = 'found'; return send(res, 200, { ok: true, message: 'Listed again.' }), true; }
      return send(res, 200, await claim(e, body)), true;
    }
    m = /^\/api\/health\/notices\/([a-f0-9]{8})\/ack$/.exec(p);
    if (m) {
      const n = notices.find(x => x.id === m[1]);
      if (!n) return send(res, 404, { ok: false, message: 'Unknown alert' }), true;
      n.ack = { by: 'You', at: now() };
      const i = issues.find(x => x.id === n.issue); if (i) i.acked = true;
      return send(res, 200, { ok: true, message: 'Acknowledged. Escalation stopped.' }), true;
    }
    m = /^\/api\/health\/([a-f0-9]{8})\/(act|look|diagnose|ask|sendai|evidence|probe|led)$/.exec(p);
    if (!m) return send(res, 404, { ok: false, message: 'Not found' }), true;
    const b = store.boards.find(x => x.id === m[1]);
    if (!b) return send(res, 404, { ok: false, message: 'Unknown board' }), true;
    switch (m[2]) {
      case 'led': return send(res, 200, await setLed(b, body.color, body.mode)), true;
      case 'act': return send(res, 200, await runAction(b, String(body.act || ''))), true;
      case 'look': return send(res, 200, await look(b, String(body.view || ''))), true;
      case 'diagnose': return send(res, 200, await diagnose(b)), true;
      case 'ask': return send(res, 200, await ask(b, body.q)), true;
      case 'sendai': return send(res, 200, sendAiAlert(b)), true;
      case 'evidence': return send(res, 200, { ok: true, text: SYSTEM + '\n\n' + diagPrompt(b) }), true;
      case 'probe': { const ok = await probeBoard(b); return send(res, 200, { ok, message: ok ? 'Checked.' : 'The board did not answer the check.' }), true; }
    }
    return false;
  }

  // Deploy and other tools say when they restart an app or install, so it is not reported as a surprise restart
  function note(b, text) { const h = H(b); h.actAt = now(); if (text) ev('info', text, b.id); }

  function forget(id) {
    HS.delete(id);
    for (const i of issues) if (!i.resolvedAt && i.boards && i.boards.indexOf(id) >= 0 && i.boards.length === 1) { i.resolvedAt = now(); i.stopped = true; }
  }

  load();
  // Other tools (the morning audit) post a summary to the HCI Support channel, or Hospital IT's if that is the only link
  function teams(title, text) { const c = cfg(), url = c.teamsHci || c.teamsIt; return url ? postWebhook(url, title, text) : Promise.resolve('no Teams link'); }

  return { onTick, handle, save, forget, note, H, probeBoard, KINDS, teams, headline: b => { try { return readFor(b).headline; } catch (e) { return ''; } } };
};
