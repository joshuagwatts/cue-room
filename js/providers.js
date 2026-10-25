/* Cue Room providers — build 2.
 * Link detection, title lookup, set/playlist expansion and the Spotify
 * swap matcher, ported from the limboverse/holoverse jukebox (the code
 * Joshua's rooms have run on since build 21, universal queue build 3).
 *
 * Queue rule (his call, 2026-10-24): a source only queues if EVERYONE
 * can hear the full thing in sync. Spotify fails that, so Spotify links
 * never queue — they swap to the SAME audio on YouTube (version fidelity:
 * a cover swaps to that cover, a sped-up edit to that sped-up edit). */

export const RESOLVE_API = 'https://holoverse-resolve.joshuagwatts.workers.dev';
export const PROVIDERS = ['youtube', 'youtube-playlist', 'soundcloud', 'soundcloud-set',
  'soundcloud-short', 'direct-audio', 'bandcamp', 'drive', 'external'];
export const MAX_QUEUE = 50;

export function isShortSCLink(url) {
  try {
    const h = new URL(String(url || '')).hostname.toLowerCase();
    return h === 'on.soundcloud.com' || h === 'snd.sc' || h === 'soundcloud.app.goo.gl';
  } catch (e) { return false; }
}

export function detectProvider(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { return { provider: 'invalid' }; }
  if (!/^https?:$/.test(u.protocol)) return { provider: 'invalid' };
  const host = u.hostname.replace(/^(www\.|m\.|mobile\.)/, '').toLowerCase();
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' ||
      host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    let vid = null;
    if (host === 'youtu.be') vid = u.pathname.slice(1).split(/[?/#]/)[0];
    else if (u.pathname === '/watch') vid = u.searchParams.get('v');
    else if (u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/')[2];
    else if (u.pathname.startsWith('/embed/')) vid = u.pathname.split('/')[2];
    else if (u.pathname.startsWith('/live/')) vid = u.pathname.split('/')[2];
    vid = (vid || '').split(/[?/#]/)[0];
    if (!(vid && /^[A-Za-z0-9_-]{6,20}$/.test(vid))) vid = null;
    if (list && /^[A-Za-z0-9_-]{8,48}$/.test(list)) {
      return { provider: 'youtube-playlist', videoId: vid, playlistId: list };
    }
    if (vid) return { provider: 'youtube', videoId: vid };
    return { provider: 'external' };
  }
  if (isShortSCLink(u.href)) return { provider: 'soundcloud-short' };
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) {
    const parts = u.pathname.split('/').filter(Boolean);
    if (host === 'api.soundcloud.com') {
      if (parts[0] === 'playlists') return { provider: 'soundcloud-set' };
      if (parts[0] === 'tracks') return { provider: 'soundcloud' };
      return { provider: 'external' };
    }
    if (parts.includes('sets')) return { provider: 'soundcloud-set' };
    if (parts.length >= 2) return { provider: 'soundcloud' };
    return { provider: 'external' };
  }
  if (host === 'open.spotify.com' || host === 'spotify.link' || host === 'spotify.com') {
    if (/\/track\//.test(u.pathname)) return { provider: 'spotify' };
    return { provider: 'spotify-other' };
  }
  if ((host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) &&
      (u.pathname.startsWith('/track/') || u.pathname.startsWith('/album/'))) {
    return { provider: 'bandcamp' };
  }
  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
    const fm = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,64})/);
    const fid = fm ? fm[1] : (u.searchParams.get('id') || '');
    if (/^[A-Za-z0-9_-]{10,64}$/.test(fid)) return { provider: 'drive', driveId: fid };
    return { provider: 'external' };
  }
  if (/\.(mp3|ogg|oga|wav|m4a|aac|opus|flac|mp4|m4v|webm|mov)$/i.test(u.pathname)) {
    return { provider: 'direct-audio' };
  }
  return { provider: 'external' };
}

export function fallbackTitle(provider) {
  return provider === 'youtube' || provider === 'youtube-playlist' ? 'a youtube track'
    : provider === 'soundcloud' || provider === 'soundcloud-set' || provider === 'soundcloud-short' ? 'a soundcloud track'
    : provider === 'direct-audio' ? 'an audio file'
    : provider === 'bandcamp' ? 'a bandcamp track'
    : provider === 'drive' ? 'a drive track'
    : 'a track';
}

export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'`]+/i);
  return m ? m[0].replace(/[.,;:!?)\]}>]+$/, '') : '';
}

