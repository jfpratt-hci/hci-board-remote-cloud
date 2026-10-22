'use strict';
/* HCI ONE Board Remote, web dashboard. Every number and every row comes from the API as the signed in
   person, so the database's row level security decides what shows. Nothing here is trusted for access. */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KIND = { wb: 'Whiteboard', ds: 'Door sign', ub: 'Unit board', tv: 'TV', cam: 'Camera', tab: 'Tablet', usb: 'USB device', other: 'Board' };
const KS = { wb: 'WB', ds: 'DS', ub: 'UB', other: 'BD' };
const STATE = { online: ['ok', 'Online'], degraded: ['warn', 'Needs a look'], late: ['warn', 'Heartbeat late'], offline: ['bad', 'Offline'], paused: ['', 'Paused'], unknown: ['', 'Checking'] };
const ACTS = [['restart', 'Restart app', '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'], ['reboot', 'Reboot board', '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>'],
  ['wake', 'Wake screen', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2"/>'], ['clock', 'Fix clock', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'],
  ['storage', 'Free storage', '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'], ['reconnect', 'Reconnect ADB', '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>'],
  ['probe', 'Health check', '<path d="M3 12h4l3-8 4 16 3-8h4"/>'], ['keeper', 'Install ADB keeper', '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/>']];
const LEDS = [['off', 'Off', '#ECE8E1'], ['white', 'White', '#ffffff'], ['red', 'Red', '#D93A2F'], ['amber', 'Amber', '#E3A008'], ['green', 'Green', '#14A44D'], ['blue', 'Blue', '#2563EB']];
const LOCK = '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

let ME = null, H = null, FLEET = null, view = 'dash', sel = null, es = null, roleNames = {};
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
  if (!isHci() || (F.hospital && F.hospital !== 'all')) F.hospital = H || 'all';
  closeDrawer(); FLEET = null; listen(); load();
}
function route() {
  const v = (location.hash || '#dash').slice(1);
  view = ['dash', 'rep', 'boards', 'pcs', 'people', 'log', 'hci', 'upd'].indexOf(v) >= 0 && ((v !== 'hci' && v !== 'upd') || isHci()) ? v : 'dash';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.v === view));
  document.querySelectorAll('.view').forEach(s => { s.hidden = s.id !== 'v-' + view; });
  if (view !== 'boards') closeDrawer();
  load();
}
function load() {
  if (view === 'hci') return loadHci();
  if (view === 'upd') return loadUpd();
  if (view === 'dash') return loadDash();
  if (view === 'rep') return loadRep();
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
  es.addEventListener('fleet', () => { clearTimeout(refetch); refetch = setTimeout(() => { if (view === 'boards' || view === 'pcs') loadFleet(); if (view === 'log') loadLog(); if (view === 'dash') loadDash(true); }, 250); });
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
  if (drawnFor !== d.id) { $('#dRoom').value = d.room || ''; $('#dFloor').value = d.floor_set || ''; $('#dUnit').value = d.unit || ''; $('#dCloset').value = d.closet || ''; drawnFor = d.id; }
  $('#dFloor').placeholder = d.floor && !d.floor_set ? d.floor : ''; $('#dFloor').title = d.floor_set ? '' : 'Worked out from the room number. Type a floor to set it.';
  ['#dRoom', '#dFloor', '#dUnit', '#dCloset'].forEach(s => { $(s).disabled = !canEdit; });
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
  const r = await api('PATCH', '/api/devices/' + sel, { room: $('#dRoom').value, floor: $('#dFloor').value, unit: $('#dUnit').value, closet: $('#dCloset').value });
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
  'hospital.update_settings': 'Changed how updates install', 'alert.acked': 'Acknowledged an alert' };
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

