/* Cue Room — build 3.
 * The limboverse jukebox, out of the game and into its own app.
 *
 * One room = one shared queue. Anyone in the room can add a link;
 * everyone hears the same track at the same time (room clock:
 * startedAt + offset, drift-corrected). Skip is a team move: it takes
 * 2 votes from 2 different people (in a solo room, a second tap from
 * you confirms). Transport is the nostr relay broadcast that made the
 * limboverse jukebox stable — no WebRTC to stall.
 *
 * The queue's line is held by an elected holder (lowest client id in
 * the room, re-elected as people come and go): the holder keeps the
 * canonical queue, broadcasts syncs, inherits the line via handoff
 * when elected, and advances past broken tracks so the room never
 * wedges on a dead link. */
import { Relay } from './relay.js?v=2';
import {
  detectProvider, fallbackTitle, extractUrl, fetchTitle, sniffAudioContentType,
  resolveShortSCLink, resolveSCSet, resolveYTPlaylist, resolveBandcamp,
  driveStreamUrl, swapIdentifySpotify, swapSearchYT, swapMatch, swapJudge,
  swapAuditText, validAdd, validPlay, MAX_QUEUE,
} from './providers.js?v=2';
import { Player } from './player.js?v=2';

const BUILD = 3;
const APP_TAG = 'cueroom_by_holowatts';
const HELLO_MS = 8000, ROSTER_TTL_MS = 25000, SYNC_MS = 10000, HANDOFF_MS = 2500;
const ACK_MS = 20000, ACK_RETRIES = 8;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------------- identity + room code ---------------- */

function makeCid() {
  return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}
