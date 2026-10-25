# Cue Room

**Listen together.** One shared queue for the whole hangout — the
limboverse jukebox, out of the game and into its own app.

Open it, create a room, and your friends scan the QR code to join
instantly. No app to install, no account. Anyone in the room can add a
link, and everyone hears the same track at the same time.

Live: https://joshuagwatts.github.io/cue-room/

## How it works

- **QR join** — the room code rides both `?room=` and `#room=` in the
  link, so it survives messaging apps and in-app browsers.
- **Anyone can cue** — YouTube (tracks + playlists), SoundCloud
  (tracks, sets, mobile short links), Bandcamp (resolved to its own
  streams), Google Drive files, and direct audio/video links.
- **Spotify swaps, never queues** — Spotify can't play in sync for
  everyone, so a Spotify link is identified and matched to the *same
  audio* on YouTube: a cover swaps to that cover, a sped-up edit to
  that sped-up edit. The match carries a visible audit trail
  ("why this version?") and is re-verified after it loads.
- **Skip takes 2 votes** — two different people have to vote before a
  track is skipped. Solo in a room, a second tap confirms.
- **Synced playback** — a room clock (`startedAt` + offset) with
  drift correction; late joiners land mid-track.
- **A holder keeps the line** — the room elects a line-holder who
  keeps the canonical queue, hands it off when they leave, and
  advances past broken links so the room never wedges.
- **Transport** — Nostr relay broadcast (ephemeral events, 3 pinned
  relays), the same transport that made the limboverse jukebox
  stable. No WebRTC, no accounts, no server of ours: the room code
  is the key.
