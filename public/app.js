'use strict';
/* HCI ONE Board Remote, web dashboard. Every number and every row comes from the API as the signed in
   person, so the database's row level security decides what shows. Nothing here is trusted for access. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KIND = { wb: 'Whiteboard', ds: 'Door sign', ub: 'Unit board', other: 'Board' };
const KS = { wb: 'WB', ds: 'DS', ub: 'UB', other: 'BD' };
const STATE = { online: ['ok', 'Online'], degraded: ['warn', 'Needs a look'], late: ['warn', 'Heartbeat late'], offline: ['bad', 'Offline'], paused: ['', 'Paused'], unknown: ['', 'Checking'] };
const ACTS = [['restart', 'Restart app', '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'], ['reboot', 'Reboot board', '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>'],
  ['wake', 'Wake screen', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2"/>'], ['clock', 'Fix clock', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  ['storage', 'Free storage', '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'], ['reconnect', 'Reconnect ADB', '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>'],
  ['probe', 'Health check', '<path d="M3 12h4l3-8 4 16 3-8h4"/>'], ['keeper', 'Install ADB keeper', '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>']];
const LEDS = [['off', 'Off', '#ECE8E1'], ['white', 'White', '#ffffff'], ['red', 'Red', '#D93A2F'], ['amber', 'Amber', '#E3A008'], ['green', 'Green', '#14A44D'], ['blue', 'Blue', '#2563EB']];
const LOCK = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

let ME = null, H = null, FLEET = null, view = 'boards', sel = null, es = null, roleNames = {};
const pendingCmd = new Map();   // command id -> label

function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' err' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), 5000);
}
async function api(method, p, body) {
  let r;
  try { r = await fetch(p, { method, cache: 'no-store', credentials: 'same-origin', headers: Object.assign({ 'X-BR': '1' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { return { ok: false, message: 'Cannot reach Board Remote Cloud. Check the network.' }; }
  if (r.status === 401) { location.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.hash); return { ok: false, message: 'Signing in…' }; }
  try { return await r.json(); } catch (e) { return { ok: false, message: 'The server answered ' + r.status + '.' }; }
}
const ago = t => { if (!t) return 'never'; const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000)); return s < 60 ? s + ' s ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const myRole = () => !ME ? null : ME.user.hciRole || ((ME.user.memberships || []).find(m => m.hospital_id === H) || {}).role || null;
const isHci = () => !!(ME && ME.user.hciRole);
// two clicks for anything that takes something away, instead of a browser dialog
function sure(btn, text, fn) {
  if (btn.dataset.sure === '1') { btn.dataset.sure = ''; btn.classList.remove('sure'); return fn(); }
  const was = btn.innerHTML; btn.dataset.sure = '1'; btn.classList.add('sure'); btn.textContent = text;
  setTimeout(() => { if (btn.dataset.sure === '1') { btn.dataset.sure = ''; btn.classList.remove('sure'); btn.innerHTML = was; } }, 4000);
}

/* ---------------- start ---------------- */
async function boot() {
  const me = await api('GET', '/api/me');
  if (!me.ok) return;
  ME = me; roleNames = me.roleNames || {};
  $('#wName').textContent = me.user.name || me.user.email;
  $('#navHci').hidden = !isHci(); $('#navUpd').hidden = !isHci();
  const hs = me.hospitals || [];
  const saved = (() => { try { return localStorage.getItem('br.h'); } catch (e) { return null; } })();
  H = (hs.find(h => h.id === saved) || hs[0] || {}).id || null;
  $('#hosp').innerHTML = hs.map(h => '<option value="' + esc(h.id) + '">' + esc(h.name) + '</option>').join('');
  $('#hosp').hidden = hs.length < 2; if (H) $('#hosp').value = H;
  if (!H && !isHci()) {
    $('#units').innerHTML = '<div class="empty"><h2>No hospital yet</h2><p class="sub">You are signed in, but nobody has added you to a hospital. Ask your hospital\'s IT lead or HCI at 513 271 8100.</p></div>';
  }
  route(); hospitalChanged();
}
function hospitalChanged() {
  try { if (H) localStorage.setItem('br.h', H); } catch (e) { /* private window */ }
  const hn = ((ME.hospitals || []).find(h => h.id === H) || {}).name || '';
  $('#wRole').textContent = (roleNames[myRole()] || '') + (hn && !isHci() ? ' · ' + hn : '');
  $('#pHosp').textContent = hn;
  closeDrawer(); FLEET = null; listen(); load();
}
function route() {
  const v = (location.hash || '#boards').slice(1);
  view = ['boards', 'pcs', 'people', 'log', 'hci', 'upd'].indexOf(v) >= 0 && ((v !== 'hci' && v !== 'upd') || isHci()) ? v : 'boards';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== 'v-' + view; });
  if (view !== 'boards') closeDrawer();
  load();
}
function load() {
  if (view === 'hci') return loadHci();
  if (view === 'upd') return loadUpd();
  if (!H) return;
  if (view === 'boards' || view === 'pcs') return loadFleet();
  if (view === 'people') return loadPeople();
  if (view === 'log') return loadLog();
}