function makeId() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}
function makeRoomCode() {
  let s = '';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (const b of buf) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
function cleanRoomCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,10}$/.test(s) ? s : null;
}
function roomFromUrl() {
  try {
    const u = new URL(location.href);
    return cleanRoomCode(u.searchParams.get('room')) ||
      cleanRoomCode((u.hash || '').replace(/^#/, '').replace(/^room=/, '')) || null;
  } catch (e) { return null; }
}
function joinUrl(code) {
  // Code rides BOTH the query and the fragment: messaging apps strip
  // fragments, some in-app browsers strip queries — one always survives
  // (the SMASHVR join lesson, 2026-10-24).
  return location.origin + location.pathname + '?room=' + code + '#room=' + code;
}

let myCid = localStorage.getItem('cueroom-cid');
if (!myCid) { myCid = makeCid(); try { localStorage.setItem('cueroom-cid', myCid); } catch (e) {} }
let myName = (localStorage.getItem('cueroom-name') || '').slice(0, 16);

/* ---------------- state ---------------- */

const S = {
  room: null, relay: null, sockets: 0, connected: false,
  queue: [], now: null, nowStartedAt: 0, adoptedAt: 0,
  roster: new Map(),           // cid -> {name, lastSeen}
  iAmHolder: false, holderCid: null, holderName: '',
  syncRev: 0, syncRevSeen: -1, syncTimer: null, helloTimer: null,
  holderCatchingUp: false, handoffTimer: null, handoffAnswers: [],
  lastKnown: null,
  pendingAck: new Map(),       // trackId -> {track, sentAt, retries}
  removedIds: new Map(),       // trackId -> time (tombstones vs stale syncs)
  skipVotes: new Map(),        // voterCid -> name, for the current track
  skipConfirmTimer: null,
  feed: [],
  volume: (() => { const v = Number(localStorage.getItem('cueroom-vol')); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.8; })(),
  unlocked: false,
  errAdvancedFor: null, endedNotifiedFor: null, badReportedFor: null,
  swapVerifyPending: null,
};

/* ---------------- dom ---------------- */

const $ = (id) => document.getElementById(id);
const landingEl = $('landing'), roomEl = $('room');
const nameInput = $('name-input'), joinCodeInput = $('join-code'), landingHint = $('landing-hint');
const connLabel = $('conn-label'), peopleLabel = $('people-label'), peopleList = $('people-list');
const nowTitle = $('now-title'), nowSub = $('now-sub'), nowAudit = $('now-audit');
const progressFill = $('progress-fill'), timePos = $('time-pos'), timeDur = $('time-dur');
const skipBtn = $('skip-btn'), skipNote = $('skip-note'), joinMusicBtn = $('join-music-btn');
const queueList = $('queue-list'), queueCount = $('queue-count');
const addUrlInput = $('add-url'), addHint = $('add-hint'), feedEl = $('feed');
const sharePanel = $('share-panel'), qrBox = $('qr-box'), shareLinkEl = $('share-link');
const swapCard = $('swap-card');

if (myName) nameInput.value = myName;

/* ---------------- player ---------------- */

const player = new Player(
  { yt: $('stage-yt'), sc: $('stage-sc'), media: $('stage-media'), idle: $('stage-idle') },
  {
    offsetFor: () => (S.now ? Math.max(0, (Date.now() - S.now.startedAt) / 1000) : 0),
    onEnded: () => onPlayerEnded(),
    onError: (msg) => onTrackError(msg),
    onPlaying: () => { joinMusicBtn.style.display = 'none'; },
    onDuration: (sec) => {
      if (S.now && sec > 0) { S.now.durationMs = Math.round(sec * 1000); renderNow(); }
    },
    onTitle: (t) => { if (S.now) { S.now.title = t; renderNow(); } },
    onAdChange: (inAd) => {
      // An ad on YOUR screen only (build 3): the room clock keeps
      // running for everyone else; you sit the ad out, then ONE clean
      // seek puts you back exactly on the room — no chasing, no
      // repeated seeks while the ad plays.
      if (!S.now) return;
      if (inAd) feed('An ad is playing on your end — the room keeps going; you\u2019ll snap back in sync when it ends');
      else { player.seekTo(offsetFor(S.now)); lastSeekAt = Date.now(); }
    },
  }
);
player.setVolume(S.volume);
$('vol').value = Math.round(S.volume * 100);
$('vol').addEventListener('input', (e) => {
  S.volume = Number(e.target.value) / 100;
  player.setVolume(S.volume);
  try { localStorage.setItem('cueroom-vol', String(S.volume)); } catch (err) {}
});

/* ---------------- feed / hints ---------------- */

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec == null) return '';
  sec = Math.max(0, Math.floor(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function feed(text) {
  S.feed.unshift({ text, at: Date.now() });
  if (S.feed.length > 30) S.feed.pop();
  feedEl.innerHTML = S.feed.map((f) =>
    `<div class="feed-item"><time>${new Date(f.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>${escapeHtml(f.text)}</div>`).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
let hintTimer = null;
function hint(msg, ms) {
  addHint.textContent = msg || '';
  if (hintTimer) clearTimeout(hintTimer);
  if (msg) hintTimer = setTimeout(() => { addHint.textContent = ''; }, ms || 6000);
}
function roomNote(text, broadcast) {
  feed(text);
  if (broadcast && S.relay) S.relay.publish({ t: 'note', cid: myCid, name: myName, text });
}

/* ---------------- persistence (per room, like limbo build 60) ---------------- */

function persistKey() { return 'cueroom-line-' + S.room; }
function persist() {
  if (!S.room) return;
  try {
    localStorage.setItem(persistKey(), JSON.stringify({
      queue: S.queue.slice(0, MAX_QUEUE), now: S.now, at: Date.now(),
    }));
  } catch (e) {}
}
function restore() {
  try {
    const raw = localStorage.getItem(persistKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    const q = (Array.isArray(d.queue) ? d.queue : []).filter(validAdd).slice(0, MAX_QUEUE);
    const n = (d.now && validPlay(d.now) && !d.now.stopped) ? d.now : null;
    if (q.length || n) S.lastKnown = { queue: q, now: n, at: d.at || Date.now() };
  } catch (e) {}
}

/* ---------------- relay wiring ---------------- */

function send(obj) {
  if (!S.relay) return false;
  return S.relay.publish({ cid: myCid, name: myName, ...obj });
}

function startRoom(code) {
  S.room = code;
  restore();
  landingEl.style.display = 'none';
  roomEl.style.display = '';
  $('room-code-label').textContent = '· ' + code;
  document.title = 'Cue Room ' + code + ' — listen together';
  history.replaceState(null, '', joinUrl(code));
  shareLinkEl.textContent = joinUrl(code);
  renderQr();
  S.relay = new Relay(APP_TAG + ':' + code,
    (obj) => handleMessage(obj),
    (st) => {
      S.sockets = st.sockets; S.connected = st.sockets > 0;
      renderConn();
    });
  S.relay.start();
  startHellos();
  setInterval(tick, 1000);
  renderAll();
  feed('You\u2019re in room ' + code + ' — share the QR and start cueing');
  // Ask the room for the line right away; retries mirror the holder sync.
  setTimeout(() => send({ t: 'stateReq', reqId: makeId() }), 1200);
  setTimeout(() => { if (!S.now && !S.queue.length) send({ t: 'stateReq', reqId: makeId() }); }, 6000);
}

function leaveRoom() {
  send({ t: 'bye' });
  if (S.relay) S.relay.close();
  location.href = location.origin + location.pathname;
}

function handleMessage(obj) {
  if (!obj || typeof obj.t !== 'string' || obj.cid === myCid) return;
  switch (obj.t) {
    case 'hello': notePeer(obj.cid, obj.name); break;
    case 'bye': S.roster.delete(obj.cid); recomputeHolder(); renderPeople(); break;
    case 'add': handleAdd(obj); break;
    case 'remove': handleRemove(obj); break;
    case 'play': handlePlay(obj); break;
    case 'skipVote': handleSkipVote(obj); break;
    case 'ended': if (S.iAmHolder && S.now && obj.id === S.now.id) advance(); break;
    case 'bad': if (S.iAmHolder && S.now && obj.id === S.now.id) scheduleErrorAdvance(obj.id); break;
    case 'title': handleTitle(obj); break;
    case 'note': feed(String(obj.text || '').slice(0, 200)); break;
    case 'stateReq': handleStateReq(obj); break;
    case 'state': handleState(obj); break;
    case 'sync': handleSync(obj); break;
    case 'claim': notePeer(obj.cid, obj.name); if (obj.cid === S.holderCid) { /* holder alive */ } break;
  }
}

/* ---------------- presence + holder election ---------------- */

function notePeer(cid, name) {
  if (!cid || cid === myCid) return;
  const isNew = !S.roster.has(cid);
  S.roster.set(cid, { name: String(name || 'guest').slice(0, 24), lastSeen: Date.now() });
  recomputeHolder();
  renderPeople();
  if (isNew) {
    feed((name || 'Someone') + ' joined the room');
    send({ t: 'hello' }); // answer so they see us right away
    if (S.iAmHolder) broadcastSync();
  }
}
function myElectionKey() { return myCid; }
function recomputeHolder() {
  const now = Date.now();
  for (const [cid, rec] of S.roster) if (now - rec.lastSeen > ROSTER_TTL_MS) S.roster.delete(cid);
  let lowest = myCid, lowestCid = myCid;
  for (const cid of S.roster.keys()) if (cid < lowest) { lowest = cid; lowestCid = cid; }
  const prev = S.holderCid;
  S.holderCid = lowestCid;
  if (lowestCid === myCid) {
    if (!S.iAmHolder) becomeHolder();
    S.holderName = myName;
  } else {
    if (S.iAmHolder) stepDown();
    const rec = S.roster.get(lowestCid);
    S.holderName = rec ? rec.name : 'a friend';
  }
  if (prev !== S.holderCid) { S.syncRevSeen = -1; renderPeople(); }
}
function becomeHolder() {
  S.iAmHolder = true;
  S.pendingAck.clear(); // my line is canonical now
  send({ t: 'claim' });
  // Handoff: collect everyone else's last-known line before ruling.
  S.holderCatchingUp = true;
  S.handoffAnswers = [];
  send({ t: 'stateReq', reqId: 'handoff' });
  if (S.handoffTimer) clearTimeout(S.handoffTimer);
  S.handoffTimer = setTimeout(finishHandoff, HANDOFF_MS);
  if (S.syncTimer) clearInterval(S.syncTimer);
  S.syncTimer = setInterval(() => { if (S.iAmHolder && !S.holderCatchingUp) broadcastSync(); }, SYNC_MS);
}
function finishHandoff() {
  if (S.handoffTimer) { clearTimeout(S.handoffTimer); S.handoffTimer = null; }
  if (!S.iAmHolder) { S.holderCatchingUp = false; return; }
  S.holderCatchingUp = false;
  let best = null;
  const consider = (queue, now, at) => {
    const score = (Array.isArray(queue) ? queue.length : 0) + (now ? 100 : 0);
    if (!best || score > best.score || (score === best.score && (at || 0) > (best.at || 0))) {
      best = { queue: queue || [], now: now || null, at: at || 0, score };
    }
  };
  for (const a of S.handoffAnswers) consider(a.queue, a.now, a.at);
  if (S.lastKnown) consider(S.lastKnown.queue, S.lastKnown.now, S.lastKnown.at);
  consider(S.queue, S.now, Date.now());
  if (best) {
    const bn = best.now;
    S.queue = (Array.isArray(best.queue) ? best.queue : []).filter(validAdd)
      .filter((t) => !(bn && t.id === bn.id)).slice(0, MAX_QUEUE);
    sortQueue();
    if (bn && validPlay(bn) && !bn.stopped && (!S.now || S.now.id !== bn.id)) adoptPlay(bn);
    else if (!S.now && S.queue.length) advance();
  }
  broadcastSync();
}
function stepDown() {
  S.iAmHolder = false;
  S.holderCatchingUp = false;
  if (S.handoffTimer) { clearTimeout(S.handoffTimer); S.handoffTimer = null; }
  if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
}
function startHellos() {
  const tickHello = () => { send({ t: 'hello' }); recomputeHolder(); };
  tickHello();
  if (S.helloTimer) clearInterval(S.helloTimer);
  S.helloTimer = setInterval(tickHello, HELLO_MS);
}
function broadcastSync() {
  if (!S.iAmHolder || S.holderCatchingUp) return;
  S.syncRev++;
  send({ t: 'sync', rev: S.syncRev, at: Date.now(), queue: S.queue.slice(0, MAX_QUEUE), now: S.now });
  persist();
}
function handleSync(obj) {
  notePeer(obj.cid, obj.name);
  if (obj.cid !== S.holderCid) return;          // only the elected holder rules
  if (typeof obj.rev !== 'number' || obj.rev <= S.syncRevSeen) return;
  S.syncRevSeen = obj.rev;
  const incoming = (Array.isArray(obj.queue) ? obj.queue : []).filter(validAdd)
    .filter((t) => !S.removedIds.has(t.id));
  const incomingIds = new Set(incoming.map((t) => t.id));
  if (obj.now && validPlay(obj.now) && !obj.now.stopped) incomingIds.add(obj.now.id);
  for (const id of [...S.pendingAck.keys()]) if (incomingIds.has(id)) S.pendingAck.delete(id);
  // Keep my unconfirmed adds (holder hasn't seen them yet) — never wipe.
  const unconfirmed = S.queue.filter((t) => t.addedById === myCid && S.pendingAck.has(t.id) && !incomingIds.has(t.id));
  const dn = obj.now;
  if (!(dn && S.now && dn.id === S.now.id)) {
    // someone else's now is not mine to keep if the holder says otherwise
  }
  S.queue = incoming.concat(unconfirmed).slice(0, MAX_QUEUE);
  sortQueue();
  if (incoming.length || (dn && validPlay(dn) && !dn.stopped)) {
    S.lastKnown = { queue: incoming.slice(0, MAX_QUEUE), now: (dn && validPlay(dn) && !dn.stopped) ? dn : null, at: obj.at || Date.now() };
  }
  if (dn && validPlay(dn) && !dn.stopped) {
    if (!S.now || S.now.id !== dn.id) adoptPlay(dn);
  } else if (dn && dn.stopped && S.now && (dn.startedAt || 0) >= S.nowStartedAt) {
    stopPlayback();
  }
  persist();
  renderAll();
}
function handleStateReq(obj) {
  // Everyone answers a handoff; only the holder answers a plain ask.
  if (obj.reqId === 'handoff' || S.iAmHolder) {
    const shareNow = S.now && validPlay(S.now) ? S.now : null;
    send({ t: 'state', reqId: obj.reqId, at: Date.now(), queue: S.queue.slice(0, MAX_QUEUE), now: shareNow });
  }
}
function handleState(obj) {
  notePeer(obj.cid, obj.name);
  if (S.holderCatchingUp) { S.handoffAnswers.push(obj); return; }
  if (S.iAmHolder) return;
  if (obj.cid !== S.holderCid && S.holderCid) {
    // A non-holder's state still seeds an empty room (fresh join, holder
    // hasn't caught up yet) — adopt only if we hold nothing.
    if (S.now || S.queue.length) return;
  }
  const q = (Array.isArray(obj.queue) ? obj.queue : []).filter(validAdd);
  if (obj.now && validPlay(obj.now) && !obj.now.stopped) {
    if (!S.now || S.now.id !== obj.now.id) adoptPlay(obj.now);
  }
  if (q.length && !S.queue.length) { S.queue = q; sortQueue(); }
  S.lastKnown = { queue: q, now: obj.now || null, at: obj.at || Date.now() };
  renderAll();
}

/* ---------------- queue ops ---------------- */

function sortQueue() {
  S.queue.sort((a, b) => (a.addedAt - b.addedAt) || (a.id < b.id ? -1 : 1));
}
function trackPending(t) {
  if (S.iAmHolder) return;
  S.pendingAck.set(t.id, { track: t, sentAt: Date.now(), retries: 0 });
}
function addToQueue(t, opts) {
  if (!validAdd(t)) return null;
  if (S.queue.some((x) => x.id === t.id) || (S.now && S.now.id === t.id)) return null;
  if (S.queue.length >= MAX_QUEUE) { hint('The queue is full at ' + MAX_QUEUE + ' — let a track finish first'); return null; }
  S.queue.push(t);
  sortQueue();
  if (!opts || !opts.remote) { send({ t: 'add', track: t }); trackPending(t); }
  persist();
  renderAll();
  if (!S.now) advance();
  return t;
}
function handleAdd(obj) {
  notePeer(obj.cid, obj.name);
  const t = obj.track;
  if (!validAdd(t)) return;
  if (S.removedIds.has(t.id)) return;
  const existed = S.queue.some((x) => x.id === t.id) || (S.now && S.now.id === t.id);
  if (!existed) {
    S.queue.push(t); sortQueue();
    feed(t.addedBy + ' cued “' + t.title + '”');
    enrichTitle(t);
  }
  if (S.iAmHolder) broadcastSync();
  persist();
  renderAll();
  if (!S.now) advance();
}
function handleRemove(obj) {
  const i = S.queue.findIndex((t) => t.id === obj.id);
  if (i === -1) return;
  const t = S.queue[i];
  if (t.addedById !== obj.cid && obj.cid !== S.holderCid) return; // only the adder (or holder cleanup)
  S.queue.splice(i, 1);
  S.removedIds.set(obj.id, Date.now());
  S.pendingAck.delete(obj.id);
  feed(t.addedBy + '\u2019s track was pulled from the queue');
  if (S.iAmHolder) broadcastSync();
  persist(); renderAll();
}
function removeOwn(id) {
  const i = S.queue.findIndex((t) => t.id === id);
  if (i === -1) return;
  S.queue.splice(i, 1);
  S.removedIds.set(id, Date.now());
  S.pendingAck.delete(id);
  send({ t: 'remove', id });
  if (S.iAmHolder) broadcastSync();
  persist(); renderAll();
}
function handleTitle(obj) {
  const t = S.queue.find((x) => x.id === obj.id);
  if (t && typeof obj.title === 'string') t.title = obj.title.slice(0, 160);
  if (S.now && S.now.id === obj.id && typeof obj.title === 'string') S.now.title = obj.title.slice(0, 160);
  if (S.iAmHolder) broadcastSync();
  renderAll();
}
async function enrichTitle(t) {
  if (!t || t.title !== fallbackTitle(t.provider)) return;
  const title = await fetchTitle(t.url, t.provider);
  if (title === fallbackTitle(t.provider)) return;
  t.title = title;
  if (S.now && S.now.id === t.id) S.now.title = title;
  if (t.addedById === myCid) send({ t: 'title', id: t.id, title });
  renderAll();
}

/* ---------------- playback / room clock ---------------- */

function offsetFor(now) { return Math.max(0, (Date.now() - (now ? now.startedAt : Date.now())) / 1000); }

function advance() {
  const next = S.queue.shift() || null;
  if (!next) {
    const msg = { t: 'play', stopped: true, by: myName, startedAt: Date.now() };
    send(msg);
    stopPlayback();
    return null;
  }
  const play = { ...next, startedAt: Date.now(), by: myName };
  send({ t: 'play', track: play });
  adoptPlay(play);
  if (S.iAmHolder) broadcastSync();
  return play;
}
function adoptPlay(play) {
  S.now = { ...play };
  S.nowStartedAt = play.startedAt;
  S.adoptedAt = Date.now();
  S.skipVotes = new Map();
  S.errAdvancedFor = null; S.endedNotifiedFor = null; S.badReportedFor = null;
  const i = S.queue.findIndex((t) => t.id === play.id);
  if (i !== -1) S.queue.splice(i, 1);
  S.pendingAck.delete(play.id);
  player.play(S.now, offsetFor(S.now));
  maybeVerifySwap(S.now);
  persist();
  renderAll();
  updateJoinMusic();
}
function stopPlayback() {
  S.now = null; S.nowStartedAt = 0;
  S.skipVotes = new Map();
  player.stop();
  persist();
  renderAll();
}
function handlePlay(obj) {
  notePeer(obj.cid, obj.name);
  if (obj.stopped) {
    if (S.now && (obj.startedAt || 0) >= S.nowStartedAt) stopPlayback();
    if (S.iAmHolder) broadcastSync();
    return;
  }
  const d = obj.track;
  if (!validPlay(d)) return;
  const inContention = Date.now() - S.adoptedAt < 1500;
  if (S.now && d.id === S.now.id && !inContention) return;
  if (inContention && S.now && d.startedAt >= S.nowStartedAt) return; // earlier claim wins
  adoptPlay(d);
  if (S.iAmHolder) broadcastSync();
}
function onPlayerEnded() {
  if (!S.now) return;
  if (S.iAmHolder) { advance(); return; }
  if (!S.holderCid || S.holderCid === myCid || S.roster.size === 0) { advance(); return; }
  if (S.endedNotifiedFor !== S.now.id) {
    S.endedNotifiedFor = S.now.id;
    send({ t: 'ended', id: S.now.id });
  }
}
function scheduleErrorAdvance(id) {
  if (S.errAdvancedFor === id) return;
  S.errAdvancedFor = id;
  setTimeout(() => {
    if (S.now && S.now.id === id && S.iAmHolder) advance();
  }, 2500);
}
function onTrackError(msg) {
  if (!S.now) return;
  const id = S.now.id;
  hint(msg);
  if (S.iAmHolder) {
    roomNote('⏭ Couldn\u2019t play “' + S.now.title.slice(0, 60) + '” — skipping', true);
    scheduleErrorAdvance(id);
  } else if (S.badReportedFor !== id) {
    S.badReportedFor = id;
    send({ t: 'bad', id });
    // If no holder answers, don't leave the room wedged: after 6s the
    // reporter advances (contention rules sort out duplicates).
    setTimeout(() => { if (S.now && S.now.id === id && !S.iAmHolder) advance(); }, 6000);
  }
}

/* ---------------- skip: 2 votes to confirm ---------------- */

function voteSkip() {
  if (!S.now) return;
  const id = S.now.id;
  const solo = S.roster.size === 0;
  if (S.skipVotes.has(myCid) && solo) {
    // Solo room: the second tap IS the confirmation.
    confirmSkip(id, [myName, myName]);
    return;
  }
  if (S.skipVotes.has(myCid)) { hint('You already voted — needs one more person'); return; }
  S.skipVotes.set(myCid, myName);
  send({ t: 'skipVote', id, voterName: myName });
  feed('You voted to skip “' + S.now.title.slice(0, 50) + '” (' + S.skipVotes.size + '/2)');
  renderSkip();
  armSkipConfirm(id);
}
function handleSkipVote(obj) {
  notePeer(obj.cid, obj.name);
  if (!S.now || obj.id !== S.now.id) return;
  if (S.skipVotes.has(obj.cid)) return;
  S.skipVotes.set(obj.cid, String(obj.voterName || obj.name || 'a friend').slice(0, 24));
  feed(S.skipVotes.get(obj.cid) + ' voted to skip (' + S.skipVotes.size + '/2)');
  renderSkip();
  armSkipConfirm(obj.id);
}
function armSkipConfirm(id) {
  if (S.skipVotes.size < 2) return;
  if (S.skipConfirmTimer) return;
  // The holder confirms; if the holder is the second voter or is gone,
  // the fallback timer below still lands the skip.
  S.skipConfirmTimer = setTimeout(() => {
    S.skipConfirmTimer = null;
    if (S.now && S.now.id === id && S.skipVotes.size >= 2) {
      if (S.iAmHolder) confirmSkip(id, [...S.skipVotes.values()]);
      else setTimeout(() => { if (S.now && S.now.id === id && S.skipVotes.size >= 2) confirmSkip(id, [...S.skipVotes.values()]); }, 1200);
    }
  }, 400);
}
function confirmSkip(id, voters) {
  if (!S.now || S.now.id !== id) return;
  const title = S.now.title;
  roomNote('⏭ Skipped “' + title.slice(0, 60) + '” — ' + (voters[0] === voters[1] ? voters[0] + ' confirmed' : voters.slice(0, 2).join(' + ') + ' voted'), true);
  advance();
}
skipBtn.addEventListener('click', voteSkip);

/* ---------------- per-second tick: roster, acks, resync, watchdog ---------------- */

function tick() {
  if (!S.room) return;
  const now = Date.now();
  // tombstone sweep
  for (const [id, at] of S.removedIds) if (now - at > 300000) S.removedIds.delete(id);
  // pending-ack retries (holder hasn't confirmed my add yet)
  for (const [id, p] of S.pendingAck) {
    if (S.queue.some((t) => t.id === id) === false && !(S.now && S.now.id === id)) { S.pendingAck.delete(id); continue; }
    if (now - p.sentAt < ACK_MS) continue;
    if (p.retries >= ACK_RETRIES) {
      S.pendingAck.delete(id);
      hint('The room didn\u2019t confirm “' + p.track.title.slice(0, 40) + '” — try cueing it again');
      continue;
    }
    p.retries++; p.sentAt = now;
    send({ t: 'add', track: p.track });
  }
  // end watchdog: track is well past its known duration and nobody advanced
  if (S.now && S.now.durationMs) {
    const elapsed = offsetFor(S.now);
    if (elapsed > S.now.durationMs / 1000 + 10) onPlayerEnded();
  }
  renderConn();
}

/* progress loop (rAF) + CLEAN SYNC (build 3, Joshua's spec):
 * under ~1s off is together — hands completely off, no seeks, no rate
 * tricks, nothing that can stall or slow playback. Over 1s off gets
 * ONE clean seek to the room position (same as a refresh landing),
 * at most once per 15s. And never seek a player whose position is
 * frozen — a frozen needle means it's still LOADING, and piling a
 * seek onto a load just restarts the buffering. */
let lastSeekAt = 0, lastCheckAt = 0, lastPosSample = null, lastPosSampleAt = 0;
const DRIFT_TOLERANCE = 1.0;   // seconds — his line: past this it stops feeling together
const SEEK_COOLDOWN = 15000;
const CHECK_EVERY = 4000;
function progressLoop() {
  requestAnimationFrame(progressLoop);
  if (!S.now) return;
  const expected = offsetFor(S.now);
  const pos = player.pos();
  const dur = player.dur() || (S.now.durationMs ? S.now.durationMs / 1000 : null);
  const shown = pos != null && pos > 0 ? pos : expected;
  if (dur) {
    progressFill.style.width = Math.min(100, (shown / dur) * 100) + '%';
    timePos.textContent = fmtTime(shown);
    timeDur.textContent = fmtTime(dur);
  } else {
    progressFill.style.width = '0%';
    timePos.textContent = fmtTime(shown);
    timeDur.textContent = '';
  }
  const nowMs = Date.now();
  if (pos != null && nowMs - lastCheckAt > CHECK_EVERY) {
    const stalled = lastPosSample != null && (nowMs - lastPosSampleAt) >= 3000 &&
      Math.abs(pos - lastPosSample) < 0.05;
    lastCheckAt = nowMs;
    lastPosSample = pos; lastPosSampleAt = nowMs;
    // Never seek past what's buffered on a media element — landing in
    // unbuffered territory restarts its download and the "resync"
    // becomes the thing wrecking playback. It'll be in range shortly;
    // the next check catches it then.
    const bufEnd = player.bufferedEnd();
    const seekWouldThrash = bufEnd != null && expected > bufEnd - 0.25;
    if (!stalled && !seekWouldThrash && expected > 2 && Math.abs(pos - expected) > DRIFT_TOLERANCE &&
        nowMs - lastSeekAt > SEEK_COOLDOWN) {
      lastSeekAt = nowMs;
      player.seekTo(expected);
    }
  }
}
requestAnimationFrame(progressLoop);

/* ---------------- add-a-link flow ---------------- */

async function addLink(rawText, titleHint, extra) {
  const spotifyUri = String(rawText || '').trim().match(/^spotify:track:[A-Za-z0-9]+/i);
  if (spotifyUri) { startSpotifySwap(spotifyUri[0]); return null; }
  const cleanUrl = extractUrl(rawText);
  let det = detectProvider(cleanUrl);
  if (det.provider === 'invalid') { hint('That link doesn\u2019t look right — paste a full https url'); return null; }
  let url = cleanUrl;
  let resolvedTitle = titleHint || null;
  if (det.provider === 'spotify' || det.provider === 'spotify-other') { startSpotifySwap(url); return null; }
  if (det.provider === 'bandcamp') return addBandcamp(url);
  if (det.provider === 'soundcloud-short') {
    hint('Resolving that soundcloud link…');
    const r = await resolveShortSCLink(url);
    if (r) { url = r.url; det = detectProvider(url); if (r.title) resolvedTitle = r.title; }
    else det = { provider: 'soundcloud' };
  }
  if (det.provider === 'soundcloud-set' || det.provider === 'youtube-playlist') {
    return addPlaylist(url, det, resolvedTitle);
  }
  if (det.provider === 'direct-audio' && !resolvedTitle) {
    try {
      const leaf = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      const stem = leaf.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_+\-]+/g, ' ').trim();
      if (stem) resolvedTitle = stem.slice(0, 140);
    } catch (e) {}
  }
  if (det.provider === 'external' && !resolvedTitle) {
    try { if (await sniffAudioContentType(url)) det = { provider: 'direct-audio' }; } catch (e) {}
    if (det.provider === 'external') {
      hint('That one can\u2019t play in sync for everyone — try a YouTube, SoundCloud, Bandcamp, Drive or direct audio link');
      return null;
    }
  }
  const t = {
    id: makeId(), url, provider: det.provider,
    videoId: det.videoId || null, title: resolvedTitle || fallbackTitle(det.provider),
    addedBy: myName, addedById: myCid, addedAt: Date.now(),
  };
  if (det.driveId) t.driveId = det.driveId;
  if (extra && typeof extra === 'object') Object.assign(t, extra);
  const added = addToQueue(t);
  if (added && !resolvedTitle) enrichTitle(t);
  if (added) feed('You cued “' + t.title + '”');
  return added;
}

async function addPlaylist(url, det, titleHint) {
  hint('Pulling the track list…');
  let tracks = null;
  try {
    tracks = det.provider === 'soundcloud-set' ? await resolveSCSet(url) : await resolveYTPlaylist(det.playlistId);
  } catch (e) { tracks = null; }
  if (!tracks || !tracks.length) { hint('Couldn\u2019t load that playlist — is it public?'); return null; }
  const gid = 'pl-' + makeId();
  const groupTitle = titleHint || (det.provider === 'soundcloud-set' ? 'soundcloud set' : 'youtube playlist');
  const now = Date.now();
  let first = null;
  tracks.forEach((tr, i) => {
    const t = {
      id: makeId(), url: tr.url, provider: tr.provider, videoId: tr.videoId || null,
      title: (tr.title || ('track ' + (i + 1))).toString().slice(0, 140),
      durationMs: tr.durationMs || null,
      addedBy: myName, addedById: myCid, addedAt: now + i,
      group: gid, groupTitle, groupCount: tracks.length,
    };
    const a = addToQueue(t);
    if (a && !first) first = a;
  });
  if (first) feed('You cued ' + tracks.length + ' tracks from ' + groupTitle);
  return first;
}

async function addBandcamp(url) {
  hint('Resolving that bandcamp link…');
  const w = await resolveBandcamp(url);
  if (!w) { hint('Couldn\u2019t read that bandcamp page — its streams wouldn\u2019t sync, so it can\u2019t cue'); return null; }
  const gid = w.tracks.length > 1 ? 'bc-' + makeId() : null;
  const now = Date.now();
  let first = null;
  w.tracks.forEach((tr, i) => {
    const t = {
      id: makeId(), url, provider: 'bandcamp', streamUrl: tr.streamUrl,
      title: (w.artist ? w.artist + ' — ' : '') + tr.title,
      durationMs: tr.durationSec ? tr.durationSec * 1000 : null,
      addedBy: myName, addedById: myCid, addedAt: now + i,
      ...(gid ? { group: gid, groupTitle: w.title, groupCount: w.tracks.length } : {}),
    };
    const a = addToQueue(t);
    if (a && !first) first = a;
  });
  if (first) feed('You cued “' + first.title + '”');
  return first;
}

/* ---------------- spotify swap ---------------- */

let swapSeq = 0, swapState = null;
function swapEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function swapShow(build) {
  swapCard.innerHTML = '';
  swapCard.style.display = '';
  build(swapCard);
}
function swapHide() { swapCard.style.display = 'none'; swapCard.innerHTML = ''; }
function swapAuditDetails(parent, track, audit) {
  const det = swapEl('div', 'audit-text', swapAuditText(track, audit).join('\n'));
  det.style.display = 'none';
  const btn = swapEl('button', null, 'why this version?');
  btn.addEventListener('click', () => {
    det.style.display = det.style.display === 'none' ? '' : 'none';
    btn.textContent = det.style.display === 'none' ? 'why this version?' : 'hide the audit';
  });
  const row = swapEl('div', 'row'); row.appendChild(btn);
  parent.appendChild(row); parent.appendChild(det);
}
async function startSpotifySwap(url) {
  const seq = ++swapSeq;
  swapState = null;
  swapShow((card) => card.appendChild(swapEl('div', 'swap-title', 'Spotify can\u2019t sync for everyone — finding the same audio on YouTube…')));
  const track = await swapIdentifySpotify(url);
  if (seq !== swapSeq) return;
  if (!track) {
    swapShow((card) => {
      card.appendChild(swapEl('div', 'swap-title', 'Couldn\u2019t read that Spotify link'));
      card.appendChild(swapEl('p', null, myName + ', that link wouldn\u2019t identify — try a different link, or paste the YouTube version straight in.'));
      const row = swapEl('div', 'row');
      const b = swapEl('button', null, 'OK'); b.addEventListener('click', swapHide);
      row.appendChild(b); card.appendChild(row);
    });
    return;
  }
  if (track.kind !== 'track') {
    swapShow((card) => {
      card.appendChild(swapEl('div', 'swap-title', 'That\u2019s a Spotify ' + track.kind + ', not a track'));
      card.appendChild(swapEl('p', null, 'The queue swaps single tracks so the version can be matched exactly — paste a track link and it\u2019ll find the same audio on YouTube.'));
      const row = swapEl('div', 'row');
      const b = swapEl('button', null, 'OK'); b.addEventListener('click', swapHide);
      row.appendChild(b); card.appendChild(row);
    });
    return;
  }
  const query = ((track.artists[0] || '') + ' ' + track.title).trim();
  const cands = await swapSearchYT(query);
  if (seq !== swapSeq) return;
  const { winner, audit } = swapMatch(track, cands);
  swapState = { track, winner, audit, query };
  if (winner) {
    swapShow((card) => {
      card.appendChild(swapEl('div', 'swap-title', 'Spotify can\u2019t sync for everyone — found the same audio on YouTube'));
      card.appendChild(swapEl('p', null, '“' + winner.title + '” — ' + winner.channel));
      const row = swapEl('div', 'row');
      const go = swapEl('button', 'primary', 'Cue that instead');
      go.addEventListener('click', queueSwapWinner);
      const no = swapEl('button', 'ghost', 'Try a different link');
      no.addEventListener('click', swapHide);
      row.appendChild(go); row.appendChild(no); card.appendChild(row);
      swapAuditDetails(card, track, audit);
    });
  } else {
    swapShow((card) => {
      card.appendChild(swapEl('div', 'swap-title', 'No confident match for “' + track.title + '”'));
      card.appendChild(swapEl('p', null, myName + ', I won\u2019t guess the room\u2019s audio — if it\u2019s the wrong version, that\u2019s worse than asking. Search YouTube for this exact track and paste the real one:'));
      const row = swapEl('div', 'row');
      const a = swapEl('a', null, '🔎 Search YouTube for it');
      a.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
      a.target = '_blank'; a.rel = 'noopener';
      const no = swapEl('button', 'ghost', 'Try a different link');
      no.addEventListener('click', swapHide);
      row.appendChild(a); row.appendChild(no); card.appendChild(row);
      swapAuditDetails(card, track, audit);
    });
  }
}
async function queueSwapWinner() {
  const st = swapState;
  if (!st || !st.winner) return;
  swapSeq++;
  const ytUrl = 'https://www.youtube.com/watch?v=' + st.winner.videoId;
  const t = await addLink(ytUrl, st.winner.title, {
    swap: {
      from: 'spotify', origTitle: st.track.title, origArtists: st.track.artists,
      videoId: st.winner.videoId, audit: swapAuditText(st.track, st.audit),
    },
  });
  swapHide();
  if (t) {
    roomNote('🔁 ' + myName + '\u2019s Spotify pick swapped to YouTube so everyone hears it', true);
    S.swapVerifyPending = { itemId: t.id, track: st.track };
  }
}
/* Post-load verification: when a swapped track starts, re-read what
 * YouTube says loaded and re-judge it. Wrong audio skips itself. */
async function maybeVerifySwap(play) {
  const p = S.swapVerifyPending;
  if (!p || !play.swap || play.id !== p.itemId) return;
  S.swapVerifyPending = null;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(play.url), { signal: ctl.signal });
    clearTimeout(to);
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.title) return;
    const verdict = swapJudge(p.track, {
      videoId: play.videoId, title: String(j.title), channel: String(j.author_name || ''),
      durationSec: play.durationMs ? play.durationMs / 1000 : null,
    });
    // Only title/version mismatches fail the post-load check here — a
    // duration line can read "unknown" when the player hasn't reported
    // one yet, and that alone must not kill a correct swap.
    const badLines = verdict.lines.filter((l) => l.includes('MISMATCH'));
    const titleBad = badLines.some((l) => l.startsWith('title') || l.startsWith('version'));
    if (titleBad) {
      roomNote('⚠️ The swapped track didn\u2019t check out as “' + p.track.title + '” — skipping it', true);
      hint('That swap loaded as something else — skipped it; try another link');
      if (S.now && S.now.id === play.id) onTrackError('swap check failed');
    }
  } catch (e) {}
}

