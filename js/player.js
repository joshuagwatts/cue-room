/* Cue Room player — build 6.
 * One player at a time, driven by the room clock: play(item, offsetSec).
 * Providers: youtube (IFrame API, visible stage), soundcloud (widget API,
 * visible stage), direct-audio / bandcamp / drive (one <video> element —
 * it plays audio files fine and gives video files a picture for free).
 *
 * Hooks: onEnded, onError(msg), onPlaying, onDuration(sec), onAdChange(inAd).
 * Load watchdog: if nothing is playing 15s after start, onError fires —
 * a dead track skips itself instead of wedging the room (limbo build 104).
 */
import { loadYTApi, loadSCApi, isShortSCLink, resolveShortSCLink, driveStreamUrl, driveFallbackUrls } from './providers.js?v=6';

const WATCHDOG_MS = 15000;

/* ---------------- AdWatch (build 6) ----------------
 * YouTube and SoundCloud embeds are sealed: no ad events, no ad
 * skipping, no way to see the ad directly. But an ad REPLACES the
 * timeline — the duration flips to the ad's length and the needle
 * restarts at zero — and that's visible from outside. Build 3 watched
 * only the duration flip and adopted the "content duration" at player
 * ready, which a pre-roll ad poisons instantly (the first duration it
 * ever sees IS the ad's). Real-world result: detection inverted or
 * never fired, and ads dragged sync around.
 *
 * AdWatch fuses the signals instead:
 *  - a duration is only ADOPTED as the content's when the needle is
 *    sitting on the room timeline (within 3.5s of expected) — an ad
 *    playing to a mid-track joiner never gets adopted;
 *  - ENTER ad: the duration flips >1.5s away from the adopted one, OR
 *    the needle resets backwards >2s with no seek of ours nearby;
 *  - EXIT ad: the duration comes back, OR the needle catches up to
 *    where the content left off (re-adopting the duration if the
 *    "content" we adopted was itself the pre-roll — the fresh-track
 *    ambiguity resolves itself there), OR a 150s failsafe.
 * While inAd, the player reports NO position and the ADOPTED duration
 * only: the room never chases an ad, never records an ad's length as
 * the track's, and watchdogs wait the ad out. On exit the app fires
 * one clean seek back to the room position. */
export class AdWatch {
  constructor(onChange, onDur) {
    this.onChange = onChange || null;
    this.onDur = onDur || null;
    this.contentDur = 0;
    this.inAd = false;
    this.adSince = 0;
    this.lastPos = null;
    this.lastSeekAt = 0;
    this.durReported = 0;
  }
  noteSeek() { this.lastSeekAt = Date.now(); }
  _set(v, viaDur) {
    if (v === this.inAd) return;
    this.inAd = v;
    if (v) this.adViaDur = !!viaDur;
    this.adSince = v ? Date.now() : 0;
    if (this.onChange) { try { this.onChange(v); } catch (e) {} }
  }
  _adopt(dur) {
    if (dur > 0 && Math.abs(dur - this.contentDur) > 0.5) {
      this.contentDur = dur;
      if (this.onDur && this.durReported !== dur) {
        this.durReported = dur;
        try { this.onDur(dur); } catch (e) {}
      }
    }
  }
  sample(dur, pos, playing, expected) {
    if (!playing || pos == null || !(pos >= 0)) return this.inAd;
    const now = Date.now();
    if (this.inAd && now - this.adSince > 150000) {
      this._set(false);
      this.lastPos = pos;
      if (dur > 0) this._adopt(dur);
      return this.inAd;
    }
    const nearExpected = expected != null && Math.abs(pos - expected) <= 3.5;
    if (!this.inAd) {
      if (dur > 0 && (!this.contentDur || nearExpected)) this._adopt(dur);
      if (this.contentDur && dur > 0 && Math.abs(dur - this.contentDur) > 1.5) { this._set(true, true); return this.inAd; }
      if (this.lastPos != null && pos < this.lastPos - 2 && now - this.lastSeekAt > 3000) { this._set(true, false); return this.inAd; }
      this.lastPos = pos;
    } else {
      // "Duration came back" only ends an ad that a duration flip
      // STARTED — if the embed reports the content duration straight
      // through the ad (reset-only breaks), that signal is noise and
      // the needle catching up is the only honest exit.
      if (this.adViaDur && this.contentDur && dur > 0 && Math.abs(dur - this.contentDur) <= 1.5) {
        this._set(false); this.lastPos = pos; return this.inAd;
      }
      if (this.lastPos != null && pos >= this.lastPos - 2) {
        if (dur > 0 && (!this.contentDur || Math.abs(dur - this.contentDur) > 1.5)) this._adopt(dur);
        this._set(false); this.lastPos = pos; return this.inAd;
      }
    }
    return this.inAd;
  }
}

