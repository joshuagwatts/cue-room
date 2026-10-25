/* Cue Room relay transport — build 4.
 *
 * Adapted from limboverse's RelayLink (the transport that actually made
 * the jukebox stable): plain Nostr ephemeral events (kind 20001, relays
 * forward but never store) over WebSockets to 3 pinned relays.
 *
 * No WebRTC, no ICE, no TURN — so there is no handshake to stall, no NAT
 * to fail, and nothing that blocks on corporate / carrier networks.
 * Every message is broadcast; every receiver dedupes by message id, so
 * hearing the same event from 2-3 relays is harmless.
 *
 * Privacy model: anyone holding the room code can read the room's
 * traffic — same as sharing the QR. Room codes are the key. */

export const RELAYS = [
  'wss://yabu.me/v2',
  'wss://relay02.lnfi.network',
  'wss://relay.sigit.io',
];
const KIND = 20001;
const MAX_BYTES = 48 * 1024;
const TOOLS_URL = 'https://esm.sh/nostr-tools@2.10.4';

export class Relay {
  constructor(tag, onMessage, onStatus) {
    this.tag = tag;               // e.g. "cueroom_by_holowatts:ABC123"
    this.onMessage = onMessage;   // (obj) => void, already deduped
    this.onStatus = onStatus || (() => {});
    this.tools = null;
    this.seckey = null;
    this.sockets = new Map();     // url -> WebSocket (open only)
    this.allSockets = new Map();  // url -> WebSocket (incl. connecting)
    this.ready = false;
    this.closed = false;
    this.outbox = [];             // publishes queued while no socket is open
    this.seen = new Map();        // msgId -> time (dedupe, bounded)
    this.tx = 0; this.rx = 0;
    this.backoff = new Map();     // url -> consecutive failures (reconnect politeness)
  }

  async start() {
    let tools = null;
    try { tools = await import(TOOLS_URL); } catch (e) { tools = null; }
    if (!tools || typeof tools.finalizeEvent !== 'function' ||
        typeof tools.generateSecretKey !== 'function') {
      this.onStatus({ sockets: 0, ready: false, error: 'relay library failed to load' });
      return false;
    }
    try {
      this.seckey = tools.generateSecretKey();
      tools.getPublicKey(this.seckey);
    } catch (e) {
      this.onStatus({ sockets: 0, ready: false, error: 'relay keygen failed' });
      return false;
    }
    this.tools = tools;
    this.ready = true;
    for (const url of RELAYS) this._connect(url);
    this.onStatus({ sockets: 0, ready: true });
    return true;
  }

  close() {
    this.closed = true; this.ready = false;
    for (const ws of this.allSockets.values()) { try { ws.close(); } catch (e) {} }
    this.allSockets.clear(); this.sockets.clear();
  }

  _status() { this.onStatus({ sockets: this.sockets.size, ready: this.ready }); }

  _connect(url) {
    if (this.closed || !this.ready || this.allSockets.has(url)) return;
    let ws = null;
    try { ws = new WebSocket(url); } catch (e) { return; }
    this.allSockets.set(url, ws);
    ws.addEventListener('open', () => {
      if (this.allSockets.get(url) !== ws) return;
      this.backoff.delete(url);
      this.sockets.set(url, ws);
      this._sendReq(ws);
      this._flushOutbox();
      this._status();
    });
    ws.addEventListener('message', (ev) => { try { this._onMessage(String(ev.data)); } catch (e) {} });
    const drop = () => {
      if (this.allSockets.get(url) === ws) this.allSockets.delete(url);
      if (this.sockets.get(url) === ws) this.sockets.delete(url);
      this._status();
      if (!this.closed && this.ready) {
        // Exponential backoff per relay (4s -> 60s cap): a relay that
        // rate-limits the handshake (429s happen on shared IPs) must not
        // be hammered — the other relays carry the room meanwhile.
        const fails = (this.backoff.get(url) || 0) + 1;
        this.backoff.set(url, fails);
        const delay = Math.min(60000, 4000 * Math.pow(2, Math.min(fails - 1, 4)));
        setTimeout(() => this._connect(url), delay);
      }
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', () => { try { ws.close(); } catch (e) {} });
  }

  _subId() { return 'cue-' + this.tag.replace(/[^A-Za-z0-9]/g, '').slice(-24); }

  _sendReq(ws) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(['REQ', this._subId(), {
        kinds: [KIND], '#t': [this.tag],
        since: Math.floor(Date.now() / 1000) - 5, limit: 50,
      }]));
    } catch (e) {}
  }

  _onMessage(data) {
    if (!data || data.charCodeAt(0) !== 91) return; // '['
    let arr = null;
    try { arr = JSON.parse(data); } catch (e) { return; }
    if (!Array.isArray(arr) || arr[0] !== 'EVENT') return;
    const ev = arr[2];
    if (!ev || ev.kind !== KIND || !Array.isArray(ev.tags)) return;
    let tag = null;
    for (const t of ev.tags) if (Array.isArray(t) && t[0] === 't') { tag = t[1]; break; }
    if (tag !== this.tag) return;
    let obj = null;
    try { obj = JSON.parse(ev.content); } catch (e) { return; }
    if (!obj || typeof obj !== 'object' || typeof obj.mid !== 'string') return;
    // Dedupe: the same event typically arrives from every open relay.
    const now = Date.now();
    if (this.seen.has(obj.mid)) return;
    this.seen.set(obj.mid, now);
    if (this.seen.size > 600) {
      for (const [k, at] of this.seen) { if (now - at > 300000) this.seen.delete(k); }
      while (this.seen.size > 600) this.seen.delete(this.seen.keys().next().value);
    }
    this.rx++;
    try { this.onMessage(obj); } catch (e) {}
  }

  /* Broadcast one object. Returns true if at least one socket took it;
   * otherwise it waits in the outbox for the next socket to open. */
  publish(obj) {
    if (!this.ready || !this.tools || !this.seckey || this.closed) return false;
    if (!obj.mid) obj.mid = obj.cid + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    // Our own message loops back through the relays — mark it seen now so
    // the echo is dropped instead of re-handled.
    this.seen.set(obj.mid, Date.now());
    let content = null;
    try { content = JSON.stringify(obj); } catch (e) { return false; }
    if (content.length > MAX_BYTES) return false;
    let ev = null;
    try {
      ev = this.tools.finalizeEvent({ kind: KIND, tags: [['t', this.tag]], content, created_at: Math.floor(Date.now() / 1000) }, this.seckey);
    } catch (e) { return false; }
    const msg = JSON.stringify(['EVENT', ev]);
    let sent = 0;
    for (const ws of this.sockets.values()) {
      try { if (ws.readyState === 1) { ws.send(msg); sent++; } } catch (e) {}
    }
    if (sent > 0) { this.tx++; return true; }
    if (this.outbox.length < 40) this.outbox.push(obj);
    return false;
  }

  _flushOutbox() {
    if (!this.outbox.length) return;
    const pending = this.outbox; this.outbox = [];
    for (const obj of pending) this.publish(obj);
  }
}