/* ---------------- rendering ---------------- */

function providerBadge(p) {
  return p === 'youtube' ? '▶ YT' : p === 'soundcloud' ? '☁ SC'
    : p === 'bandcamp' ? '▣ BC' : p === 'drive' ? '▲ Drive'
    : p === 'direct-audio' ? '♪ file' : '♪';
}
function renderConn() {
  if (!S.room) return;
  const people = S.roster.size + 1;
  if (S.sockets > 0) {
    connLabel.textContent = '● live · ' + S.sockets + '/3 relays · line held by ' + (S.iAmHolder ? 'you' : S.holderName);
    connLabel.classList.add('live');
  } else {
    connLabel.textContent = '○ connecting to relays…';
    connLabel.classList.remove('live');
  }
  peopleLabel.textContent = people === 1
    ? '👥 Just you so far — share the QR to bring people in'
    : '👥 ' + people + ' people in the room';
}
function renderPeople() {
  const names = [{ name: myName, me: true, cid: myCid }];
  for (const [cid, rec] of S.roster) names.push({ name: rec.name, me: false, cid });
  peopleList.innerHTML = names.map((p) =>
    `<span class="person${p.me ? ' me' : ''}${p.cid === S.holderCid ? ' holder' : ''}">${escapeHtml(p.name)}${p.me ? ' (you)' : ''}${p.cid === S.holderCid ? ' · line' : ''}</span>`).join('');
  renderConn();
}
function renderNow() {
  if (S.now) {
    nowTitle.textContent = S.now.title;
    nowSub.textContent = providerBadge(S.now.provider) + ' · cued by ' + S.now.addedBy +
      (S.now.group ? ' · from ' + (S.now.groupTitle || 'a playlist') : '');
    skipBtn.disabled = false;
  } else {
    nowTitle.textContent = 'Nothing yet — add the first track';
    nowSub.textContent = '';
    skipBtn.disabled = true;
    progressFill.style.width = '0%';
    timePos.textContent = '0:00'; timeDur.textContent = '';
  }
  nowAudit.innerHTML = '';
  if (S.now && S.now.swap && Array.isArray(S.now.swap.audit)) {
    const btn = document.createElement('button');
    btn.textContent = '🔁 from Spotify — why this version?';
    const det = document.createElement('div');
    det.className = 'audit-text';
    det.style.display = 'none';
    det.textContent = S.now.swap.audit.join('\n');
    btn.addEventListener('click', () => { det.style.display = det.style.display === 'none' ? '' : 'none'; });
    nowAudit.appendChild(btn); nowAudit.appendChild(det);
  }
  renderSkip();
}
function renderSkip() {
  const n = S.skipVotes.size;
  if (!S.now) { skipNote.textContent = 'Skip needs 2 votes'; skipBtn.classList.remove('mine'); return; }
  skipBtn.classList.toggle('mine', S.skipVotes.has(myCid));
  if (n === 0) skipNote.textContent = S.roster.size === 0 ? 'Skip needs 2 taps (you\u2019re solo)' : 'Skip needs 2 votes';
  else if (n === 1) {
    const who = [...S.skipVotes.values()][0];
    skipNote.textContent = S.roster.size === 0 ? 'Tap skip again to confirm' : who + ' voted — needs 1 more person';
  } else skipNote.textContent = 'Skipping…';
}
function renderQueue() {
  queueCount.textContent = S.queue.length ? '· ' + S.queue.length : '';
  if (!S.queue.length) {
    queueList.innerHTML = '<div class="empty">Queue is empty — drop a link below</div>';
    return;
  }
  queueList.innerHTML = '';
  S.queue.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'q-item';
    const main = document.createElement('div');
    main.className = 'q-main';
    const title = document.createElement('div');
    title.className = 'q-title'; title.textContent = t.title;
    const meta = document.createElement('div');
    meta.className = 'q-meta';
    meta.textContent = providerBadge(t.provider) + ' · ' + t.addedBy +
      (t.durationMs ? ' · ' + fmtTime(t.durationMs / 1000) : '') +
      (t.swap ? ' · 🔁 spotify swap' : '');
    main.appendChild(title); main.appendChild(meta);
    const num = document.createElement('div');
    num.className = 'q-num'; num.textContent = String(i + 1);
    row.appendChild(num); row.appendChild(main);
    if (t.addedById === myCid) {
      const rm = document.createElement('button');
      rm.className = 'q-remove'; rm.textContent = 'pull';
      rm.addEventListener('click', () => removeOwn(t.id));
      row.appendChild(rm);
    }
    queueList.appendChild(row);
  });
}
function renderAll() { renderNow(); renderQueue(); renderPeople(); }
function updateJoinMusic() {
  // Autoplay policies: until this device has had one tap, embedded
  // players may sit silent. Surface the tap exactly when music exists.
  joinMusicBtn.style.display = S.now && !S.unlocked ? '' : 'none';
}
joinMusicBtn.addEventListener('click', () => {
  S.unlocked = true;
  joinMusicBtn.style.display = 'none';
  player.playPauseResume();
});

