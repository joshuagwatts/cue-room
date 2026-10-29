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

## Build 4 — steady timeline audit (2026-10-25, Joshua: "double check anything that might jump the timeline or sync for anyone tapped in even the host")

Full audit of every code path that can move someone's playback.
Six jump sources found and fixed:

1. ONE peer's "bad" report made the HOLDER skip the track for the
   whole room. Now: holder advances on peer reports only with
   corroboration (2+ distinct reporters) or when the holder's own
   player also isn't progressing — the holder's playback is ground
   truth for "this track is broken".
2. A non-holder's own player error fell back (6s) to advancing the
   ROOM. Now: report + self-heal (re-request state, restart own
   player at the room position). One broken phone can't skip the
   song for everyone. The no-holder anti-wedge fallback stays.
3. A peer's "ended" advanced the holder INSTANTLY — a guest whose
   player ended early (shorter cut, ad-truncated stream) cut the
   track for all. Now honored only inside the end window (elapsed
   within 15s of known duration, or 30s+ when duration unknown).
4. The end watchdog trusted durationMs blindly; a wrong duration
   (e.g. an ad's length recorded at ready) could false-fire a skip.
   Now: if the player is playing PAST the stated duration, the
   duration is discarded as the liar it is.
5. NO clock-skew correction existed: a phone with a fast/slow clock
   computed a permanently wrong position and chased resyncs forever.
   Every message now carries sender `at`; skew (max of recent
   samples vs the track's origin) corrects offsetFor centrally.
6. Handoff merge scored a stale now-playing equal to a fresh one —
   a lagging peer could resurrect the previous track on holder
   change. Freshness (startedAt) now dominates the score.

PROOF (cue-steady.mjs): A) 1 bad report → no skip; B) 2nd distinct
report → skip lands; C) early "ended" at 0.8s into a 45s track →
ignored; D) track injected from a +3000ms clock → skew estimated
2998ms, expected position reads the true 10.08s (not 7s), playback
tracks at 0.04s. Full suite, sync suite, drive test: all pass.
(Test note: the main suite's solo-skip step now waits out the fake
voter's 25s roster TTL — it previously passed on timing luck.)

## Build 5 — ads, taken seriously (2026-10-27, Joshua: "the youtube ad thing be fucking with the whole synchronized situation" + "soundcloud prolly will too")

He was right — build 3's detector failed in the real world. Autopsy:
it adopted the "content duration" from the player's ready event,
which during a pre-roll ad IS the ad's length (detection inverted or
never fired), it had no answer for embeds that keep reporting the
content duration straight through an ad, the load watchdog could
kill a track 15s into a 30s ad (position reads null in an ad), an
ad-poisoned duration could cut the track via the end watchdog, and
SoundCloud had no detection at all.

Build 5 replaces it with AdWatch (js/player.js), shared by the
YouTube and SoundCloud players:
- Durations are ADOPTED as the content's only when the needle sits
  on the room timeline (within 3.5s of expected) — a pre-roll shown
  to a mid-track joiner is never adopted; adoption is what reports
  the duration to the room, so ad lengths never poison durationMs.
- Enter ad on EITHER signal: duration flips >1.5s from adopted, or
  the needle resets >2s with no seek of ours nearby. Exit on the
  matching signal (duration-restore only counts for flip-entered
  ads — unit test 4 caught that cross-talk), needle catch-up
  (re-adopting duration — resolves the fresh-track pre-roll
  ambiguity), or a 150s failsafe.
- While in an ad: position reports null (room never chases it), the
  load watchdog re-arms instead of erroring (ads can't skip songs),
  the end watchdog stands down, SoundCloud's dead-stream pause
  detector stands down (ad boundaries can pause), and on exit the
  app fires its one clean seek (unchanged build-3 path).
PROOF: cue-adwatch.mjs — 7 synthetic sample streams (clean,
joiner pre-roll, mid-roll flip, reset-only break, own-seek,
buffering, fresh-track pre-roll): ALL PASS, including exactly one
ad-start/ad-end pair for the mid-roll. Full/sync/steady/drive
suites pass. Still unprovable in the sandbox: a REAL ad break —
headless test players don't draw ads. The detector's inputs are the
same numbers a real ad produces; his next hangout is the live proof.
Honest limit, unchanged: an ad victim's content pauses while the
room plays on — inside the official embeds nothing can reclaim
those seconds; what changed is the ad can no longer drag, skip, or
desync anyone, and the victim snaps back clean when it ends.

## Build 6 — iPhone pass (2026-10-29, Joshua: "make sure cue room works on the iphone too")

Full static iOS audit, then fixes:
- THE bug: the join-music tap marked the device unlocked and hid
  the button BEFORE knowing any sound existed. Player readiness is
  async (YT/SC API callbacks; short SC links resolve first), so a
  quick iPhone tap could be consumed by a not-yet-existent player —
  silent phone, recovery button gone forever. Now the tap only asks;
  onPlaying confirms, sets unlocked, and retires the button. If no
  confirmation in 3s the button relabels itself: "Still quiet? Tap
  the video itself ▶ then tap here again" (Safari sometimes only
  accepts activation on the player itself).
- apple-touch-icon (180px, generated from the 512) +
  apple-mobile-web-app-capable/status-bar meta — Add to Home Screen
  now gets a real icon and standalone chrome.
- Startup localStorage reads routed through safeGet() — Safari with
  blocked storage throws on getItem; an exception at module top
  would have killed the app before the landing painted.
- Volume slider on iOS replaced with "use the phone's buttons" —
  iOS ignores programmatic media volume; a slider that lies is
  worse than none.
- Share button double-failure no longer silent: "Long-press the
  link above to copy it."
Audit-cleared as already fine: playsinline everywhere, no 100vh
trap (document flow + safe-area-padded fixed add bar), QR joining
needs no in-app camera (system Camera scan), WebSocket/JS feature
floor is Safari-15-safe.
PROOF GAP, stated plainly: the sandbox's local Chromium broke on
2026-10-29 (new build demands a daemon-supplied WebGL policy —
"Normal startup requires the image-owned WebGL policy"), so the
automated suites (incl. the new iPhone-emulated cue-ios.mjs) could
not run for this build. Verification = static audit + syntax +
served-bytes + live boot check. The decisive test is a real iPhone.

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