/* ---------------- live ---------------- */
let refetch = null;
function listen() {
  if (es) { es.close(); es = null; }
  if (!H || !window.EventSource) return;
  es = new EventSource('/api/hospitals/' + H + '/events');
  es.onopen = () => $('#live').classList.add('on');
  es.onerror = () => $('#live').classList.remove('on');
  es.addEventListener('fleet', () => { clearTimeout(refetch); refetch = setTimeout(() => { if (view === 'boards' || view === 'pcs') loadFleet(); if (view === 'log') loadLog(); }, 250); });
  es.addEventListener('command', e => { let d = {}; try { d = JSON.parse(e.data); } catch (x) { /* ignore */ } if (pendingCmd.has(d.id)) settle(d.id); });
}

/* ---------------- boards ---------------- */
async function loadFleet() {
  const h = H, f = await api('GET', '/api/hospitals/' + h + '/fleet');
  if (h !== H) return;
  if (!f.ok) return toast(f.message, true);
  FLEET = f;
  if (view === 'boards') renderBoards();
  if (view === 'pcs') renderPcs();
  if (sel) renderDrawer();
  $('#footMsg').textContent = f.devices.length + ' boards · ' + f.pcs.filter(p => p.online).length + ' of ' + f.pcs.length + ' Board Remote PCs connected';
}
const cls = d => (STATE[d.state] || STATE.unknown)[0];
function matches(d) {
  const q = $('#q').value.trim().toLowerCase(), s = $('#fShow').value;
  if (q && ![d.room, d.unit, d.closet, d.name, d.identity].some(v => String(v || '').toLowerCase().indexOf(q) >= 0)) return false;
  if (s === 'bad') return cls(d) === 'bad' || cls(d) === 'warn';
  if (s === 'locked') return d.locked;
  if (s === 'unlocked') return !d.locked;
  if (s) return d.kind === s;
  return true;
}
function renderBoards() {
  const ds = FLEET.devices, n = k => ds.filter(d => cls(d) === k).length;
  $('#sum').innerHTML = '<span class="hname">' + esc(FLEET.hospital.name) + '</span><span class="chip ok"><span class="d"></span><b>' + n('ok') + '</b> online</span>' + (n('warn') ? '<span class="chip warn"><span class="d"></span><b>' + n('warn') + '</b> need a look</span>' : '') +
    (n('bad') ? '<span class="chip bad"><span class="d"></span><b>' + n('bad') + '</b> offline</span>' : '') + '<span class="chip">' + LOCK + '<b>' + ds.filter(d => d.locked).length + '</b> of ' + ds.length + ' locked</span>';
  $('#btnLockAll').hidden = !isHci();
  const all = ds.length && ds.every(d => d.locked);
  $('#btnLockAll').querySelector('span').textContent = all ? 'Unlock locations' : 'Lock locations';
  $('#btnLockAll').dataset.lock = all ? '0' : '1';
  if (!ds.length) {
    $('#units').innerHTML = '<div class="empty"><h2>No boards yet</h2><p class="sub">Boards show up here once a Board Remote PC at this hospital joins. Go to PCs, make a code, and enter it on that PC under Remote, HCI ONE Cloud.</p><div><a class="btn dark" href="#pcs">Add a PC</a></div></div>';
    return;
  }
  const show = ds.filter(matches), units = new Map();
  for (const d of show) { const u = d.unit || 'No unit set'; if (!units.has(u)) units.set(u, []); units.get(u).push(d); }
  if (!show.length) { $('#units').innerHTML = '<div class="empty"><h2>No board matches</h2><p class="sub">Clear the search or pick Every board.</p></div>'; return; }
  $('#units').innerHTML = [...units].map(([u, list]) => {
    const down = list.filter(d => cls(d) === 'bad').length;
    return '<div class="unit"><div class="uhead"><h2>' + esc(u) + '</h2><span class="sub">' + list.length + ' board' + (list.length > 1 ? 's' : '') + (down ? ', ' + down + ' offline' : '') + '</span></div><div class="bgrid">' +
      list.map(d => '<button class="b ' + cls(d) + (sel === d.id ? ' picked' : '') + '" data-id="' + esc(d.id) + '"><span class="dot"></span><span class="rm">' + esc(d.room ? 'Room ' + d.room : d.name || d.identity) + '</span><span class="kd">' + (d.locked ? '<span class="lk" title="Location locked by HCI">' + LOCK + '</span> ' : '') + esc(KS[d.kind] || 'BD') + '</span>' +
        '<span class="hl">' + esc(d.headline || (STATE[d.state] || STATE.unknown)[1]) + '</span></button>').join('') + '</div></div>';
  }).join('');
}
$('#units').addEventListener('click', e => { const b = e.target.closest('.b'); if (!b) return; sel = b.dataset.id; renderDrawer(); renderBoards(); });
$('#q').addEventListener('input', () => FLEET && renderBoards());
$('#fShow').addEventListener('change', () => FLEET && renderBoards());
$('#btnAudit').addEventListener('click', async () => { const r = await api('POST', '/api/hospitals/' + H + '/command', { action: 'auditRun' }); toast(r.message, !r.ok); });
$('#btnLockAll').addEventListener('click', e => {
  const lock = e.currentTarget.dataset.lock === '1';
  sure(e.currentTarget, lock ? 'Click again to lock every board' : 'Click again to unlock every board', async () => { const r = await api('POST', '/api/hospitals/' + H + '/lock', { locked: lock }); toast(r.message, !r.ok); loadFleet(); });
});

