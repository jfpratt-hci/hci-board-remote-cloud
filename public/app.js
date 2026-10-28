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
  $('#hosp').hidden = hs.length < 2; $('#hosp').parentElement.hidden = hs.length < 2; if (H) $('#hosp').value = H;
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
  view = ['dash', 'rep', 'ctr', 'boards', 'pcs', 'people', 'log', 'hci', 'upd'].indexOf(v) >= 0 && ((v !== 'hci' && v !== 'upd') || isHci()) ? v : 'dash';
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
  if (view === 'ctr') return loadCtr();
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
  es.addEventListener('fleet', () => { clearTimeout(refetch); refetch = setTimeout(() => { if (view === 'boards' || view === 'pcs') loadFleet(); if (view === 'log') loadLog(); if (view === 'dash') loadDash(true); if (view === 'ctr') loadCtr(true); }, 250); });
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
    '<span class="m">' + esc([a.kind === 'pc_offline' ? 'Board Remote PC' : /^container/.test(a.kind) ? 'Backend container' : a.kind === 'service' || a.kind === 'prometheus_down' ? 'Backend service' : KIND[a.board_kind] || 'Board', (DASH.by === 'hospital' ? a.hname : ''), a.unit, 'since ' + ago(a.opened_at).replace(' ago', '') + ' ago'].filter(Boolean).join(' · ')) + (a.acked_at ? ' · acknowledged ' + esc(ago(a.acked_at)) : '') + '</span></div>').join('')
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

/* ---------------- containers (cAdvisor) ---------------- */
// Seven fixed colours, given to the busiest containers when a host is picked and kept while the page
// shows it, so a container never changes colour between charts or refreshes. The rest fold into Other.
const PAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'], OTHER = '#a8a39b';
const K = { host: '', range: '1h', q: '', focus: '', metric: 'cpu', from: 0, to: 0, prev: '1h' };   // custom: from/to in ms, to 0 = up to now
try { const k = JSON.parse(localStorage.getItem('br.k') || '{}'); if (k.range) K.range = k.range; if (k.range === 'custom') { K.from = k.from || 0; K.to = k.to || 0; K.prev = k.prev || '1h'; if (K.from < Date.now() - 8 * 86400000) K.range = K.prev; } if (k.host) K.host = k.host; if (k.metric) K.metric = k.metric; } catch (e) { /* private window */ }
const saveK = () => { try { localStorage.setItem('br.k', JSON.stringify({ host: K.host, range: K.range, metric: K.metric, from: K.from, to: K.to, prev: K.prev })); } catch (e) { /* private window */ } };
let CTR = null, ctrSeq = 0, kColors = null, kColorKey = '';
const bytes = n => { if (n === null || n === undefined) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; };
const rate = n => n === null || n === undefined ? '–' : bytes(n) + '/s';
const cpuTxt = c => c === null || c === undefined ? '–' : (c * 100 < 10 ? (c * 100).toFixed(1) : Math.round(c * 100)) + '%';
// key, title, subtitle, format, the smallest top of the scale (so an idle chart still reads sensibly)
const KM = [['cpu', 'CPU', '100% is one full core', cpuTxt, 0.05], ['mem', 'Memory', 'Working set', bytes, 1048576], ['rx', 'Network received', 'Bytes per second in', rate, 1024],
  ['tx', 'Network sent', 'Bytes per second out', rate, 1024], ['rd', 'Disk read', 'Bytes per second', rate, 1024], ['wr', 'Disk written', 'Bytes per second', rate, 1024],
  ['throttle', 'CPU throttled', 'Share of time its CPU limit held it back', v => v === null || v === undefined ? '–' : Math.round(v * 100) + '%', 0.1, 'max']];