/* ---------------- share / QR ---------------- */

function renderQr() {
  try {
    if (!window.qrcode) return;
    const canvas = document.createElement('canvas');
    const text = joinUrl(S.room);
    const qr = window.qrcode(0, 'L');
    qr.addData(text); qr.make();
    const n = qr.getModuleCount();
    const quiet = 2, px = 240;
    const scale = Math.max(1, Math.floor(px / (n + quiet * 2)));
    const size = (n + quiet * 2) * scale;
    canvas.width = size; canvas.height = size;
    canvas.style.width = px + 'px'; canvas.style.height = px + 'px';
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
    qrBox.innerHTML = '';
    qrBox.appendChild(canvas);
  } catch (e) { qrBox.textContent = shareLinkEl.textContent; }
}
$('share-btn').addEventListener('click', () => {
  const open = sharePanel.style.display !== 'none';
  sharePanel.style.display = open ? 'none' : '';
  if (!open) renderQr();
});
$('close-share-btn').addEventListener('click', () => { sharePanel.style.display = 'none'; });
$('copy-link-btn').addEventListener('click', async () => {
  const link = joinUrl(S.room);
  try { await navigator.clipboard.writeText(link); $('copy-link-btn').textContent = 'Copied ✓'; }
  catch (e) {
    if (navigator.share) { try { await navigator.share({ title: 'Cue Room ' + S.room, url: link }); } catch (err) {} }
  }
  setTimeout(() => { $('copy-link-btn').textContent = 'Copy link'; }, 2000);
});
$('leave-btn').addEventListener('click', leaveRoom);

