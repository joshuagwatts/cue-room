/* Cue Room player — build 2.
 * One player at a time, driven by the room clock: play(item, offsetSec).
 * Providers: youtube (IFrame API, visible stage), soundcloud (widget API,
 * visible stage), direct-audio / bandcamp / drive (one <video> element —
 * it plays audio files fine and gives video files a picture for free).
 *
 * Hooks: onEnded, onError(msg), onPlaying, onDuration(sec).
 * Load watchdog: if nothing is playing 15s after start, onError fires —
 * a dead track skips itself instead of wedging the room (limbo build 104).
 */
import { loadYTApi, loadSCApi, isShortSCLink, resolveShortSCLink, driveStreamUrl, driveFallbackUrls } from './providers.js?v=2';

const WATCHDOG_MS = 15000;

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
      const p = this.pos();
      const playing = this.kind === 'media' ? !this.els.media.paused : (p != null && p > 0.05);
      if (playing) return;
      if (retry) { try { retry(); } catch (e) {} this._armWatchdog(id, null); return; }
      this.hooks.onError('that track wouldn\u2019t start — skipping');
    }, WATCHDOG_MS);
  }

  async play(item, offsetSec) {
    this.stop();
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
              try { if (off > 1) ev.target.seekTo(off, true); } catch (e) {}
              try { ev.target.playVideo(); } catch (e) {}
              const d = (() => { try { return ev.target.getDuration(); } catch (e) { return 0; } })();
              if (d > 0) this.hooks.onDuration(d);
              this._armWatchdog(item.id, () => {
                try { ev.target.loadVideoById(item.videoId, Math.max(0, this.hooks.offsetFor ? this.hooks.offsetFor() : 0)); } catch (e) {}
              });
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
          seekTo: (s) => p.seekTo(s, true),
          pos: () => { try { return p.getCurrentTime(); } catch (e) { return null; } },
          dur: () => { try { return p.getDuration() || null; } catch (e) { return null; } },
          setVolume: (v) => { try { p.setVolume(v); } catch (e) {} },
          destroy: () => { try { p.destroy(); } catch (e) {} },
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
        let lastPos = null, lastDur = null, playAt = 0, peakMs = 0, posIv = null;
        w.bind(window.SC.Widget.Events.READY, () => {
          try { w.setVolume(Math.round(this.volume * 100)); } catch (e) {}
          const off = this.hooks.offsetFor ? this.hooks.offsetFor() : offset;
          try { if (off > 1) w.seekTo(Math.round(off * 1000)); } catch (e) {}
          try { w.play(); } catch (e) {}
          try { w.getDuration((ms) => { if (ms > 0) { lastDur = ms / 1000; this.hooks.onDuration(ms / 1000); } }); } catch (e) {}
          this._armWatchdog(item.id, () => { try { w.play(); } catch (e) {} });
        });
        w.bind(window.SC.Widget.Events.PLAY, () => {
          playAt = Date.now(); this.hooks.onPlaying();
          if (!posIv) posIv = setInterval(() => { try { w.getPosition((ms) => { if (ms > peakMs) peakMs = ms; }); } catch (e) {} }, 1000);
        });
        w.bind(window.SC.Widget.Events.PAUSE, () => {
          // PLAY then a quick PAUSE with the needle never moving = the
          // audio stream died upstream (limbo build 58). Say so, move on.
          if (playAt && Date.now() - playAt < 12000 && peakMs < 2000 && this.currentId === item.id) {
            playAt = 0;
            this.hooks.onError('that track\u2019s audio wouldn\u2019t load on soundcloud');
          }
        });
        w.bind(window.SC.Widget.Events.FINISH, () => this.hooks.onEnded());
        w.bind(window.SC.Widget.Events.ERROR, () => this.hooks.onError('soundcloud refused that track'));
        this.impl = {
          play: () => w.play(), pause: () => w.pause(),
          seekTo: (s) => w.seekTo(Math.round(s * 1000)),
          pos: () => { try { w.getPosition((ms) => { lastPos = ms / 1000; }); } catch (e) {} return lastPos; },
          dur: () => { try { w.getDuration((ms) => { lastDur = ms / 1000; }); } catch (e) {} return lastDur; },
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
