# Cue Room — build notes (started 2026-10-25)

Joshua's ask: the limboverse queue/jukebox as its OWN standalone app,
super fleshed out and stable. Share while hanging out: QR scan →
instant join, anyone can add a link, everyone finishes tracks
together as a team, and a skip needs TWO votes to confirm.

## Design decisions

- **Transport = relay only.** Limboverse's jukebox got stable when its
  traffic moved onto the Nostr relay broadcast (RelayLink, build
  37–44); Trystero/WebRTC was the flaky layer (ICE stalls, staggered
  sockets, UDP blocked on some networks). Cue Room ships relay-only:
  kind-20001 ephemeral events, 3 pinned relays (yabu.me, lnfi,
  sigit), message-id dedupe across relays, outbox for zero-socket
  windows. No WebRTC at all.
- **Holder election** (limbo build 43 pattern): hellos every 8s,
  roster TTL 25s, lowest clientId holds the line. Holder broadcasts
  sync (rev-guarded) every 10s + on mutation, answers state requests,
  and on election does a 2.5s handoff collection before ruling.
  Non-holders keep unconfirmed adds across syncs (build 44 ack/retry:
  resend after 20s, 8 tries, then an honest hint).
- **Room clock**: play = track + startedAt; offset = now − startedAt;
  drift check every 20s, seek if >2.5s off; rAF progress from the
  player's real position when available.
- **Skip = 2 distinct voters** per track (votes reset on track
  change). Holder confirms; a 1.2s fallback lets the voters confirm
  if the holder stalls. Solo room: a second tap from the same person
  confirms (otherwise a solo room could never skip).
- **Never wedge**: player load watchdog 15s, SoundCloud dead-stream
  detection (build 58 pattern), error → holder advances after 2.5s,
  reporter advances after 6s if no holder answers, end-of-track
  watchdog from known durations, anyone's `ended` notice routes to
  the holder.
- **Providers**: ported from holoverse build 3 — detect, titles via
  noembed/oEmbed, SC short links + sets, YT playlists, Bandcamp and
  Spotify via the existing keyless `holoverse-resolve` Cloudflare
  worker, Drive stream URLs, direct media, content-type sniff for
  extensionless audio. Spotify swap matcher is the A3F version
  (version fidelity, audit trail, post-load re-verification).
- **Persistence**: queue + now-playing per room code in localStorage
  (limbo build 60 pattern) — a refresh rejoins mid-track.
- **Cache**: no-cache document meta + `?v=` asset pins, visible
  build stamp on the landing page.

## Files

- `index.html` — landing (name, create, join-by-code) + room UI
- `js/app.js` — room state, election, queue, skip voting, swap card
- `js/relay.js` — the nostr broadcast transport
- `js/providers.js` — detection, resolvers, swap matcher
- `js/player.js` — YT / SC / direct-media players + watchdogs
- `js/vendor/qrcode.js` — vendored QR generator (from limboverse)

## Build 2 — Drive ORB fix (2026-10-25, Joshua's report: "says a drive file isn't public and skips it when it is public")

- ROOT CAUSE (reproduced, not guessed): Drive's download host sends
  `Cross-Origin-Resource-Policy: same-site`; Chromium kills a
  cross-origin media-element load from it with
  `ERR_BLOCKED_BY_ORB` — public files included. Verified with a real
  public FLAC: curl gets `200 audio/flac` + ranges, the app's
  `<video>` element gets ORB-blocked and errors instantly. The build-1
  error text ("isn't public") was wrong about the cause.
- FIX: playback goes through the resolver worker's new `/drive?id=`
  proxy — it fetches the bytes server-side (handling Google's
  virus-scan interstitial form for large files), forwards Range, and
  re-serves with CORS * and no CORP header. Player falls back to
  Drive's own two URL forms if the proxy ever fails, and only skips
  after every candidate fails. Error copy no longer asserts the file
  "isn't public".
- PROOF: `cue-drive.mjs` against the real public file — build 1:
  ORB-blocked + skipped; build 2: 206 ranges via the worker, playing,
  duration known, clock advancing. Full `cue-room.mjs` still ALL PASS.

## Build 3 — clean sync + ad-proofing (2026-10-25, Joshua's spec)

His words: sync must not hinder loading or playback; milliseconds off
is fine, more than ~1s behind stops feeling together; a refresh-style
clean resync is the model. Rules now in the code:

- DRIFT_TOLERANCE = 1.0s. Inside it: hands off entirely — no seeks, no
  playback-rate tricks, nothing. Past it: ONE clean seek to the room
  position, at most once per 15s (SEEK_COOLDOWN), checked every 4s.
- Never seek a frozen needle: if the position hasn't moved between
  checks the player is still LOADING — a seek there just restarts its
  buffering. The resync waits until it's actually playing.
- Never seek past the buffered end of a media element (player.
  bufferedEnd guard): landing in unbuffered territory restarts the
  download; the seek fires on a later check once the target is in
  range. (Found by the sync prove-out: a range-less test server made
  naive seeks thrash a track back to 0 repeatedly.)
- Slow loads are never punished: the YouTube watchdog retry is now a
  play() nudge, not loadVideoById (which restarted buffering from
  zero); the media watchdog grants one extension while bytes are
  actively flowing.
- YouTube ads: no adblocker can live inside YouTube's sealed iframe,
  so instead ads are made sync-proof. During an ad, getDuration()
  flips to the ad's length (the embed's only tell) — while flipped,
  the player reports no position, drift logic leaves it completely
  alone, the room clock keeps running for everyone else, and when the
  ad ends ONE clean seek snaps that listener back onto the room.
  Caveat: the duration-flip heuristic is code-verified, not ad-verified
  (sandbox players don't draw real ads); it proves itself in real use.

PROOF (cue-sync.mjs, local range-served 60s file, two contexts):
joiner lands mid-track at 0.05s drift; pages 0.35s apart; forced +5s
drift → one resync → 0.04s, playback advance a clean 3.00s per 3s
before and after. Full suite + drive test still pass.

## Known limits

- Two-phone live proof is Joshua's phones, as with limboverse: this
  VM's browser needs its proxy for relay sockets, and real-world
  relay reachability varies — the connection label shows live relay
  count so a dead room is visible, not silent.
- Bandcamp resolve rides public fetch paths that rate-limit shared
  IPs (same caveat as holoverse).
- Phone-file playback (the limboverse P2P file transfer) is NOT in
  v1: it was the one feature that needed WebRTC data channels.
  Link-based sources only.