async function fetchWithTimeout(url, ms, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...(opts || {}), signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

export async function fetchTitle(url, provider) {
  const fb = fallbackTitle(provider);
  const endpoint = provider === 'youtube'
    ? 'https://noembed.com/embed?url=' + encodeURIComponent(url)
    : (provider === 'soundcloud' || provider === 'soundcloud-short')
    ? 'https://soundcloud.com/oembed?url=' + encodeURIComponent(url) + '&format=json'
    : null;
  if (!endpoint) return fb;
  try {
    const r = await fetchWithTimeout(endpoint, 4000);
    const jj = await r.json();
    if (jj && jj.title) return String(jj.title).slice(0, 140);
  } catch (e) {}
  return fb;
}

export async function sniffAudioContentType(url) {
  try {
    const r = await fetchWithTimeout(url, 5000, { method: 'HEAD', redirect: 'follow' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    return r.ok && (ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/octet-stream');
  } catch (e) { return false; }
}

/* SoundCloud short share links -> canonical track URL + title (oEmbed). */
export async function resolveShortSCLink(url) {
  try {
    try {
      const h = new URL(String(url || '')).hostname.toLowerCase();
      if (h === 'soundcloud.app.goo.gl') {
        try {
          const rr = await fetchWithTimeout(url, 10000, { redirect: 'follow' });
          if (rr && rr.url && !isShortSCLink(rr.url)) url = rr.url;
        } catch (e) {}
      }
    } catch (e) {}
    const r = await fetchWithTimeout('https://soundcloud.com/oembed?url=' + encodeURIComponent(url) + '&format=json', 15000);
    const jj = await r.json();
    if (jj && jj.html) {
      const m = String(jj.html).match(/src="([^"]*w\.soundcloud\.com\/player\/[^"]*)"/);
      if (m) {
        const src = m[1].replace(/&amp;/g, '&');
        const canonical = new URL(src).searchParams.get('url');
        if (canonical && /(^|\.)soundcloud\.com/.test(new URL(canonical).hostname)) {
          return { url: canonical, title: jj.title ? String(jj.title).slice(0, 140) : null };
        }
      }
    }
  } catch (e) {}
  return null;
}

/* ---------- provider API loaders (shared, with hung-load latches) ---------- */

let ytReady = false, ytLoading = false, ytQueue = [], ytToken = 0;
export function loadYTApi(cb) {
  if (ytReady) { cb(true); return; }
  ytQueue.push(cb);
  if (ytLoading) return;
  ytLoading = true;
  const token = ++ytToken;
  const fail = () => {
    if (ytToken !== token) return;
    ytToken++; ytLoading = false;
    const q = ytQueue.splice(0); q.forEach((f) => { try { f(false); } catch (e) {} });
  };
  window.onYouTubeIframeAPIReady = () => {
    if (ytToken !== token) return;
    ytToken++; ytReady = true; ytLoading = false;
    const q = ytQueue.splice(0); q.forEach((f) => { try { f(true); } catch (e) {} });
  };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = fail;
  document.head.appendChild(s);
  setTimeout(() => { if (ytLoading && ytToken === token) fail(); }, 12000);
}

let scReady = false, scLoading = false, scQueue = [], scToken = 0;
export function loadSCApi(cb) {
  if (scReady) { cb(true); return; }
  scQueue.push(cb);
  if (scLoading) return;
  scLoading = true;
  const token = ++scToken;
  const fail = () => {
    if (scToken !== token) return;
    scToken++; scLoading = false;
    const q = scQueue.splice(0); q.forEach((f) => { try { f(false); } catch (e) {} });
  };
  const s = document.createElement('script');
  s.src = 'https://w.soundcloud.com/player/api.js';
  s.onload = () => {
    if (scToken !== token) return;
    scToken++; scReady = true; scLoading = false;
    const q = scQueue.splice(0); q.forEach((f) => { try { f(true); } catch (e) {} });
  };
  s.onerror = fail;
  document.head.appendChild(s);
  setTimeout(() => { if (scLoading && scToken === token) fail(); }, 12000);
}

/* SoundCloud set -> its tracks via a hidden widget (READY -> getSounds). */
export function resolveSCSet(setUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tracks) => {
      if (done) return; done = true; clearTimeout(to);
      try { document.getElementById('cue-set-resolver').remove(); } catch (e) {}
      resolve(tracks);
    };
    const to = setTimeout(() => finish(null), 25000);
    const div = document.createElement('div');
    div.id = 'cue-set-resolver'; div.style.display = 'none';
    document.body.appendChild(div);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('frameborder', '0');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(setUrl) +
      '&auto_play=false&visual=false&hide_related=true';
    div.appendChild(iframe);
    loadSCApi((ok) => {
      if (!ok) { finish(null); return; }
      try {
        const w = window.SC.Widget(iframe);
        w.bind(window.SC.Widget.Events.READY, () => {
          try {
            w.getSounds((sounds) => {
              if (!sounds || !sounds.length) { finish(null); return; }
              finish(sounds.filter((s) => s && (s.permalink_url || s.uri)).map((s) => ({
                url: s.permalink_url || setUrl,
                title: (s.title || 'untitled').toString().slice(0, 140),
                durationMs: s.duration || null,
                provider: 'soundcloud',
              })));
            });
          } catch (e) { finish(null); }
        });
        w.bind(window.SC.Widget.Events.ERROR, () => finish(null));
      } catch (e) { finish(null); }
    });
  });
}

/* YouTube playlist -> its videos via a transient hidden player. */
export function resolveYTPlaylist(playlistId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tracks) => {
      if (done) return; done = true; clearTimeout(to);
      try { document.getElementById('cue-pl-resolver').remove(); } catch (e) {}
      resolve(tracks);
    };
    const to = setTimeout(() => finish(null), 30000);
    const div = document.createElement('div');
    div.id = 'cue-pl-resolver';
    div.style.cssText = 'position:absolute;left:-9999px;top:0;width:8px;height:8px;overflow:hidden;';
    document.body.appendChild(div);
    const el = document.createElement('div');
    div.appendChild(el);
    loadYTApi((ok) => {
      if (!ok || !window.YT) { finish(null); return; }
      try {
        new window.YT.Player(el, {
          width: '8', height: '8',
          playerVars: { autoplay: 0, controls: 0, disablekb: 1 },
          events: {
            onReady: (ev) => { try { ev.target.cuePlaylist({ list: playlistId, index: 0 }); } catch (e) { finish(null); } },
            onStateChange: async (ev) => {
              if (!ev.target || ev.data !== window.YT.PlayerState.CUED) return;
              let ids = null;
              try { ids = ev.target.getPlaylist(); } catch (e) {}
              try { ev.target.destroy(); } catch (e) {}
              if (!ids || !ids.length) { finish(null); return; }
              const tracks = await Promise.all(ids.slice(0, 50).map(async (vid) => {
                const url = 'https://www.youtube.com/watch?v=' + vid;
                const title = await fetchTitle(url, 'youtube');
                return { url, title, durationMs: null, provider: 'youtube', videoId: vid };
              }));
              finish(tracks);
            },
            onError: () => finish(null),
          },
        });
      } catch (e) { finish(null); }
    });
  });
}