/* ---------------- drawer ---------------- */
function closeDrawer() { sel = null; $('#drawer').hidden = true; document.body.classList.remove('dopen'); if (FLEET && view === 'boards') renderBoards(); }
$('#dClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
let drawnFor = null;
function renderDrawer() {
  const d = FLEET && FLEET.devices.find(x => x.id === sel);
  if (!d) { $('#drawer').hidden = true; return; }
  $('#drawer').hidden = false; document.body.classList.add('dopen');
  const [c, word] = STATE[d.state] || STATE.unknown;
  $('#dKind').textContent = KIND[d.kind] || 'Board';
  $('#dName').textContent = d.room ? 'Room ' + d.room : d.name || d.identity;
  $('#dModel').textContent = [d.model, d.android ? 'Android ' + d.android : '', d.identity].filter(Boolean).join(' · ');
  $('#dState').className = 'dstate ' + c; $('#dWord').textContent = word; $('#dHead').textContent = (d.headline || '') + (d.last_beat && new Date(isNaN(d.last_beat) ? d.last_beat : Number(d.last_beat)).getTime() > 0 ? ' Last heartbeat ' + ago(isNaN(d.last_beat) ? d.last_beat : Number(d.last_beat)) + '.' : '');
  // the location: only refill the inputs when another board is opened, so typing is not overwritten by a live update
  const canEdit = !d.locked;
  if (drawnFor !== d.id) { $('#dRoom').value = d.room || ''; $('#dUnit').value = d.unit || ''; $('#dCloset').value = d.closet || ''; drawnFor = d.id; }
  ['#dRoom', '#dUnit', '#dCloset'].forEach(s => { $(s).disabled = !canEdit; });
  $('#dSave').hidden = !canEdit;
  $('#dLockTxt').innerHTML = d.locked ? '· ' + LOCK.replace('<svg', '<svg style="width:12px;height:12px;vertical-align:-1px"') + ' locked by ' + esc(d.locked_by_name || 'HCI') + (d.locked_at ? ', ' + esc(ago(d.locked_at)) : '') : '';
  $('#dLock').hidden = !isHci();
  $('#dLock').innerHTML = LOCK + '<span>' + (d.locked ? 'Unlock' : 'Lock location') + '</span>';
  const busy = new Set([...pendingCmd.values()].filter(x => x.device === d.id).map(x => x.key));
  $('#dActs').innerHTML = ACTS.map(([k, label, ic]) => '<button class="btn' + (busy.has(k) ? ' busy' : '') + '" data-act="' + k + '"><svg viewBox="0 0 24 24">' + ic + '</svg>' + esc(busy.has(k) ? 'Running…' : label) + '</button>').join('');
  $('#dLedSec').hidden = d.kind !== 'ds';
  $('#dLeds').innerHTML = LEDS.map(([k, l, col]) => '<button data-led="' + k + '"><span class="sw" style="background:' + col + ';border:1px solid #d8d2c8"></span>' + esc(l) + '</button>').join('');
  $('#dReach').innerHTML = (d.reach || []).map(r => '<div class="r"><span class="tag ' + (r.online ? 'ok' : 'bad') + '">' + (r.online ? 'Reaches it' : 'Lost it') + '</span><span>' + esc(r.pc) + (r.primary ? ' <span class="tag blue">Runs commands</span>' : '') + '</span><span class="h">' + esc(r.host || '') + '</span></div>').join('') || '<p class="sub">No Board Remote PC sees this board right now.</p>';
}
$('#dSave').addEventListener('click', async () => {
  const r = await api('PATCH', '/api/devices/' + sel, { room: $('#dRoom').value, unit: $('#dUnit').value, closet: $('#dCloset').value });
  toast(r.message, !r.ok); drawnFor = null; loadFleet();
});
$('#dLock').addEventListener('click', async () => {
  const d = FLEET.devices.find(x => x.id === sel); if (!d) return;
  const go = async () => { const r = await api('POST', '/api/devices/' + sel + '/lock', { locked: !d.locked }); toast(r.message, !r.ok); loadFleet(); };
  if (d.locked) sure($('#dLock'), 'Click again to unlock', go); else go();
});
async function command(args, label, key) {
  const d = FLEET.devices.find(x => x.id === sel); if (!d) return;
  const r = await api('POST', '/api/devices/' + d.id + '/command', args);
  if (!r.ok) return toast(r.message, true);
  pendingCmd.set(r.id, { label: label + ', ' + (d.room ? 'room ' + d.room : d.name), device: d.id, key, at: Date.now() });
  toast(label + ' sent to ' + ((d.reach || []).find(x => x.primary) || {}).pc + '.');
  renderDrawer();
  setTimeout(() => { if (pendingCmd.has(r.id)) settle(r.id); }, 20000);   // in case the live stream missed it
}
async function settle(id) {
  const r = await api('GET', '/api/commands/' + id), c = r.command, p = pendingCmd.get(id);
  if (!c || !p) return;
  if (c.status === 'queued' || c.status === 'sent') { if (Date.now() - p.at < 190000) return setTimeout(() => settle(id), 5000); }
  pendingCmd.delete(id);
  const msg = (c.result && c.result.message) || (c.status === 'expired' ? 'No Board Remote picked it up in time.' : c.status);
  toast(p.label + ': ' + msg, c.status !== 'done');
  if (sel === p.device) renderDrawer();
}
$('#dActs').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const k = b.dataset.act, label = (ACTS.find(a => a[0] === k) || [])[1];
  if (k === 'probe') return command({ action: 'probe' }, label, k);
  if (k === 'reboot') return sure(b, 'Click again to reboot', () => command({ action: 'act', args: { key: k } }, label, k));
  command({ action: 'act', args: { key: k } }, label, k);
});
$('#dLeds').addEventListener('click', e => {
  const b = e.target.closest('[data-led]'); if (!b) return;
  command({ action: 'led', args: { color: b.dataset.led, mode: $('#dFlash').checked ? 'flash' : 'solid' } }, 'Light ' + b.dataset.led, 'led');
});