/* ---------------- landing / add wiring ---------------- */

function ensureName() {
  const n = nameInput.value.trim().slice(0, 16);
  if (n) {
    myName = n;
    try { localStorage.setItem('cueroom-name', myName); } catch (e) {}
    return true;
  }
  landingHint.textContent = 'Pick a name first — it\u2019s how the room sees your cues.';
  nameInput.focus();
  return false;
}
$('create-btn').addEventListener('click', () => { if (ensureName()) startRoom(makeRoomCode()); });
$('join-btn').addEventListener('click', () => {
  if (!ensureName()) return;
  const code = cleanRoomCode(joinCodeInput.value);
  if (!code) { landingHint.textContent = 'That code doesn\u2019t look right — codes are 6 letters/numbers.'; return; }
  startRoom(code);
});
joinCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('create-btn').click(); });

$('add-btn').addEventListener('click', doAdd);
addUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
addUrlInput.addEventListener('paste', () => setTimeout(doAdd, 60)); // paste-and-go
let adding = false;
async function doAdd() {
  if (adding) return;
  const raw = addUrlInput.value;
  if (!extractUrl(raw) && !/^spotify:track:/i.test(raw.trim())) return;
  adding = true;
  try {
    const t = await addLink(raw);
    if (t) addUrlInput.value = '';
  } finally { adding = false; }
}

/* Deep link: ?room=CODE (or #room=CODE) joins straight in — this is
 * what the QR encodes. Name still required (one field, remembered). */
const urlRoom = roomFromUrl();
if (urlRoom) {
  joinCodeInput.value = urlRoom;
  landingHint.textContent = 'You\u2019re joining room ' + urlRoom + ' — add your name and tap Join.';
  if (myName) startRoom(urlRoom);
}

/* test seam (same spirit as limboverse's __limbo) */
window.__cue = {
  build: BUILD,
  state: () => ({
    room: S.room, queue: S.queue, now: S.now, holder: S.iAmHolder,
    holderCid: S.holderCid, roster: [...S.roster.keys()], skipVotes: [...S.skipVotes.keys()],
    sockets: S.sockets,
  }),
  detect: detectProvider,
  swapMatch, swapJudge,
  addLink: (u, hint) => addLink(u, hint),
  voteSkip,
  handleMessage,
  setName: (n) => { myName = n; nameInput.value = n; },
  startRoom,
  advance,
  cid: () => myCid,
  pos: () => player.pos(),
  inAd: () => player.inAd(),
  seekTo: (s) => player.seekTo(s),
  expected: () => (S.now ? offsetFor(S.now) : null),
};