export class Player {
  constructor(els, hooks) {
    this.els = els; // { yt, sc, media, idle }
    this.hooks = hooks;
    this.kind = null;
    this.impl = null; // { play, pause, seekTo, pos, dur, setVolume, destroy }
    this.volume = 0.8;
    this.unlocked = false;
    this.watchdog = null;
    this.currentId = null;
  }

  setVolume(v01) {
    this.volume = v01;
    if (this.impl) { try { this.impl.setVolume(Math.round(v01 * 100)); } catch (e) {} }
    if (this.kind === 'media') { try { this.els.media.volume = v01; } catch (e) {} }
  }
  pos() { try { return this.impl ? this.impl.pos() : null; } catch (e) { return null; } }
  inAd() { try { return !!(this.impl && this.impl.inAd && this.impl.inAd()); } catch (e) { return false; } }
  /* How much of the media element's file is actually buffered. A seek
   * past the buffered end restarts the download from scratch on hosts
   * without snappy range serving — the opposite of a clean resync —
   * so the app checks this before seeking a media track. Null for
   * iframe players (their own buffering is their business). */
  bufferedEnd() {
    if (this.kind !== 'media') return null;
    try {
      const b = this.els.media.buffered;
      return b && b.length ? b.end(b.length - 1) : 0;
    } catch (e) { return null; }
  }
  dur() { try { return this.impl ? this.impl.dur() : null; } catch (e) { return null; } }
  seekTo(s) { if (this.impl) { try { this.impl.seekTo(s); } catch (e) {} } }
  playPauseResume() { if (this.impl) { try { this.impl.play(); } catch (e) {} } }

  stop() {
    this._clearWatchdog();
    if (this.impl) { try { this.impl.destroy(); } catch (e) {} this.impl = null; }
    this.kind = null; this.currentId = null;
    this.els.yt.classList.remove('on'); this.els.yt.innerHTML = '';
    this.els.sc.classList.remove('on'); this.els.sc.innerHTML = '';
    try { this.els.media.pause(); this.els.media.removeAttribute('src'); this.els.media.load(); } catch (e) {}
    this.els.media.style.display = 'none';
    this.els.idle.style.display = '';
  }