/* ---------------- PCs ---------------- */
const UPD = { waiting: ['warn', 'Waiting for approval'], scheduled: ['blue', 'Installs tonight'], downloading: ['blue', 'Downloading'], installing: ['blue', 'Installing'], done: ['ok', 'Updated'], failed: ['bad', 'Update failed'], rolled_back: ['bad', 'Rolled back'] };
function updCell(p) {
  const u = UPD[p.update_state]; if (!u) return '<span class="sub">' + (p.service ? 'Up to date' : 'Updates need the Windows app') + '</span>';
  return '<span class="tag ' + u[0] + '">' + u[1] + (p.update_version ? ' ' + esc(p.update_version) : '') + '</span>' + (p.update_detail && p.update_state !== 'waiting' ? '<div class="sub">' + esc(p.update_detail) + '</div>' : '');
}
function renderPcs() {
  const pcs = FLEET.pcs, U = FLEET.hospital.updates || {};
  const seen = id => FLEET.devices.filter(d => (d.reach || []).some(r => r.agent === id && r.online)).length;
  const waiting = pcs.filter(p => p.update_state === 'waiting').length;
  $('#updBar').innerHTML = '<span class="label">Updates</span><span>' + (U.update_mode === 'approve' ? 'Each update waits for approval here' : 'Install automatically overnight') + (U.update_ring === 'pilot' ? ', <b>pilot</b> (gets new versions first)' : '') + '</span>' +
    (U.target ? '<span class="sub">Latest for this hospital: ' + esc(U.target) + '</span>' : '') +
    (waiting > 1 ? '<button class="btn dark" id="apAll">Approve all ' + waiting + '</button>' : '') +
    (isHci() ? '<select id="updMode" class="sel"><option value="auto">Automatic overnight</option><option value="approve">Wait for approval</option></select><label class="check"><input type="checkbox" id="updPilot"> Pilot</label>' : '');
  if (isHci()) { $('#updMode').value = U.update_mode || 'auto'; $('#updPilot').checked = U.update_ring === 'pilot'; }
  $('#tPcs').innerHTML = '<tr><th>PC</th><th>Status</th><th>Boards it reaches</th><th>Version</th><th>Update</th><th>Last seen</th><th></th></tr>' + (pcs.length ? pcs.map(p =>
    '<tr><td><b>' + esc(p.name) + '</b><div class="sub">' + esc(p.pc_name || '') + '</div></td><td><span class="tag ' + (p.online ? 'ok' : 'bad') + '">' + (p.online ? 'Connected' : 'Not connected') + '</span></td><td>' + seen(p.id) + '</td><td class="mono">' + esc(p.version || '') + '</td><td>' + updCell(p) + '</td><td class="m">' + esc(p.online ? 'now' : ago(p.last_seen)) + '</td>' +
    '<td class="r">' + (p.update_state === 'waiting' || (p.service && U.target && p.version !== U.target && ['downloading', 'installing'].indexOf(p.update_state) < 0) ? '<button class="btn dark" data-approve="' + esc(p.id) + '">' + (p.update_state === 'waiting' ? 'Approve' : 'Install now') + '</button> ' : '') + '<button class="btn danger" data-revoke="' + esc(p.id) + '">Remove</button></td></tr>').join('') : '<tr><td colspan="7" class="m">No Board Remote PC has joined yet. Make a code on the right.</td></tr>');
}
$('#updBar').addEventListener('change', async e => {
  if (e.target.id !== 'updMode' && e.target.id !== 'updPilot') return;
  const r = await api('PATCH', '/api/hospitals/' + H + '/updates', { updateMode: $('#updMode').value, updateRing: $('#updPilot').checked ? 'pilot' : 'normal' });
  toast(r.message, !r.ok); loadFleet();
});
$('#updBar').addEventListener('click', async e => {
  if (!e.target.closest('#apAll')) return;
  const r = await api('POST', '/api/hospitals/' + H + '/approve', {}); toast(r.message, !r.ok); loadFleet();
});
$('#tPcs').addEventListener('click', async e => {
  const a = e.target.closest('[data-approve]');
  if (a) { const r = await api('POST', '/api/agents/' + a.dataset.approve + '/approve', {}); toast(r.message, !r.ok); return loadFleet(); }
  const b = e.target.closest('[data-revoke]'); if (!b) return;
  sure(b, 'Click again to remove', async () => { const r = await api('POST', '/api/agents/' + b.dataset.revoke + '/revoke', {}); toast(r.message, !r.ok); loadFleet(); });
});
$('#fCode').addEventListener('submit', async e => {
  e.preventDefault();
  const label = $('#cLabel').value.trim() || 'Board Remote PC';
  const r = await api('POST', '/api/hospitals/' + H + '/codes', { label });
  if (!r.ok) return toast(r.message, true);
  $('#codeBox').hidden = false; $('#codeVal').textContent = r.code; $('#codeFor').textContent = 'For ' + label + '. ' + r.message;
  $('#cLabel').value = '';
});