const upFor = t => { if (!t) return ''; const s = (Date.now() - new Date(t)) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days'; };

// the time, service, host and search controls: inside the analytics console, or above the page when there is none
function kDock(inside) {
  const bar = $('.ctrbar'), home = inside && $('#kConCtl');
  if (home) { if (bar.parentNode !== home) home.appendChild(bar); }
  else if (bar.parentNode !== $('#v-ctr')) $('#v-ctr').insertBefore(bar, $('#kBody'));
}
// the time asked for, as query parameters: a preset, or from (and to, unless it runs up to now)
const kWindowQ = () => K.range !== 'custom' ? { range: K.range } : Object.assign({ from: new Date(K.from).toISOString() }, K.to ? { to: new Date(K.to).toISOString() } : {});
async function loadCtr(quiet) {
  if (!H) return;
  const q = Object.assign({ hospital: H, host: K.host }, kWindowQ());
  const n = ++ctrSeq, r = await api('GET', '/api/containers?' + new URLSearchParams(q));
  if (n !== ctrSeq || view !== 'ctr') return;
  if (!r.ok) {
    if (!quiet) toast(r.message, true);
    if (K.range === 'custom' && /^Pick /.test(r.message || '')) { K.range = K.prev; saveK(); }   // a stretch no longer kept
    return;
  }
  CTR = r;
  if (r.host && K.host !== r.host.id) { K.host = r.host.id; saveK(); }
  renderCtr();
  // a refresh brings in new events too, unless more pages were opened (they would jump)
  if (quiet && CTR.host && KE.rows.length <= 25 && kEvKey() === KE.want) loadEv(false);
}
const kMatch = c => !K.q || (c.name + ' ' + c.image).toLowerCase().indexOf(K.q.toLowerCase()) >= 0;
function kPickColors() {
  // the busiest by CPU and memory together, over the range shown
  const key = CTR.host.id + '|' + K.range + (K.range === 'custom' ? '|' + K.from + '|' + K.to : '');
  if (kColors && kColorKey === key) return;
  const avg = a => { const v = (a || []).filter(x => x !== null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
  const names = CTR.containers.filter(c => c.running).map(c => c.name);
  const cpu = new Map(names.map(n => [n, avg(CTR.series.cpu[n])])), mem = new Map(names.map(n => [n, avg(CTR.series.mem[n])]));
  const rank = m => { const o = names.slice().sort((a, b) => m.get(b) - m.get(a)); return new Map(o.map((n, i) => [n, i])); };
  const rc = rank(cpu), rm = rank(mem);
  kColors = new Map(names.sort((a, b) => (rc.get(a) + rm.get(a)) - (rc.get(b) + rm.get(b)) || a.localeCompare(b)).slice(0, PAL.length).map((n, i) => [n, PAL[i]]));
  kColorKey = key;
}
// a running container's state: fine, or what is pressing on it now
function kFlags(c) {
  const f = [], open = new Set((CTR.alerts || []).filter(a => a.container === c.name).map(a => a.kind));
  if (open.has('container_memory') || (c.mem_limit && c.mem / c.mem_limit >= 0.9)) f.push('<span class="tag bad">Memory limit</span>');
  if (open.has('container_cpu') || c.throttle >= 0.25) f.push('<span class="tag warn">CPU throttled ' + Math.round((c.throttle || 0) * 100) + '%</span>');
  if (open.has('container_restarting')) f.push('<span class="tag bad">Restarting</span>');
  if (open.has('container_unusual')) f.push('<span class="tag warn">Unusual</span>');
  if (c.psi_mem >= 10 || c.psi_io >= 25) f.push('<span class="tag warn" title="Share of the last minute it waited for ' + (c.psi_mem >= 10 ? 'memory' : 'disk') + '">Waiting on ' + (c.psi_mem >= 10 ? 'memory ' + Math.round(c.psi_mem) : 'disk ' + Math.round(c.psi_io)) + '%</span>');
  return f.length ? f.join(' ') : '<span class="tag ok">Running</span>';
}
const KEV_C = { restart: 'var(--red)', stopped: 'var(--red)', started: 'var(--green)', limit: 'var(--amber)' };
const EVW = { restart: ['bad', 'Restarted'], stopped: ['bad', 'Stopped'], started: ['ok', 'Started'], limit: ['warn', 'Memory limit'] };
const kLast = a => { for (let i = (a || []).length - 1; i >= 0; i--) if (a[i] !== null) return a[i]; return null; };
function renderCtr() {
  const r = CTR;
  $('#kHost').innerHTML = r.hosts.map(h => '<option value="' + esc(h.id) + '">' + esc(h.name) + (!h.ok || h.stale ? ' (not reporting)' : '') + '</option>').join('');
  $('#kHost').hidden = r.hosts.length < 2; if (r.host) $('#kHost').value = r.host.id;
  document.querySelectorAll('#kRange button').forEach(b => b.classList.toggle('on', b.dataset.k === K.range));
  $('#kCust').textContent = K.range === 'custom' && CTR.from ? kSpan(CTR.from, K.to ? CTR.to : 0) : 'Custom';
  $('#kBack').hidden = K.range !== 'custom'; $('#kBack').textContent = '✕ Back to ' + ($('#kRange [data-k="' + K.prev + '"]') || { textContent: '1 h' }).textContent;
  // pick one container from anywhere on the page, without scrolling to the table
  $('#kOne').innerHTML = '<option value="">Every container (' + r.containers.length + ')</option>' + r.containers.map(c => '<option value="' + esc(c.name) + '">' + esc(c.name) + (c.running ? '' : ' (stopped)') + '</option>').join('');
  $('#kOne').hidden = !r.host; $('#kOne').value = K.focus;
  if (!r.host) {
    $('#kSeen').textContent = '';
    kDock(false);
    $('#kBody').innerHTML = '<div class="empty"><h2>No Docker hosts yet</h2><p class="sub">The containers of this hospital\'s backend (MediaCare and its services) show here once a Board Remote PC at the hospital reads cAdvisor on the Docker host.</p>' +
      '<p class="sub"><b>1.</b> On the Docker host, add cAdvisor if it is not there: <code>deploy/monitoring/add-cadvisor.ps1</code> (Windows) or <code>add-cadvisor.sh</code> (Linux). It listens on port 8098.<br><b>2.</b> For service alerts, add Prometheus too: <code>add-prometheus.ps1</code> or <code>add-prometheus.sh</code>, port 9090.<br><b>3.</b> On a Board Remote PC joined to this hospital, open Remote, Backend containers, and add <code>http://&lt;host&gt;:8098</code> and <code>http://&lt;host&gt;:9090</code>.<br><b>4.</b> Containers show here within a minute.</p></div>';
    return;
  }
  if (!$('#kIns')) {
    $('#kBody').innerHTML = '<section class="kcon" id="kOneP" aria-label="Container analytics">' +
      '<div class="kc-head"><div class="kc-title"><span class="kc-live" title="Live: a new minute from cAdvisor every 60 s"></span><div><h2>Container analytics</h2><p id="kOneS"></p></div></div><div class="kc-stats" id="kConStats"></div></div>' +
      '<div class="kc-ctl" id="kConCtl"></div>' +
      '<div class="kc-tiles" id="kTiles"></div>' +
      '<div class="kc-main"><div class="kc-card"><div class="kc-ch"><div><span class="kc-k">Viewing</span><h3 id="kOneT"></h3></div><span id="kOneX"></span></div><div id="kOneC"></div></div>' +
      '<div class="kc-card" id="kChgP"><div class="kc-ch"><div><span class="kc-k">What changed lately</span><p id="kChgS"></p></div></div><div class="kchg" id="kChg"></div></div></div>' +
      '<div class="kc-card" id="kHeatP"><div class="kc-ch"><div><span class="kc-k">Every container over time</span><p id="kHeatS"></p></div></div><div class="kheat" id="kHeat"></div><div id="kHeatM"></div></div></section>' +
      '<div class="kdash">' +
      '<div class="panel w5" id="kInsP"><div class="phead"><div><h2>What is going on</h2><p class="sub" id="kInsS"></p></div><span class="kstate" id="kInsT"></span></div><div class="kins" id="kIns"></div></div>' +
      '<div class="panel w7" id="kSplitP"><div class="phead"><div><h2>Where the host goes</h2><p class="sub">Right now, split by container. The empty end is what is left. Click a part to look at that container.</p></div></div><div class="ksplit" id="kSplit"></div></div>' +
      '<div class="panel w7" id="kAlertsP"><div class="phead"><div><h2>Problems on this host</h2><p class="sub" id="kAlertsSub"></p></div></div><div id="kAlertsC"></div><div class="alist" id="kAlerts"></div><div id="kAlertsM"></div></div>' +
      '<div class="panel w7" id="kSizeP"><div class="phead"><div><h2>Sizing and headroom</h2><p class="sub" id="kSizeS"></p></div></div><div class="kfcs" id="kSizeF"></div><div class="tablewrap"><table class="tbl" id="tSize"></table></div>' +
      '<div class="kfoot"><p class="sub">Suggestions leave 30% over the peak. For a Java service keep the limit at least a quarter above its -Xmx, or it is stopped when the heap fills.</p><span id="kSizeM"></span></div><div id="kSizeP2"></div></div>' +
      '<div class="panel w5"><div class="phead"><div><h2>Recent events</h2><p class="sub" id="kEvS"></p></div></div><div id="kEvC"></div><div class="tablewrap"><table class="tbl kevt" id="tEv"></table></div><div id="kEvM"></div></div>' +
      '<div class="panel w12"><div class="phead"><div><h2>Containers</h2><p class="sub">Click one to look at it, again to see the whole host. Click a column to sort by it.</p></div></div><div id="kCtrC"></div><div class="tablewrap"><table class="tbl" id="tCtr"></table></div><div id="kCtrM"></div></div></div>';
    kDock(true);
  }
  kPickColors();
  const h = r.host, last = kLast;
  $('#kSeen').textContent = (h.ok && !h.stale ? 'Read ' : 'Last read ') + ago(h.ok ? h.last_ok : h.last_seen) + (h.pc ? ' by ' + h.pc : '') + (h.cadvisor ? ' · cAdvisor ' + h.cadvisor : '') + (h.address ? ' · ' + h.address.replace(/^https?:\/\//, '') : '') +
    (h.prometheus ? ' · Prometheus ' + (h.prom_ok ? h.prom_rules + ' rules checked' : 'not answering') : ' · no Prometheus: service alerts off');
  // the console's header: the host at a glance
  const S = r.series, hc = last(S.cpu['']), hm2 = last(S.mem['']);
  const rn = (CTR.marks || []).filter(m => m.kind === 'restart').reduce((a, m) => a + m.n, 0), open = (CTR.alerts || []).length;
  const pill = (cls, html, title) => '<span class="kc-pill ' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + html + '</span>';
  $('#kConStats').innerHTML =
    pill(!h.ok || h.stale ? 'bad' : h.stopped ? 'bad' : 'ok', '<b>' + h.running + '</b> running' + (h.stopped ? ' · <b>' + h.stopped + '</b> stopped' : ''), !h.ok || h.stale ? h.error || 'cAdvisor is not reporting' : '') +
    pill('', 'CPU <b>' + (hc !== null && h.cores ? Math.round(hc / h.cores * 100) + '%' : '–') + '</b> of ' + (h.cores || '?') + ' cores') +
    pill('', 'Memory <b>' + (hm2 !== null && h.memory ? Math.round(hm2 / h.memory * 100) + '%' : '–') + '</b> of ' + bytes(h.memory)) +
    pill(rn ? 'warn' : '', '<b>' + rn + '</b> ' + (rn === 1 ? 'restart' : 'restarts')) +
    pill(open ? 'bad' : 'ok', '<b>' + open + '</b> ' + (open === 1 ? 'problem' : 'problems') + ' open') +
    '<span class="kc-pill" id="kConState"></span>';
  renderInsights(); renderAlerts(); renderSplit(); renderConsole(); renderSizing(); renderTable();
  if (kEvKey() !== KE.want) loadEv(false); else renderEv();
}

/* Lists on this page that can grow (problems, containers, the heatmap, sizing) show a page at a time,
   with chips to narrow them; events are paged by the server. KP[list] is how many are shown now. */
const KPAGE = { alerts: 6, ctr: 25, heat: 15, size: 15 }, KP = {}, KF = { alerts: '', ctr: '', ev: '' };
const kShown = (list, total) => Math.min(total, KP[list] || KPAGE[list]);
function kMore(list, total) {
  const n = kShown(list, total); if (total <= KPAGE[list]) return '';
  return '<div class="kmore"><span>Showing ' + n + ' of ' + total + '</span>' + (n < total
    ? '<button class="btn" data-more="' + list + '">Show ' + Math.min(KPAGE[list], total - n) + ' more</button>' + (total - n > KPAGE[list] ? '<button class="btn" data-all="' + list + '">Show all</button>' : '')
    : '<button class="btn" data-less="' + list + '">Show fewer</button>') + '</div>';
}
const kChips = (list, opts) => '<div class="kchips">' + opts.map(([v, label, n]) => '<button data-chip="' + list + '" data-v="' + v + '" class="' + (KF[list] === v ? 'on' : '') + '"' + (v && !n && KF[list] !== v ? ' disabled' : '') + '>' + label + ' <b>' + n + '</b></button>').join('') + '</div>';
const KRENDER = { alerts: () => renderAlerts(), ctr: () => renderTable(), heat: () => renderHeat(), size: () => renderSizing(), ev: () => loadEv(false) };

// Problems on this host, grouped into chips by what kind of problem it is; the unacknowledged first
const AL_G = { container_down: 'stop', container_restarting: 'stop', container_memory: 'mem', container_cpu: 'cpu', container_unusual: 'unusual', service: 'svc', prometheus_down: 'svc', container_host_down: 'host' };
const AL_L = [['stop', 'Stopped and restarting'], ['mem', 'Memory'], ['cpu', 'CPU'], ['unusual', 'Unusual'], ['svc', 'Services'], ['host', 'cAdvisor']];
function renderAlerts() {
  const h = CTR.host, all = (CTR.alerts || []).slice().sort((a, b) => (a.acked_at ? 1 : 0) - (b.acked_at ? 1 : 0) || new Date(b.opened_at) - new Date(a.opened_at));
  $('#kAlertsSub').textContent = all.length ? all.length + ' open' + (all.some(a => a.acked_at) ? ', ' + all.filter(a => !a.acked_at).length + ' not yet acknowledged' : '') + '. From cAdvisor' + (h.prometheus ? ' and the services\' own numbers in Prometheus' : '') + '. Each closes on its own once the cause is gone.' : '';
  $('#kAlertsP').hidden = !all.length && h.ok;
  const n = g => all.filter(a => (AL_G[a.kind] || 'svc') === g).length;
  if (KF.alerts && !n(KF.alerts)) KF.alerts = '';
  $('#kAlertsC').innerHTML = all.length > 3 ? kChips('alerts', [['', 'All', all.length]].concat(AL_L.filter(([g]) => n(g)).map(([g, l]) => [g, l, n(g)]))) : '';
  const al = all.filter(a => !KF.alerts || (AL_G[a.kind] || 'svc') === KF.alerts);
  $('#kAlerts').innerHTML = al.length ? al.slice(0, kShown('alerts', al.length)).map(a => '<div class="al ' + (a.acked_at ? 'acked' : 'bad') + '"><span class="dot"></span><span class="t">' + esc(a.title) + '</span>' +
    (a.acked_at ? '<span class="tag warn">' + esc(String(a.acked_by_name || 'Someone').split(' ')[0]) + ' has it</span>' : '<button class="btn dark" data-kack="' + esc(a.id) + '">Acknowledge</button>') +
    '<span class="m">' + esc((KIND_K[a.kind] || 'Backend') + ' · since ' + ago(a.opened_at).replace(' ago', '') + ' ago') + '</span></div>').join('') : '<div class="none"><b>Nothing wrong</b>Every container is running within its limits.</div>';
  $('#kAlertsM').innerHTML = kMore('alerts', al.length);
}

// Containers: All, the ones needing a look, the stopped ones; sorted by any column
const kTrouble = c => !c.running || (CTR.alerts || []).some(a => a.container === c.name) || (c.mem_limit && c.mem / c.mem_limit >= 0.9) || c.throttle >= 0.25 || c.psi_mem >= 10 || c.psi_io >= 25;
const KSORT = { name: c => c.name, restarts: c => c.restarts || 0, cpu: c => c.running ? c.cpu || 0 : -1, mem: c => c.running ? c.mem || 0 : -1, rx: c => c.running ? c.rx || 0 : -1, tx: c => c.running ? c.tx || 0 : -1, fs: c => c.fs || 0, up: c => c.running && c.started_at ? -new Date(c.started_at) : -Infinity };
function renderTable() {
  const base = CTR.containers.filter(kMatch), trouble = base.filter(kTrouble).length, stopped = base.filter(c => !c.running).length;
  $('#kCtrC').innerHTML = kChips('ctr', [['', 'All', base.length], ['trouble', 'Needs a look', trouble], ['stopped', 'Stopped', stopped]]);
  let rows = base.filter(c => !KF.ctr || (KF.ctr === 'stopped' ? !c.running : kTrouble(c)));
  if (K.sort) { const f = KSORT[K.sort], d = K.desc ? -1 : 1; rows = rows.slice().sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * d || a.name.localeCompare(b.name); }); }
  const th = (k, label, n) => '<th class="sort' + (n ? ' n' : '') + (K.sort === k ? ' on' : '') + '" data-sort="' + k + '">' + label + (K.sort === k ? (K.desc ? ' ↓' : ' ↑') : '') + '</th>';
  $('#tCtr').innerHTML = '<tr>' + th('name', 'Container') + '<th>Image</th><th>Status</th>' + th('restarts', 'Restarts', 1) + th('cpu', 'CPU', 1) + th('mem', 'Memory', 1) + th('rx', 'Net in', 1) + th('tx', 'Net out', 1) + th('fs', 'Disk', 1) + th('up', 'Up', 1) + '</tr>' +
    (rows.length ? rows.slice(0, kShown('ctr', rows.length)).map(c =>
    '<tr class="click' + (K.focus === c.name ? ' picked' : '') + '" data-c="' + esc(c.name) + '"><td><b><span class="sw" style="background:' + (kColors.get(c.name) || OTHER) + '"></span>' + esc(c.name) + '</b></td><td><div class="img" title="' + esc(c.image) + '">' + esc(c.image) + '</div></td>' +
    '<td>' + (c.running ? kFlags(c) : '<span class="tag bad">Stopped</span><div class="sub">' + esc(ago(c.last_seen)) + '</div>') + '</td>' +
    '<td class="n">' + (c.restarts ? c.restarts + '<div class="sub">last ' + esc(ago(c.restarted_at)) + '</div>' : '0') + '</td>' +
    '<td class="n">' + (c.running ? cpuTxt(c.cpu) : '–') + '</td><td class="n">' + (c.running ? bytes(c.mem) + (c.mem_limit ? '<div class="sub">' + Math.round(c.mem / c.mem_limit * 100) + '% of ' + bytes(c.mem_limit) + '</div>' : '') : '–') + '</td>' +
    '<td class="n">' + (c.running ? rate(c.rx) : '–') + '</td><td class="n">' + (c.running ? rate(c.tx) : '–') + '</td><td class="n">' + bytes(c.fs) + '</td><td class="n">' + (c.running ? upFor(c.started_at) : '–') + '</td></tr>').join('')
    : '<tr><td colspan="10" class="m">' + (K.q ? 'No container matches.' : KF.ctr ? 'None right now.' : 'cAdvisor reported no containers.') + '</td></tr>');
  $('#kCtrM').innerHTML = kMore('ctr', rows.length);
}

// Recent events, a page at a time from the server: repeats within 10 minutes are one row with a count
const KE = { want: '', rows: [], next: null, counts: {} };
const kEvQ = () => Object.assign({ hospital: H, host: CTR.host.id }, kWindowQ(), KF.ev ? { kind: KF.ev } : {}, K.focus ? { name: K.focus } : {});
const kEvKey = () => CTR && CTR.host ? JSON.stringify(kEvQ()) : '';
async function loadEv(more) {
  if (!CTR || !CTR.host) return;
  const q = kEvQ(), key = JSON.stringify(q);
  if (more) { if (!KE.next) return; q.before = KE.next; }
  KE.want = key;
  const r = await api('GET', '/api/containers/events?' + new URLSearchParams(q));
  if (KE.want !== key || view !== 'ctr') return;   // something else was asked for meanwhile
  if (!r.ok) { toast(r.message, true); return; }
  KE.rows = more ? KE.rows.concat(r.rows) : r.rows; KE.next = r.next; KE.counts = r.counts;
  renderEv();
}
const kRangeWords = () => K.range === 'custom' && CTR.from ? 'from ' + kSpan(CTR.from, K.to ? CTR.to : 0) : ({ '1h': 'in the last hour', '6h': 'in the last 6 hours', '24h': 'in the last 24 hours', '7d': 'in the last 7 days' })[K.range] || '';
function renderEv() {
  if (!$('#tEv')) return;
  const c = KE.counts || {}, tot = Object.values(c).reduce((a, b) => a + b, 0);
  $('#kEvS').textContent = (K.focus ? K.focus + ': restarts' : 'Restarts') + ', stops, starts and memory limit hits ' + kRangeWords() + '. The same again within 10 minutes is one row.';
  $('#kEvC').innerHTML = kChips('ev', [['', 'All', tot], ['restart', 'Restarts', c.restart || 0], ['stopped', 'Stops', c.stopped || 0], ['started', 'Starts', c.started || 0], ['limit', 'Memory limit', c.limit || 0]]);
  $('#tEv').innerHTML = '<tr><th>When</th><th>Container</th><th>What</th></tr>' + (KE.rows.length ? KE.rows.map(e => '<tr class="click" data-c="' + esc(e.name) + '"><td class="m">' + esc(when(e.last_at)) + (e.n > 1 ? '<div class="sub">first ' + esc(when(e.first_at)) + '</div>' : '') + '</td><td><b>' + esc(e.name) + '</b></td>' +
    '<td><span class="tag ' + (EVW[e.kind] || ['', e.kind])[0] + '">' + esc((EVW[e.kind] || ['', e.kind])[1]) + (e.n > 1 ? ' ×' + e.n : '') + '</span> ' + (e.detail ? (e.n > 1 ? '<span class="m">latest:</span> ' : '') + esc(e.detail) : '') + '</td></tr>').join('')
    : '<tr><td colspan="3" class="m">Nothing ' + (KF.ev ? 'of that kind ' : '') + 'restarted, stopped or hit a limit ' + kRangeWords() + '.</td></tr>');
  $('#kEvM').innerHTML = KE.next ? '<div class="kmore"><span>Showing ' + KE.rows.length + ' rows, newest first</span><button class="btn" id="kEvMore">Show ' + 25 + ' more</button></div>' : '';
}

// a small line of a series over the range, for a KPI tile
function kSpark(a) {
  const v = (a || []).map(x => x === null ? null : +x), ok = v.filter(x => x !== null); if (ok.length < 2) return '';
  const top = Math.max(...ok) || 1, n = v.length, X = i => (i / (n - 1) * 100).toFixed(2), Y = x => (28 - x / top * 26).toFixed(2);
  let d = '', pen = false; v.forEach((x, i) => { if (x === null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i) + ',' + Y(x); pen = true; });
  return '<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '"/></svg>';
}

/* What is going on: the page's numbers turned into a few plain sentences, worst first. Each names
   what to look at and, when it is one container, opens it on a click. Nothing here is new data: it
   reads the same alerts, samples, events and sizing the panels show. */
function kInsights() {
  const r = CTR, h = r.host, S = r.series, t = S.t, out = [], add = (lvl, html, c) => out.push({ lvl, html, c });
  const run = r.containers.filter(c => c.running), z = r.sizing, b = s => '<b>' + esc(s) + '</b>';
  if (!h.ok || h.stale) add('bad', 'cAdvisor on this host is not answering' + (h.error ? ': ' + esc(h.error) : '') + '. The numbers below stop at ' + esc(when(h.last_ok || h.last_seen)) + '.');
  const stopped = r.containers.filter(c => !c.running);
  if (stopped.length) add('bad', stopped.length + (stopped.length === 1 ? ' container is' : ' containers are') + ' stopped: ' + stopped.slice(0, 4).map(c => b(c.name)).join(', ') + (stopped.length > 4 ? ' and ' + (stopped.length - 4) + ' more' : '') + '.', stopped.length === 1 ? stopped[0].name : '');
  const svc = (r.alerts || []).filter(a => a.kind === 'service');
  if (svc.length) add('bad', svc.length + ' service ' + (svc.length === 1 ? 'alert' : 'alerts') + ' from Prometheus, for example: ' + esc(svc[0].title) + '.');
  // restarts: many at once is one cause (a deploy, the host); a few spread out are each their own
  const rs = (r.marks || []).filter(m => m.kind === 'restart').sort((a, b) => a.at - b.at);
  if (rs.length) {
    let best = [], i0 = 0;
    for (let i = 0; i < rs.length; i++) { while (rs[i].at - rs[i0].at > 600000) i0++; const w = rs.slice(i0, i + 1); if (new Set(w.map(m => m.name)).size > new Set(best.map(m => m.name)).size) best = w; }
    const names = [...new Set(best.map(m => m.name))], all = [...new Set(rs.map(m => m.name))];
    if (names.length >= 3) add('warn', b(names.length + ' containers') + ' restarted within 10 minutes around ' + esc(new Date(best[0].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '. Many at once usually means a deploy or something on the host, not each service failing.');
    else add(all.length > 2 ? 'warn' : 'info', all.slice(0, 3).map(b).join(', ') + (all.length > 3 ? ' and ' + (all.length - 3) + ' more' : '') + ' restarted ' + kRangeWords() + '.', all.length === 1 ? all[0] : '');
  }
  // memory: at or near a limit, then over-commit, then what is growing toward one
  const lim = new Map(); (r.marks || []).filter(m => m.kind === 'limit').forEach(m => lim.set(m.name, (lim.get(m.name) || 0) + m.n));
  run.filter(c => c.mem_limit && (c.mem / c.mem_limit >= 0.9 || lim.get(c.name))).sort((a, b) => b.mem / b.mem_limit - a.mem / a.mem_limit).slice(0, 3).forEach(c =>
    add('bad', b(c.name) + ' is at ' + Math.round(c.mem / c.mem_limit * 100) + '% of its ' + esc(bytes(c.mem_limit)) + ' memory limit' + (lim.get(c.name) ? ' and hit it ' + lim.get(c.name) + (lim.get(c.name) === 1 ? ' time' : ' times') + ' ' + kRangeWords() : '') + '. Raise the limit' + (z && (z.containers.find(x => x.name === c.name) || {}).suggest ? ' to about ' + esc(bytes(z.containers.find(x => x.name === c.name).suggest)) : '') + '.', c.name));
  if (z) {
    z.containers.filter(x => x.grow).slice(0, 2).forEach(x => add(x.grow.days < 3 ? 'bad' : 'warn', b(x.name) + '\'s memory grows ' + esc(bytes(x.grow.per_day)) + ' a day and ' + (x.grow.against === 'limit' ? 'reaches its limit' : 'uses up the host') + ' in about ' + Math.max(1, Math.round(x.grow.days)) + (Math.round(x.grow.days) === 1 ? ' day' : ' days') + '.', x.name));
    if (z.memory && z.limits > z.memory) add('warn', 'Memory limits add up to ' + b(bytes(z.limits)) + ' on a ' + esc(bytes(z.memory)) + ' host. If several containers grow at once, the host runs out before they reach their limits.');
    const spare = z.containers.filter(x => x.mem === 'spare').reduce((a, x) => a + x.limit - x.suggest, 0);
    if (spare >= 512 * 1048576) add('info', 'Lowering ' + z.containers.filter(x => x.mem === 'spare').length + ' generous limits would give back ' + b(bytes(spare)) + ' (see Sizing and headroom).');
  }
  run.filter(c => c.throttle >= 0.25).slice(0, 2).forEach(c => add('warn', b(c.name) + ' is held back by its CPU limit ' + Math.round(c.throttle * 100) + '% of the time.', c.name));
  // the host: how full, and its biggest spike with who caused it
  const hc = kLast(S.cpu['']), hm = kLast(S.mem['']), cp = hc !== null && h.cores ? hc / h.cores : null, mp = hm !== null && h.memory ? hm / h.memory : null;
  if (cp !== null && cp >= 0.85 || mp !== null && mp >= 0.85) add('bad', 'The host is nearly full: CPU ' + Math.round(cp * 100) + '%, memory ' + Math.round(mp * 100) + '%.');
  else if (cp !== null && cp >= 0.7 || mp !== null && mp >= 0.7) add('warn', 'The host is getting busy: CPU ' + Math.round(cp * 100) + '%, memory ' + Math.round(mp * 100) + '%.');
  const hcs = S.cpu[''] || [], okc = hcs.filter(x => x !== null).sort((a, b) => a - b);
  if (okc.length > 5) {
    const med = okc[Math.floor(okc.length / 2)], pk = okc[okc.length - 1], pi = hcs.indexOf(pk);
    if (pk > med * 3 && pk - med >= 0.5) {
      let who = '', most = 0; for (const c of r.containers) { const v = kBridge(S.cpu[c.name] || [])[pi]; if (v !== null && v !== undefined && v > most) { most = v; who = c.name; } }
      // a spike no container shares came from outside them: the host itself, Docker or a backup
      const own = who && most >= (pk - med) * 0.25;
      add(own ? 'info' : 'warn', 'Host CPU spiked to ' + b(cpuTxt(pk)) + ' at ' + esc(new Date(t[pi]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + ' (usually ' + esc(cpuTxt(med)) + ')' +
        (own ? ', mostly ' + b(who) + ' at ' + esc(cpuTxt(most)) + '.' : '. No container rose with it, so it came from outside them: the host itself, Docker, or a job such as a backup or antivirus scan.'), own ? who : '');
    }
  }
  // who uses the most, so the picture has a scale
  const top = run.slice().sort((a, b) => (b.mem || 0) - (a.mem || 0))[0];
  if (top && h.memory) add('info', b(top.name) + ' uses the most memory: ' + esc(bytes(top.mem)) + ', ' + Math.round(top.mem / h.memory * 100) + '% of the host.', top.name);
  if (!out.some(x => x.lvl === 'bad' || x.lvl === 'warn')) out.unshift({ lvl: 'ok', html: 'All ' + run.length + ' containers are running within their limits' + (cp !== null ? ', and the host has room: CPU ' + Math.round(cp * 100) + '%, memory ' + Math.round(mp * 100) + '%' : '') + '.' });
  const rank = { bad: 0, warn: 1, ok: 2, info: 3 };
  return out.sort((a, b) => rank[a.lvl] - rank[b.lvl]);
}
function renderInsights() {
  const ins = kInsights(), worst = ins[0] ? ins[0].lvl : 'ok', bad = ins.filter(x => x.lvl === 'bad').length, warn = ins.filter(x => x.lvl === 'warn').length;
  $('#kInsT').className = 'kstate ' + worst; $('#kInsT').textContent = worst === 'bad' ? 'Needs action' : worst === 'warn' ? 'Worth a look' : 'Healthy';
  const st = $('#kConState'); if (st) { st.className = 'kc-pill state ' + worst; st.innerHTML = '<i></i>' + $('#kInsT').textContent; }
  $('#kInsS').textContent = (bad || warn ? [bad && bad + ' to act on', warn && warn + ' to keep an eye on'].filter(Boolean).join(', ') + '. ' : '') + 'Worked out from the numbers on this page, ' + kRangeWords() + '.';
  $('#kIns').innerHTML = ins.map(x => '<div class="ki ' + x.lvl + (x.c ? ' click' : '') + '"' + (x.c ? ' data-c="' + esc(x.c) + '"' : '') + '><span class="ic">' + ({ bad: '!', warn: '!', ok: '✓', info: 'i' })[x.lvl] + '</span><span>' + x.html + '</span></div>').join('');
}

/* What changed lately: for the measure picked, each container's last stretch (the last sixth of the
   range, at least 3 readings) against the rest of it. Small moves are left out, so this lists what a
   person would notice, up or down. */
const KMIN = { cpu: 0.02, mem: 20 * 1048576, rx: 5120, tx: 5120, rd: 5120, wr: 5120, throttle: 0.05 };
function renderChanges() {
  const m = KM.find(x => x[0] === K.metric) || KM[0], S = CTR.series[m[0]], n = CTR.series.t.length, k = Math.max(3, Math.round(n / 6));
  const mean = a => { const v = a.filter(x => x !== null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; };
  const rows = [];
  for (const c of CTR.containers.filter(kMatch)) {
    const v = S[c.name]; if (!v || n < 8) continue;
    const now = mean(v.slice(n - k)), before = mean(v.slice(0, n - k));
    if (now === null || before === null || Math.abs(now - before) < KMIN[m[0]]) continue;
    rows.push({ c, now, before, d: now - before, x: before > 0 ? now / before : Infinity, v });
  }
  rows.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const lastFor = (CTR.series.t[n - 1] - CTR.series.t[n - k]) / 60000;
  $('#kChgS').textContent = m[1] + ': the last ' + (lastFor < 90 ? Math.round(lastFor) + ' minutes' : Math.round(lastFor / 60) + ' hours') + ' against earlier in the range. Biggest moves first.';
  const fx = r => r.x === Infinity ? 'new' : r.x >= 1.95 ? r.x.toFixed(1) + '×' : r.d < 0 ? '−' + Math.round((1 - r.x) * 100) + '%' : '+' + Math.round((r.x - 1) * 100) + '%';
  $('#kChg').innerHTML = rows.length ? rows.slice(0, 9).map(r => '<div class="kc click' + (K.focus === r.c.name ? ' picked' : '') + '" data-c="' + esc(r.c.name) + '"><span class="ar ' + (r.d > 0 ? 'up' : 'down') + '">' + (r.d > 0 ? '▲' : '▼') + '</span>' +
    '<span class="nm"><b><span class="sw" style="background:' + (kColors.get(r.c.name) || OTHER) + '"></span>' + esc(r.c.name) + '</b><small>' + esc(m[3](r.before)) + ' → ' + esc(m[3](r.now)) + '</small></span>' + kSpark(r.v) + '<span class="fx ' + (r.d > 0 ? 'up' : 'down') + '">' + esc(fx(r)) + '</span></div>').join('')
    : '<div class="kok"><span class="dot"></span>Nothing moved much. Every container\'s ' + esc(m[1].toLowerCase()) + ' is about where it was earlier in the range.</div>';
}

// Where the host goes: one bar each for memory and CPU, cut into the coloured containers and Other
function renderSplit() {
  const h = CTR.host, run = CTR.containers.filter(c => c.running);
  const one = (title, key, total, fmt, head) => {
    const items = run.map(c => ({ n: c.name, v: c[key] || 0 })).filter(o => o.v > 0).sort((a, b) => b.v - a.v);
    const sum = items.reduce((s, o) => s + o.v, 0), cap = Math.max(total || 0, sum) || 1, rest = items.filter(o => !kColors.has(o.n));
    const segs = items.filter(o => kColors.has(o.n)).map(o => ({ n: o.n, v: o.v, color: kColors.get(o.n) }));
    if (rest.length) segs.push({ n: 'Other (' + rest.length + ')', v: rest.reduce((s, o) => s + o.v, 0), color: OTHER, other: true });
    const pct = v => v / cap * 100;
    return '<div><div class="sh"><b>' + title + '</b><span>' + esc(head(sum, total)) + '</span></div>' +
      '<div class="sbar">' + segs.map(s => '<div data-seg="' + esc(s.n) + '" data-v="' + esc(fmt(s.v) + (total ? ', ' + (pct(s.v) < 1 ? pct(s.v).toFixed(1) : Math.round(pct(s.v))) + '% of the host' : '')) + '"' + (s.other ? '' : ' data-c="' + esc(s.n) + '"') +
        ' style="width:' + pct(s.v).toFixed(2) + '%;background:' + s.color + '"></div>').join('') + '</div>' +
      '<div class="slg">' + segs.map(s => '<span' + (s.other ? ' class="o"' : ' data-c="' + esc(s.n) + '"') + '><i style="background:' + s.color + '"></i>' + esc(s.n) + ' <b>' + esc(fmt(s.v)) + '</b></span>').join('') + '</div></div>';
  };
  $('#kSplit').innerHTML =
    one('Memory', 'mem', h.memory, bytes, (s, t) => bytes(s) + ' in containers' + (t ? ' of ' + bytes(t) + ' · ' + Math.round(s / t * 100) + '%' : '')) +
    one('CPU', 'cpu', h.cores, cpuTxt, (s, t) => s.toFixed(s < 1 ? 2 : 1) + ' cores in containers' + (t ? ' of ' + t + ' · ' + Math.round(s / t * 100) + '%' : ''));
}

// The focus panel: the whole host, or the one container picked, as quiet single-subject charts.
// In and out share a chart: in above the line, out below it.
let kOneG = [];
// the console: the tiles pick the measure; the main chart, the changes and the heatmap all follow it
const renderConsole = () => { renderTiles(); renderOne(); renderHeat(); renderChanges(); };
const kBin = m => m[3] === bytes || m[3] === rate;
// one tile a measure, for the host or the service looked at: now, its shape over the range, and what it means
function renderTiles() {
  const h = CTR.host, S = CTR.series, c = K.focus ? CTR.containers.find(x => x.name === K.focus) : null, key = c ? c.name : '';
  const peak = a => Math.max(0, ...(a || []).filter(x => x !== null));
  $('#kTiles').innerHTML = KM.map(m => {
    const v = (S[m[0]] || {})[key], now = kLast(v);
    let sub = v ? 'peak ' + m[3](peak(v)) : c ? 'no readings' : 'per service only';
    if (now !== null && m[0] === 'cpu') sub = c ? (now >= 1 ? (now).toFixed(1) + ' cores' : 'of one core') + ' · peak ' + cpuTxt(peak(v)) : h.cores ? Math.round(now / h.cores * 100) + '% of ' + h.cores + ' cores' : sub;
    if (now !== null && m[0] === 'mem') { const lim = c ? c.mem_limit : h.memory; if (lim) sub = Math.round(now / lim * 100) + '% of ' + (c ? 'its limit ' : '') + bytes(lim); }
    return '<button class="kt' + (K.metric === m[0] ? ' on' : '') + '" data-km="' + m[0] + '"><span class="kt-l">' + esc(m[1]) + '</span><b>' + esc(now === null ? '–' : axT(m[3](now))) + '</b><small>' + esc(sub) + '</small>' + (v ? kSpark(v) : '<span class="spark"></span>') + '</button>';
  }).join('');
}
function renderOne() {
  const h = CTR.host, S = CTR.series, c = K.focus ? CTR.containers.find(x => x.name === K.focus) : null, key = c ? c.name : '';
  const m = KM.find(x => x[0] === K.metric) || KM[0], col = c ? kColors.get(c.name) || PAL[0] : '#3a3733';
  $('#kOneT').innerHTML = (c ? '<span class="sw" style="background:' + col + '"></span>' + esc(c.name) : 'Whole host') + ' <span class="kc-m">· ' + esc(m[1]) + '</span>';
  const thr = c ? (S.throttle[key] || []).filter(v => v !== null) : [];
  $('#kOneS').innerHTML = c ? [esc(c.image), c.running ? 'up ' + upFor(c.started_at) : '<b class="bad">stopped</b>', (c.restarts || 0) + (c.restarts === 1 ? ' restart' : ' restarts'), c.mem_limit ? 'memory limit ' + bytes(c.mem_limit) : 'no memory limit',
    thr.length && Math.max(...thr) > 0.01 ? 'CPU limit held it back up to ' + Math.round(Math.max(...thr) * 100) + '% of the time' : ''].filter(Boolean).join(' · ')
    : 'Every container together' + (h.cores ? ' on ' + h.cores + ' cores' : '') + (h.memory ? ' and ' + bytes(h.memory) : '') + '. Pick a service, a measure and a time; drag across the chart or the rows to zoom in.';
  $('#kOneX').innerHTML = c ? '<button class="btn" data-c="' + esc(c.name) + '">✕ Whole host</button>' : '';
  const lim = m[0] === 'mem' ? (c ? c.mem_limit : h.memory) : m[0] === 'cpu' && !c ? h.cores : 0;
  kOneG = [{ title: m[1], parts: [{ v: (S[m[0]] || {})[key], label: m[1] }], fmt: m[3], min: m[4], bin: kBin(m), limit: lim, note: m[0] === 'cpu' ? (c ? '100% is one core' : '100% is one core; the host has ' + h.cores) : m[2] }];
  kOneG.forEach(g => g.parts.forEach(p => { p.v = p.v || CTR.series.t.map(() => null); p.color = col; }));
  if (!c && m[0] === 'throttle') { $('#kOneC').innerHTML = '<div class="karea big"><div class="cv"><div class="empty">CPU throttling is per service: how often its CPU limit held it back. Pick a service above, or a row below.</div></div></div>'; return; }
  $('#kOneC').innerHTML = '<div class="karea big"><div class="cv" data-g="0"></div><div class="knote" data-n="0"></div></div>';
  kOneDraw();
}
const kOneDraw = () => document.querySelectorAll('#kOneC .cv').forEach(el => kArea(el, kOneG[+el.dataset.g]));

// a missed minute or two (a reading that landed in the next bucket) is bridged, so lines do not break apart
const kBridge = v => v.map((x, i) => {
  if (x !== null) return x;
  let a = i - 1, b = i + 1; while (a >= 0 && v[a] === null && i - a < 3) a--; while (b < v.length && v[b] === null && b - i < 3) b++;
  return a >= 0 && b < v.length && v[a] !== null && v[b] !== null ? v[a] + (v[b] - v[a]) * (i - a) / (b - a) : null;
});
// a smooth curve that never rises above a peak or dips below zero (monotone cubic)
function kCurve(p) {
  const n = p.length, f = q => q[0].toFixed(1) + ',' + q[1].toFixed(1);
  if (n < 3) return p.map((q, i) => (i ? 'L' : 'M') + f(q)).join('');
  const s = [], m = [];
  for (let i = 0; i < n - 1; i++) s.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
  m[0] = s[0]; m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : 2 * s[i - 1] * s[i] / (s[i - 1] + s[i]);
  let d = 'M' + f(p[0]);
  for (let i = 0; i < n - 1; i++) { const k = (p[i + 1][0] - p[i][0]) / 3; d += 'C' + f([p[i][0] + k, p[i][1] + m[i] * k]) + ' ' + f([p[i + 1][0] - k, p[i + 1][1] - m[i + 1] * k]) + ' ' + f(p[i + 1]); }
  return d;
}
// the top of a scale at a round number in the metric's own unit (256 KB, 2 GB, not 48.8 KB)
const kTop = (max, bin) => { let u = 1; if (bin) while (max / u >= 1024) u *= 1024; const p = Math.pow(10, Math.floor(Math.log10(max / u))), f = max / u / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p * u; };
const axT = s => String(s).replace(/\.0(?=\s|%|$)/, '');
const kTime = (ms, span) => span > 2 * 86400000 ? new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric' })
  : span > 20 * 3600000 ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// a stretch of time in words: "Oct 27, 9:00 AM – 11:30 AM", "Oct 26, 9:00 PM – Oct 27, 6:00 AM", "Oct 27, 9:00 AM – now"
const kSpan = (f, t) => {
  const d = ms => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }), h = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d(f) + ', ' + h(f) + ' – ' + (!t ? 'now' : d(t) === d(f) ? h(t) : d(t) + ', ' + h(t));
};
let kUid = 0;
function kArea(el, g) {
  const t = CTR.series.t, n = t.length, W = Math.max(200, el.clientWidth), Hh = Math.max(110, el.clientHeight), L = 52, R = 4, T = 6, B = 20, pw = W - L - R, ph = Hh - T - B;
  const vals = p => p.v.filter(x => x !== null), note = el.parentNode.querySelector('.knote');
  if (!g.parts.some(p => vals(p).length)) { el.innerHTML = '<div class="empty">' + (CTR.range === 'custom' ? 'No numbers in this stretch: cAdvisor was not being read then.' : CTR.host.ok ? 'No numbers in this range yet.' : 'cAdvisor is not reporting.') + '</div>'; el._a = null; note.textContent = ''; return; }
  const peak = ps => Math.max(0, ...ps.flatMap(vals)), up = g.parts.filter(p => !p.neg), dn = g.parts.filter(p => p.neg);
  // a limit far above what is used would flatten the line, so then it is only named under the chart
  const lim = g.limit && g.limit <= peak(up) * 2.2 ? g.limit : 0;
  let tu = kTop(Math.max(g.min, peak(up) * 1.08, lim * 1.04), g.bin), td = 0;
  if (dn.length) { td = kTop(Math.max(g.min, peak(dn) * 1.08), g.bin); tu = td = Math.max(tu, td); }
  const tot = tu + td, y0 = T + ph * tu / tot, x = i => L + (n < 2 ? pw / 2 : i / (n - 1) * pw), y = (v, neg) => neg ? y0 + v / tot * ph : y0 - v / tot * ph;
  const id = 'ka' + (++kUid);
  let s = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + esc(g.title) + '"><defs>' +
    '<linearGradient id="' + id + 'u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + g.parts[0].color + '" stop-opacity=".34"/><stop offset="1" stop-color="' + g.parts[0].color + '" stop-opacity=".02"/></linearGradient>' +
    '<linearGradient id="' + id + 'd" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="' + g.parts[0].color + '" stop-opacity=".2"/><stop offset="1" stop-color="' + g.parts[0].color + '" stop-opacity=".02"/></linearGradient></defs>';
  const tick = (v, neg) => '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v, neg) + '" y2="' + y(v, neg) + '"/><text class="ax" x="' + (L - 8) + '" y="' + (y(v, neg) + 3.5) + '" text-anchor="end">' + esc(axT(g.fmt(v))) + '</text>';
  s += tick(tu) + tick(tu / 2) + (td ? tick(td / 2, true) + tick(td, true) : '');
  s += '<text class="ax" x="' + (L - 8) + '" y="' + (y0 + 3.5) + '" text-anchor="end">0</text>';
  for (const p of g.parts) {
    const v = kBridge(p.v); let run = [];
    const flush = () => {
      if (run.length === 1) s += '<circle cx="' + run[0][0].toFixed(1) + '" cy="' + run[0][1].toFixed(1) + '" r="2.5" fill="' + p.color + '"/>';
      else if (run.length) { const d = kCurve(run); s += '<path d="' + d + 'L' + run[run.length - 1][0].toFixed(1) + ',' + y0 + 'L' + run[0][0].toFixed(1) + ',' + y0 + 'Z" fill="url(#' + id + (p.neg ? 'd' : 'u') + ')"/><path class="ln' + (p.neg ? ' neg' : '') + '" d="' + d + '" stroke="' + p.color + '"/>'; }
      run = [];
    };
    v.forEach((a, i) => { if (a === null) flush(); else run.push([x(i), y(a, p.neg)]); }); flush();
  }
  s += '<line class="zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y0 + '" y2="' + y0 + '"/>';
  if (lim) s += '<line class="lim" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(lim) + '" y2="' + y(lim) + '"/><text class="lt" x="' + (W - R - 4) + '" y="' + (y(lim) - 5) + '" text-anchor="end">' + esc((CTR.host && !K.focus ? 'host ' : 'limit ') + g.fmt(lim)) + '</text>';
  if (dn.length) s += '<text class="side" x="' + (L + 8) + '" y="' + (T + 12) + '">↑ ' + esc(up[0].label) + '</text><text class="side" x="' + (L + 8) + '" y="' + (T + ph - 6) + '">↓ ' + esc(dn[0].label) + '</text>';
  const span = t[n - 1] - t[0];
  for (let k = 0; k < 4; k++) { const i = Math.round(k / 3 * (n - 1)); s += '<text class="ax" x="' + x(i) + '" y="' + (Hh - 4) + '" text-anchor="' + (k === 0 ? 'start' : k === 3 ? 'end' : 'middle') + '">' + esc(kTime(t[i], span)) + '</text>'; }
  el.innerHTML = s + '<g class="hov"></g></svg>';
  // restarts, stops, starts and limit hits in this range: of the container looked at, or of any on the whole host
  const st = (CTR.step || 60) * 1000, xt = ms => L + (n < 2 ? pw / 2 : (ms - t[0]) / (t[n - 1] - t[0]) * pw);
  const evs = (CTR.marks || []).filter(e => !K.focus || e.name === K.focus).map(e => Object.assign({ ms: e.at }, e));
  // limit hits (often one a minute) as a strip along the top; a restart, stop or start as a marked line
  const hv = el.querySelector('.hov'), bi = ms => Math.max(0, Math.min(n - 1, Math.round((ms - t[0]) / st))), lim2 = new Set(), mark = new Map();
  for (const e of evs) { const b = bi(e.ms); if (e.kind === 'limit') lim2.add(b); else if (!mark.has(b) || e.kind !== 'started') mark.set(b, e.kind); }
  const cw = n < 2 ? pw : pw / (n - 1);
  let ev = [...lim2].map(b => '<rect x="' + (x(b) - cw / 2).toFixed(1) + '" y="' + (T - 3) + '" width="' + cw.toFixed(1) + '" height="4" style="fill:' + KEV_C.limit + '"/>').join('');
  for (const [b, kind] of mark) { const ex = x(b).toFixed(1), c = KEV_C[kind] || 'var(--grey)';
    ev += '<line class="evl" x1="' + ex + '" x2="' + ex + '" y1="' + T + '" y2="' + (T + ph) + '" style="stroke:' + c + '"/><path d="M' + (ex - 4.5) + ',' + (T - 3) + 'h9l-4.5,6z" style="fill:' + c + '"/>'; }
  hv.insertAdjacentHTML('beforebegin', ev);
  el._a = { g, x, y, T, ph, L, pw, evs, st };
  note.textContent = g.limit && !lim ? (K.focus ? 'Limit ' : 'Host has ') + g.fmt(g.limit) + ', far above this' : g.note || '';
}
// the same minute marked on every chart of the focus panel; the numbers for the chart under the pointer
// drag across a focus chart or the heatmap to zoom into that time
let kDrag = null, kDragged = false;
function kDragIdx(e, d) {
  const b = d.box, n = CTR.series.t.length;
  return d.kind === 'heat' ? Math.max(0, Math.min(n - 1, Math.floor((e.clientX - b.left) / b.width * n)))
    : Math.max(0, Math.min(n - 1, Math.round((e.clientX - b.left - d.a.L) / d.a.pw * (n - 1))));
}
function kDragDraw() {
  const d = kDrag, lo = Math.min(d.i0, d.i1), hi = Math.max(d.i0, d.i1), n = CTR.series.t.length;
  if (d.kind === 'heat') {
    const hb = $('#kHeat').getBoundingClientRect(), sel = $('#kHeat .ksel');
    sel.hidden = false; sel.style.left = (d.box.left - hb.left + lo / n * d.box.width) + 'px'; sel.style.width = ((hi - lo + 1) / n * d.box.width) + 'px';
    return;
  }
  document.querySelectorAll('#kOneC .cv').forEach(el => {
    const a = el._a, g = el.querySelector('.hov'); if (!a || !g) return;
    g.innerHTML = '<rect class="zsel" x="' + a.x(lo) + '" y="' + a.T + '" width="' + Math.max(1, a.x(hi) - a.x(lo)) + '" height="' + a.ph + '"/>';
  });
}
// show from f to t (ms); at least 10 minutes, never past now; an end within 90 s of now keeps following now
function kZoom(f, t) {
  const now = Date.now();
  t = Math.min(t, now);
  if (t - f < 600000) { const mid = (f + t) / 2; f = mid - 300000; t = Math.min(now, mid + 300000); if (t - f < 600000) f = t - 600000; }
  if (K.range !== 'custom') K.prev = K.range;
  K.range = 'custom'; K.from = Math.round(f); K.to = now - t < 90000 ? 0 : Math.round(t);
  saveK(); kPop(false); loadCtr();
}
function kAreaHover(e, cv) {
  const t = CTR.series.t, k = cv._a, box = cv.getBoundingClientRect();
  const i = Math.max(0, Math.min(t.length - 1, Math.round((e.clientX - box.left - k.L) / k.pw * (t.length - 1))));
  document.querySelectorAll('#kOneC .cv').forEach(el => {
    const a = el._a, g = el.querySelector('.hov'); if (!a || !g) return;
    g.innerHTML = '<line class="cross" x1="' + a.x(i) + '" x2="' + a.x(i) + '" y1="' + a.T + '" y2="' + (a.T + a.ph) + '"/>' +
      a.g.parts.filter(p => p.v[i] !== null).map(p => '<circle class="pt" cx="' + a.x(i) + '" cy="' + a.y(p.v[i], p.neg) + '" r="4" fill="' + p.color + '"/>').join('');
  });
  kTip('<b>' + esc(new Date(t[i]).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + '</b>' + k.g.parts.map(p => '<div class="row"><span>' + esc(p.label) + '</span><span>' + esc(p.v[i] === null ? 'no reading' : k.g.fmt(p.v[i])) + '</span></div>').join('') +
    kEvTip(k.evs.filter(v => Math.abs(v.ms - t[i]) <= k.st / 2)), e);
}

// Every container over time: a row each, a cell each minute, darker is busier
const KRAMP = [[232, 240, 251], [14, 64, 140]];   // pale to deep blue
const kShade = f => { f = Math.sqrt(Math.max(0, Math.min(1, f))) * (KRAMP.length - 1); const k = Math.min(KRAMP.length - 2, Math.floor(f)), u = f - k; return 'rgb(' + KRAMP[k].map((x, i) => Math.round(x + (KRAMP[k + 1][i] - x) * u)).join(',') + ')'; };
function renderHeat() {
  const m = KM.find(x => x[0] === K.metric) || KM[0], S = CTR.series[m[0]], t = CTR.series.t, n = t.length;
  document.querySelectorAll('[data-km]').forEach(b => b.classList.toggle('on', b.dataset.km === m[0]));
  const rows = CTR.containers.filter(kMatch).filter(c => S[c.name]).map(c => {
    const v = kBridge(S[c.name]), ok = v.filter(x => x !== null);
    return { c, v, peak: ok.length ? Math.max(...ok) : 0, mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0 };
  }).sort((a, b) => b.mean - a.mean || a.c.name.localeCompare(b.c.name));
  // one scale for every row, so a darker cell is really more; the square root keeps quiet containers' patterns visible
  const top = Math.max(m[4], ...rows.map(r => r.peak));
  $('#kHeatS').textContent = m[1] + ', ' + m[2].charAt(0).toLowerCase() + m[2].slice(1) + '. Busiest on top; darkest is ' + m[3](top) + '. Click a row to look at it; drag across the rows to zoom in.';
  const span = t[n - 1] - t[0];
  let s = '<div class="hrow hh"><span>Container</span><div class="htime">' + [0, 1, 2, 3, 4].map(k => { const i = Math.round(k / 4 * (n - 1)); return '<span style="left:' + ((i + 0.5) / n * 100).toFixed(2) + '%">' + esc(kTime(t[i], span)) + '</span>'; }).join('') + '</div><span class="hv">Now</span><span class="hv">Peak</span></div>';
  s += rows.slice(0, kShown('heat', rows.length)).map(r => '<div class="hrow' + (K.focus === r.c.name ? ' picked' : '') + (r.c.running ? '' : ' off') + '" data-c="' + esc(r.c.name) + '"><span class="hn"><i style="background:' + (kColors.get(r.c.name) || OTHER) + '"></i>' + esc(r.c.name) + '</span>' +
    '<svg viewBox="0 0 ' + n + ' 1" preserveAspectRatio="none" shape-rendering="crispEdges">' + r.v.map((v, i) => v === null ? '' : '<rect x="' + i + '" width=".86" height="1" fill="' + kShade(v / top) + '"/>').join('') + '</svg>' +
    '<span class="hv">' + esc(r.c.running ? m[3](kLast(r.v)) : 'stopped') + '</span><span class="hv m">' + esc(m[3](r.peak)) + '</span></div>').join('');
  s += rows.length ? '<div class="hkey"><span>Idle</span><i style="background:linear-gradient(90deg,' + [0, 0.06, 0.25, 0.56, 1].map(kShade).join(',') + ')"></i><span>' + esc(m[3](top)) + '</span><span class="gap">No reading</span><i class="none"></i></div>' : '<div class="m">' + (K.q ? 'No container matches.' : CTR.range === 'custom' ? 'No numbers in this stretch: cAdvisor was not being read then.' : 'No numbers yet.') + '</div>';
  $('#kHeat').innerHTML = s + '<div class="kguide" hidden></div><div class="ksel" hidden></div>';
  $('#kHeat')._h = { m, rows: new Map(rows.map(r => [r.c.name, r.v])) };
  $('#kHeatM').innerHTML = kMore('heat', rows.length);
}
// Sizing and headroom: what is heading for a limit, and which memory limits are too tight, missing or too generous
function renderSizing() {
  const z = CTR.sizing; if (!z) { $('#kSizeP').hidden = true; return; }
  $('#kSizeP').hidden = false;
  const custom = CTR.range === 'custom', live = Date.now() - CTR.to < 600000;
  const span = custom ? kSpan(CTR.from, live ? 0 : CTR.to) : z.hours >= 144 ? 'the last 7 days' : 'the ' + (z.hours < 2 ? 'last hour' : 'last ' + z.hours + ' hours') + ' (a week once there is one)';
  if (!z.containers.length) {
    $('#kSizeS').textContent = 'From ' + span + '. No numbers in this stretch, so nothing to size.';
    $('#kSizeF').innerHTML = ''; $('#tSize').innerHTML = ''; $('#kSizeM').innerHTML = ''; $('#kSizeP2').innerHTML = ''; return;
  }
  const over = z.memory && z.limits > z.memory;
  $('#kSizeS').innerHTML = 'From ' + span + '. ' + (z.limited ? 'Memory limits add up to <b>' + esc(bytes(z.limits)) + '</b>' + (z.memory ? ' on a ' + esc(bytes(z.memory)) + ' host' : '') + '; ' : '') +
    'the suggestions below add up to <b>' + esc(bytes(z.suggested)) + '</b>.' + (over ? ' <span class="tag bad">Over-committed by ' + esc(bytes(z.limits - z.memory)) + '</span>' : '');
  // heading for trouble: steady growth with a date on it
  const fc = z.containers.filter(x => x.grow || x.fs_day);
  $('#kSizeF').innerHTML = fc.length ? fc.map(x => '<div class="kfc ' + (x.grow && x.grow.days < 3 ? 'bad' : 'warn') + '" data-c="' + esc(x.name) + '"><b>' + esc(x.name) + '</b>' +
    (x.grow ? '<span>Memory grows ' + esc(bytes(x.grow.per_day)) + ' a day. ' + (x.grow.against === 'limit' ? 'Reaches its limit' : 'Uses up the host\'s memory') + ' in <em>' + (x.grow.days < 1 ? 'under a day' : x.grow.days < 2 ? 'about a day' : Math.round(x.grow.days) + ' days') + '</em> at this rate.</span>' : '') +
    (x.fs_day ? '<span>Writes ' + esc(bytes(x.fs_day)) + ' a day to its own disk (logs or temp files?).</span>' : '') + '</div>').join('')
    : '<div class="kok"><span class="dot"></span>' + (!live ? 'This stretch ends in the past, so no days-left are worked out: steady growth is only judged up to now.' : 'Nothing is growing steadily toward a limit over ' + (custom && CTR.to - CTR.from < 3 * 86400000 ? 'this stretch' : 'the last 3 days') + '.') + '</div>';
  const pick = z.containers.filter(x => x.mem !== 'ok' || x.cpu !== 'ok'), fine = z.containers.length - pick.length;
  const all = K.sizeAll ? z.containers : pick, rows = all.slice(0, kShown('size', all.length));
  const verdict = x => {
    const t = [];
    if (x.mem === 'tight') t.push('<span class="tag bad">' + (x.hits ? 'Hit its limit ' + x.hits + (x.hits === 1 ? ' time' : ' times') : 'Within 10% of its limit') + '</span>');
    if (x.mem === 'none') t.push('<span class="tag warn">No memory limit</span>');
    if (x.mem === 'spare') t.push('<span class="tag">Can give back ' + esc(bytes(x.limit - x.suggest)) + '</span>');
    if (x.cpu === 'tight') t.push('<span class="tag warn">CPU limit held it back in ' + Math.round(x.thr_share * 100) + '% of minutes</span>');
    return t.length ? t.join(' ') : '<span class="tag ok">Right size</span>';
  };
  const bar = x => {
    const cap = x.limit || z.memory || x.peak || 1, w = v => Math.min(100, v / cap * 100).toFixed(1);
    return '<div class="kbar ' + x.mem + '" title="Usually ' + esc(bytes(x.p95)) + ', peak ' + esc(bytes(x.peak)) + (x.limit ? ' of ' + esc(bytes(x.limit)) : ' of the host\'s ' + esc(bytes(z.memory))) + '"><i style="width:' + w(x.p95) + '%"></i><b style="left:' + w(x.peak) + '%"></b></div>';
  };
  $('#tSize').innerHTML = '<tr><th>Container</th><th>Memory against its limit</th><th class="n">Peak</th><th class="n">Limit</th><th class="n">Suggested</th><th>What to do</th></tr>' +
    (rows.length ? rows.map(x => '<tr class="click' + (K.focus === x.name ? ' picked' : '') + '" data-c="' + esc(x.name) + '"><td><b><span class="sw" style="background:' + (kColors.get(x.name) || OTHER) + '"></span>' + esc(x.name) + '</b></td><td>' + bar(x) + '</td>' +
      '<td class="n">' + esc(bytes(x.peak)) + '</td><td class="n">' + (x.limit ? esc(bytes(x.limit)) : '<span class="m">none</span>') + '</td><td class="n">' + (x.suggest ? '<b>' + esc(bytes(x.suggest)) + '</b>' : '–') + '</td><td>' + verdict(x) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="m">Every container\'s memory limit fits what it uses.</td></tr>');
  $('#kSizeP2').innerHTML = kMore('size', all.length);
  $('#kSizeM').innerHTML = fine ? '<button class="btn" id="kSizeAll">' + (K.sizeAll ? 'Show only the ones to look at' : 'Show the ' + fine + ' that are fine too') + '</button>' : '';
}
// the events of one minute for a tooltip: the same kind for the same container once, with a count
function kEvTip(list) {
  const g = new Map();
  for (const v of list) { const key = v.kind + '|' + v.name, o = g.get(key); if (o) o.n += v.n || 1; else g.set(key, { v, n: v.n || 1 }); }
  return [...g.values()].slice(0, 6).map(({ v, n }) => '<div class="ev"><i style="background:' + (KEV_C[v.kind] || 'var(--grey)') + '"></i>' + esc((EVW[v.kind] || ['', v.kind])[1] + (n > 1 ? ' ×' + n : '') + (K.focus ? '' : ': ' + v.name)) +
    (v.detail && n === 1 ? '<small>' + esc(v.detail) + '</small>' : '') + '</div>').join('');
}
function kHeatHover(e, svg) {
  const H2 = $('#kHeat')._h, t = CTR.series.t, n = t.length, b = svg.getBoundingClientRect(), hb = $('#kHeat').getBoundingClientRect();
  const i = Math.max(0, Math.min(n - 1, Math.floor((e.clientX - b.left) / b.width * n))), name = svg.parentNode.dataset.c, v = H2.rows.get(name)[i];
  const gd = $('#kHeat .kguide'); gd.hidden = false; gd.style.left = (b.left - hb.left + (i + 0.5) / n * b.width) + 'px';
  kTip('<b>' + esc(name) + '</b><div>' + esc(new Date(t[i]).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + '</div><div class="row"><span>' + esc(H2.m[1]) + '</span><span>' + esc(v === null ? 'no reading' : H2.m[3](v)) + '</span></div>', e);
}
function kTip(html, e) {
  const tip = $('#tip'); tip.innerHTML = html; tip.hidden = false;
  tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, e.clientX + 14) + 'px'; tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 10) + 'px';
}
function kUnhover() {
  $('#tip').hidden = true;
  document.querySelectorAll('#kOneC .hov').forEach(g => { g.innerHTML = ''; });
  const gd = $('#kHeat .kguide'); if (gd) gd.hidden = true;
}
// look at one container (or the whole host again); bring the focus panel into view
const kFocus = (name, scroll) => {
  K.focus = K.focus === name ? '' : name; renderCtr();
  if (scroll) $('#kOneP').scrollIntoView({ block: 'start', behavior: 'smooth' });
};
$('#kBody').addEventListener('mousedown', e => {
  if (e.button !== 0 || !CTR || !CTR.series) return;
  const cv = e.target.closest('#kOneC .cv'), hs = e.target.closest('.hrow[data-c] svg');
  if (cv && cv._a) kDrag = { kind: 'area', a: cv._a, box: cv.getBoundingClientRect(), x0: e.clientX };
  else if (hs) kDrag = { kind: 'heat', box: hs.getBoundingClientRect(), x0: e.clientX };
  else return;
  kDrag.i0 = kDrag.i1 = kDragIdx(e, kDrag); e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!kDrag || (!kDrag.moved && Math.abs(e.clientX - kDrag.x0) < 6)) return;
  kDrag.moved = true; kDrag.i1 = kDragIdx(e, kDrag); $('#tip').hidden = true; kDragDraw();
});
window.addEventListener('mouseup', () => {
  const d = kDrag; kDrag = null; if (!d) return;
  const sel = $('#kHeat .ksel'); if (sel) sel.hidden = true;
  if (!d.moved) return;
  kDragged = true; setTimeout(() => { kDragged = false; }, 0);   // the click that ends a drag is not a click on a row
  if (d.i0 === d.i1) { kUnhover(); return; }
  const t = CTR.series.t, st = (CTR.step || 60) * 1000, lo = Math.min(d.i0, d.i1), hi = Math.max(d.i0, d.i1);
  kZoom(d.kind === 'heat' ? t[lo] : t[lo] - st / 2, t[hi] + st / 2);
});
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (kDrag) { kDrag = null; kUnhover(); const sel = $('#kHeat .ksel'); if (sel) sel.hidden = true; }
  kPop(false);
});
$('#kBody').addEventListener('mousemove', e => {
  if (kDrag && kDrag.moved) return;
  const cv = e.target.closest('#kOneC .cv'), hs = e.target.closest('.hrow[data-c] svg'), sg = e.target.closest('[data-seg]');
  if (cv && cv._a) return kAreaHover(e, cv);
  kUnhover();
  if (hs) return kHeatHover(e, hs);
  if (sg) kTip('<b>' + esc(sg.dataset.seg) + '</b><div>' + esc(sg.dataset.v) + '</div>', e);
});
$('#kBody').addEventListener('mouseleave', kUnhover);
$('#kBody').addEventListener('scroll', kUnhover, { passive: true });
const KIND_K = { container_down: 'Container stopped', container_host_down: 'cAdvisor', container_memory: 'Memory', container_cpu: 'CPU limit', container_restarting: 'Restarts', container_unusual: 'Unusual for this time of day', service: 'Service (Prometheus)', prometheus_down: 'Prometheus' };
$('#kBody').addEventListener('click', async e => {
  const k = e.target.closest('[data-kack]');
  if (k) { k.disabled = true; const r = await api('POST', '/api/alerts/' + k.dataset.kack + '/ack', {}); toast(r.message, !r.ok); return loadCtr(); }
  if (e.target.closest('#kSizeAll')) { K.sizeAll = !K.sizeAll; KP.size = 0; return renderSizing(); }
  const pg = e.target.closest('[data-more],[data-all],[data-less]');
  if (pg) { const l = pg.dataset.more || pg.dataset.all || pg.dataset.less; KP[l] = pg.dataset.less ? 0 : pg.dataset.all ? 1e9 : kShown(l, 1e9) + KPAGE[l]; return KRENDER[l](); }
  const ch = e.target.closest('[data-chip]');
  if (ch) { KF[ch.dataset.chip] = ch.dataset.v; KP[ch.dataset.chip] = 0; return KRENDER[ch.dataset.chip](); }
  const so = e.target.closest('[data-sort]');
  if (so) { const k = so.dataset.sort; K.desc = K.sort === k ? !K.desc : k !== 'name'; K.sort = k; return renderTable(); }
  if (e.target.closest('#kEvMore')) { e.target.closest('#kEvMore').disabled = true; return loadEv(true); }
  const km = e.target.closest('[data-km]'); if (km) { K.metric = km.dataset.km; saveK(); return renderConsole(); }
  if (kDragged) return;
  const c = e.target.closest('[data-c]'); if (c) kFocus(c.dataset.c, !c.closest('#kOneP'));
});
$('#kOne').addEventListener('change', () => { K.focus = ''; kFocus($('#kOne').value); });
$('#kHost').addEventListener('change', () => { K.host = $('#kHost').value; K.focus = ''; kColors = null; saveK(); loadCtr(); });
$('#kRange').addEventListener('click', e => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  if (b.dataset.k === 'custom') return kPop($('#kPop').hidden);
  kPop(false); K.range = b.dataset.k; saveK(); loadCtr();
});
$('#kBack').addEventListener('click', () => { K.range = K.prev; saveK(); loadCtr(); });
// the custom stretch: From and To, or a quick pick; numbers are kept 8 days
const kLocal = ms => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function kPop(open) {
  $('#kPop').hidden = !open; $('#kPopE').textContent = '';
  if (!open) return;
  const now = Date.now(), f = CTR && CTR.from ? CTR.from : now - 3600000, t = CTR && CTR.to ? CTR.to : now;
  $('#kFrom').value = kLocal(f); $('#kTo').value = kLocal(Math.min(t, now));
  $('#kFrom').min = $('#kTo').min = kLocal(now - 8 * 86400000); $('#kFrom').max = $('#kTo').max = kLocal(now);
  $('#kFrom').focus();
}
$('#kPop').addEventListener('click', e => {
  const q = e.target.closest('[data-q]'), now = Date.now(), mid = new Date(); mid.setHours(0, 0, 0, 0);
  if (q) return q.dataset.q === 'today' ? kZoom(+mid, now) : q.dataset.q === 'yesterday' ? kZoom(+mid - 86400000, +mid) : kZoom(now - 48 * 3600000, now);
  if (e.target.closest('#kPopX')) return kPop(false);
  if (!e.target.closest('#kPopOk')) return;
  const f = new Date($('#kFrom').value).getTime(), t = new Date($('#kTo').value).getTime();
  const err = !f || !t ? 'Pick both a start and an end.' : t <= f ? 'Pick a start before the end.' : t - f < 600000 ? 'Pick at least 10 minutes.'
    : f < now - 8 * 86400000 ? 'Numbers are kept 8 days. Pick a start after ' + kSpan(now - 8 * 86400000, 1).split(' – ')[0] + '.' : t > now + 60000 ? 'Pick an end that is not in the future.' : '';
  if (err) { $('#kPopE').textContent = err; return; }
  kZoom(f, t);
});
document.addEventListener('mousedown', e => { if (!$('#kPop').hidden && !e.target.closest('#kPop') && !e.target.closest('#kCust')) kPop(false); });
$('#kq').addEventListener('input', () => { K.q = $('#kq').value.trim(); if (CTR && CTR.host) renderCtr(); });
window.addEventListener('resize', () => { if (view === 'ctr' && CTR && CTR.host) kOneDraw(); });

/* ---------------- shell ---------------- */
$('#hosp').addEventListener('change', () => { H = $('#hosp').value; hospitalChanged(); });
window.addEventListener('hashchange', route);
$('#btnOut').addEventListener('click', async () => { await api('POST', '/auth/logout', {}); location.href = '/auth/login'; });
setInterval(() => { if (view === 'boards' && FLEET && !(es && es.readyState === 1)) loadFleet(); }, 15000);
setInterval(() => { if (view === 'dash' && !document.hidden) loadDash(true); }, 30000);
setInterval(() => { if (view === 'ctr' && !document.hidden) loadCtr(true); }, 60000);   // a new minute from cAdvisor
boot();