  _clearWatchdog() { if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; } }
  _armWatchdog(id, retry) {
    this._clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (this.currentId !== id) return;
      // An ad is not a stall: pos() is null by design while one plays,
      // and killing the track at 15s is how ads used to skip songs.
      // Wait the ad out and check again after.
      if (this.inAd()) { this._armWatchdog(id, retry); return; }
      const p = this.pos();
      const playing = this.kind === 'media' ? !this.els.media.paused : (p != null && p > 0.05);
      if (playing) return;
      // Still actively loading (bytes flowing, not enough buffered)?
      // Give it one more window instead of skipping a slow-but-alive
      // track — sync machinery must never punish a load in progress.
      if (this.kind === 'media' && !this._wdExtended &&
          this.els.media.networkState === 2 && this.els.media.readyState < 3) {
        this._wdExtended = true;
        this._armWatchdog(id, null);
        return;
      }
      if (retry) { try { retry(); } catch (e) {} this._armWatchdog(id, null); return; }
      this.hooks.onError('that track wouldn\u2019t start — skipping');
    }, WATCHDOG_MS);
  }

  async play(item, offsetSec) {
    this.stop();
    this._wdExtended = false;
    this.currentId = item.id;
    this.els.idle.style.display = 'none';
    if (item.provider === 'youtube') this._playYT(item, offsetSec);
    else if (item.provider === 'soundcloud') this._playSC(item, offsetSec);
    else if (item.provider === 'bandcamp' || item.provider === 'drive' || item.provider === 'direct-audio') {
      this._playMedia(item, offsetSec);
    } else {
      this.hooks.onError('that link type can\u2019t play in sync — skipping');
    }
  }

  /* ---------- youtube ---------- */
  _playYT(item, offset) {
    this.kind = 'youtube';
    this.els.yt.classList.add('on');
    const slot = document.createElement('div');
    this.els.yt.appendChild(slot);
    const watch = new AdWatch(
      (v) => { if (this.hooks.onAdChange) this.hooks.onAdChange(v); },
      (d) => this.hooks.onDuration(d)
    );
    let sampler = null;
    loadYTApi((ok) => {
      if (this.currentId !== item.id) { try { slot.remove(); } catch (e) {} return; }
      if (!ok || !window.YT) { this.hooks.onError('youtube isn\u2019t loading — check your connection'); return; }
      try {
        const p = new window.YT.Player(slot, {
          width: '100%', height: '100%',
          videoId: item.videoId,
          playerVars: { autoplay: 0, controls: 1, disablekb: 0, rel: 0, playsinline: 1 },
          events: {
            onReady: (ev) => {
              try { ev.target.setVolume(Math.round(this.volume * 100)); } catch (e) {}
              const off = this.hooks.offsetFor ? this.hooks.offsetFor() : offset;
              watch.noteSeek();
              try { if (off > 1) ev.target.seekTo(off, true); } catch (e) {}
              try { ev.target.playVideo(); } catch (e) {}
              // NOTE: no duration is reported here anymore — at ready
              // time a pre-roll ad may be what's loaded, and its length
              // is not the track's. AdWatch adopts (and reports) the
              // real duration only once the needle sits on the room
              // timeline.
              // Watchdog retry is a play() nudge ONLY — never a reload.
              this._armWatchdog(item.id, () => {
                try { ev.target.playVideo(); } catch (e) {}
              });
              sampler = setInterval(() => {
                if (this.currentId !== item.id) { clearInterval(sampler); return; }
                let st = -1, pos = null, dur = 0;
                try { st = ev.target.getPlayerState(); } catch (e) {}
                try { pos = ev.target.getCurrentTime(); } catch (e) {}
                try { dur = ev.target.getDuration() || 0; } catch (e) {}
                const expected = this.hooks.offsetFor ? this.hooks.offsetFor() : null;
                watch.sample(dur, pos, st === window.YT.PlayerState.PLAYING, expected);
              }, 1000);
            },
            onStateChange: (ev) => {
              if (ev.data === window.YT.PlayerState.PLAYING) this.hooks.onPlaying();
              if (ev.data === window.YT.PlayerState.ENDED) this.hooks.onEnded();
            },
            onError: () => this.hooks.onError('youtube refused that video — private, deleted or blocked?'),
          },
        });
        this.impl = {
          play: () => p.playVideo(), pause: () => p.pauseVideo(),
          seekTo: (s) => { watch.noteSeek(); p.seekTo(s, true); },
          // During an ad the iframe's clock is the AD's clock — report
          // nothing, so drift logic leaves this player completely alone.
          pos: () => { if (watch.inAd) return null; try { return p.getCurrentTime(); } catch (e) { return null; } },
          dur: () => { if (watch.contentDur > 0) return watch.contentDur; try { return p.getDuration() || null; } catch (e) { return null; } },
          inAd: () => watch.inAd,
          setVolume: (v) => { try { p.setVolume(v); } catch (e) {} },
          destroy: () => { if (sampler) clearInterval(sampler); try { p.destroy(); } catch (e) {} },
        };
      } catch (e) { this.hooks.onError('youtube player failed to start'); }
    });
  }

  /* ---------- soundcloud ---------- */
  async _playSC(item, offset) {
    this.kind = 'soundcloud';
    if (isShortSCLink(item.url)) {
      const r = await resolveShortSCLink(item.url).catch(() => null);
      if (this.currentId !== item.id) return;
      if (r && r.url) { item = { ...item, url: r.url }; if (r.title) this.hooks.onTitle && this.hooks.onTitle(r.title); }
      else { this.hooks.onError('that soundcloud link won\u2019t open — paste the full soundcloud.com link'); return; }
    }
    this.els.sc.classList.add('on');
    const iframe = document.createElement('iframe');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allow', 'autoplay; encrypted-media');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(item.url) +
      '&auto_play=false&hide_related=true&show_comments=false&show_user=true&visual=false';
    this.els.sc.appendChild(iframe);
    loadSCApi((ok) => {
      if (this.currentId !== item.id) { try { iframe.remove(); } catch (e) {} return; }
      if (!ok) { this.hooks.onError('soundcloud isn\u2019t loading — check your connection'); return; }
      try {
        const w = window.SC.Widget(iframe);
        let lastPos = null, lastDur = null, playAt = 0, peakMs = 0, posIv = null, scPlaying = false;
        const watch = new AdWatch(
          (v) => { if (this.hooks.onAdChange) this.hooks.onAdChange(v); },
          (d) => this.hooks.onDuration(d)
        );
        w.bind(window.SC.Widget.Events.READY, () => {
          try { w.setVolume(Math.round(this.volume * 100)); } catch (e) {}
          const off = this.hooks.offsetFor ? this.hooks.offsetFor() : offset;
          watch.noteSeek();
          try { if (off > 1) w.seekTo(Math.round(off * 1000)); } catch (e) {}
          try { w.play(); } catch (e) {}
          // Duration is NOT reported straight from the widget anymore
          // (build 6): if SoundCloud inserts an ad, its length is not
          // the track's. AdWatch adopts + reports via the sampler.
          this._armWatchdog(item.id, () => { try { w.play(); } catch (e) {} });
        });
        w.bind(window.SC.Widget.Events.PLAY, () => {
          playAt = Date.now(); scPlaying = true; this.hooks.onPlaying();
          if (!posIv) posIv = setInterval(() => {
            try { w.getPosition((ms) => { if (ms > peakMs) peakMs = ms; lastPos = ms / 1000; }); } catch (e) {}
            try { w.getDuration((ms) => { if (ms > 0) lastDur = ms / 1000; }); } catch (e) {}
            const expected = this.hooks.offsetFor ? this.hooks.offsetFor() : null;
            watch.sample(lastDur || 0, lastPos, scPlaying, expected);
          }, 1000);
        });
        w.bind(window.SC.Widget.Events.PAUSE, () => {
          scPlaying = false;
          // PLAY then a quick PAUSE with the needle never moving = the
          // audio stream died upstream (limbo build 68). Say so, move on.
          // Build 5: not while an ad is on — an ad boundary can pause.
          if (!watch.inAd && playAt && Date.now() - playAt < 12000 && peakMs < 2000 && this.currentId === item.id) {
            playAt = 0;
            this.hooks.onError('that track\u2019s audio wouldn\u2019t load on soundcloud');
          }
        });
        w.bind(window.SC.Widget.Events.FINISH, () => this.hooks.onEnded());
        w.bind(window.SC.Widget.Events.ERROR, () => this.hooks.onError('soundcloud refused that track'));
        this.impl = {
          play: () => w.play(), pause: () => w.pause(),
          seekTo: (s) => { watch.noteSeek(); w.seekTo(Math.round(s * 1000)); },
          pos: () => { if (watch.inAd) return null; try { w.getPosition((ms) => { lastPos = ms / 1000; }); } catch (e) {} return lastPos; },
          dur: () => { if (watch.contentDur > 0) return watch.contentDur; try { w.getDuration((ms) => { lastDur = ms / 1000; }); } catch (e) {} return lastDur; },
          inAd: () => watch.inAd,
          setVolume: (v) => { try { w.setVolume(v); } catch (e) {} },
          destroy: () => { try { if (posIv) clearInterval(posIv); } catch (e) {} try { iframe.remove(); } catch (e) {} },
        };
      } catch (e) { this.hooks.onError('soundcloud player failed to start'); }
    });
  }

  /* ---------- direct media (direct / bandcamp stream / drive) ---------- */
  _playMedia(item, offset) {
    this.kind = 'media';
    const el = this.els.media;
    el.style.display = '';
    el.controls = true;
    el.volume = this.volume;
    // Drive gets a candidate chain: worker proxy (ORB-safe) first, then
    // Drive's own hosts. An error only skips the track after EVERY
    // candidate has failed — one bad host must not kill a public file.
    const candidates = item.provider === 'bandcamp' ? [item.streamUrl]
      : item.provider === 'drive' ? [driveStreamUrl(item.driveId), ...driveFallbackUrls(item.driveId)]
      : [item.url];
    let attempt = 0;
    const mySeq = (this._mediaSeq = (this._mediaSeq || 0) + 1);
    const tryNext = () => {
      if (this.currentId !== item.id || this._mediaSeq !== mySeq) return;
      el.src = candidates[attempt];
      try { el.load(); } catch (e) {}
    };
    const onMeta = () => {
      if (this.currentId !== item.id) return;
      if (el.duration > 0) this.hooks.onDuration(el.duration);
      const off = this.hooks.offsetFor ? this.hooks.offsetFor() : offset;
      try { if (off > 1 && el.duration && off < el.duration) el.currentTime = off; } catch (e) {}
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => { /* autoplay wait: the join-music button resumes */ });
      this._armWatchdog(item.id, null);
    };
    el.onloadedmetadata = onMeta;
    el.onplaying = () => this.hooks.onPlaying();
    el.onended = () => { if (this.currentId === item.id) this.hooks.onEnded(); };
    el.onerror = () => {
      if (this.currentId !== item.id || this._mediaSeq !== mySeq) return;
      attempt++;
      if (attempt < candidates.length) { tryNext(); return; }
      this.hooks.onError(item.provider === 'drive'
        ? 'drive wouldn\u2019t serve that file to the room — check it\u2019s shared with \u201canyone with the link\u201d, or try another link'
        : 'that file wouldn\u2019t play — skipping');
    };
    this.impl = {
      play: () => el.play(), pause: () => el.pause(),
      seekTo: (s) => { try { el.currentTime = s; } catch (e) {} },
      pos: () => { try { return el.currentTime; } catch (e) { return null; } },
      dur: () => { try { return el.duration || null; } catch (e) { return null; } },
      setVolume: (v) => { try { el.volume = v / 100; } catch (e) {} },
      destroy: () => { el.onloadedmetadata = null; el.onplaying = null; el.onended = null; el.onerror = null; },
    };
    tryNext();
  }
}