/* ---------------- people ---------------- */
async function loadPeople() {
  const h = H, r = await api('GET', '/api/hospitals/' + h + '/people');
  if (h !== H) return;
  if (!r.ok) return toast(r.message, true);
  $('#tPeople').innerHTML = '<tr><th>Name</th><th>Role</th><th>Signed in</th><th>Last sign in</th><th></th></tr>' + (r.people.length ? r.people.map(p =>
    '<tr><td><b>' + esc(p.name || p.email) + '</b><div class="sub">' + esc(p.email) + '</div></td><td>' + esc(roleNames[p.role] || p.role) + '</td><td><span class="tag ' + (p.signed_in ? 'ok' : '') + '">' + (p.signed_in ? 'Yes' : 'Not yet') + '</span></td><td class="m">' + esc(p.last_login ? ago(p.last_login) : 'never') + '</td>' +
    '<td class="r">' + (p.id === ME.user.id ? '<span class="sub">You</span>' : '<button class="btn danger" data-rm="' + esc(p.membership) + '">Remove</button>') + '</td></tr>').join('') : '<tr><td colspan="5" class="m">Nobody yet.</td></tr>');
}
$('#tPeople').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  sure(b, 'Click again to remove', async () => { const r = await api('DELETE', '/api/memberships/' + b.dataset.rm); toast(r.message, !r.ok); loadPeople(); });
});
$('#iRole').addEventListener('change', () => { $('#iTidF').hidden = $('#iRole').value !== 'dealer'; });
$('#fInvite').addEventListener('submit', async e => {
  e.preventDefault(); $('#iErr').textContent = '';
  const r = await api('POST', '/api/hospitals/' + H + '/people', { email: $('#iEmail').value, name: $('#iName').value, role: $('#iRole').value, tenantId: $('#iTid').value });
  if (!r.ok) { $('#iErr').textContent = r.message; return; }
  toast(r.message); $('#iEmail').value = ''; $('#iName').value = ''; $('#iTid').value = ''; loadPeople();
});