/* ---------------- filters: the same for the dashboard and reports ---------------- */
const F = (() => { let f = {}; try { f = JSON.parse(localStorage.getItem('br.f') || '{}'); } catch (e) { /* private window */ } return Object.assign({ hospital: '', kind: '', floor: '', unit: '', closet: '', pc: '', range: '7', from: '', to: '' }, f); })();
let OPTS = null, DASH = null, REP = null, rKind = 'uptime';
try { rKind = localStorage.getItem('br.r') || 'uptime'; } catch (e) { /* private window */ }
const saveF = () => { try { localStorage.setItem('br.f', JSON.stringify(F)); } catch (e) { /* private window */ } };
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch (e) { return 'America/New_York'; } })();
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const RANGES = [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['last', 'Last month'], ['custom', 'Pick dates']];
function rangeDates() {
  const t = new Date(), d = n => { const x = new Date(t); x.setDate(x.getDate() - n); return ymd(x); };
  if (F.range === 'today') return [ymd(t), ymd(t)];
  if (F.range === '30') return [d(29), ymd(t)];
  if (F.range === 'month') return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)];
  if (F.range === 'last') return [ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), ymd(new Date(t.getFullYear(), t.getMonth(), 0))];
  if (F.range === 'custom' && F.from && F.to) return [F.from, F.to];
  return [d(6), ymd(t)];
}
function fq() {
  if (!F.hospital) F.hospital = isHci() ? 'all' : (H || 'all');
  const [from, to] = rangeDates(), q = new URLSearchParams({ hospital: F.hospital, from, to, tz: TZ });
  for (const k of ['kind', 'floor', 'unit', 'closet', 'pc']) if (F[k]) q.set(k, F[k]);
  return q.toString();
}
const rangeText = () => { const [a, b] = rangeDates(), f = x => new Date(x + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); return a === b ? f(a) : f(a) + ' to ' + f(b); };
function renderFbar() {
  const o = OPTS || { kinds: [], floors: [], units: [], closets: [], pcs: [], hospitals: [] };
  // a filter still set to something no longer offered keeps showing, so it can be cleared
  const sel = (k, all, list, label) => { const vals = list.map(x => Array.isArray(x) ? x : [x, x]); if (F[k] && !vals.some(v => v[0] === F[k])) vals.push([F[k], F[k]]);
    return '<select class="show' + (F[k] ? ' on' : '') + '" data-f="' + k + '" title="' + esc(label) + '"><option value="">' + esc(all) + '</option>' + vals.map(([v, l]) => '<option value="' + esc(v) + '"' + (F[k] === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>'; };
  const hs = (ME && ME.hospitals) || [];
  const multi = (o.hospitals.length > 1 && F.hospital === 'all') || hs.length > 1;
  const html = '<span class="label">Show</span>' +
    (hs.length > 1 ? '<select class="show' + (F.hospital !== 'all' ? ' on' : '') + '" data-f="hospital"><option value="all">All hospitals</option>' + hs.map(h => '<option value="' + esc(h.id) + '"' + (F.hospital === h.id ? ' selected' : '') + '>' + esc(h.name) + '</option>').join('') + '</select>' : '') +
    sel('kind', 'Every type', o.kinds.map(k => [k, KIND[k] || k]), 'Device type') +
    sel('floor', 'Every floor', o.floors.map(f => [f, 'Floor ' + f]), 'Floor') +
    sel('unit', 'Every unit', o.units, 'Unit') +
    sel('closet', 'Every closet', o.closets, 'Closet') +
    sel('pc', 'Every PC', o.pcs.map(p => [p.id, multi ? p.hname + ': ' + p.name : p.name]), 'Board Remote PC') +
    (['kind', 'floor', 'unit', 'closet', 'pc'].some(k => F[k]) ? '<button class="btn" data-clear="1">Clear</button>' : '') +
    '<span class="grow"></span>' +
    '<select class="show" data-f="range">' + RANGES.map(([v, l]) => '<option value="' + v + '"' + (F.range === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
    (F.range === 'custom' ? '<input type="date" data-f="from" value="' + esc(F.from || rangeDates()[0]) + '"><input type="date" data-f="to" value="' + esc(F.to || rangeDates()[1]) + '">' : '');
  document.querySelectorAll('[data-fbar]').forEach(el => { el.innerHTML = html; });
}
document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.f; if (!k || !e.target.closest('[data-fbar]')) return;
  F[k] = e.target.value;
  if (k === 'hospital') { for (const x of ['floor', 'unit', 'closet', 'pc']) F[x] = ''; if (F.hospital !== 'all' && F.hospital !== H) { H = F.hospital; $('#hosp').value = H; try { localStorage.setItem('br.h', H); } catch (x) { /* private window */ } listen(); } }
  if (k === 'range' && F.range === 'custom') { const [a, b] = rangeDates(); F.from = F.from || a; F.to = F.to || b; }
  saveF(); renderFbar(); load();
});
document.addEventListener('click', e => {
  const c = e.target.closest('[data-fbar] [data-clear]'); if (!c) return;
  for (const x of ['kind', 'floor', 'unit', 'closet', 'pc']) F[x] = '';
  saveF(); renderFbar(); load();
});

/* ---------------- dashboard ---------------- */
const hm = s => { s = Math.round(s || 0); if (s < 60) return s ? '<1 min' : '0'; const m = Math.round(s / 60); if (m < 60) return m + ' min'; const h = Math.floor(m / 60); if (h < 48) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); return Math.floor(h / 24) + ' d ' + (h % 24) + ' h'; };
const pctTxt = v => v === null || v === undefined ? 'n/a' : (v >= 99.995 ? '100' : v.toFixed(v >= 99 ? 2 : 1)) + '%';
const upCls = v => v === null || v === undefined ? '' : v >= 99 ? 'ok' : v >= 95 ? 'warn' : 'bad';
const meter = v => '<span class="meter ' + upCls(v) + '"><i><b style="width:' + Math.max(0, Math.min(100, v || 0)) + '%"></b></i><span>' + pctTxt(v) + '</span></span>';
const boardName = b => (b.room ? 'Room ' + b.room : b.name || 'Board') + (b.kind ? ' ' + (KS[b.kind] || '') : '');
let dashSeq = 0;
async function loadDash(quiet) {
  const n = ++dashSeq, r = await api('GET', '/api/dashboard?' + fq());
  if (n !== dashSeq || view !== 'dash') return;
  if (!r.ok) { if (!quiet) toast(r.message, true); return; }
  DASH = r; OPTS = r.options; renderFbar(); renderDash();
}
function renderDash() {
  const t = DASH.totals, nw = t.now;
  const kpi = (cls, v, label, sub) => '<div class="kpi ' + cls + '"><div class="label">' + label + '</div><div class="v">' + v + '</div><div class="s"><span class="d"></span>' + sub + '</div></div>';
  $('#kpis').innerHTML =
    kpi(nw.online + nw.warn === t.boards && t.boards ? 'ok' : '', (nw.online + nw.warn) + '<small> of ' + t.boards + '</small>', 'Boards up now', nw.warn ? nw.warn + ' need a look' : t.boards ? 'answering their PCs' : 'no boards match') +
    kpi(nw.offline ? 'bad' : 'ok', nw.offline, 'Offline now', nw.other ? nw.other + ' not watched right now' : 'every board is watched') +
    kpi(upCls(t.uptime), pctTxt(t.uptime), 'Uptime', rangeText()) +
    kpi(t.alertsUnacked ? 'bad' : t.alertsOpen ? 'warn' : 'ok', t.alertsOpen, 'Open alerts', t.alertsUnacked ? t.alertsUnacked + ' not acknowledged' : t.alertsOpen ? 'all acknowledged' : 'nothing open') +
    kpi(t.pcsOnline === t.pcs ? 'ok' : 'bad', t.pcsOnline + '<small> of ' + t.pcs + '</small>', 'Board Remote PCs', t.pcsOnline === t.pcs ? 'all connected' : (t.pcs - t.pcsOnline) + ' not connected');
  $('#chartSub').textContent = hm(t.down_s) + ' offline in all, ' + t.outages + ' outage' + (t.outages === 1 ? '' : 's') + ', ' + rangeText();
  drawChart();
  $('#gTitle').textContent = DASH.by === 'hospital' ? 'By hospital' : 'By unit';
  $('#tGroups').innerHTML = '<tr><th>' + (DASH.by === 'hospital' ? 'Hospital' : 'Unit') + '</th><th class="n">Boards</th><th class="n">Offline now</th><th>Uptime</th><th class="n">Outages</th></tr>' + (DASH.groups.length ? DASH.groups.map(g =>
    '<tr class="click" data-g="' + esc(DASH.by === 'hospital' ? g.hospital_id : g.name) + '"><td><b>' + esc(g.name) + '</b></td><td class="n">' + g.boards + '</td><td class="n">' + (g.offline ? '<span class="tag bad">' + g.offline + '</span>' : '0') + '</td><td>' + meter(g.uptime) + '</td><td class="n">' + g.outages + '</td></tr>').join('') : '<tr><td colspan="5" class="m">No boards match these filters.</td></tr>');
  $('#tWorst').innerHTML = '<tr><th>Board</th><th>Where</th><th class="n">Offline</th><th class="n">Uptime</th></tr>' + (DASH.worst.length ? DASH.worst.map(b =>
    '<tr class="click" data-b="' + esc(b.id) + '"><td><b>' + esc(boardName(b)) + '</b>' + (b.state === 'offline' ? ' <span class="tag bad">Offline</span>' : '') + '</td><td class="m">' + esc([DASH.by === 'hospital' ? b.hname : '', b.unit, b.floor ? 'floor ' + b.floor : ''].filter(Boolean).join(', ')) + '</td><td class="n">' + hm(b.down_s) + (b.outages > 1 ? '<div class="sub">' + b.outages + ' times</div>' : '') + '</td><td class="n">' + pctTxt(b.uptime) + '</td></tr>').join('') : '<tr><td colspan="4" class="m">No board went offline ' + (F.range === 'today' ? 'today' : 'in this range') + '.</td></tr>');
  $('#alist').innerHTML = DASH.alerts.length ? DASH.alerts.map(a =>
    '<div class="al ' + (a.acked_at ? 'acked' : 'bad') + '"><span class="dot"></span><span class="t">' + esc(a.title) + '</span>' + (a.acked_at ? '<span class="tag warn">' + esc((a.acked_by_name || a.acked_by_email || 'Someone').split(' ')[0]) + ' has it</span>' : '<button class="btn dark" data-ack="' + esc(a.id) + '">Acknowledge</button>') +
    '<span class="m">' + esc([a.kind === 'pc_offline' ? 'Board Remote PC' : KIND[a.board_kind] || 'Board', (DASH.by === 'hospital' ? a.hname : ''), a.unit, 'since ' + ago(a.opened_at).replace(' ago', '') + ' ago'].filter(Boolean).join(' · ')) + (a.acked_at ? ' · acknowledged ' + esc(ago(a.acked_at)) : '') + '</span></div>').join('')
    : '<div class="none"><b>Nothing open</b>Every board and PC that matches is answering.</div>';
}
function drawChart() {
  const el = $('#chart'), days = DASH.days, W = Math.max(200, el.clientWidth), Hh = Math.max(120, el.clientHeight);
  if (!days.length || days.every(d => d.up_s + d.down_s === 0)) { el.innerHTML = '<div class="empty">No history for these boards yet. It builds from the moment boards report in.</div>'; return; }
  const hrs = days.map(d => d.down_s / 3600), max = Math.max(1, ...hrs);
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 60 ? 10 : Math.ceil(max / 5 / 10) * 10, top = Math.ceil(max / step) * step;
  const L = 40, R = 8, T = 8, B = 22, pw = W - L - R, ph = Hh - T - B, bw = pw / days.length, gap = Math.min(8, Math.max(2, bw * .25));
  const y = v => T + ph - v / top * ph;
  let s = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="Hours offline per day">';
  for (let v = 0; v <= top + 1e-9; v += step) s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + ' h</text>';
  const every = Math.ceil(days.length / Math.max(1, Math.floor(pw / 52)));
  days.forEach((d, i) => {
    const x = L + i * bw + gap / 2, w = Math.max(1, bw - gap), h = hrs[i], yy = y(h), hh = T + ph - yy;
    const r = Math.min(4, w / 2, hh);
    const path = hh <= 0 ? '' : 'M' + x + ',' + (T + ph) + 'V' + (yy + r) + 'Q' + x + ',' + yy + ' ' + (x + r) + ',' + yy + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + yy + ' ' + (x + w) + ',' + (yy + r) + 'V' + (T + ph) + 'Z';
    s += '<g data-i="' + i + '"><rect class="hit" x="' + (L + i * bw) + '" y="' + T + '" width="' + bw + '" height="' + ph + '"/>' + (path ? '<path class="bar" d="' + path + '"/>' : '<rect class="bar zero" x="' + x + '" y="' + (T + ph - 2) + '" width="' + w + '" height="2" rx="1"/>') + '</g>';
    if (i % every === 0) s += '<text class="ax" x="' + (L + i * bw + bw / 2) + '" y="' + (Hh - 6) + '" text-anchor="middle">' + new Date(d.day + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) + '</text>';
  });
  el.innerHTML = s + '</svg>';
}
$('#chart').addEventListener('mousemove', e => {
  const g = e.target.closest('g[data-i]'), tip = $('#tip');
  if (!g || !DASH) { tip.hidden = true; return; }
  const d = DASH.days[+g.dataset.i];
  tip.innerHTML = '<b>' + new Date(d.day + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + '</b><br>' + hm(d.down_s) + ' offline, ' + d.outages + ' outage' + (d.outages === 1 ? '' : 's') + '<br>Uptime ' + pctTxt(d.uptime);
  tip.hidden = false; tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 14) + 'px'; tip.style.top = (e.clientY - tip.offsetHeight - 10) + 'px';
});
$('#chart').addEventListener('mouseleave', () => { $('#tip').hidden = true; });
window.addEventListener('resize', () => { if (view === 'dash' && DASH) drawChart(); });
$('#tGroups').addEventListener('click', e => {
  const r = e.target.closest('[data-g]'); if (!r) return;
  if (DASH.by === 'hospital') { F.hospital = r.dataset.g; H = F.hospital; $('#hosp').value = H; listen(); } else F.unit = r.dataset.g === 'No unit set' ? '' : r.dataset.g;
  saveF(); load();
});
$('#tWorst').addEventListener('click', async e => {
  const r = e.target.closest('[data-b]'); if (!r) return;
  const b = DASH.worst.find(x => x.id === r.dataset.b); if (!b) return;
  const h = ((ME.hospitals || []).find(x => x.name === b.hname) || {}).id;
  if (h && h !== H) { H = h; $('#hosp').value = H; hospitalChanged(); }
  location.hash = '#boards'; await loadFleet(); sel = b.id; renderDrawer(); renderBoards();
});
$('#alist').addEventListener('click', async e => {
  const b = e.target.closest('[data-ack]'); if (!b) return;
  b.disabled = true; const r = await api('POST', '/api/alerts/' + b.dataset.ack + '/ack', {}); toast(r.message, !r.ok); loadDash();
});

/* ---------------- reports ---------------- */
const RNAME = { uptime: 'Uptime', alerts: 'Alerts and response', inventory: 'Inventory', activity: 'Support activity' };
const STATE_WORD = s => (STATE[s] || STATE.unknown)[1];
const dt = t => t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
// each report: tiles, then columns as [heading, value for the screen, value for the CSV, number?]
const REPORTS = {
  uptime: r => ({
    tiles: [[pctTxt(r.summary.uptime), 'Uptime across ' + r.summary.boards + ' boards'], [hm(r.summary.down_s), 'Offline in all'], [r.summary.outages, 'Outages'], [r.summary.perfect, 'Boards never offline'], [r.summary.unwatched, 'Boards with no history in range']],
    cols: [['Board', b => '<b>' + esc(boardName(b)) + '</b>', b => boardName(b)], ['Hospital', b => esc(b.hname), b => b.hname, 0, 'multi'], ['Unit', b => esc(b.unit), b => b.unit], ['Floor', b => esc(b.floor), b => b.floor], ['Closet', b => esc(b.closet), b => b.closet],
      ['Uptime', b => meter(b.uptime), b => b.uptime === null ? '' : b.uptime], ['Offline', b => hm(b.down_s), b => Math.round(b.down_s / 60), 1, 0, 'Offline (min)'], ['Outages', b => b.outages, b => b.outages, 1], ['Longest', b => hm(b.longest_s), b => Math.round(b.longest_s / 60), 1, 0, 'Longest (min)'],
      ['Not watched', b => hm(b.other_s), b => Math.round(b.other_s / 60), 1, 0, 'Not watched (min)'], ['Now', b => '<span class="tag ' + cls(b) + '">' + esc(STATE_WORD(b.state)) + '</span>', b => STATE_WORD(b.state)]]
  }),
  alerts: r => ({
    tiles: [[r.summary.total, 'Alerts opened'], [r.summary.boards + ' / ' + r.summary.pcs, 'Boards / PCs'], [r.summary.medAck === null ? 'n/a' : r.summary.medAck + ' min', 'Typical time to acknowledge'], [r.summary.medFix === null ? 'n/a' : hm(r.summary.medFix * 60), 'Typical time back up'], [r.summary.open, 'Still open']]
      .concat(r.summary.repeat.length ? [['<div class="lst">' + r.summary.repeat.slice(0, 4).map(x => esc(x.room ? 'Room ' + x.room : x.title) + ': ' + x.n + ' times').join('<br>') + '</div>', 'Went offline most', 1]] : []),
    cols: [['Opened', a => esc(dt(a.opened_at)), a => new Date(a.opened_at).toISOString()], ['Alert', a => '<b>' + esc(a.title) + '</b>', a => a.title], ['Hospital', a => esc(a.hname), a => a.hname, 0, 'multi'], ['Unit', a => esc(a.unit || ''), a => a.unit || ''],
      ['Acknowledged by', a => a.acked_at ? esc(a.acked_by_name || a.acked_by_email) + '<div class="sub">after ' + a.ack_min + ' min</div>' : '<span class="m">No one</span>', a => a.acked_by_name || a.acked_by_email || ''], ['To acknowledge', a => a.ack_min === null ? '' : a.ack_min + ' min', a => a.ack_min === null ? '' : a.ack_min, 1, 0, 'To acknowledge (min)'],
      ['Back up', a => a.resolved_at ? esc(dt(a.resolved_at)) : '<span class="tag bad">Still open</span>', a => a.resolved_at ? new Date(a.resolved_at).toISOString() : 'open'], ['Down for', a => a.fix_min === null ? '' : hm(a.fix_min * 60), a => a.fix_min === null ? '' : a.fix_min, 1, 0, 'Down for (min)']]
  }),
  inventory: r => {
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n || 4).map(([k, v]) => esc(KIND[k] || k) + ': ' + v).join('<br>');
    return {
      tiles: [[r.summary.boards, 'Boards'], [r.summary.locked + ' of ' + r.summary.boards, 'Locations locked by HCI'], ['<div class="lst">' + top(r.summary.byKind) + '</div>', 'By type', 1], ['<div class="lst">' + top(r.summary.byModel) + '</div>', 'By model', 1], ['<div class="lst">' + Object.entries(r.summary.byAndroid).sort().map(([k, v]) => 'Android ' + esc(k) + ': ' + v).slice(0, 4).join('<br>') + '</div>', 'Android versions', 1]],
      cols: [['Board', b => '<b>' + esc(b.room ? 'Room ' + b.room : b.name || b.identity) + '</b>', b => b.room || b.name], ['Type', b => esc(KIND[b.kind] || b.kind), b => KIND[b.kind] || b.kind], ['Hospital', b => esc(b.hname), b => b.hname, 0, 'multi'], ['Unit', b => esc(b.unit), b => b.unit], ['Floor', b => esc(b.floor), b => b.floor], ['Closet', b => esc(b.closet), b => b.closet],
        ['Model', b => esc(b.model), b => b.model], ['Android', b => esc(b.android), b => b.android], ['MAC or serial', b => '<span class="mono">' + esc(b.identity) + '</span>', b => b.identity], ['Seen by', b => b.seen_by ? esc(b.seen_by.pc) + '<div class="sub">' + esc(b.seen_by.host || '') + '</div>' : '', b => b.seen_by ? b.seen_by.pc : ''],
        ['Now', b => '<span class="tag ' + cls(b) + '">' + esc(STATE_WORD(b.state)) + '</span>', b => STATE_WORD(b.state)], ['Locked', b => b.locked ? LOCK.replace('<svg', '<svg style="width:14px;height:14px"') : '', b => b.locked ? 'yes' : '']]
    };
  },
  activity: r => ({
    tiles: [[r.summary.actions, 'Changes and commands'], [r.summary.commands, 'Fixes sent to boards'], [r.summary.success === null ? 'n/a' : r.summary.success + '%', r.summary.done + ' worked, ' + r.summary.failed + ' failed, ' + r.summary.expired + ' timed out'],
      ['<div class="lst">' + r.summary.people.slice(0, 4).map(p => esc(p.who) + ': ' + p.actions).join('<br>') + '</div>', 'Most active', 1], ['<div class="lst">' + r.summary.fixes.slice(0, 4).map(f => esc(f.name) + ': ' + f.done + ' of ' + f.n).join('<br>') + '</div>', 'Fixes that worked', 1]],
    cols: [['When', l => esc(dt(l.at)), l => new Date(l.at).toISOString()], ['Who', l => esc(l.user_name || l.user_email || l.pc || (l.actor_kind === 'system' ? 'Board Remote Cloud' : '')), l => l.user_email || l.pc || l.actor_kind], ['What', l => esc(ACTION[l.action] || l.action) + (l.result && l.result !== 'ok' ? ' <span class="tag bad">' + esc(l.result) + '</span>' : ''), l => ACTION[l.action] || l.action],
      ['Hospital', l => esc(l.hname), l => l.hname, 0, 'multi'], ['Board', l => esc(l.room ? (KS[l.board_kind] || '') + ' ' + l.room : ''), l => l.room || ''], ['Details', l => '<span class="m">' + esc(detail(l)) + '</span>', l => detail(l)], ['From', l => l.origin === 'agent' ? 'Board Remote PC' : l.actor_kind === 'system' ? 'Cloud' : 'Web', l => l.origin]]
  })
};
let repSeq = 0;
async function loadRep() {
  document.querySelectorAll('#rSeg button').forEach(b => b.classList.toggle('on', b.dataset.r === rKind));
  const n = ++repSeq, r = await api('GET', '/api/reports/' + rKind + '?' + fq());
  if (n !== repSeq || view !== 'rep') return;
  if (!r.ok) return toast(r.message, true);
  REP = r; renderFbar(); renderRep();
  if (!OPTS) { const d = await api('GET', '/api/dashboard?' + fq()); if (d.ok) { OPTS = d.options; renderFbar(); } }
}
const repCols = r => { const def = REPORTS[r.kind](r); def.cols = def.cols.filter(c => c[4] !== 'multi' || r.hospitals.length > 1); return def; };
function renderRep() {
  const r = REP, def = repCols(r), fs = [];
  if (r.filters.kind) fs.push(KIND[r.filters.kind] || r.filters.kind); if (r.filters.floor) fs.push('floor ' + r.filters.floor); if (r.filters.unit) fs.push(r.filters.unit); if (r.filters.closet) fs.push(r.filters.closet);
  if (r.filters.pc && OPTS) fs.push(((OPTS.pcs.find(p => p.id === r.filters.pc) || {}).name) || 'one PC');
  $('#rTitle').innerHTML = '<div class="label">HCI ONE Board Remote</div><h2>' + esc(RNAME[r.kind]) + ' report</h2><p class="sub">' + esc(r.hospitals.length > 3 ? r.hospitals.length + ' hospitals' : r.hospitals.join(', ')) + ' · ' + esc(rangeText()) + (fs.length ? ' · ' + esc(fs.join(', ')) : '') + ' · made ' + esc(new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })) + ' by ' + esc(ME.user.name || ME.user.email) + '</p>';
  $('#rTiles').innerHTML = def.tiles.map(([v, l, wide]) => '<div class="rtile' + (wide ? ' wide' : '') + '"><div class="v">' + (wide ? v : esc(v)) + '</div><div class="s">' + esc(l) + '</div></div>').join('');
  $('#tRep').innerHTML = '<tr>' + def.cols.map(c => '<th' + (c[3] ? ' class="n"' : '') + '>' + esc(c[0]) + '</th>').join('') + '</tr>' +
    (r.rows.length ? r.rows.map(x => '<tr>' + def.cols.map(c => '<td' + (c[3] ? ' class="n"' : '') + '>' + c[1](x) + '</td>').join('') + '</tr>').join('') : '<tr><td colspan="' + def.cols.length + '" class="m">Nothing in this range for these filters.</td></tr>');
}
$('#rSeg').addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; rKind = b.dataset.r; try { localStorage.setItem('br.r', rKind); } catch (x) { /* private window */ } REP = null; loadRep(); });
$('#rCsv').addEventListener('click', () => {
  if (!REP) return;
  const def = repCols(REP), q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [def.cols.map(c => c[5] || c[0])].concat(REP.rows.map(x => def.cols.map(c => c[2](x))));
  const [a, b] = rangeDates();
  const el = document.createElement('a'); el.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
  el.download = 'board-remote-' + REP.kind + '-' + a + (a === b ? '' : '-to-' + b) + '.csv'; el.click(); setTimeout(() => URL.revokeObjectURL(el.href), 1000);
});
$('#rPdf').addEventListener('click', () => { if (REP) window.print(); });

/* ---------------- shell ---------------- */
$('#hosp').addEventListener('change', () => { H = $('#hosp').value; hospitalChanged(); });
window.addEventListener('hashchange', route);
$('#btnOut').addEventListener('click', async () => { await api('POST', '/auth/logout', {}); location.href = '/auth/login'; });
setInterval(() => { if (view === 'boards' && FLEET && !(es && es.readyState === 1)) loadFleet(); }, 15000);
setInterval(() => { if (view === 'dash' && !document.hidden) loadDash(true); }, 30000);   // other hospitals have no live stream here   // fallback when the live stream is down
boot();
