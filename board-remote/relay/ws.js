'use strict';
/*
  Small WebSocket (RFC 6455) for Node 16 and newer, no dependencies.
  Used by Board Remote for its one outbound link to HCI ONE Remote, and by the relay
  for that link and for the web viewer. The same file sits in relay/ws.js.

  accept(req, socket, head)      server side, from an http 'upgrade' event
  connect(url, headers)          client side, ws:// or wss://
  A socket emits 'message' (text as a string, binary as a Buffer), 'close' and 'drain',
  and has send(), ping(), close() and bufferedAmount.
*/
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024;

class Socket extends EventEmitter {
  constructor(sock, isClient, head) {
    super();
    this.sock = sock;
    this.isClient = isClient;
    this.open = true;
    this.done = false;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.heard = Date.now();
    sock.setNoDelay(true);
    sock.setTimeout(0);
    sock.on('data', d => { this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.pump(); });
    sock.on('close', () => this.finish());
    sock.on('error', () => { /* a close always follows */ });
    sock.on('drain', () => this.emit('drain'));
    if (this.buf.length) setImmediate(() => this.pump());
  }

  get bufferedAmount() { return this.sock.writableLength || 0; }

  pump() {
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(2) * 4294967296 + b.readUInt32BE(6); off = 10; }
      if (len > MAX_MESSAGE) return this.fail(1009);
      const keyLen = masked ? 4 : 0;
      if (b.length < off + keyLen + len) return;
      const payload = Buffer.from(b.subarray(off + keyLen, off + keyLen + len));
      if (masked) { const k = b.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= k[i & 3]; }
      this.buf = b.subarray(off + keyLen + len);
      this.heard = Date.now();
      if (op === 0x8) { this.gotClose(payload); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x0) {
        if (!this.frag) return this.fail(1002);
        this.frag.push(payload);
        if (fin) { const all = Buffer.concat(this.frag), o = this.fragOp; this.frag = null; this.deliver(o, all); }
        continue;
      }
      if (op === 0x1 || op === 0x2) {
        if (!fin) { this.frag = [payload]; this.fragOp = op; continue; }
        this.deliver(op, payload);
        continue;
      }
      return this.fail(1002);
    }
  }

  deliver(op, data) {
    try { this.emit('message', op === 0x1 ? data.toString('utf8') : data, op === 0x2); }
    catch (e) { this.emit('error', e); }
  }

  frame(op, payload) {
    if (!this.open && op !== 0x8) return false;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 4294967296), 2); head.writeUInt32BE(len >>> 0, 6); }
    head[0] = 0x80 | op;
    try {
      if (this.isClient) {                        // a client masks everything it sends
        head[1] |= 0x80;
        const k = crypto.randomBytes(4);
        const body = Buffer.from(payload);
        for (let i = 0; i < body.length; i++) body[i] ^= k[i & 3];
        return this.sock.write(Buffer.concat([head, k, body]));
      }
      if (len < 4096) return this.sock.write(Buffer.concat([head, payload]));
      this.sock.write(head);
      return this.sock.write(payload);
    } catch (e) { return false; }
  }

  send(data) {
    return typeof data === 'string' ? this.frame(0x1, Buffer.from(data, 'utf8')) : this.frame(0x2, data);
  }
  json(obj) { return this.send(JSON.stringify(obj)); }
  ping() { return this.frame(0x9, Buffer.alloc(0)); }

  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code || 1000, 0); r.copy(p, 2);
    this.frame(0x8, p);
    this.open = false;
    this.closeCode = code || 1000; this.closeReason = String(reason || '');
    try { this.sock.end(); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { this.sock.destroy(); } catch (e) { /* gone */ } }, 2000);
    if (t.unref) t.unref();
  }

  terminate() { this.open = false; try { this.sock.destroy(); } catch (e) { /* gone */ } }

  gotClose(p) {
    const code = p.length >= 2 ? p.readUInt16BE(0) : 1005;
    if (this.closeCode === undefined) { this.closeCode = code; this.closeReason = p.subarray(2).toString('utf8'); }
    if (this.open) {
      this.open = false;
      this.frame(0x8, p.subarray(0, 2));
      try { this.sock.end(); } catch (e) { /* gone */ }
    }
  }

  fail(code) { this.close(code); this.terminate(); }

  finish() {
    if (this.done) return;
    this.done = true;
    this.open = false;
    this.emit('close', this.closeCode || 1006, this.closeReason || '');
  }
}

/* server side: call from an http server's 'upgrade' event */
function accept(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { refuse(socket, 400, 'Bad Request'); return null; }
  const answer = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + answer + '\r\n\r\n');
  return new Socket(socket, false, head);
}

function refuse(socket, code, text) {
  try { socket.end('HTTP/1.1 ' + code + ' ' + text + '\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(text) + '\r\n\r\n' + text); }
  catch (e) { /* gone */ }
}

/* client side: resolves with an open socket, or rejects with the server's answer */
function connect(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('That relay address is not a valid web address.')); }
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const lib = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const req = lib.request({
      hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: (u.pathname || '/') + (u.search || ''), method: 'GET',
      headers: Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key }, headers || {})
    });
    const timer = setTimeout(() => req.destroy(new Error('The relay did not answer.')), timeoutMs || 15000);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== want) { socket.destroy(); return reject(new Error('The relay answered, but not as a WebSocket.')); }
      resolve(new Socket(socket, true, head));
    });
    req.on('response', res => {
      clearTimeout(timer);
      let s = '';
      res.on('data', c => { if (s.length < 2000) s += c; });
      res.on('end', () => reject(Object.assign(new Error(s.trim() || ('The relay answered ' + res.statusCode + '.')), { status: res.statusCode })));
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

module.exports = { accept, connect, refuse, Socket };