/* ---------- keyless resolver worker (bandcamp + spotify swap) ---------- */

export async function resolver(path, ms) {
  try {
    const r = await fetchWithTimeout(RESOLVE_API + path, ms || 20000);
    return await r.json();
  } catch (e) { return null; }
}

export async function resolveBandcamp(url) {
  const w = await resolver('/bandcamp?url=' + encodeURIComponent(url), 30000);
  if (!w || w.error || !Array.isArray(w.tracks) || !w.tracks.length) return null;
  return w; // { kind, title, artist, tracks: [{title, durationSec, streamUrl}] }
}

/* Drive playback goes through the resolver worker's /drive proxy
 * FIRST (build 2): Drive's own host sends Cross-Origin-Resource-Policy:
 * same-site, and Chromium kills cross-origin media loads from it with
 * ERR_BLOCKED_BY_ORB — public files included (reproduced 2026-10-25
 * with a public FLAC: curl gets the bytes, a <video> element gets
 * blocked). The worker re-serves the same bytes clean. The direct
 * forms stay as fallbacks in case the worker is ever down. */
export function driveStreamUrl(driveId) {
  return RESOLVE_API + '/drive?id=' + encodeURIComponent(driveId);
}
export function driveFallbackUrls(driveId) {
  return [
    'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(driveId) + '&export=download&confirm=t',
    'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(driveId),
  ];
}

/* ---------- Spotify swap matcher (A3F: version fidelity is the only job) ---------- */

function swapNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/\(feat\.?[^)]*\)|\[feat\.?[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function swapQualifiersOf(title) {
  const s = ' ' + swapNorm(title) + ' ';
  const q = new Set();
  const rm = s.match(/ ([a-z0-9]+) (remix|rework|flip|bootleg) /);
  if (rm) q.add('remix:' + rm[1]);
  else if (/ (remix|rework|flip|bootleg) /.test(s)) q.add('remix:?');
  if (/ sped up | spedup /.test(s)) q.add('spedup');
  if (/ slowed /.test(s)) q.add('slowed');
  if (/ reverb /.test(s)) q.add('reverb');
  if (/ nightcore /.test(s)) q.add('nightcore');
  if (/ 8d /.test(s)) q.add('8d');
  if (/ live /.test(s)) q.add('live');
  if (/ acoustic /.test(s)) q.add('acoustic');
  if (/ unplugged /.test(s)) q.add('unplugged');
  if (/ instrumental /.test(s)) q.add('instrumental');
  if (/ karaoke /.test(s)) q.add('karaoke');
  if (/ cover /.test(s)) q.add('cover');
  if (/ mashup /.test(s)) q.add('mashup');
  if (/ extended /.test(s)) q.add('extended');
  if (/ radio edit /.test(s)) q.add('radioedit');
  if (/ demo /.test(s)) q.add('demo');
  if (/ remaster(ed)? /.test(s) && !/ video /.test(s)) q.add('remaster');
  return q;
}
const SWAP_STRIP_WORDS = new Set(('official video audio music lyric lyrics hd 4k 8k mv visualizer visualiser ' +
  'remix rework flip bootleg sped up spedup slowed reverb nightcore 8d live acoustic unplugged instrumental karaoke ' +
  'cover mashup extended radio edit demo remaster remastered version ver full song track hq').split(' '));
function swapCoreTitle(title) {
  return swapNorm(title).split(' ').filter((w) => w && !SWAP_STRIP_WORDS.has(w)).join(' ');
}
function swapArtistHit(track, candTitle, candChannel) {
  const hay = swapNorm(candTitle) + ' | ' + swapNorm(candChannel);
  return (track.artists || []).some((a) => {
    const ac = swapNorm(a);
    return ac.length >= 2 && hay.includes(ac);
  });
}
function swapOfficialBoost(track, candChannel) {
  const cn = swapNorm(candChannel);
  return (track.artists || []).some((a) => {
    const ac = swapNorm(a);
    return ac && (cn === ac || cn === ac + ' topic');
  });
}
function swapTitleHit(track, candTitle) {
  const core = swapCoreTitle(track.title);
  if (!core) return false;
  const cc = swapCoreTitle(candTitle);
  if (cc === core || cc.includes(core) || core.includes(cc)) return true;
  for (const a of track.artists || []) {
    const ac = swapCoreTitle(a);
    if (ac && cc.startsWith(ac + ' ')) {
      const rest = cc.slice(ac.length + 1);
      if (rest === core || rest.includes(core) || core.includes(rest)) return true;
    }
  }
  return false;
}
function swapSetEq(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
export function swapJudge(track, cand) {
  const lines = [];
  let pass = true; let score = 0;
  const lq = swapQualifiersOf(track.title);
  const cq = swapQualifiersOf(cand.title);
  const qEq = swapSetEq(lq, cq);
  lines.push(`version [${[...lq].join(' ') || 'plain'}] vs [${[...cq].join(' ') || 'plain'}] ${qEq ? 'ok' : 'MISMATCH'}`);
  if (!qEq) pass = false;
  const tHit = swapTitleHit(track, cand.title);
  lines.push(`title ${tHit ? 'ok' : 'MISMATCH'}`);
  if (!tHit) pass = false;
  const boost = swapOfficialBoost(track, cand.channel);
  let dOk = null;
  if (track.durationMs && cand.durationSec != null) {
    const diff = Math.abs(cand.durationSec - track.durationMs / 1000);
    dOk = diff <= 2.5;
    lines.push(`duration ${cand.durationSec}s vs ${(track.durationMs / 1000).toFixed(1)}s (off by ${diff.toFixed(1)}s) ${dOk ? 'ok' : 'MISMATCH'}`);
    if (!dOk) pass = false;
  } else if (cand.durationSec == null) {
    lines.push('duration unknown on the candidate — cannot verify, refusing');
    pass = false;
  } else {
    lines.push('link duration unknown — the bar rises: needs the artist\u2019s own channel');
    if (!boost) pass = false;
  }
  const aHit = swapArtistHit(track, cand.title, cand.channel);
  if (aHit) lines.push('artist ok');
  else if (qEq && tHit && swapCoreTitle(cand.title) === swapCoreTitle(track.title) && dOk === true) {
    lines.push('artist not credited — carried by exact title + version + duration');
    score -= 0.5;
  } else { lines.push('artist MISMATCH'); pass = false; }
  if (boost) { score += 2; lines.push('artist\u2019s own channel / topic: confidence +'); }
  return { pass, score, lines };
}
export function swapMatch(track, candidates) {
  const audit = [];
  let winner = null;
  (candidates || []).forEach((cand, i) => {
    const v = swapJudge(track, cand);
    audit.push({ videoId: cand.videoId, title: cand.title, channel: cand.channel, pass: v.pass, lines: v.lines });
    if (v.pass) {
      const score = v.score - i * 0.01;
      if (!winner || score > winner.score) winner = { ...cand, score };
    }
  });
  return { winner, audit };
}
export function swapAuditText(track, audit) {
  const out = [`linked: "${track.title}" by ${(track.artists || []).join(', ') || '?'}${track.durationMs ? ` (${(track.durationMs / 1000).toFixed(1)}s)` : ''}`];
  for (const a of (audit || []).slice(0, 6)) {
    out.push(`${a.pass ? '✓' : '✗'} ${a.title} — ${a.channel}`);
    for (const l of a.lines) out.push('   ' + l);
  }
  if (!audit || !audit.length) out.push('no youtube candidates came back at all');
  return out.map((l) => l.slice(0, 160));
}
export async function swapIdentifySpotify(url) {
  let w = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    w = await resolver('/spotify?url=' + encodeURIComponent(url), 20000);
    if (w && !w.error && w.title) {
      return { title: String(w.title), artists: w.artists || [], durationMs: w.durationMs || null, kind: 'track' };
    }
    if (w && w.error === 'not-a-track') return { kind: w.kind || 'link' };
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  try {
    const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url));
    if (r.ok) {
      const j = await r.json();
      if (j && j.title) return { title: String(j.title), artists: [], durationMs: null, kind: 'track', degraded: true };
    }
  } catch (e) {}
  return null;
}
export async function swapSearchYT(q) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const w = await resolver('/ytsearch?q=' + encodeURIComponent(q), 20000);
    if (w && Array.isArray(w.candidates) && w.candidates.length) return w.candidates;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  for (const host of ['https://inv.nadeko.net', 'https://invidious.privacyredirect.com']) {
    try {
      const r = await fetchWithTimeout(host + '/api/v1/search?type=video&q=' + encodeURIComponent(q), 8000);
      if (!r.ok) continue;
      const arr = await r.json();
      const cands = (arr || []).filter((v) => v && v.videoId).slice(0, 8).map((v) => ({
        videoId: v.videoId, title: v.title || '', channel: v.author || '',
        durationSec: typeof v.lengthSeconds === 'number' ? v.lengthSeconds : null,
      }));
      if (cands.length) return cands;
    } catch (e) {}
  }
  return [];
}