/* ---------------- audit log ---------------- */
const ACTION = { 'device.placement': 'Changed location', 'device.locked': 'Locked location', 'device.unlocked': 'Unlocked location', 'hospital.locked': 'Locked locations', 'hospital.unlocked': 'Unlocked locations',
  'command.act': 'Ran a fix', 'command.led': 'Set the door sign light', 'command.probe': 'Ran a health check', 'command.auditRun': 'Started the morning audit', 'command.result': 'Command finished',
  'person.invited': 'Added a person', 'person.removed': 'Removed a person', 'agent.enrolled': 'A PC joined', 'agent.revoked': 'Removed a PC', 'agent.code_created': 'Made a PC code', 'device.discovered': 'Found a new board', 'hospital.created': 'Added the hospital', 'hospital.updated': 'Changed the hospital',
  'user.sign_in': 'Signed in', 'update.approved': 'Approved an update', 'update.done': 'Board Remote updated', 'update.failed': 'Update failed', 'update.rolled_back': 'Update rolled back',
  'hospital.update_settings': 'Changed how updates install' };
let LOG = [];
function detail(l) {
  const x = l.details || {};
  if (l.action === 'device.placement') return Object.keys(x.to || {}).map(k => k + ' ' + (x.from && x.from[k] ? '"' + x.from[k] + '"' : 'blank') + ' to "' + x.to[k] + '"').join(', ');
  if (l.action === 'command.act') return (x.args && x.args.key) || '';
  if (l.action === 'command.led') return x.args ? x.args.color + ' ' + (x.args.mode || 'solid') : '';
  if (x.email) return x.email + (x.role ? ', ' + (roleNames[x.role] || x.role) : '');
  if (/^update\./.test(l.action)) return [x.from ? x.from + ' to ' + x.to : x.version, x.detail].filter(Boolean).join('. ');
  if (l.action === 'hospital.update_settings') return [x.mode === 'approve' ? 'wait for approval' : x.mode === 'auto' ? 'automatic overnight' : '', x.ring === 'pilot' ? 'pilot' : x.ring === 'normal' ? 'not pilot' : ''].filter(Boolean).join(', ');
  if (x.message) return x.message;
  return '';
}
async function loadLog() {
  const h = H, r = await api('GET', '/api/hospitals/' + h + '/audit?limit=500');
  if (h !== H) return;
  if (!r.ok) return toast(r.message, true);
  LOG = r.entries;
  $('#tLog').innerHTML = '<tr><th>When</th><th>Who</th><th>What</th><th>Board</th><th>Details</th><th>From</th></tr>' + (LOG.length ? LOG.map(l =>
    '<tr><td class="m" style="white-space:nowrap">' + esc(when(l.at)) + '</td><td>' + esc(l.user_name || l.user_email || l.pc || (l.actor_kind === 'system' ? 'Board Remote Cloud' : '')) + '</td><td>' + esc(ACTION[l.action] || l.action) + (l.result && l.result !== 'ok' ? ' <span class="tag bad">' + esc(l.result) + '</span>' : '') + '</td>' +
    '<td>' + esc(l.room ? (KS[l.kind] || '') + ' ' + l.room : '') + '</td><td class="m">' + esc(detail(l)) + '</td><td class="m">' + esc(l.origin === 'agent' ? 'Board Remote PC' : l.actor_kind === 'system' ? 'Cloud' : 'Web') + '</td></tr>').join('') : '<tr><td colspan="6" class="m">Nothing yet.</td></tr>');
}
$('#btnCsv').addEventListener('click', () => {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['When', 'Who', 'Action', 'Board', 'Details', 'From']].concat(LOG.map(l => [new Date(l.at).toISOString(), l.user_email || l.pc || '', ACTION[l.action] || l.action, l.room || '', detail(l), l.origin]));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = 'board-remote-audit-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------------- HCI: hospitals and staff ---------------- */
async function loadHci() {
  const [h, s] = await Promise.all([api('GET', '/api/hospitals'), api('GET', '/api/hci/people')]);
  if (h.ok) $('#tHosp').innerHTML = '<tr><th>Hospital</th><th>Boards</th><th>Offline</th><th>Locked</th><th>PCs</th><th>Updates</th><th>Microsoft tenant</th><th></th></tr>' + h.hospitals.map(x =>
    '<tr><td><b>' + esc(x.name) + '</b></td><td>' + x.devices + '</td><td>' + (x.down ? '<span class="tag bad">' + x.down + '</span>' : '0') + '</td><td>' + x.locked + ' of ' + x.devices + '</td><td>' + x.pcsOnline + ' of ' + x.pcs + '</td>' +
    '<td>' + (x.update_mode === 'approve' ? 'Approve' : 'Automatic') + (x.update_ring === 'pilot' ? ' <span class="tag blue">Pilot</span>' : '') + '</td>' +
    '<td class="mono">' + esc(x.entra_tenant_id || 'not set') + '</td><td class="r"><button class="btn" data-open="' + esc(x.id) + '">Open</button> <button class="btn" data-tid="' + esc(x.id) + '">Tenant</button></td></tr>').join('');
  if (s.ok) $('#tStaff').innerHTML = '<tr><th>Name</th><th>Role</th><th>Last sign in</th><th></th></tr>' + s.people.map(p =>
    '<tr><td><b>' + esc(p.name || p.email) + '</b><div class="sub">' + esc(p.email) + '</div></td><td>' + esc(roleNames[p.role] || 'No HCI role') + '</td><td class="m">' + esc(p.last_login ? ago(p.last_login) : 'never') + '</td>' +
    '<td class="r">' + (p.id === ME.user.id || !p.membership || ME.user.hciRole !== 'hci_admin' ? '' : '<button class="btn danger" data-rm="' + esc(p.membership) + '">Remove</button>') + '</td></tr>').join('');
  $('#fStaff').hidden = ME.user.hciRole !== 'hci_admin';
}
$('#tHosp').addEventListener('click', async e => {
  const o = e.target.closest('[data-open]');
  if (o) { H = o.dataset.open; $('#hosp').value = H; location.hash = '#boards'; return hospitalChanged(); }
  const t = e.target.closest('[data-tid]'); if (!t) return;
  const row = t.closest('tr'), cell = row.querySelector('.mono');
  if (cell.querySelector('input')) { const r = await api('PATCH', '/api/hospitals/' + t.dataset.tid, { entraTenantId: cell.querySelector('input').value }); toast(r.message, !r.ok); return loadHci(); }
  const cur = cell.textContent === 'not set' ? '' : cell.textContent;
  cell.innerHTML = '<input style="height:32px;width:100%;border:2px solid var(--line);border-radius:8px;padding:0 8px;font:600 12px var(--mono)" value="' + esc(cur) + '">'; t.textContent = 'Save';
});
$('#tStaff').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  sure(b, 'Click again to remove', async () => { const r = await api('DELETE', '/api/memberships/' + b.dataset.rm); toast(r.message, !r.ok); loadHci(); });
});
$('#fHosp').addEventListener('submit', async e => {
  e.preventDefault(); $('#hErr').textContent = '';
  const r = await api('POST', '/api/hospitals', { name: $('#hName').value, entraTenantId: $('#hTid').value });
  if (!r.ok) { $('#hErr').textContent = r.message; return; }
  toast(r.message); $('#hName').value = ''; $('#hTid').value = '';
  const me = await api('GET', '/api/me'); if (me.ok) { ME = me; $('#hosp').innerHTML = me.hospitals.map(h => '<option value="' + esc(h.id) + '">' + esc(h.name) + '</option>').join(''); $('#hosp').hidden = me.hospitals.length < 2; $('#hosp').value = H || ''; }
  loadHci();
});
$('#fStaff').addEventListener('submit', async e => {
  e.preventDefault(); $('#sErr').textContent = '';
  const r = await api('POST', '/api/hci/people', { email: $('#sEmail').value, role: $('#sRole').value });
  if (!r.ok) { $('#sErr').textContent = r.message; return; }
  toast(r.message); $('#sEmail').value = ''; loadHci();
});

