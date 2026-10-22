/* HCI ONE Remote banner: on every Board Remote page, shows when HCI is viewing a board live, and
   keeps the Remote tab in the navigation once this site is connected. Nobody here is asked first:
   connecting the site with HCI's code is the consent. */
(function () {
  'use strict';
  var css = '.hrb{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:90;display:grid;gap:8px;width:min(560px,calc(100vw - 24px));font:600 13px/1.35 Montserrat,"Segoe UI",system-ui,sans-serif}' +
    '.hrb .it{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;background:#1E1C19;color:#fff;border-radius:14px;padding:12px 12px 12px 14px;box-shadow:0 14px 40px rgba(30,28,25,.28)}' +
    '.hrb .it.live{background:#fff;color:#1E1C19;box-shadow:0 6px 24px rgba(30,28,25,.16);padding:8px 8px 8px 12px}' +
    '.hrb .ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#2563EB}' +
    '.hrb .it.live .ic{width:26px;height:26px;border-radius:8px;background:#E2F4E8;color:#14A44D}' +
    '.hrb svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.hrb .t b{font-weight:800}.hrb .s{font-weight:500;font-size:12px;opacity:.75;margin-top:2px}' +
    '.hrb .bs{display:flex;gap:6px}.hrb button{font:inherit;border:0;border-radius:10px;height:34px;padding:0 14px;cursor:pointer;font-weight:800}' +
    '.hrb .ok{background:#14A44D;color:#fff}.hrb .no{background:rgba(255,255,255,.14);color:#fff}.hrb .end{background:#FBE4E1;color:#D93A2F;height:30px}' +
    '.hrb .dot{width:8px;height:8px;border-radius:50%;background:#14A44D;display:inline-block;margin-right:6px;animation:hrbp 1.2s infinite}@keyframes hrbp{50%{opacity:.3}}' +
    'html:not(.hci-remote-on) .navRemote{display:none!important}';
  var KEY = 'hciRemoteOn';
  function mark(on) {
    document.documentElement.classList.toggle('hci-remote-on', !!on);
    try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
  }
  try { if (localStorage.getItem(KEY)) mark(true); } catch (e) { /* storage blocked */ }
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  // the version, next to HCI ONE in the header of every page, so support can ask "which version are you on"
  fetch('/api/ping', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
    if (!j || !j.version) return;
    document.querySelectorAll('.brand .kicker').forEach(function (k) { k.textContent = 'HCI ONE \u00B7 ' + j.version; k.title = 'Board Remote ' + j.version; });
  }).catch(function () { /* Board Remote not running */ });
  var box = document.createElement('div'); box.className = 'hrb'; box.setAttribute('role', 'status');
  document.body.appendChild(box);
  var EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var last = '';
  function post(p, body) {
    return fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Remote': '1' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return {}; });
  }
  function render(d) {
    var h = '';
    (d.live || []).forEach(function (l) {
      h += '<div class="it live"><span class="ic">' + EYE + '</span><div class="t"><span class="dot"></span><b>' + esc(l.who) + '</b> from HCI is viewing <b>' + esc(l.board) + '</b></div>' +
        '<div class="bs"><button class="end" data-end="' + l.ch + '">End</button></div></div>';
    });
    if (h === last) return;
    last = h;
    box.innerHTML = h;
    box.querySelectorAll('[data-end]').forEach(function (b) { b.onclick = function () { b.disabled = true; post('/api/remote/end', { ch: Number(b.dataset.end) }).then(poll); }; });
  }
  var busy = false;
  function poll() {
    if (busy) return; busy = true;
    fetch('/api/remote', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      render(d);
      if (d.status) mark(!!d.enrolled);
      var link = document.getElementById('remoteLink');
      if (link) {
        var words = { off: 'Remote off', setup: 'Remote not set up', connecting: 'Remote connecting', connected: 'Remote on', error: 'Remote needs a look' };
        link.textContent = words[d.status] || 'Remote';
        link.title = d.message || '';
      }
    }).catch(function () { /* Board Remote stopping */ }).then(function () { busy = false; });
  }
  poll();
  setInterval(poll, 2000);
})();