/* ---------- queue item validation (wire hygiene) ---------- */

export function validAdd(d) {
  if (!d || typeof d !== 'object') return false;
  if (typeof d.id !== 'string' || !d.id || d.id.length > 48) return false;
  if (!PROVIDERS.includes(d.provider)) return false;
  if (typeof d.url !== 'string' || !d.url || d.url.length > 600) return false;
  if (d.provider === 'drive' && (typeof d.driveId !== 'string' || !/^[A-Za-z0-9_-]{10,64}$/.test(d.driveId))) return false;
  if (d.provider === 'bandcamp' && (typeof d.streamUrl !== 'string' || !d.streamUrl || d.streamUrl.length > 1400)) return false;
  if (typeof d.title !== 'string' || !d.title || d.title.length > 160) return false;
  if (typeof d.addedBy !== 'string' || !d.addedBy || d.addedBy.length > 24) return false;
  if (typeof d.addedById !== 'string' || !d.addedById) return false;
  if (typeof d.addedAt !== 'number') return false;
  if (d.videoId != null && (typeof d.videoId !== 'string' || d.videoId.length > 24)) return false;
  if (d.durationMs != null && typeof d.durationMs !== 'number') return false;
  return true;
}
export function validPlay(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.stopped) return typeof d.by === 'string';
  if (!validAdd(d)) return false;
  if (typeof d.startedAt !== 'number' || typeof d.by !== 'string') return false;
  return true;
}