/* ---------------- HCI: Board Remote releases ---------------- */
const RSTAT = { draft: ['', 'Draft'], pilot: ['blue', 'Pilot hospitals'], everyone: ['ok', 'Everyone'], paused: ['bad', 'Paused'] };
async function loadUpd() {
  const r = await api('GET', '/api/releases');
  if (!r.ok) return toast(r.message, true);
  const pub = r.canPublish;
  $('#tRel').innerHTML = '<tr><th>Version</th><th>Sent to</th><th>PCs on it</th><th>What changed</th><th>Added</th><th></th></tr>' + (r.releases.length ? r.releases.map(x => {
    const st = RSTAT[x.status] || RSTAT.draft, next = [];
    if (pub && x.status !== 'pilot' && x.status !== 'everyone') next.push(['pilot', 'Send to pilot']);
    if (pub && x.status !== 'everyone') next.push(['everyone', 'Send to everyone']);
    if (pub && (x.status === 'pilot' || x.status === 'everyone')) next.push(['paused', 'Pause']);
    return '<tr><td class="mono"><b>' + esc(x.version) + '</b><div class="sub">' + esc(Math.round(x.size / 1024)) + ' KB · ' + esc(x.sha256.slice(0, 12)) + '</div></td><td><span class="tag ' + st[0] + '">' + st[1] + '</span></td><td>' + x.on_version + '</td><td class="m" style="max-width:320px">' + esc(x.notes) + '</td><td class="m">' + esc(ago(x.created_at)) + (x.created_by_name ? '<div class="sub">' + esc(x.created_by_name) + '</div>' : '') + '</td>' +
      '<td class="r">' + next.map(([k, l]) => '<button class="btn' + (k === 'paused' ? ' danger' : k === 'everyone' ? ' dark' : '') + '" data-rel="' + esc(x.id) + '" data-st="' + k + '">' + l + '</button>').join(' ') + '</td></tr>';
  }).join('') : '<tr><td colspan="6" class="m">No release uploaded yet.</td></tr>');
  $('#tRelPcs').innerHTML = '<tr><th>Hospital</th><th>PC</th><th>Version</th><th>Update</th><th>Mode</th></tr>' + (r.pcs.length ? r.pcs.map(p =>
    '<tr><td>' + esc(p.hospital) + '</td><td><b>' + esc(p.name) + '</b><div class="sub">' + esc(p.pc_name || '') + (p.online ? '' : ' · not connected') + '</div></td><td class="mono">' + esc(p.version || '') + '</td><td>' + updCell(p) + '</td><td class="m">' + (p.update_mode === 'approve' ? 'Approve' : 'Automatic') + (p.update_ring === 'pilot' ? ', pilot' : '') + '</td></tr>').join('') : '<tr><td colspan="5" class="m">No PCs yet.</td></tr>');
  $('#fRel').hidden = !pub;
}
$('#tRel').addEventListener('click', e => {
  const b = e.target.closest('[data-rel]'); if (!b) return;
  const go = async () => { const r = await api('POST', '/api/releases/' + b.dataset.rel + '/status', { status: b.dataset.st }); toast(r.message, !r.ok); loadUpd(); };
  if (b.dataset.st === 'everyone') sure(b, 'Click again to send to every hospital', go); else go();
});
$('#rZip').addEventListener('change', () => { const m = /(\d+\.\d+\.\d+)/.exec(($('#rZip').files[0] || {}).name || ''); if (m && !$('#rVer').value) $('#rVer').value = m[1]; });
const readAs = (f, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); how === 'text' ? r.readAsText(f) : r.readAsDataURL(f); });
$('#fRel').addEventListener('submit', async e => {
  e.preventDefault(); $('#rErr').textContent = '';
  const z = $('#rZip').files[0], g = $('#rSig').files[0];
  if (!z || !g) { $('#rErr').textContent = 'Pick both files from the build: the .zip and the .sig.'; return; }
  $('#rGo').disabled = true; $('#rGo').textContent = 'Uploading…';
  try {
    const pkg = String(await readAs(z)).replace(/^data:[^,]*,/, ''), sig = String(await readAs(g, 'text')).trim();
    const r = await api('POST', '/api/releases', { version: $('#rVer').value.trim(), notes: $('#rNotes').value, packageBase64: pkg, signature: sig });
    if (!r.ok) { $('#rErr').textContent = r.message; return; }
    toast(r.message); $('#fRel').reset(); loadUpd();
  } finally { $('#rGo').disabled = false; $('#rGo').textContent = 'Upload as draft'; }
});

/* ---------------- shell ---------------- */
$('#hosp').addEventListener('change', () => { H = $('#hosp').value; hospitalChanged(); });
window.addEventListener('hashchange', route);
$('#btnOut').addEventListener('click', async () => { await api('POST', '/auth/logout', {}); location.href = '/auth/login'; });
setInterval(() => { if (view === 'boards' && FLEET && !(es && es.readyState === 1)) loadFleet(); }, 15000);   // fallback when the live stream is down
boot();
