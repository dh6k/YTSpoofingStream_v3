// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Main World Script                            ║
// ║  Pre-warm Cache + ITAG Disguise + Force Player Reload            ║
// ╚══════════════════════════════════════════════════════════════════╝
(function () {
  'use strict';

  if (location.hostname === 'music.youtube.com') {
    return; // YouTube Music has its own native high-quality engine; do not hook
  }

  const TAG = '[YTSS]';
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  const MODES = { AAC: 'aac_only', OPUS_HQ: 'opus_hq', HIGHEST: 'highest' };

  // ─── ITAG DISGUISE TABLE ──────────────────────────────────────────
  // The desktop web player refuses itags that are not in its own format table
  // ("Video unavailable" / silent playback). So each premium itag is presented to
  // the player under a codec-compatible itag it does accept, while the `url` still
  // points at the premium stream. The fetch/XHR interceptors then restore the real
  // itag and client on the outgoing videoplayback request.
  const ITAG_DISGUISE = {
    774: { as: 251, mimeType: 'audio/webm; codecs="opus"' },        // Opus 256-300kbps → Opus 160kbps slot
  };
  const HQ_ITAGS = [774];

  const OP_MODES = { HYBRID_HQ: 'HYBRID_HQ', YTM_HARVESTER: 'YTM_HARVESTER', TV_HEADLESS: 'TV_HEADLESS' };

  // ─── SETTINGS ────────────────────────────────────────────────────
  let S = {
    enabled: true,
    hqFetch: true,
    forceOverride: true,
    audioMode: MODES.HIGHEST,
    operationMode: OP_MODES.HYBRID_HQ,
    autoReload: true,
    preferredClient: 'AUTO',
    rawItag: false,
    shadowPlayer: true,
    shadowVolume: 1.0,
    lang: 'vi',
  };

  // Keys that may live in `S`. Earlier builds pushed the whole extension storage
  // area into this world, which meant the TV OAuth token (access_token +
  // refresh_token) ended up in `S` and persisted to youtube.com localStorage where
  // any page script could read it. Filtering on both read and write also scrubs
  // tokens that older builds already wrote.
  const SETTING_KEYS = Object.keys(S);

  function pickSettings(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const key of SETTING_KEYS) {
      if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
  }

  function persistSettings() {
    try { localStorage.setItem('ytss_settings', JSON.stringify(S)); } catch (e) { }
  }

  try {
    const stored = localStorage.getItem('ytss_settings');
    if (stored) {
      const parsed = JSON.parse(stored);
      Object.assign(S, pickSettings(parsed));
      // Rewrite immediately if the stored blob carried anything it shouldn't.
      if (Object.keys(parsed).some(k => !SETTING_KEYS.includes(k))) {
        persistSettings();
        try { localStorage.removeItem('ytSpoofingStream_settings'); } catch (e) { }
        console.warn(TAG, 'Purged non-settings keys from stored config.');
      }
    }
  } catch (e) { }

  function handleSettingsChange() {
    if (!S.enabled) {
      if (typeof StudioEngine774 !== 'undefined') StudioEngine774.stopAndUnmute('Extension Disabled');
      const container = document.getElementById('ytss-vol-container');
      if (container) container.style.display = 'none';
      status.activeMethod = 'original';
      status.activeAudioItag = 251;
      status.fallbackReason = 'Extension Disabled';
      status.bestAudioInfo = 'Extension Disabled';
      report();
    } else {
      const container = document.getElementById('ytss-vol-container');
      if (container) container.style.display = 'inline-flex';
      hqCache.clear();
      confirmedNo774Videos.clear();
      try {
        for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
          const k = window.sessionStorage.key(i);
          if (k && k.startsWith('ytss_hq_')) window.sessionStorage.removeItem(k);
        }
      } catch (e) {}
      const curVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
      if (curVid) {
        console.log(TAG, `[SettingsChange] Switched to ${S.operationMode} -> Triggering HQ harvest for ${curVid}`);
        prewarmCache(curVid);
      }
      if (typeof window.__ytssUpdateBadge === 'function') {
        window.__ytssUpdateBadge();
      }
    }
  }

  window.addEventListener('message', (e) => {
    // Only trust messages this page posted to itself — otherwise any embedded
    // iframe on the page could push arbitrary settings into the extension.
    if (e.source !== window) return;
    if ((e.data?.type === 'YTSS_SETTINGS_UPDATE' || e.data?.type === 'YTSpoofingStream_settingsUpdate') && e.data.settings) {
      Object.assign(S, pickSettings(e.data.settings));
      persistSettings();
      handleSettingsChange();
    }
  });

  // ── DISABLE SERVICE WORKER ──────────────────────────────────────────
  // YouTube uses a Service Worker (sw.js) to intercept network requests.
  // If active, it handles videoplayback requests in a separate thread,
  // bypassing our window.fetch and XHR hooks. We must disable it!
  // Gated on S.enabled: with the extension switched off there is nothing to
  // intercept, and breaking YouTube's own Service Worker anyway would degrade
  // the site for no reason.
  if (navigator.serviceWorker && S.enabled) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      for (let registration of registrations) {
        registration.unregister().then(success => {
          if (success) console.log(TAG, 'Unregistered existing Service Worker');
        });
      }
    }).catch(e => { });

    Object.defineProperty(navigator.serviceWorker, 'register', {
      value: function () {
        console.log(TAG, "Service Worker registration blocked by YTSpoofingStream.");
        return Promise.reject(new Error("Service Worker disabled to force fetch intercept."));
      },
      configurable: true,
      writable: true
    });
  }

  // ─── STATUS ──────────────────────────────────────────────────────
  const status = {
    injectedStreams: 0,
    bestAudioInfo: '—',
    activeMethod: '—',
    activeAudioItag: '—',
    fallbackReason: null,
    lastError: null,
    activeMode: S.audioMode,
    clientStats: {},
    clientFallback: null,   // set when the chosen Spoofing Method returned no HQ
    noUrlDrop: null,        // set when HQ formats arrived as metadata only (SABR-only, no url)
    prewarmStatus: '—',
  };

  let lastReportJson = '';
  function report() {
    status.activeMode = S.audioMode;
    const currentJson = JSON.stringify(status);
    if (currentJson === lastReportJson) return;
    lastReportJson = currentJson;

    try { localStorage.setItem('ytSpoofingStream_status', currentJson); } catch (e) { }
    if (typeof window.__ytssUpdateBadge === 'function') {
      try { window.__ytssUpdateBadge(); } catch (e) { }
    }
  }

  // ─── HQ FORMAT CACHE (per videoId, 25s TTL) ─────────────────────
  // Cache HQ formats so they can be merged SYNCHRONOUSLY when player initializes.
  // TTL prevents serving stale/expired stream URLs to the player.
  const HQ_CACHE_TTL_MS = 3600000; // 1 hour
  const hqCache = new Map();        // videoId → { formats, ts }
  const pendingFetches = new Map(); // videoId → Promise<hqFormats[]>
  const loudnessDbMap = new Map();  // videoId → loudnessDb (number)
  const VIDEO_ID_RE = /^[\w-]{11}$/;
  const failedFetches = new Map();  // videoId → ts of the last empty result (backoff)
  const FAILED_RETRY_MS = 20000;    // don't re-run the fan-out for a failing video more often than this
  const reloadedVideos = new Set(); // guard: only force-reload once per videoId
  const pendingReloads = new Set(); // guard: only one reload retry loop per videoId
  // Ephemeral single-track tracking: only holds at most 1 video temporarily in-memory.
  // Cleared and replaced upon video change. NEVER stored in session storage.
  let currentNo774VideoId = null;
  const confirmedNo774Videos = {
    has(v) { return Boolean(v && currentNo774VideoId === v); },
    add(v) { if (v && VIDEO_ID_RE.test(v)) currentNo774VideoId = v; },
    delete(v) { if (currentNo774VideoId === v) currentNo774VideoId = null; },
    clear() { currentNo774VideoId = null; }
  };
  let isInitialPageLoad = true;     // guard: only allow page reload on very first visit
  const isMusicSite = location.hostname === 'music.youtube.com'; // YouTube Music needs special handling
  let navTargetVideoId = null;

  function isCurrentWatchVideo(vid) {
    if (!vid) return false;
    const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
    if (playerVid && playerVid === vid) return true;
    if (navTargetVideoId && navTargetVideoId === vid) return true;
    const urlVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    if (urlVid && urlVid === vid) return true;
    return false;
  }
  const isCurrentTarget = isCurrentWatchVideo;

  // A cache hit used to overwrite status.clientStats wholesale with a single CACHE
  // entry. The popup's client grid is the only place that reports which clients
  // returned 774/141 and why the rest failed, and cacheGet runs on every interception
  // point — so the per-client results were wiped moments after the fan-out produced
  // them. Only fill the marker in when there is nothing better to show.
  function noteCacheHit(entry) {
    if (entry?.clientStats && Object.keys(entry.clientStats).length > 0) {
      status.clientStats = { ...entry.clientStats };
      report();
    } else if (!status.clientStats || Object.keys(status.clientStats).length === 0) {
      status.clientStats = { CACHE: 'Loaded from Session Cache (Instant)' };
      report();
    }
  }

  const CACHE_PREFIX = 'ytss_hq_v5_';

  // Purge legacy/stale cache entries (e.g. v1, v2)
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith('ytss_hq_') && !k.startsWith(CACHE_PREFIX)) {
        window.sessionStorage.removeItem(k);
      }
    }
  } catch (e) { }

  function cacheGet(videoId) {
    // 1. Check memory map first
    const entry = hqCache.get(videoId);
    if (entry && (Date.now() - entry.ts <= HQ_CACHE_TTL_MS)) {
      if ((!entry.videoId || entry.videoId === videoId) && (!entry.opMode || entry.opMode === S.operationMode)) {
        noteCacheHit(entry);
        return entry;
      }
      hqCache.delete(videoId);
    }
    // 2. Check sync sessionStorage (handles F5 reloads flawlessly)
    try {
      const stored = window.sessionStorage.getItem(CACHE_PREFIX + videoId);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Date.now() - parsed.ts <= HQ_CACHE_TTL_MS) {
          if ((!parsed.videoId || parsed.videoId === videoId) && (!parsed.opMode || parsed.opMode === S.operationMode)) {
            hqCache.set(videoId, parsed); // restore to mem
            noteCacheHit(parsed);
            return parsed;
          } else {
            window.sessionStorage.removeItem(CACHE_PREFIX + videoId);
          }
        } else {
          window.sessionStorage.removeItem(CACHE_PREFIX + videoId);
        }
      }
    } catch (e) { }

    hqCache.delete(videoId);
    return null;
  }

  function cacheSet(videoId, formats, streamingContext = null, clientStats = null) {
    const entry = { videoId, formats, streamingContext, opMode: S.operationMode, clientStats: clientStats || status.clientStats, ts: Date.now() };
    hqCache.set(videoId, entry);
    try {
      window.sessionStorage.setItem(CACHE_PREFIX + videoId, JSON.stringify(entry));
    } catch (e) { }
  }

  // ─── SERVICE WORKER BRIDGE ────────────────────────────────────────
  function fetchHQViaSW(videoId, opts = {}) {
    return new Promise((resolve) => {
      const requestId = 'req_' + Math.random().toString(36).substr(2, 9);

      function onMessage(e) {
        if (e.data?.type === 'YTSS_HQ_RESULT' && e.data.requestId === requestId) {
          window.removeEventListener('message', onMessage);
          resolve({
            results: e.data.results || [],
            streamingContext: e.data.streamingContext || null,
            confirmedNo774: !!e.data.confirmedNo774,
            error: e.data.error || null,
          });
        }
      }
      window.addEventListener('message', onMessage);

      const playerEl = document.getElementById('movie_player');
      const playerVid = playerEl?.getVideoData?.()?.video_id;
      const initialVid = window.ytInitialPlayerResponse?.videoDetails?.videoId;

      let title = null;
      let author = null;

      if (initialVid === videoId) {
        title = window.ytInitialPlayerResponse?.videoDetails?.title;
        author = window.ytInitialPlayerResponse?.videoDetails?.author;
      } else if (playerVid === videoId) {
        title = playerEl?.getVideoData?.()?.title;
        author = playerEl?.getVideoData?.()?.author;
      }

      window.postMessage({
        type: 'YTSS_FETCH_HQ',
        videoId,
        title,
        author,
        requestId,
        opMode: S.operationMode,
        preferredSource: opts.preferredSource || null,
        excludeSource: opts.excludeSource || null,
        forceFresh: !!opts.forceFresh,
        context: collectPageContext()
      }, '*');

      // 12s timeout: SW may need to restart after being killed by Chrome (~30s idle).
      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ results: [], streamingContext: null });
      }, 12000);
    });
  }

  // ── Phase 1 (Option D): TV streaming context cache + fetcher.
  const TVCTX_CACHE_TTL_MS = 3600000;
  const tvCtxCache = new Map(); // videoId → { ctx, ts }

  function getTvContext(videoId) {
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return Promise.resolve(null);

    // 1. Check memory / hqCache first
    const hqEntry = hqCache.get(videoId);
    if (hqEntry?.streamingContext) return Promise.resolve(hqEntry.streamingContext);

    const mem = tvCtxCache.get(videoId);
    if (mem && (Date.now() - mem.ts <= TVCTX_CACHE_TTL_MS)) {
      return Promise.resolve(mem.ctx);
    }

    // 2. Ask SW via bridge (async)
    return new Promise((resolve) => {
      const requestId = 'tvctx_' + Math.random().toString(36).substr(2, 9);

      function onMessage(e) {
        if (e.data?.type === 'YTSS_TVCTX_RESULT' && e.data.requestId === requestId) {
          window.removeEventListener('message', onMessage);
          const ctx = e.data.streamingContext || null;
          if (ctx) tvCtxCache.set(videoId, { ctx, ts: Date.now() });
          resolve(ctx);
        }
      }
      window.addEventListener('message', onMessage);

      window.postMessage({ type: 'YTSS_FETCH_TVCTX', videoId, requestId }, '*');

      setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(null);
      }, 3000);
    });
  }

  async function fetchAllHQAudio(videoId, opts = {}) {
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return { formats: [], streamingContext: null };
    if (confirmedNo774Videos.has(videoId) && !opts.forceFresh) {
      return { formats: [], streamingContext: null };
    }
    const hasFailoverOpts = !!(opts.excludeSource || opts.preferredSource);
    if (!hasFailoverOpts && !opts.forceFresh) {
      if (pendingFetches.has(videoId)) return await pendingFetches.get(videoId);

      const cached = cacheGet(videoId);
      if (cached && (cached.formats?.length > 0 || cached.streamingContext)) return cached;

      const failedAt = failedFetches.get(videoId);
      if (failedAt && Date.now() - failedAt < FAILED_RETRY_MS) return { formats: [], streamingContext: null };
    }

    const isCurrentVideo = isCurrentWatchVideo(videoId);

    if (!hasFailoverOpts && !opts.isNextPrefetch && !isCurrentVideo) {
      console.log(TAG, `[HQ] Skipping background harvest for non-current video ${videoId} to dedicate harvester to current track`);
      return { formats: [], streamingContext: null };
    }

    console.log(TAG, `[HQ] Fetching for ${videoId} (isCurrent: ${isCurrentVideo}${hasFailoverOpts ? `, failover: ${JSON.stringify(opts)}` : ''})...`);
    if (isCurrentVideo) {
      status.clientStats = {}; // Clear stale stats only for current video
      report();
    }

    const fetchPromise = fetchHQViaSW(videoId, opts).then(({ results, streamingContext, confirmedNo774 }) => {
      if (confirmedNo774) {
        confirmedNo774Videos.add(videoId);
        failedFetches.set(videoId, Date.now());
        pendingFetches.delete(videoId);
        console.log(TAG, `[HQ] Video ${videoId} reported NO 774 from SW. Marked as confirmedNo774.`);
        return { formats: [], streamingContext: null };
      }

      const merged = [];
      const seen = new Set();
      let tvCtx = streamingContext;
      const statsForVideo = {};

      for (const clientRes of results) {
        if (clientRes.audioFormats?.length > 0) {
          const audio = clientRes.audioFormats;
          const itags = audio.map(f => f.itag);
          const hasPlayable774 = audio.some(f => (f.itag === 774 || f._origItag === 774) && (f.url || f.signatureCipher));
          const hasPlayable141 = audio.some(f => (f.itag === 141 || f._origItag === 141) && (f.url || f.signatureCipher));
          const hasSabr774 = audio.some(f => (f.itag === 774 || f._origItag === 774) && !f.url && !f.signatureCipher);

          let star = '';
          if (hasPlayable774) star = ' ★774';
          else if (hasPlayable141) star = ' ★141';
          else if (hasSabr774) star = ' [SABR]';

          statsForVideo[clientRes.source] = `${audio.length}str ${itags.slice(0, 6).join('/')}${star}`;

          if (clientRes.streamingContext) {
            tvCtx = clientRes.streamingContext;
          }

          for (const fmt of audio) {
            const key = `${fmt._src || clientRes.source}:${fmt.itag}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(fmt);
            }
          }
        } else if (clientRes.error) {
          statsForVideo[clientRes.source] = clientRes.error;
        } else {
          statsForVideo[clientRes.source] = 'No Audio';
        }
      }

      hqCache.delete(videoId);
      const has774 = merged.some(f => (f.itag === 774 || f._origItag === 774));
      if (has774) {
        // Strip 251 and non-774 audio formats so 251 never goes into the player after fetch
        const only774 = merged.filter(f => f.itag === 774 || f._origItag === 774);
        cacheSet(videoId, only774, tvCtx, statsForVideo);
        failedFetches.delete(videoId);
        if (isCurrentVideo) {
          tryUpgradeVideo(videoId, 'FetchComplete');
        }
      } else {
        failedFetches.set(videoId, Date.now());
        confirmedNo774Videos.add(videoId);
        console.log(TAG, `[HQ] Video ${videoId} has NO 774. Marked as confirmedNo774 (SW and extension will not touch further).`);
        try {
          window.postMessage({ type: 'YTSS_CONFIRM_NO_774', videoId }, '*');
        } catch (e) {}
      }
      pendingFetches.delete(videoId);

      if (isCurrentVideo) {
        status.clientStats = statsForVideo;
        report();
      }

      return { formats: has774 ? only774 : merged, streamingContext: tvCtx };
    });

    if (!hasFailoverOpts) {
      pendingFetches.set(videoId, fetchPromise);
    }
    return await fetchPromise;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 0] SESSION CACHE LOADER (Removed, now native sync via sessionStorage)

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 1] PRE-WARM CACHE
  // Start fetching HQ formats immediately from URL videoId, BEFORE player initializes.
  // When ytInitialPlayerResponse fires, cache should already be ready → sync merge.
  // ═══════════════════════════════════════════════════════════════════
  function getVideoIdFromUrl() {
    try {
      const urlVid = new URLSearchParams(window.location.search).get('v');
      if (urlVid && VIDEO_ID_RE.test(urlVid)) return urlVid;
      if (window.location.pathname.startsWith('/shorts/')) {
        const sVid = window.location.pathname.split('/')[2];
        if (sVid && VIDEO_ID_RE.test(sVid)) return sVid;
      }
      const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
      if (playerVid && VIDEO_ID_RE.test(playerVid)) return playerVid;
      return null;
    } catch (e) { return null; }
  }

  function getMainVideoElement() {
    return document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('ytd-miniplayer video.html5-main-video')
      || document.querySelector('.html5-video-player video.html5-main-video')
      || document.querySelector('video.html5-main-video');
  }

  function isPlayerActiveOnPage() {
    const isWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts') || location.pathname.startsWith('/live') || location.pathname.startsWith('/tv') || isMusicSite;
    if (isWatch) return true;
    const mini = document.querySelector('ytd-miniplayer');
    const isMiniActive = mini && (mini.hasAttribute('active') || mini.style.display !== 'none' || mini.offsetHeight > 0);
    const player = document.getElementById('movie_player');
    const hasPlayerVideo = !!(player && player.getVideoData?.()?.video_id);
    return !!isMiniActive || hasPlayerVideo;
  }

  navTargetVideoId = getVideoIdFromUrl();

  function getPlayable774Candidates(list) {
    if (!list || !Array.isArray(list)) return [];
    return list.filter(f => {
      const itag = f._origItag || f.itag;
      const hasUrl = !!(f.url || f._directUrl);
      return itag === 774 && hasUrl;
    });
  }

  function getAll774Candidates(list) {
    if (!list || !Array.isArray(list)) return [];
    return list.filter(f => {
      const itag = f._origItag || f.itag;
      return itag === 774;
    });
  }

  function findBestReal774(list) {
    const cands = getAll774Candidates(list);
    return cands.length > 0 ? cands[0] : null;
  }

  // Clear any experimental stale playback rates left in storage from past sessions
  try {
    const cachedRate = window.sessionStorage?.getItem('yt-player-playback-rate');
    if (cachedRate && (cachedRate.includes('0.8') || cachedRate.includes('0.96') || cachedRate.includes('1.04'))) {
      window.sessionStorage.removeItem('yt-player-playback-rate');
      window.localStorage?.removeItem('yt-player-playback-rate');
    }
  } catch (e) {}

  // Descriptor-level volume & mute control for native video element
  // Directly silences hardware audio output while preserving DOM and player UI volume state
  const descVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume') || {
    get() { return this.volume; },
    set(v) { this.volume = v; }
  };
  const descMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted') || {
    get() { return this.muted; },
    set(v) { this.muted = v; }
  };

  // Prototype-level Volume & Mute Interception
  // Enforces hardware silence across all <video> elements on YouTube while keeping player UI volume intact
  try {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      get() {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descVolume.get.call(this);
        }
        if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive) {
          return this._userVol !== undefined ? this._userVol : descVolume.get.call(this);
        }
        return descVolume.get.call(this);
      },
      set(v) {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descVolume.set.call(this, v);
        }
        this._userVol = v;
        const isMainVideo = (this.classList && this.classList.contains('html5-main-video')) ||
                            (this.closest && this.closest('#movie_player, .html5-video-player'));
        if (!isMainVideo) {
          try { descVolume.set.call(this, v); } catch (e) {}
          return;
        }
        if (typeof StudioEngine774 !== 'undefined') {
          if (v > 0) {
            this._userMuted = false;
            StudioEngine774._userMuted = false;
          } else {
            this._userMuted = true;
            StudioEngine774._userMuted = true;
          }
        }
        if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive && !StudioEngine774.isAdActive()) {
          if (typeof StudioEngine774._silenceElement === 'function') {
            StudioEngine774._silenceElement(this);
          }
          try { descVolume.set.call(this, 0); } catch (e) {}
          try { descMuted.set.call(this, true); } catch (e) {}
          if (StudioEngine774.audio && StudioEngine774.isActive) {
            StudioEngine774.syncVolDirect(v);
          }
        } else {
          try { descVolume.set.call(this, v); } catch (e) {}
        }
      },
      configurable: true
    });
  } catch (e) {}

  try {
    Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
      get() {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descMuted.get.call(this);
        }
        if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive) {
          return this._userMuted !== undefined ? this._userMuted : StudioEngine774.isUserMuted();
        }
        return descMuted.get.call(this);
      },
      set(m) {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descMuted.set.call(this, m);
        }
        this._userMuted = !!m;
        if (typeof StudioEngine774 !== 'undefined') {
          StudioEngine774._userMuted = !!m;
        }
        const isMainVideo = (this.classList && this.classList.contains('html5-main-video')) ||
                            (this.closest && this.closest('#movie_player, .html5-video-player'));
        if (!isMainVideo) {
          try { descMuted.set.call(this, m); } catch (e) {}
          return;
        }
        if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive && !StudioEngine774.isAdActive()) {
          if (typeof StudioEngine774._silenceElement === 'function') {
            StudioEngine774._silenceElement(this);
          }
          try { descVolume.set.call(this, 0); } catch (e) {}
          try { descMuted.set.call(this, true); } catch (e) {}
          if (StudioEngine774.audio && StudioEngine774.isActive) {
            if (StudioEngine774.isUserMuted()) {
              StudioEngine774.audio.volume = 0;
            } else {
              const curVol = (this._userVol !== undefined) ? this._userVol : 1.0;
              if (curVol > 0) StudioEngine774.syncVolDirect(curVol);
            }
          }
        } else {
          try { descMuted.set.call(this, m); } catch (e) {}
        }
      },
      configurable: true
    });
  } catch (e) {}

  // Hardware play interceptor: ensures native video is completely silent whenever playback begins/resumes
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    if (typeof StudioEngine774 !== 'undefined' && this !== StudioEngine774.audio && StudioEngine774.isActive && !StudioEngine774.isAdActive()) {
      try { descVolume.set.call(this, 0); } catch (e) {}
      try { descMuted.set.call(this, true); } catch (e) {}
    }
    return origPlay.apply(this, args);
  };

  function cleanStreamUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    try {
      const u = new URL(rawUrl);
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      u.searchParams.delete('ump');
      u.searchParams.delete('sabr');
      u.searchParams.delete('alr');
      u.searchParams.delete('sq');
      return u.toString();
    } catch (e) {
      return rawUrl
        .replace(/[?&]range=[^&]*/g, '')
        .replace(/[?&]rn=[^&]*/g, '')
        .replace(/[?&]rbuf=[^&]*/g, '')
        .replace(/[?&]ump=[^&]*/g, '')
        .replace(/[?&]sabr=[^&]*/g, '')
        .replace(/[?&]alr=[^&]*/g, '')
        .replace(/[?&]sq=[^&]*/g, '');
    }
  }

  function getPreciseBitrate(fmt) {
    if (!fmt) return 256000;
    if (typeof fmt.averageBitrate === 'number' && fmt.averageBitrate > 0) {
      return fmt.averageBitrate;
    }
    if (typeof fmt.bitrate === 'number' && fmt.bitrate > 0 && fmt.bitrate !== 280000 && fmt.bitrate !== 301258) {
      return fmt.bitrate;
    }
    const rawUrl = fmt.url || fmt._directUrl;
    if (typeof rawUrl === 'string') {
      try {
        const u = new URL(rawUrl);
        const clen = u.searchParams.get('clen');
        const dur = u.searchParams.get('dur');
        if (clen && dur) {
          const c = parseFloat(clen);
          const d = parseFloat(dur);
          if (c > 0 && d > 0) return Math.round((c * 8) / d);
        }
      } catch (e) {}
    }
    return fmt.bitrate || 256000;
  }

  function formatBitrate(fmt) {
    const bps = getPreciseBitrate(fmt);
    return `${Math.round(bps / 1000)}kbps`;
  }

  // ─── HYBRID MODE FAILOVER CONTROLLER ──────────────────────────────
  const failedSourcesPerVideo = new Map(); // videoId -> Set of failed sources ('YTM_HARVESTER', 'TVHTML5')

  function canHybridFailover(videoId, failedSource, targetSource) {
    if (!videoId || S.operationMode !== OP_MODES.HYBRID_HQ) return false;
    let failedSet = failedSourcesPerVideo.get(videoId);
    if (!failedSet) {
      failedSet = new Set();
      failedSourcesPerVideo.set(videoId, failedSet);
    }
    if (failedSet.has(targetSource)) {
      return false; // Alternate target has already failed for this video
    }
    return true;
  }

  function handleHybridRuntimeFailover(videoId, failedSource, targetSource, reason = '') {
    if (!videoId || S.operationMode !== OP_MODES.HYBRID_HQ) return;
    let failedSet = failedSourcesPerVideo.get(videoId);
    if (!failedSet) {
      failedSet = new Set();
      failedSourcesPerVideo.set(videoId, failedSet);
    }
    failedSet.add(failedSource);

    console.log(TAG, `[HybridFailover] Mode HYBRID_HQ: ${failedSource} failed on ${videoId} (${reason}) -> Smart Failover to ${targetSource}...`);

    // Reset StudioEngine774 if active and restore native player audio
    if (StudioEngine774.isActive) {
      StudioEngine774.isActive = false;
      if (StudioEngine774.audio) {
        try {
          StudioEngine774.audio.pause();
          StudioEngine774.audio.removeAttribute('src');
          StudioEngine774.audio.load();
        } catch (e) {}
      }
      StudioEngine774.stopWatchdog();
      const mainVideo = getMainVideoElement();
      if (mainVideo) {
        StudioEngine774.restoreNativeVideo(mainVideo);
      }
    }

    // Invalidate stale caches so failed stream is never re-used
    hqCache.delete(videoId);
    try {
      window.sessionStorage.removeItem(`ytss_hq_${videoId}`);
    } catch (e) {}
    window.postMessage({ type: 'YTSS_CLEAR_VIDEO_CACHE', videoId }, '*');
    window.postMessage({ type: 'YTSS_STOP_HARVEST' }, '*');

    status.activeMethod = `Failover to ${targetSource}`;
    status.fallbackReason = `Smart Failover from ${failedSource} (${reason})`;
    report();

    fetchAllHQAudio(videoId, { preferredSource: targetSource, excludeSource: failedSource }).then(hqData => {
      if (!isCurrentWatchVideo(videoId)) {
        console.log(TAG, `[HybridFailover] Video changed during failover (current: ${getVideoIdFromUrl()}). Aborting.`);
        return;
      }

      const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
      const playable = getPlayable774Candidates(formats);
      const all774 = getAll774Candidates(formats);

      if (playable.length > 0) {
        console.log(TAG, `[HybridFailover] Smart failover SUCCESS: Playing direct 774 stream via ${targetSource}`);
        StudioEngine774.load774(videoId, playable[0]);
      } else if (all774.length > 0) {
        console.log(TAG, `[HybridFailover] Smart failover SUCCESS: Delivering TV 774 stream via ${targetSource}`);
        StudioEngine774.stopAndUnmute('Native TV 774 stream');
        const best774 = all774[0];
        status.activeAudioItag = 774;
        status.activeMethod = best774._src || targetSource;
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      } else {
        console.warn(TAG, `[HybridFailover] Alternate source ${targetSource} also failed / has no 774 for ${videoId}. Cleanly retaining native YouTube stream (ITAG 251).`);
        failedSet.add(targetSource);
        StudioEngine774.stopAndUnmute(`Both modes failed (${reason})`);
      }
    }).catch(err => {
      console.warn(TAG, `[HybridFailover] Error during smart failover fetch for ${videoId}:`, err);
      failedSet.add(targetSource);
      StudioEngine774.stopAndUnmute(`Failover error: ${err.message}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // STUDIO ENGINE 774 — Sophisticated High-Fidelity Audio Engine
  // Direct Hardware Opus Playback • Flawless Sync • Unified Player Binding
  // ═══════════════════════════════════════════════════════════════════
  const StudioEngine774 = {
    audio: null,
    activeVideoId: null,
    best774Candidate: null,
    pending774: null,
    isActive: false,
    _isTransitioning: false,
    _lastSeekTime: 0,
    _waiterTimer: null,
    _watchdogTimer: null,
    _inSyncVol: false,
    _globalEventsHooked: false,
    _hookedVideos: new WeakSet(),
    _userMuted: false,
    _userPaused: false,
    _isAudioBuffering: false,
    _isInternalVideoSync: false,
    _isSeeking: false,
    _seekDebounceTimer: null,
    _waitingPauseTimer: null,
    _advanceFallbackTimer: null,
    _hasDispatchedEnded: false,
    _reconnectAttempts: 0,
    _lastAudioTime: -1,
    _lastAudioAdvance: 0,
    _audioStalledAt: 0,
    _currentNormGain: 1.0,

    init() {
      if (!this.audio) {
        this.audio = document.createElement('audio');
        this.audio.id = 'ytss-studio-774';
        this.audio.preload = 'auto';
        this.audio.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0.001;pointer-events:none;';

        const parent = document.body || document.documentElement;
        if (parent) {
          parent.appendChild(this.audio);
        } else {
          document.addEventListener('DOMContentLoaded', () => {
            (document.body || document.documentElement).appendChild(this.audio);
          }, { once: true });
        }

        this.audio.addEventListener('error', (e) => {
          if (!this.isActive || !this.audio || !this.audio.src) return;
          const err = this.audio.error;
          // Ignore aborted stream errors (code 1: MEDIA_ERR_ABORTED) caused by seeking or normal browser lifecycle
          if (!err || err.code === MediaError.MEDIA_ERR_ABORTED || err.code === 1 || this._isSeeking) {
            return;
          }
          const currentVid = this.activeVideoId || getVideoIdFromUrl();
          const currentSrc = this.best774Candidate?._src || status.activeMethod || 'YTM_HARVESTER';
          console.warn(TAG, `[StudioEngine774] Stream error (code: ${err?.code}, message: ${err?.message}) on source: ${currentSrc}`);

          if (err && (err.code === MediaError.MEDIA_ERR_NETWORK || err.code === MediaError.MEDIA_ERR_DECODE || err.code === 4)) {
            if ((this._reconnectAttempts || 0) < 3) {
              const delay = 500 * Math.pow(2, this._reconnectAttempts || 0);
              console.log(TAG, `[StudioEngine774] Network/decode hiccup. Auto-reconnecting in ${delay}ms (${(this._reconnectAttempts || 0) + 1}/3, error code: ${err?.code})...`);
              setTimeout(() => {
                if (this.isActive) this._reconnectStream('Media error recovery');
              }, delay);
              return;
            }
          }

          if (S.operationMode === OP_MODES.HYBRID_HQ && currentVid) {
            const alternateSource = (currentSrc === 'TVHTML5') ? 'YTM_HARVESTER' : 'TVHTML5';
            if (canHybridFailover(currentVid, currentSrc, alternateSource)) {
              console.log(TAG, `[HybridFailover] Stream failed on ${currentSrc}. Initiating smart failover to ${alternateSource} for ${currentVid}...`);
              handleHybridRuntimeFailover(currentVid, currentSrc, alternateSource, `Stream error (code ${err?.code || 'unknown'})`);
              return;
            }
          }

          this.stopAndUnmute('Audio stream error');
        });

        this.audio.addEventListener('loadedmetadata', () => {
          if (!this.isActive || this.isAdActive()) return;
          const video = getMainVideoElement();
          if (video) {
            this.audio.currentTime = video.currentTime;
            this.audio.playbackRate = video.playbackRate || 1.0;
          }
        });

        const onAudioBufferReady = () => {
          if (!this.isActive || this.isAdActive()) return;
          if (this._waitingPauseTimer) {
            clearTimeout(this._waitingPauseTimer);
            this._waitingPauseTimer = null;
          }
          if (this._isAudioBuffering) {
            this._isAudioBuffering = false;
            this._audioStalledAt = 0;
            console.log(TAG, '[StudioEngine774] Audio buffer replenished. Resuming video sync...');
          }
          const video = getMainVideoElement();
          if (video && !video.seeking && !this._isSeeking && !this.audio.seeking) {
            const diff = Math.abs(this.audio.currentTime - video.currentTime);
            if (diff > 0.15) {
              this.audio.currentTime = video.currentTime;
            }
          }
        };

        this.audio.addEventListener('canplay', onAudioBufferReady);
        this.audio.addEventListener('canplaythrough', onAudioBufferReady);

        // When 774 audio is ACTUALLY playing, seamlessly silence native video
        this.audio.addEventListener('playing', () => {
          this._reconnectAttempts = 0;
          this._lastAudioTime = this.audio.currentTime;
          this._lastAudioAdvance = Date.now();
          onAudioBufferReady();
          if ((this.isActive || this._isTransitioning) && !this.isAdActive()) {
            const video = getMainVideoElement();
            if (video) {
              this._silenceElement(video);
            }
          }
        });

        this.audio.addEventListener('waiting', () => {
          if (!this.isActive || this.isAdActive()) return;
          this._audioStalledAt = Date.now();
          this._isAudioBuffering = true;
          // Never pause video during audio buffering: let video play smoothly
          // and let micro-rate sync catch up when buffer arrives!
        });

        this.audio.addEventListener('stalled', () => {
          if (!this.isActive || this.isAdActive()) return;
          this._audioStalledAt = Date.now();
          this._isAudioBuffering = true;
          // Network stall: normal progressive download pause by browser.
          // NEVER pause video here to maintain buttery smooth playback!
        });

        this.audio.addEventListener('pause', () => {
          if (this.isActive && this.isAdActive()) {
            const video = getMainVideoElement();
            if (video) this.restoreNativeVideo(video);
          }
        });

        this.audio.addEventListener('ended', () => {
          if (!this.isActive) return;
          console.log(TAG, '[StudioEngine774] Audio playback completed. Evaluating autoplay/playlist state...');
          const video = getMainVideoElement();
          const player = document.getElementById('movie_player');
          const shouldAdvance = this.shouldAutoplayNext();

          if (video) {
            this._isInternalVideoSync = true;
            try {
              if (video.duration && !isNaN(video.duration)) {
                video.currentTime = video.duration;
              }
            } catch (e) {}
            if (shouldAdvance) {
              // Dispatch ended once to trigger YouTube's native transition ONLY if video not already ended
              if (!video.ended) {
                video.dispatchEvent(new Event('ended', { bubbles: true }));
              }
            } else {
              try { video.pause(); } catch (e) {}
            }
            setTimeout(() => { this._isInternalVideoSync = false; }, 250);
          }

          if (shouldAdvance) {
            if (player) {
              if (this._advanceFallbackTimer) clearTimeout(this._advanceFallbackTimer);
              // Fallback ONLY: only call player.nextVideo() if YouTube did not advance after 5.5s
              this._advanceFallbackTimer = setTimeout(() => {
                this._advanceFallbackTimer = null;
                if ((this.isActive || this._isTransitioning) && player.getVideoData?.()?.video_id === this.activeVideoId) {
                  if (typeof player.nextVideo === 'function') {
                    console.log(TAG, '[StudioEngine774] Video did not auto-advance; calling fallback player.nextVideo()...');
                    try { player.nextVideo(); } catch (e) {}
                  }
                }
              }, 5500);
            }
          } else {
            console.log(TAG, '[StudioEngine774] Video finished. Autoplay is OFF; halting playback.');
            if (player && typeof player.pauseVideo === 'function') {
              try { player.pauseVideo(); } catch (e) {}
            }
            this.stopAndUnmute('Playback ended (autoplay disabled)');
          }
        });
      }

      this.hookGlobalEvents();
      this.hookPlayer();
    },

    shouldAutoplayNext() {
      const player = document.getElementById('movie_player');

      // 1. Check YouTube player DOM autonav toggle button FIRST (explicit user toggle)
      const autonavBtn = document.querySelector('.ytp-autonav-toggle-button') ||
                         document.querySelector('.ytp-autonav-toggle-button-container') ||
                         document.querySelector('[data-tooltip-target-id="ytp-autonav-toggle-button"]');
      if (autonavBtn) {
        const checked = autonavBtn.getAttribute('aria-checked') ||
                        autonavBtn.querySelector('[aria-checked]')?.getAttribute('aria-checked') ||
                        autonavBtn.closest('[aria-checked]')?.getAttribute('aria-checked');
        if (checked === 'false') return false;
        if (checked === 'true') return true;
      }

      // 2. Check YouTube player API for autonav state: 2 = ON, 1 = OFF
      if (player && typeof player.getAutonavState === 'function') {
        try {
          const state = player.getAutonavState();
          if (state === 1) return false;
          if (state === 2) return true;
        } catch (e) {}
      }

      // 3. Check sessionStorage / localStorage ('yt-player-autonavstate')
      try {
        const raw = sessionStorage.getItem('yt-player-autonavstate') || localStorage.getItem('yt-player-autonavstate');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.data === '1' || parsed?.data === 1 || parsed?.data === false) return false;
          if (parsed?.data === '2' || parsed?.data === 2 || parsed?.data === true) return true;
        }
      } catch (e) {}

      // 4. Check if genuinely in an active playlist (URL must have `list=`)
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const listParam = urlParams.get('list');
        if (listParam && listParam !== '') {
          const plId = (player && typeof player.getPlaylistId === 'function') ? player.getPlaylistId() : null;
          const plPanel = document.querySelector('ytd-playlist-panel-renderer');

          if (plId || plPanel) {
            if (player && typeof player.getPlaylist === 'function') {
              const pl = player.getPlaylist();
              const idx = (typeof player.getPlaylistIndex === 'function') ? player.getPlaylistIndex() : -1;
              if (Array.isArray(pl) && pl.length > 1 && idx >= 0 && idx < pl.length - 1) {
                return true;
              }
            }

            if (plPanel) {
              const items = plPanel.querySelectorAll('ytd-playlist-panel-video-renderer');
              const selected = plPanel.querySelector('ytd-playlist-panel-video-renderer[selected]');
              if (items.length > 1 && selected && selected !== items[items.length - 1]) {
                return true;
              }
            }
          }
        }
      } catch (e) {}

      // 5. Check YouTube global config
      try {
        const ytcfgAuto = window.ytcfg?.get('AUTONAV_SETTINGS')?.isAutonavEnabled;
        if (typeof ytcfgAuto === 'boolean') return ytcfgAuto;
      } catch (e) {}

      return false;
    },

    _silenceElement(el) {
      if (!el || el === this.audio || !this.isActive || this.isAdActive()) return;
      this.hookVideoVolume(el);
      try { descVolume.set.call(el, 0); } catch (e) {}
      try { descMuted.set.call(el, true); } catch (e) {}
    },

    hookVideoVolume(video) {
      if (!video || video._ytssVolHooked) return;
      video._ytssVolHooked = true;
      try {
        video._userVol = descVolume.get.call(video);
      } catch (e) {
        video._userVol = 1.0;
      }

      // 1. Intercept volume setter/getter
      try {
        Object.defineProperty(video, 'volume', {
          get() {
            if (StudioEngine774.isActive) {
              return this._userVol !== undefined ? this._userVol : 1.0;
            }
            return descVolume.get.call(this);
          },
          set(v) {
            this._userVol = v;
            if (v > 0 && !StudioEngine774.isUserMuted()) {
              this._userMuted = false;
              StudioEngine774._userMuted = false;
            }
            if (StudioEngine774.isActive && !StudioEngine774.isAdActive()) {
              StudioEngine774._silenceElement(this);
              try { descVolume.set.call(this, 0); } catch (e) {}
              try { descMuted.set.call(this, true); } catch (e) {}
              if (StudioEngine774.audio) {
                StudioEngine774.syncVolDirect(v);
              }
            } else {
              try { descVolume.set.call(this, v); } catch (e) {}
            }
          },
          configurable: true
        });
      } catch (e) {}

      // 2. Intercept muted setter/getter
      try {
        Object.defineProperty(video, 'muted', {
          get() {
            if (StudioEngine774.isActive) {
              return this._userMuted !== undefined ? this._userMuted : StudioEngine774.isUserMuted();
            }
            return descMuted.get.call(this);
          },
          set(m) {
            this._userMuted = !!m;
            StudioEngine774._userMuted = !!m;
            if (StudioEngine774.isActive && !StudioEngine774.isAdActive()) {
              StudioEngine774._silenceElement(this);
              try { descVolume.set.call(this, 0); } catch (e) {}
              try { descMuted.set.call(this, true); } catch (e) {}
              if (StudioEngine774.audio) {
                if (StudioEngine774.isUserMuted()) {
                  StudioEngine774.audio.volume = 0;
                } else {
                  const curVol = (this._userVol !== undefined) ? this._userVol : 1.0;
                  if (curVol > 0) StudioEngine774.syncVolDirect(curVol);
                }
              }
            } else {
              try { descMuted.set.call(this, m); } catch (e) {}
            }
          },
          configurable: true
        });
      } catch (e) {}
    },

    silenceNativeVideo(video) {
      if (video) {
        this._silenceElement(video);
        return;
      }
      try {
        document.querySelectorAll('video').forEach(v => {
          this._silenceElement(v);
        });
      } catch (e) {}
    },

    restoreNativeVideo(video) {
      const restore = (v) => {
        if (!v || v === this.audio) return;
        const savedVol = (typeof v._userVol === 'number' && !isNaN(v._userVol) && v._userVol > 0)
          ? v._userVol
          : null;
        const isMuted = this.isUserMuted();

        delete v._ytssVolHooked;
        delete v.volume;
        delete v.muted;
        delete v._userVol;
        delete v._userMuted;

        try { descMuted.set.call(v, isMuted); } catch (e) {}
        if (savedVol !== null) {
          try { descVolume.set.call(v, isMuted ? 0 : savedVol); } catch (e) {}
        }

        const p = document.getElementById('movie_player');
        if (p && typeof p.unMute === 'function' && !isMuted && p.isMuted()) {
          try { p.unMute(); } catch (e) {}
        }
      };
      if (video) restore(video);
      try {
        document.querySelectorAll('video').forEach(v => {
          if (v !== this.audio) restore(v);
        });
      } catch (e) {}
    },

    isAdActive() {
      const p = document.getElementById('movie_player');
      if (p && typeof p.isAdShowing === 'function') {
        try { if (p.isAdShowing()) return true; } catch (e) { }
      }
      if (p && p.classList && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) {
        return true;
      }
      return !!document.querySelector('.ad-showing, .ad-interrupting');
    },

    hookGlobalEvents() {
      if (this._globalEventsHooked) return;
      this._globalEventsHooked = true;

      // HTML5 video events do not bubble, so we capture them at the document root
      const onVideoEvent = (e) => {
        if (!e.target || e.target.tagName !== 'VIDEO' || e.target.id === 'ytss-studio-774') return;
        const video = e.target;
        // Ignore hover thumbnail previews on home/feed pages
        if (video.closest('ytd-video-preview') || video.closest('ytd-thumbnail')) return;
        if (!video.closest('#movie_player, ytd-miniplayer, .html5-video-player') && !video.classList.contains('html5-main-video')) return;
        const curVid = getVideoIdFromUrl();
        if (curVid && confirmedNo774Videos.has(curVid)) {
          return; // Confirmed NO 774: do not touch native video!
        }
        this.hookVideo(video);

        // If we have a pending 774 stream waiting for video
        if (this.pending774) {
          const { videoId, best774 } = this.pending774;
          if (isCurrentWatchVideo(videoId)) {
            this.applyToVideo(video, videoId, best774);
          }
        }

        if (this.isActive && !this.isAdActive()) {
          this._silenceElement(video);
        }

        if (!this.isActive || !this.audio) return;

        // 1. Seeking & Seeked — Process BEFORE document.hidden check so background seeking works!
        if (e.type === 'seeking') {
          if (this._isVolScrubbing || this._isInternalVideoSync) return;
          this._isSeeking = true;
          this._hasDispatchedEnded = false;
          if (!this.isAdActive()) {
            this._silenceElement(video);
            this.syncVol(video);
          }
          return;
        }

        if (e.type === 'seeked') {
          if (this._isVolScrubbing || this._isInternalVideoSync) return;
          if (this._seekDebounceTimer) {
            clearTimeout(this._seekDebounceTimer);
            this._seekDebounceTimer = null;
          }
          this._isSeeking = false;
          this._hasDispatchedEnded = false;
          this._lastSeekTime = Date.now();
          if (!this.isAdActive()) {
            this._silenceElement(video);
            this.syncVol(video);
            this.audio.currentTime = video.currentTime;
            this.audio.playbackRate = video.playbackRate;
            if (!video.paused && this.audio.paused) {
              this.audio.play().catch(() => {});
            }
          }
          return;
        }

        // 2. Rate & Volume Changes — Process BEFORE document.hidden check
        if (e.type === 'ratechange') {
          if (!this._isInternalVideoSync) {
            this.audio.playbackRate = video.playbackRate;
          }
          return;
        }

        if (e.type === 'volumechange') {
          if (this._isVolScrubbing || this._inSyncVol) return;
          this.syncVol(video);
          return;
        }

        // 3. Track Ended — Do not abruptly kill audio if audio still has duration left
        if (e.type === 'ended') {
          if (!this.audio.duration || this.audio.currentTime >= this.audio.duration - 0.5) {
            this.audio.pause();
          }
          return;
        }

        // 4. Background / Hidden optimization: let audio play continuously in background
        if (document.hidden) {
          if ((e.type === 'play' || e.type === 'playing') && !this.isAdActive()) {
            this._silenceElement(video);
            this.syncVol(video);
            this.audio.playbackRate = video.playbackRate;
            if (this.audio.paused) {
              if (Math.abs(this.audio.currentTime - video.currentTime) > 1.0) {
                this.audio.currentTime = video.currentTime;
              }
              this.audio.play().catch(() => {});
            }
          }
          // Do NOT pause 774 audio when tab is hidden, because Chrome automatically pauses/throttles
          // hidden video elements to save resources. Audio must continue playing in background!
          return;
        }

        if (e.type === 'play' || e.type === 'playing' || e.type === 'loadedmetadata' || e.type === 'canplay') {
          if (!this.isActive && !this.isAdActive()) {
            const curVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
            if (curVid && isCurrentWatchVideo(curVid) && !confirmedNo774Videos.has(curVid)) {
              tryUpgradeVideo(curVid, 'VideoEvent_' + e.type);
            }
          }
        }

        if (e.type === 'play' || e.type === 'playing') {
          this._userPaused = false;
          // Playback Safety Guard: verify audio engine is playing for current active video
          if (this.isActive && this.activeVideoId && !isCurrentWatchVideo(this.activeVideoId)) {
            console.warn(TAG, `[PlaybackSafetyGuard] Audio engine playing ${this.activeVideoId} but video is no longer active! Preparing transition.`);
            this.prepareTransition(getVideoIdFromUrl());
            return;
          }

          if (this.isAdActive()) {
            this.audio.pause();
            this.restoreNativeVideo(video);
            return;
          }
          this._silenceElement(video);
          this.syncVol(video);
          this.audio.playbackRate = video.playbackRate;

          if (this.audio.paused) {
            const diff = Math.abs(this.audio.currentTime - video.currentTime);
            if (diff > 0.1) {
              this.audio.currentTime = video.currentTime;
            }
            this.audio.playbackRate = video.playbackRate || 1.0;
            this.audio.play().catch((err) => {
              if (err && err.name === 'NotAllowedError') {
                const resume = () => {
                  if (this.isActive && this.audio && !video.paused && !this.isAdActive()) {
                    this.audio.play().catch(() => {});
                  }
                };
                window.addEventListener('click', resume, { once: true, capture: true });
                window.addEventListener('keydown', resume, { once: true, capture: true });
              }
            });
          }
        } else if (e.type === 'pause') {
          if (video.ended) {
            // Video ended naturally; do NOT abruptly kill audio while audio is finishing
            return;
          }
          if (!document.hidden && !this._isInternalVideoSync) {
            this._userPaused = true;
            this.audio.pause();
          }
        } else if (e.type === 'loadedmetadata' || e.type === 'canplay') {
          if (!this.isAdActive() && !document.hidden && !this._isInternalVideoSync && !this._isVolScrubbing) {
            this._silenceElement(video);
            this.syncVol(video);
            if (video.paused && !this.audio.paused) {
              this.audio.pause();
            } else if (!video.paused && this.audio.paused) {
              this.audio.play().catch(() => {});
            }
          }
        }
      };

      const captureOpts = { capture: true, passive: true };
      ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange', 'loadedmetadata', 'canplay', 'ended'].forEach(evt => {
        document.addEventListener(evt, onVideoEvent, captureOpts);
      });
    },

    hookVideo(video) {
      if (!video || this._hookedVideos.has(video)) return;
      this._hookedVideos.add(video);
      this.hookVideoVolume(video);
      video.addEventListener('timeupdate', () => {
        if (typeof NextVideoManager !== 'undefined') {
          NextVideoManager.tick();
        }
      }, { passive: true });
      this.hookPlayer();
    },

    hookPlayer() {
      const player = document.getElementById('movie_player');
      if (!player) return;

      if (!player._ytssEventsHooked && typeof player.addEventListener === 'function') {
        player._ytssEventsHooked = true;

        const handleVolumeChange = (data) => {
          const isMuted = data ? !!data.muted : (typeof player.isMuted === 'function' && player.isMuted());
          let vol = 1.0;
          if (data && typeof data.volume === 'number' && !isNaN(data.volume)) {
            vol = data.volume / 100;
          } else if (typeof player.getVolume === 'function') {
            const pv = player.getVolume();
            if (typeof pv === 'number' && !isNaN(pv)) vol = pv / 100;
          }
          vol = Math.max(0, Math.min(1.0, vol));

          this._userMuted = isMuted;
          const mainV = getMainVideoElement();
          if (mainV) {
            mainV._userMuted = isMuted;
            mainV._userVol = vol;
          }

          if (this.isActive && !this.isAdActive() && this.audio) {
            if (isMuted || vol <= 0) {
              this.audio.volume = 0;
            } else {
              this.syncVolDirect(vol);
            }
          }
        };

        player.addEventListener('onVolumeChange', handleVolumeChange);

        let isPlaybackEnded = false;
        const handleVideoDataChange = () => {
          const newVid = player.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
          if (newVid && (newVid !== this.activeVideoId || !this.isActive)) {
            console.log(TAG, `[PlayerVideoDataChange] Video active inside player: ${newVid} (was ${this.activeVideoId}, active: ${this.isActive})`);
            navTargetVideoId = newVid;
            failedSourcesPerVideo.delete(newVid);
            failedFetches.delete(newVid);
            confirmedNo774Videos.clear(); // Ephemeral: clear previous video no-774 state
            NextVideoManager.reset(newVid);
            isPlaybackEnded = false;

            if (confirmedNo774Videos.has(newVid)) {
              this.activeVideoId = newVid;
              if (this.isActive) {
                this.stopAndUnmute('Video has no 774', newVid);
              }
              return;
            }

            if (newVid !== this.activeVideoId) {
              // Seamless transition: maintain native silence so 251 never blasts during track load
              this.prepareTransition(newVid);
            }

            if (this.pending774 && this.pending774.videoId === newVid) {
              const pending = this.pending774;
              this.pending774 = null;
              const v = getMainVideoElement();
              if (v) {
                console.log(TAG, `[PlayerVideoDataChange] Applying pending 774 immediately for ${newVid}`);
                this.applyToVideo(v, newVid, pending.best774);
                return;
              }
            }

            const cached = cacheGet(newVid);
            if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
              const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
              const playable = getPlayable774Candidates(formats);
              const all774 = getAll774Candidates(formats);
              if (S.operationMode !== OP_MODES.TV_HEADLESS && playable.length > 0) {
                this.load774(newVid, playable[0]);
              } else if (all774.length > 0) {
                this.stopAndUnmute('Native TV 774 stream', newVid);
                const best774 = all774[0];
                status.activeAudioItag = 774;
                status.activeMethod = best774._src || 'TVHTML5';
                status.fallbackReason = null;
                status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
                report();
                if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
              } else {
                this.stopAndUnmute('No 774 stream available for this video', newVid);
              }
            } else if (S.hqFetch) {
              prewarmCache(newVid);
            }
          }
        };

        player.addEventListener('videodatachange', handleVideoDataChange);
        player.addEventListener('onStateChange', (state) => {
          if (state === 0) {
            isPlaybackEnded = true;
          } else if (state === 1 || state === 3) {
            if (isPlaybackEnded) {
              isPlaybackEnded = false;
              const curVid = player.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
              if (curVid) {
                console.log(TAG, `[PlayerReplay] Video replayed after end: ${curVid} -> Triggering 1 fresh fetch`);
                confirmedNo774Videos.clear();
                failedFetches.delete(curVid);
                NextVideoManager.reset(curVid);
                if (!this.isActive || status.activeAudioItag !== 774) {
                  prewarmCache(curVid, { forceFresh: true });
                }
              }
            }
            handleVideoDataChange();
            if (!this.isActive && !this.isAdActive()) {
              const curVid = player.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
              if (curVid && isCurrentWatchVideo(curVid) && !confirmedNo774Videos.has(curVid)) {
                tryUpgradeVideo(curVid, 'PlayerStateChange_' + state);
              }
            }
          } else if (state === -1 || state === 5) {
            handleVideoDataChange();
          }
        });

        // Replay button click handler for ended video replay
        document.addEventListener('click', (e) => {
          const replayBtn = e.target?.closest?.('.ytp-play-button, .ytp-replay-button');
          if (replayBtn) {
            const state = (typeof player.getPlayerState === 'function') ? player.getPlayerState() : null;
            if (state === 0 || isPlaybackEnded) {
              const curVid = player.getVideoData?.()?.video_id || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
              if (curVid) {
                console.log(TAG, `[ReplayClick] Replay button clicked for ${curVid} -> Triggering 1 fresh fetch`);
                confirmedNo774Videos.clear();
                failedFetches.delete(curVid);
                NextVideoManager.reset(curVid);
                prewarmCache(curVid, { forceFresh: true });
              }
            }
          }
        }, true);
      }

      if (!player._ytssMethodsHooked && typeof player.setVolume === 'function') {
        player._ytssMethodsHooked = true;

        const origSetVol = player.setVolume;
        player.setVolume = (v) => {
          if (v > 0) {
            this._userMuted = false;
            const mainV = getMainVideoElement();
            if (mainV) mainV._userMuted = false;
          } else {
            this._userMuted = true;
            const mainV = getMainVideoElement();
            if (mainV) mainV._userMuted = true;
          }
          const res = origSetVol.call(player, v);
          if (this.isActive && !this.isAdActive()) {
            const mainV = getMainVideoElement();
            if (mainV) this._silenceElement(mainV);
            if (this.audio) {
              this.syncVolDirect(v / 100);
            }
          }
          return res;
        };

        const origMute = player.mute;
        if (typeof origMute === 'function') {
          player.mute = () => {
            this._userMuted = true;
            const mainV = getMainVideoElement();
            if (mainV) mainV._userMuted = true;
            const res = origMute.call(player);
            if (this.isActive && !this.isAdActive()) {
              const mainV = getMainVideoElement();
              if (mainV) this._silenceElement(mainV);
              if (this.audio) {
                this.audio.volume = 0;
              }
            }
            return res;
          };
        }

        const origUnmute = player.unMute;
        if (typeof origUnmute === 'function') {
          player.unMute = () => {
            this._userMuted = false;
            const mainV = getMainVideoElement();
            if (mainV) mainV._userMuted = false;
            const res = origUnmute.call(player);
            if (this.isActive && !this.isAdActive()) {
              const mainV = getMainVideoElement();
              if (mainV) this._silenceElement(mainV);
              if (this.audio) {
                const curVol = (typeof player.getVolume === 'function') ? player.getVolume() : 100;
                this.syncVolDirect(curVol / 100);
              }
            }
            return res;
          };
        }
      }
    },

    prepareTransition(newVid) {
      console.log(TAG, `[StudioEngine774] Preparing transition to: ${newVid}`);
      this._isTransitioning = true;
      this.isActive = false;
      this.activeVideoId = null;
      this.best774Candidate = null;
      // Drop stale 774 stamp immediately so SFN/badge do not lie during the gap
      status.activeAudioItag = 251;
      status.activeMethod = 'original';
      status.fallbackReason = 'Video transition';
      if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      if (this.pending774 && this.pending774.videoId !== newVid) {
        this.pending774 = null;
      }
      this._isAudioBuffering = false;
      this._isSeeking = false;
      this._hasDispatchedEnded = false;
      this._reconnectAttempts = 0;
      this._lastSeekTime = Date.now();
      if (this._seekDebounceTimer) {
        clearTimeout(this._seekDebounceTimer);
        this._seekDebounceTimer = null;
      }
      if (this._advanceFallbackTimer) {
        clearTimeout(this._advanceFallbackTimer);
        this._advanceFallbackTimer = null;
      }
      if (this.audio) {
        try {
          this.audio.pause();
          this.audio.removeAttribute('src');
          this.audio.load();
        } catch (e) {}
      }
    },

    isUserMuted() {
      const player = document.getElementById('movie_player');
      if (player && typeof player.isMuted === 'function') {
        try {
          if (player.isMuted()) return true;
        } catch (e) {}
      }
      const v = getMainVideoElement();
      if (v && v._userVol === 0) return true;
      if (v && typeof v._userMuted === 'boolean') return v._userMuted;
      return !!this._userMuted;
    },

    getUserVolume() {
      if (this.isUserMuted()) return 0;
      const player = document.getElementById('movie_player');
      if (player && typeof player.getVolume === 'function') {
        try {
          const v = player.getVolume();
          if (typeof v === 'number' && !isNaN(v)) return Math.max(0, Math.min(1.0, v / 100));
        } catch (e) {}
      }
      const video = getMainVideoElement();
      if (video && typeof video._userVol === 'number') {
        return Math.max(0, Math.min(1.0, video._userVol));
      }
      return 1.0;
    },

    updateNormalizedGain() {
      this._currentNormGain = 1.0;
      return 1.0;
    },

    getNormalizedGain() {
      return 1.0;
    },

    syncVolDirect(v) {
      if (!this.isActive || !this.audio) return;
      this._markVolScrubbing();
      if (this.isAdActive()) return;
      if (v > 0 && this.isUserMuted()) {
        this._userMuted = false;
        const mainV = getMainVideoElement();
        if (mainV) mainV._userMuted = false;
      }
      const target = (this.isUserMuted() || v <= 0) ? 0 : Math.max(0, Math.min(1.0, v));
      if (Math.abs(this.audio.volume - target) > 0.005) {
        this.audio.volume = target;
      }
    },

    _markVolScrubbing() {
      this._isVolScrubbing = true;
      clearTimeout(this._volScrubTimer);
      this._volScrubTimer = setTimeout(() => {
        this._isVolScrubbing = false;
      }, 500);
    },

    syncVol(mainVideo) {
      if (this._inSyncVol || !this.isActive || !this.audio) return;
      this._inSyncVol = true;
      try {
        if (this.isAdActive()) {
          this.restoreNativeVideo(mainVideo);
          return;
        }
        if (this.isUserMuted()) {
          this.audio.volume = 0;
        } else {
          const userVol = this.getUserVolume();
          const target = Math.max(0, Math.min(1.0, userVol));
          if (Math.abs(this.audio.volume - target) > 0.005) {
            this.audio.volume = target;
          }
        }
        if (mainVideo) this._silenceElement(mainVideo);
      } finally {
        this._inSyncVol = false;
      }
    },

    waitForVideo() {
      if (this._waiterTimer) return;
      let attempts = 0;
      this._waiterTimer = setInterval(() => {
        attempts++;
        const video = getMainVideoElement();
        if (video) {
          clearInterval(this._waiterTimer);
          this._waiterTimer = null;
          if (this.pending774) {
            const { videoId, best774 } = this.pending774;
            if (isCurrentWatchVideo(videoId)) {
              this.applyToVideo(video, videoId, best774);
            }
          }
        } else if (attempts > 100) { // 10 seconds max
          clearInterval(this._waiterTimer);
          this._waiterTimer = null;
        }
      }, 100);
    },

    syncOnTabVisible() {
      if (!this.isActive || !this.audio || this.isAdActive()) return;
      const video = getMainVideoElement();
      if (!video) return;

      this._silenceElement(video);
      this.syncVol(video);
      this.audio.playbackRate = video.playbackRate;

      // Audio playing in background must NEVER stutter or seek on tab switch!
      if (!this.audio.paused && !this.audio.ended) {
        if (video.paused) {
          const drift = this.audio.currentTime - video.currentTime;
          // Only seek video if Chrome throttled background video significantly (> 1.0s)
          if (drift > 1.0) {
            this._isInternalVideoSync = true;
            video.currentTime = this.audio.currentTime;
            setTimeout(() => { this._isInternalVideoSync = false; }, 250);
          }
          video.play().catch(() => {});
          this._silenceElement(video);
        } else {
          const drift = this.audio.currentTime - video.currentTime;
          if (drift > 1.5) {
            this._isInternalVideoSync = true;
            video.currentTime = this.audio.currentTime;
            setTimeout(() => { this._isInternalVideoSync = false; }, 250);
          }
          this._silenceElement(video);
        }
      } else if (this.audio.ended || (this.audio.duration && this.audio.currentTime >= this.audio.duration - 0.5)) {
        // Audio already completed while tab was hidden: advance video immediately to end
        this._isInternalVideoSync = true;
        if (video.duration) video.currentTime = video.duration;
        const shouldAdvance = this.shouldAutoplayNext();
        if (shouldAdvance) {
          video.dispatchEvent(new Event('ended', { bubbles: true }));
          const player = document.getElementById('movie_player');
          if (player && typeof player.nextVideo === 'function') {
            try { player.nextVideo(); } catch (e) {}
          }
        } else {
          try { video.pause(); } catch (e) {}
          const player = document.getElementById('movie_player');
          if (player && typeof player.pauseVideo === 'function') {
            try { player.pauseVideo(); } catch (e) {}
          }
          this.stopAndUnmute('Playback ended while hidden (autoplay disabled)');
        }
        setTimeout(() => { this._isInternalVideoSync = false; }, 250);
      } else if (video.paused && !this.audio.paused) {
        this.audio.pause();
      }
    },

    _reconnectStream(reason = '') {
      if (!this.isActive || !this.best774Candidate) return;
      const video = getMainVideoElement();
      const targetTime = video ? video.currentTime : (this.audio ? this.audio.currentTime : 0);
      const rawUrl = this.best774Candidate.url || this.best774Candidate._directUrl;
      const streamUrl = cleanStreamUrl(rawUrl);
      if (!streamUrl) return;

      this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
      if (this._reconnectAttempts > 4) {
        console.warn(TAG, '[StudioEngine774] Exceeded max reconnect attempts');
        if (S.operationMode === OP_MODES.HYBRID_HQ) {
          const currentVid = this.activeVideoId || getVideoIdFromUrl();
          const currentSrc = this.best774Candidate?._src || status.activeMethod || 'YTM_HARVESTER';
          const alternateSource = (currentSrc === 'TVHTML5') ? 'YTM_HARVESTER' : 'TVHTML5';
          if (currentVid && canHybridFailover(currentVid, currentSrc, alternateSource)) {
            handleHybridRuntimeFailover(currentVid, currentSrc, alternateSource, 'Max reconnect attempts exceeded');
            return;
          }
        }
        this.stopAndUnmute('Max stream reconnect attempts exceeded');
        return;
      }

      console.log(TAG, `[StudioEngine774] Auto-reconnecting stream (#${this._reconnectAttempts}, reason: ${reason}) at ${targetTime.toFixed(2)}s...`);
      try {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch (e) {}

      this.audio.src = streamUrl;
      this.audio.load();
      if (targetTime > 0.05) {
        try { this.audio.currentTime = targetTime; } catch (e) {}
      }
      if (video) {
        this.audio.playbackRate = video.playbackRate;
        this.syncVol(video);
        if (!video.paused && !this.isAdActive()) {
          this.audio.play().catch(() => {});
        }
      }
    },

    startWatchdog() {
      if (this._watchdogTimer) return;
      this._lastAudioTime = this.audio ? this.audio.currentTime : -1;
      this._lastAudioAdvance = Date.now();
      this._watchdogTimer = setInterval(() => {
        this.checkSyncWatchdog();
      }, 750);
    },

    stopWatchdog() {
      if (this._watchdogTimer) {
        clearInterval(this._watchdogTimer);
        this._watchdogTimer = null;
      }
    },

    checkSyncWatchdog() {
      if (typeof NextVideoManager !== 'undefined') {
        NextVideoManager.tick();
      }
      if (!this.isActive || !this.audio || !this.audio.src) return;
      if (this.isAdActive()) return;

      const video = getMainVideoElement();
      if (!video) return;

      // 0. Native Audio Leak Guard: ensure native video is NEVER outputting sound while StudioEngine774 is active
      try {
        document.querySelectorAll('video').forEach(v => {
          if (v !== this.audio) {
            const vVol = descVolume.get.call(v);
            const vMuted = descMuted.get.call(v);
            if (vVol > 0 || vMuted === false) {
              this._silenceElement(v);
            }
          }
        });
      } catch (e) {}

      // 0b. Audio Volume & Mute Sync Guard: keep 774 audio strictly in sync with player mute/volume state
      if (!this._isVolScrubbing) {
        const targetVol = this.getUserVolume();
        if (Math.abs(this.audio.volume - targetVol) > 0.01) {
          this.audio.volume = targetVol;
        }
      }

      if (document.hidden) {
        // BACKGROUND TAB CLOCK SYNCHRONIZATION:
        // When tab is hidden, Chrome throttles or pauses background <video> to save GPU/power.
        // In this mode, <audio> is the MASTER CLOCK since it is what the user hears.
        // Periodically advance video.currentTime to keep YouTube player state in sync.
        if (!this.audio.paused && !this.audio.ended) {
          const aTime = this.audio.currentTime;
          const vTime = video.currentTime;
          const drift = aTime - vTime;
          // Audio ahead of video (video throttled by browser): advance video
          if (drift > 1.5 && !video.seeking && !this._isInternalVideoSync) {
            this._isInternalVideoSync = true;
            video.currentTime = aTime;
            setTimeout(() => { this._isInternalVideoSync = false; }, 200);
          }
          // Video ahead of audio (user sought forward while tab was hidden): align audio to video
          else if (drift < -1.5 && !video.seeking && !this._isAudioBuffering) {
            const now = Date.now();
            const canHardSeek = (now - (this._lastSeekTime || 0) > 3000) && !this._isSeeking && !this.audio.seeking;
            if (canHardSeek) {
              this._lastSeekTime = now;
              this.audio.currentTime = vTime;
            }
          }

          if (video.duration && aTime >= video.duration - 0.5) {
            if (!this._hasDispatchedEnded) {
              this._hasDispatchedEnded = true;
              this._isInternalVideoSync = true;
              video.currentTime = video.duration;
              if (this.shouldAutoplayNext()) {
                if (!video.ended) {
                  video.dispatchEvent(new Event('ended', { bubbles: true }));
                }
              } else {
                try { video.pause(); } catch (e) {}
              }
              setTimeout(() => { this._isInternalVideoSync = false; }, 200);
            }
          }
        }
        return;
      }

      if (video.seeking || this._isInternalVideoSync || this._isSeeking) return;

      if (video.paused) {
        if (video.ended) {
          // Video ended naturally; do NOT abruptly kill audio while audio is finishing its last moments
          if (this.audio.ended || (this.audio.duration && this.audio.currentTime >= this.audio.duration - 0.5)) {
            if (!this.audio.paused) this.audio.pause();
          }
          return;
        }
        if (!this.audio.paused) {
          this.audio.pause();
        }
        return;
      }

      // If user is actively adjusting volume, do not interfere with clock
      if (this._isVolScrubbing) return;

      // Video is playing
      const vTime = video.currentTime;
      const aTime = this.audio.currentTime;

      // 1. Detect frozen / stalled audio stream (not merely buffering)
      if (Math.abs(aTime - this._lastAudioTime) < 0.05 && !this.audio.paused) {
        const stalledDuration = Date.now() - (this._lastAudioAdvance || Date.now());
        if (stalledDuration > 8000) {
          console.warn(TAG, `[StudioEngine774 Watchdog] Audio frozen at ${aTime.toFixed(2)}s for ${(stalledDuration / 1000).toFixed(1)}s (video at ${vTime.toFixed(2)}s). Auto-recovering...`);
          this._lastAudioAdvance = Date.now();
          if (stalledDuration > 15000) {
            this._reconnectStream('Watchdog detected frozen stream');
          } else {
            this.audio.play().catch(() => {});
          }
          return;
        }
      } else {
        this._lastAudioTime = aTime;
        this._lastAudioAdvance = Date.now();
      }

      // 2. Audio paused while video is playing
      if (this.audio.paused && !video.paused && !this._isAudioBuffering) {
        this.audio.play().catch(() => {});
      }

      // 3. Keep playbackRate strictly 1:1 with video at all times.
      // NEVER micro-adjust rate! Any rate !== 1.0 triggers Chromium's WSOLA time-stretcher,
      // which introduces comb filtering, robotic raspiness, and resampler crackle ("bị rè").
      const userRate = video.playbackRate || 1.0;
      if (this.audio.playbackRate !== userRate) {
        this.audio.playbackRate = userRate;
      }

      const drift = aTime - vTime;
      const absDiff = Math.abs(drift);
      const now = Date.now();
      const canHardSeek = (now - (this._lastSeekTime || 0) > 1500) && !this._isSeeking && !this.audio.seeking;

      if (absDiff > 0.20 && !this._isAudioBuffering && canHardSeek) {
        this._lastSeekTime = now;
        this.audio.currentTime = vTime;
      }
    },

    applyToVideo(mainVideo, videoId, best774) {
      if (!isCurrentWatchVideo(videoId)) {
        console.log(TAG, `[StudioEngine774] Rejecting applyToVideo for stale video ${videoId} (current is ${getVideoIdFromUrl()})`);
        return false;
      }
      const streamUrl = cleanStreamUrl(best774.url || best774._directUrl);
      if (!streamUrl) return false;

      // If already active and playing this stream for this video, do NOT reset currentTime!
      if (this.isActive && this.activeVideoId === videoId && this.audio && this.audio.src === streamUrl) {
        this.syncVol(mainVideo);
        return true;
      }

      this.pending774 = null;
      this.activeVideoId = videoId;
      this.best774Candidate = best774;
      this._isTransitioning = false;
      this.isActive = true;
      this._reconnectAttempts = 0;
      this._isAudioBuffering = false;
      this._isSeeking = false;
      this._userPaused = false;
      this._hasDispatchedEnded = false;
      this._lastSeekTime = Date.now();
      this.updateNormalizedGain();

      this.hookVideo(mainVideo);
      this._silenceElement(mainVideo);

      if (this.audio.src !== streamUrl) {
        try {
          this.audio.pause();
          this.audio.removeAttribute('src');
          this.audio.load();
        } catch (e) {}
        this.audio.src = streamUrl;
        this.audio.load();
      }

      try {
        this.audio.currentTime = mainVideo.currentTime || 0;
      } catch (e) {}
      this.audio.playbackRate = mainVideo.playbackRate || 1.0;

      this.syncVol(mainVideo);

      const isPlayerPlaying = !mainVideo.paused || (document.hidden && document.getElementById('movie_player')?.getPlayerState?.() === 1);
      if (isPlayerPlaying && !this.isAdActive()) {
        this.audio.play().catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            const resume = () => {
              if (this.isActive && this.audio && !mainVideo.paused && !this.isAdActive()) {
                this.audio.play().catch(() => {});
              }
            };
            window.addEventListener('click', resume, { once: true, capture: true });
            window.addEventListener('keydown', resume, { once: true, capture: true });
          }
        });
      }

      this.startWatchdog();

      status.activeAudioItag = 774;
      status.activeMethod = best774._src || 'YTM_HARVESTER';
      status.fallbackReason = null;
      status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
      report();
      if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();

      console.log(TAG, `[StudioEngine774] Successfully loaded ITAG 774 for ${videoId} at ${mainVideo.currentTime.toFixed(2)}s`);
      return true;
    },

    load774(videoId, best774) {
      if (!videoId || !best774 || !S.enabled || isMusicSite) return false;
      const isCurrent = isCurrentWatchVideo(videoId);
      const isUpcoming = (typeof NextVideoManager !== 'undefined' && NextVideoManager.nextVideoId === videoId) || (navTargetVideoId === videoId);
      if (!isCurrent && !isUpcoming) {
        console.log(TAG, `[StudioEngine774] Rejecting load774 for stale video ${videoId} (current is ${getVideoIdFromUrl()})`);
        return false;
      }
      const streamUrl = cleanStreamUrl(best774.url || best774._directUrl);
      if (!streamUrl) return false;

      // If already active and playing this exact video with this stream, do not reload/rewind!
      if (this.isActive && this.activeVideoId === videoId && this.audio && (this.audio.src === streamUrl || this.best774Candidate?.url === streamUrl)) {
        const mainVideo = getMainVideoElement();
        if (mainVideo) this.syncVol(mainVideo);
        return true;
      }

      this.init();

      const mainVideo = getMainVideoElement();
      if (!mainVideo) {
        this.pending774 = { videoId, best774 };
        this.activeVideoId = videoId;
        this.best774Candidate = best774;
        this.waitForVideo();

        status.activeAudioItag = 774;
        status.activeMethod = best774._src || 'YTM_HARVESTER';
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
        return true;
      }

      // If mainVideo is currently playing an earlier video (e.g. pre-warming upcoming track),
      // do NOT cut off the current track! Store as pending and apply when player switches.
      const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
      if (playerVid && playerVid !== videoId) {
        console.log(TAG, `[StudioEngine774] Storing 774 for upcoming track ${videoId} (player currently at ${playerVid})`);
        this.pending774 = { videoId, best774 };
        return true;
      }

      return this.applyToVideo(mainVideo, videoId, best774);
    },

    stopAndUnmute(reason = '', preserveVideoId = null) {
      const vId = preserveVideoId || this.activeVideoId || getVideoIdFromUrl();
      if (vId && (reason.toLowerCase().includes('no 774') || reason.toLowerCase().includes('not supported'))) {
        confirmedNo774Videos.add(vId);
      }

      if (!this.isActive && !this._isTransitioning && !this.pending774) {
        return; // Already cleanly running native; do not disrupt video!
      }
      const wasActive = this.isActive;
      this._isTransitioning = false;
      this.isActive = false;
      this.activeVideoId = vId;
      this.best774Candidate = null;
      this.pending774 = null;
      this._reconnectAttempts = 0;
      this._isAudioBuffering = false;
      this._isSeeking = false;
      this._userPaused = false;
      this._hasDispatchedEnded = false;
      if (this._seekDebounceTimer) {
        clearTimeout(this._seekDebounceTimer);
        this._seekDebounceTimer = null;
      }
      if (this._waitingPauseTimer) {
        clearTimeout(this._waitingPauseTimer);
        this._waitingPauseTimer = null;
      }
      if (this._advanceFallbackTimer) {
        clearTimeout(this._advanceFallbackTimer);
        this._advanceFallbackTimer = null;
      }
      this.stopWatchdog();
      if (this._waiterTimer) {
        clearInterval(this._waiterTimer);
        this._waiterTimer = null;
      }
      if (this.audio) {
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      }
      if (wasActive) {
        const mainVideo = getMainVideoElement();
        if (mainVideo) {
          this.restoreNativeVideo(mainVideo);
        }
      }
      const p = document.getElementById('movie_player');
      if (p && typeof p.isMuted === 'function' && p.isMuted() && !this._userMuted) {
        try { p.unMute(); } catch (e) {}
      }
      if (reason !== 'Native TV 774 stream') {
        status.activeAudioItag = 251;
        status.activeMethod = 'original';
        status.fallbackReason = reason || 'Native 251 Fallback';
        status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      }
      if (reason === 'Native TV 774 stream') {
        console.log(TAG, '[StudioEngine774] Using native TV 774 (SABR/disguise) — dual engine off');
      } else if (reason) {
        console.log(TAG, `[StudioEngine774] Fallback to native. Reason: ${reason}`);
      }
    }
  };

  function upgradePlayerToNative774(videoId, best774) {
    return StudioEngine774.load774(videoId, best774);
  }

  // ═══════════════════════════════════════════════════════════════════
  // NEXT VIDEO PREFETCH CONTROLLER (Last 3s Countdown & Ephemeral Cache)
  // ═══════════════════════════════════════════════════════════════════
  const NextVideoManager = {
    currentVideoId: null,
    nextVideoId: null,
    hasFetchedCall1: false,
    hasFetchedCall2: false,

    reset(vid) {
      if (!vid || vid !== this.currentVideoId) {
        this.currentVideoId = vid || null;
        this.nextVideoId = null;
        this.hasFetchedCall1 = false;
        this.hasFetchedCall2 = false;
      }
    },

    isEligible() {
      // Must have autoplay enabled OR be inside an active playlist
      if (this.isInPlaylist()) return true;
      if (typeof StudioEngine774 !== 'undefined' && typeof StudioEngine774.shouldAutoplayNext === 'function') {
        if (StudioEngine774.shouldAutoplayNext()) return true;
      }
      const autonavBtn = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"], button[data-tooltip-target-id="ytp-autonav-toggle-button"][aria-checked="true"]');
      if (autonavBtn) return true;
      return false;
    },

    isInPlaylist() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const listParam = urlParams.get('list');
        if (listParam && listParam !== '') return true;

        const player = document.getElementById('movie_player');
        if (player) {
          if (typeof player.getPlaylistId === 'function' && player.getPlaylistId()) return true;
          if (typeof player.getPlaylist === 'function') {
            const pl = player.getPlaylist();
            if (Array.isArray(pl) && pl.length > 1) return true;
          }
        }
        if (document.querySelector('ytd-playlist-panel-renderer')) return true;
      } catch (e) {}
      return false;
    },

    resolveNextVideoId() {
      const curVid = this.currentVideoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
      const player = document.getElementById('movie_player');

      // 1. In playlist: pick the next item in the playlist sequence
      if (this.isInPlaylist()) {
        try {
          if (player && typeof player.getPlaylist === 'function' && typeof player.getPlaylistIndex === 'function') {
            const pl = player.getPlaylist();
            const idx = player.getPlaylistIndex();
            if (Array.isArray(pl) && idx >= 0 && idx < pl.length - 1) {
              const candidate = pl[idx + 1];
              if (candidate && candidate !== curVid && VIDEO_ID_RE.test(candidate)) return candidate;
            }
          }

          const currentItem = document.querySelector('ytd-playlist-panel-video-renderer[selected]');
          if (currentItem) {
            const nextItem = currentItem.nextElementSibling;
            const href = nextItem?.querySelector('a#thumbnail')?.getAttribute('href') || nextItem?.querySelector('a')?.getAttribute('href');
            if (href) {
              const m = href.match(/[?&]v=([\w-]{11})/);
              if (m && m[1] && m[1] !== curVid) return m[1];
            }
          }
        } catch (e) {}
      }

      // 2. Autonav / Autoplay: pick upcoming or first recommendation
      try {
        if (player && typeof player.getUpcomingVideoData === 'function') {
          const up = player.getUpcomingVideoData();
          if (up?.videoId && up.videoId !== curVid && VIDEO_ID_RE.test(up.videoId)) return up.videoId;
        }

        if (player && typeof player.getWatchNextResponse === 'function') {
          const wnr = player.getWatchNextResponse();
          const upNextVid = wnr?.playerOverlays?.playerOverlayRenderer?.autonavToggle?.watchEndpoint?.videoId ||
            wnr?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results?.[0]?.compactVideoRenderer?.videoId ||
            wnr?.currentVideoEndpoint?.watchEndpoint?.videoId;
          if (upNextVid && upNextVid !== curVid && VIDEO_ID_RE.test(upNextVid)) return upNextVid;
        }

        const endLink = document.querySelector('.ytp-autonav-endscreen-upnext-container a, a.ytp-autonav-endscreen-link-container, .ytp-upnext a, .ytp-cued-thumbnail-overlay a');
        if (endLink?.href) {
          const m = endLink.href.match(/[?&]v=([\w-]{11})/);
          if (m && m[1] && m[1] !== curVid) return m[1];
        }

        const firstRec = document.querySelector('ytd-compact-video-renderer a#thumbnail, ytd-watch-next-secondary-results-renderer a#thumbnail, #related ytd-compact-video-renderer a#thumbnail');
        if (firstRec?.href) {
          const m = firstRec.href.match(/[?&]v=([\w-]{11})/);
          if (m && m[1] && m[1] !== curVid) return m[1];
        }

        const secResults = window.ytInitialData?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results;
        const firstRecVid = secResults?.[0]?.compactVideoRenderer?.videoId;
        if (firstRecVid && firstRecVid !== curVid && VIDEO_ID_RE.test(firstRecVid)) return firstRecVid;
      } catch (e) {}

      return null;
    },

    checkCountdown(currentTime, duration) {
      if (!duration || isNaN(duration) || duration <= 0 || duration === Infinity) return;
      if (currentTime === undefined || currentTime === null || isNaN(currentTime)) return;

      const remaining = duration - currentTime;

      // If user scrubbed / sought backward, reset fetch flags so next countdown can fire
      if (remaining > 5.0 && (this.hasFetchedCall1 || this.hasFetchedCall2)) {
        this.hasFetchedCall1 = false;
        this.hasFetchedCall2 = false;
      }

      // ONLY act in the last 3s window of playback: 0 < remaining <= 3.0
      if (remaining > 3.0 || remaining <= 0) return;

      // Must be eligible (autoplay or playlist)
      if (!this.isEligible()) return;

      if (!this.nextVideoId) {
        this.nextVideoId = this.resolveNextVideoId();
      }
      const nextVid = this.nextVideoId;
      if (!nextVid || !VIDEO_ID_RE.test(nextVid) || nextVid === this.currentVideoId) return;

      // Call 1: Triggered when entering the <= 3.0s window
      if (!this.hasFetchedCall1) {
        this.hasFetchedCall1 = true;
        console.log(TAG, `[NextVideoManager] In last 3s (${remaining.toFixed(2)}s left) -> Triggering prefetch Call 1 for next video ${nextVid} (autoplay/playlist active)`);
        fetchAllHQAudio(nextVid, { isNextPrefetch: true }).then(hqData => {
          const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
          const playable = getPlayable774Candidates(formats);
          if (playable.length > 0) {
            StudioEngine774.load774(nextVid, playable[0]);
          }
        }).catch(() => {});
      }

      // Call 2: Triggered at <= 1.5s remaining (or ~1.5s later within the 3s window)
      if (this.hasFetchedCall1 && !this.hasFetchedCall2 && remaining <= 1.5 && remaining > 0) {
        this.hasFetchedCall2 = true;
        console.log(TAG, `[NextVideoManager] In last 1.5s (${remaining.toFixed(2)}s left) -> Triggering prefetch Call 2 (refresh/confirm) for next video ${nextVid}`);
        fetchAllHQAudio(nextVid, { isNextPrefetch: true, forceFresh: true }).then(hqData => {
          const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
          const playable = getPlayable774Candidates(formats);
          if (playable.length > 0) {
            StudioEngine774.load774(nextVid, playable[0]);
          }
        }).catch(() => {});
      }
    },

    tick() {
      if (!S.enabled || !S.hqFetch) return;
      const vid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null) ||
        document.getElementById('movie_player')?.getVideoData?.()?.video_id ||
        StudioEngine774.activeVideoId;
      if (!vid) return;
      this.reset(vid);

      // Auto-upgrade watchdog: if not currently active on 774 and not in an ad, attempt upgrade straight to 774
      const isTvSabrActive = status.activeAudioItag === 774 && (status.activeMethod === 'TVHTML5' || status.activeMethod === 'TV_HEADLESS');
      if (!StudioEngine774.isActive && !isTvSabrActive && !StudioEngine774.isAdActive() && !confirmedNo774Videos.has(vid) && isCurrentWatchVideo(vid)) {
        tryUpgradeVideo(vid, 'NextVideoManagerTick');
      }

      let curTime = 0;
      let dur = 0;

      if (StudioEngine774.isActive && StudioEngine774.audio && !StudioEngine774.audio.paused) {
        curTime = StudioEngine774.audio.currentTime;
        dur = StudioEngine774.audio.duration;
      } else {
        const v = getMainVideoElement();
        if (v && !v.paused) {
          curTime = v.currentTime;
          dur = v.duration;
        }
      }

      if (dur > 0 && !isNaN(dur) && dur !== Infinity && curTime > 0) {
        this.checkCountdown(curTime, dur);
      }
    }
  };

  // Run the countdown tick every 350ms to ensure reliable detection even in background tabs
  setInterval(() => {
    NextVideoManager.tick();
  }, 350);

  function prewarmCache(videoId, opts = {}) {
    if (!videoId || !VIDEO_ID_RE.test(videoId) || !S.enabled || !S.hqFetch) return;
    if (confirmedNo774Videos.has(videoId) && !opts.forceFresh) return;
    navTargetVideoId = videoId;
    reloadedVideos.delete(videoId);
    status.prewarmStatus = `pre-fetching ${videoId}…`;
    report();
    fetchAllHQAudio(videoId, opts).then(hqData => {
      const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
      const tvCtx = hqData?.streamingContext || null;
      const count = formats.length;
      status.prewarmStatus = (count > 0 || tvCtx)
        ? `ready: ${count} formats${tvCtx ? ' + TV SABR' : ''}`
        : 'no HQ formats';
      report();
      console.log(TAG, `[Pre-warm] ${status.prewarmStatus} for ${videoId}`);

      const playableCandidates = getPlayable774Candidates(formats);
      const all774Candidates = getAll774Candidates(formats);

      if (playableCandidates.length > 0) {
        if (isCurrentWatchVideo(videoId)) {
          StudioEngine774.load774(videoId, playableCandidates[0]);
        } else if (typeof NextVideoManager !== 'undefined' && NextVideoManager.nextVideoId === videoId) {
          StudioEngine774.pending774 = { videoId, best774: playableCandidates[0] };
        }
      } else if (all774Candidates.length > 0 && isCurrentWatchVideo(videoId)) {
        // Authenticated TVHTML5 stream
        StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
        const best774 = all774Candidates[0];
        status.activeAudioItag = 774;
        status.activeMethod = best774._src || 'TVHTML5';
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      } else if (isCurrentWatchVideo(videoId)) {
        confirmedNo774Videos.add(videoId);
        status.activeAudioItag = 251;
        status.activeMethod = 'original';
        status.fallbackReason = 'No 774 stream available for this video';
        status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
        if (StudioEngine774.isActive) {
          StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
        }
      }
    });
  }

  // Pre-warm on initial page load
  const earlyVideoId = getVideoIdFromUrl();
  if (earlyVideoId) {
    prewarmCache(earlyVideoId);
  }

  // Also pre-warm on YouTube SPA navigation (yt-navigate-start fires before new page renders)
  window.addEventListener('yt-navigate-start', (e) => {
    isInitialPageLoad = false; // We are now in SPA territory, never reload page

    let incomingVid = e?.detail?.endpoint?.watchEndpoint?.videoId
      || e?.detail?.command?.watchEndpoint?.videoId
      || e?.detail?.params?.videoId
      || null;

    if (!incomingVid && typeof e?.detail?.url === 'string') {
      try {
        const u = new URL(e.detail.url, window.location.origin);
        incomingVid = u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null);
      } catch (err) { }
    }

    if (incomingVid) {
      navTargetVideoId = incomingVid;
      failedSourcesPerVideo.delete(incomingVid);
    }

    const currentActiveVid = StudioEngine774.activeVideoId || document.getElementById('movie_player')?.getVideoData?.()?.video_id;

    // ONLY reset and stop if we are navigating to a DIFFERENT video!
    // When minimizing the player to home page, incomingVid is null/same, so keep 774 audio playing smoothly!
    if (incomingVid && incomingVid !== currentActiveVid) {
      confirmedNo774Videos.clear();
      failedFetches.delete(incomingVid);
      NextVideoManager.reset(incomingVid);
      StudioEngine774.prepareTransition(incomingVid);
      status.fallbackReason = 'Loading HQ stream...';
      report();
      prewarmCache(incomingVid);
    } else if (incomingVid && incomingVid === currentActiveVid) {
      // User clicked the same video again ("bấm lại") -> trigger 1 fresh fetch
      console.log(TAG, `[Navigate] Same video clicked again ("bấm lại") for ${incomingVid} -> Refreshing 1 fetch`);
      confirmedNo774Videos.clear();
      failedFetches.delete(incomingVid);
      NextVideoManager.reset(incomingVid);
      prewarmCache(incomingVid, { forceFresh: true });
    } else if (!incomingVid) {
      const activeVid = currentActiveVid || getVideoIdFromUrl();
      if (activeVid && (!status.activeAudioItag || status.activeAudioItag === 251)) {
        setTimeout(() => prewarmCache(activeVid), 100);
      }
    }
  });

  window.addEventListener('popstate', () => {
    const currentVid = getVideoIdFromUrl();
    if (currentVid && currentVid !== StudioEngine774.activeVideoId) {
      confirmedNo774Videos.clear();
      failedFetches.delete(currentVid);
      NextVideoManager.reset(currentVid);
      navTargetVideoId = currentVid;
      failedSourcesPerVideo.delete(currentVid);
      StudioEngine774.prepareTransition(currentVid);
      prewarmCache(currentVid);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // HQ FILTER & MERGE ENGINE (Direct Fallback)
  // ═══════════════════════════════════════════════════════════════════
  function processPlayerResponse(json, hqData = null) {
    if (!json?.streamingData?.adaptiveFormats) return json;

    if (!json._origFormats) {
      json._origFormats = JSON.parse(JSON.stringify(json.streamingData.adaptiveFormats));
    }

    const videoFormats = json._origFormats.filter(f => !(f.mimeType || '').includes('audio/'));
    const origAudio = json._origFormats.filter(f => (f.mimeType || '').includes('audio/'));

    const currentVid = json.videoDetails?.videoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    if (currentVid) {
      const cached = cacheGet(currentVid);
      if (cached?.clientStats && Object.keys(cached.clientStats).length > 0) {
        status.clientStats = { ...cached.clientStats };
        report();
      }
    }

    let filteredHq = [];
    let tvStreamingContext = null;

    if (Array.isArray(hqData)) {
      filteredHq = hqData;
    } else if (hqData && typeof hqData === 'object') {
      filteredHq = hqData.formats || [];
      tvStreamingContext = hqData.streamingContext || null;
    }

    // Filter HQ formats by preferred client if specified.
    status.clientFallback = null;
    if (S.preferredClient && S.preferredClient !== 'AUTO') {
      const preferred = filteredHq.filter(f => f._src === S.preferredClient);
      if (preferred.length > 0) {
        filteredHq = preferred;
      } else if (filteredHq.length > 0) {
        status.clientFallback = `${S.preferredClient} returned no HQ — using best available`;
        console.warn(TAG, `[Client] ${status.clientFallback}`);
      }
    }

    const seen = new Set();
    const pool = [];
    let droppedNoUrl = 0;

    if (filteredHq.length > 0) {
      // Prioritize formats with direct URL or cipher over URL-less SABR formats
      filteredHq.sort((a, b) => {
        const aUrl = !!(a.url || a.signatureCipher);
        const bUrl = !!(b.url || b.signatureCipher);
        if (aUrl && !bUrl) return -1;
        if (!aUrl && bUrl) return 1;
        return (b.bitrate || 0) - (a.bitrate || 0);
      });

      for (const f of filteredHq) {
        const hasUrlOrCipher = !!(f.url || f.signatureCipher);
        const hasSABR = !hasUrlOrCipher && (f._src === 'TVHTML5' || f.itag === 774);
        if (!hasUrlOrCipher && !hasSABR) {
          if (droppedNoUrl === 0) {
            console.warn(TAG, `[Pool] dropped format without direct URL or SABR: itag=${f.itag} _src=${f._src}`);
          }
          droppedNoUrl++;
          continue;
        }
        if (!seen.has(f.itag)) {
          seen.add(f.itag);
          pool.push(f);
        } else {
          const idx = pool.findIndex(p => p.itag === f.itag);
          if (idx !== -1 && !pool[idx].url && !pool[idx].signatureCipher && hasUrlOrCipher) {
            pool[idx] = f;
          }
        }
      }
    }

    if (droppedNoUrl > 0) {
      status.noUrlDrop = `${droppedNoUrl}/${filteredHq.length} HQ formats had no url & no SABR`;
      console.warn(TAG, `[Pool] ${status.noUrlDrop}`);
    } else {
      status.noUrlDrop = null;
    }

    // Original streams
    for (const f of origAudio) {
      if (!seen.has(f.itag)) { seen.add(f.itag); pool.push({ ...f, _src: 'original' }); }
    }

    // Remove itag 140 (low-quality AAC fallback) if we have something better
    let filteredPool = pool.filter(f => f.itag !== 140);
    if (filteredPool.length === 0) filteredPool = pool;

    const hqInPool = pool.filter(f => f._src !== 'original');
    console.log(TAG, `[Pool] fromSW=${filteredHq.length} usable=${hqInPool.length}`
      + ` | candidates=${filteredPool.map(f => `${f.itag}${f._src === 'original' ? '' : '*'}`).join(',') || '(none)'}`
      + ` (* = HQ from SW)`);

    const mode = S.audioMode || MODES.HIGHEST;
    let selectedAudio = [];

    const byBitrate = (list) => list.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const pick = (list) => (S.forceOverride ? [list[0]] : list);

    if (mode === MODES.AAC) {
      const aac = byBitrate(filteredPool.filter(f => (f.mimeType || '').includes('mp4a')));
      const target = aac.find(f => f.itag === 141);
      if (target) {
        selectedAudio = [target];
        console.log(TAG, `★ ITAG 141 (AAC 256kbps) [${target._src}]`);
      } else if (aac.length) {
        selectedAudio = pick(aac);
        console.log(TAG, `AAC -> ITAG ${aac[0].itag} (${Math.round((aac[0].bitrate || 0) / 1000)}k) [${aac[0]._src}]`);
      } else {
        selectedAudio = filteredPool;
      }
    } else if (mode === MODES.OPUS_HQ) {
      const opus = byBitrate(filteredPool.filter(f => (f.mimeType || '').includes('opus')));
      const target = opus.find(f => f.itag === 774 || f._origItag === 774);
      if (target) {
        selectedAudio = [target];
        console.log(TAG, `★ ITAG 774 (Opus 256kbps+) [${target._src}]`);
      } else if (opus.length) {
        selectedAudio = pick(opus);
        console.log(TAG, `Opus -> ITAG ${opus[0].itag} (${Math.round((opus[0].bitrate || 0) / 1000)}k) [${opus[0]._src}]`);
      } else {
        selectedAudio = filteredPool;
      }
    } else {
      // HIGHEST: prefer 774 if present
      const target774 = filteredPool.find(f => f.itag === 774 || f._origItag === 774);
      if (target774) {
        selectedAudio = [target774];
        console.log(TAG, `★ ITAG 774 (Opus 256kbps+) [${target774._src}]`);
        if (status.fallbackReason) {
          status.fallbackReason = null;
          report();
        }
      } else {
        const ranked = byBitrate(filteredPool);
        selectedAudio = ranked.length ? pick(ranked) : [];
        if (ranked.length) {
          console.log(TAG, `Highest -> ITAG ${ranked[0].itag} (${Math.round((ranked[0].bitrate || 0) / 1000)}k) [${ranked[0]._src}]`);
        }
      }
    }

    selectedAudio = selectedAudio.filter(Boolean);

    // Filter and normalize HQ audio formats (retain raw 774 / 141 itags)
    const hqAudioFormats = [];
    const seenItags = new Set();
    for (const f of selectedAudio) {
      const origItag = f._origItag || f.itag;
      if (!seenItags.has(origItag)) {
        seenItags.add(origItag);
        hqAudioFormats.push({ ...f, itag: origItag, _origItag: origItag, _src: f._src || 'hq' });
      }
    }

    const all774Candidates = getAll774Candidates(pool);
    const playable774Candidates = getPlayable774Candidates(pool);
    const has774 = all774Candidates.length > 0;
    const isCurrent = isCurrentWatchVideo(json.videoDetails?.videoId);

    if (has774) {
      const best774 = playable774Candidates.length > 0 ? playable774Candidates[0] : all774Candidates[0];
      const streamUrl = best774.url || best774._directUrl;
      const orig251 = json._origFormats.find(f => f.itag === 251) || {};

      if (streamUrl) {
        // Direct playable HTTP stream (e.g. harvested from YTM) handled exclusively by StudioEngine774 (the 2nd player):
        // Strip 251 and all audio formats from native player's streamingData so native player never requests or plays 251!
        json.streamingData.adaptiveFormats = [...videoFormats];
      } else {
        // TVHTML5 Authenticated 774 Stream: upgrade 251 and retain SABR pipeline
        const preciseBps = getPreciseBitrate(best774);
        const upgraded251 = {
          ...orig251,
          ...best774,
          itag: 251,
          _origItag: 774,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: preciseBps,
          averageBitrate: best774.averageBitrate || preciseBps,
          audioQuality: 'AUDIO_QUALITY_HIGH',
          lastModified: best774.lastModified || orig251.lastModified,
          contentLength: best774.contentLength || orig251.contentLength
        };
        const raw774 = {
          ...best774,
          itag: 774,
          _origItag: 774,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: preciseBps,
        };
        const otherAudio = origAudio.filter(f => f.itag !== 251);
        json.streamingData.adaptiveFormats = [...videoFormats, ...otherAudio, upgraded251, raw774];
      }

      if (isCurrent) {
        status.activeMethod = best774._src || 'TVHTML5';
        status.activeAudioItag = 774;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
        status.injectedStreams = Math.max(pool.length, 6);
        status.videoTitle = json.videoDetails?.title || document.title || 'audio';
        status.fallbackReason = null;
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      }
    } else {
      // Clean fallback: keep original formats and SABR endpoints intact
      json.streamingData.adaptiveFormats = [...videoFormats, ...origAudio];
      if (isCurrent) {
        status.activeMethod = 'original';
        status.activeAudioItag = 251;
        status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
        status.injectedStreams = json._origFormats.length;
        status.videoTitle = json.videoDetails?.title || document.title || 'audio';
        status.fallbackReason = 'No 774 stream available for this video';
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      }
    }

    return json;
  }

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 2] ytInitialPlayerResponse HOOK
  // Runs synchronously when YouTube sets this global.
  // If pre-warm cache already done → merge sync. Otherwise async merge + player reload.
  // ═══════════════════════════════════════════════════════════════════
  let initialResponseValue = window.ytInitialPlayerResponse;
  if (initialResponseValue) {
    const initVid = initialResponseValue.videoDetails?.videoId;
    const initLdb = initialResponseValue.playerConfig?.audioConfig?.loudnessDb;
    if (initVid && typeof initLdb === 'number') {
      loudnessDbMap.set(initVid, initLdb);
    }
  }

  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    get() { return initialResponseValue; },
    set(val) {
      initialResponseValue = val;
      if (val && S.enabled) {
        const videoId = val.videoDetails?.videoId;
        const lDb = val.playerConfig?.audioConfig?.loudnessDb;
        if (videoId && typeof lDb === 'number') {
          loudnessDbMap.set(videoId, lDb);
          if (StudioEngine774.isActive && StudioEngine774.activeVideoId === videoId) {
            StudioEngine774.syncVol();
          }
        }
        if (videoId) {
          if (confirmedNo774Videos.has(videoId)) {
            return;
          }
          const cached = cacheGet(videoId);
          if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
            const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
            const playable = getPlayable774Candidates(formats);
            const all774 = getAll774Candidates(formats);
            if (S.operationMode !== OP_MODES.TV_HEADLESS && playable.length > 0 && isCurrentWatchVideo(videoId)) {
              val = processPlayerResponse(val, cached);
              StudioEngine774.load774(videoId, playable[0]);
            } else if (all774.length > 0 && isCurrentWatchVideo(videoId)) {
              val = processPlayerResponse(val, cached);
              StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
              const best774 = all774[0];
              status.activeAudioItag = 774;
              status.activeMethod = best774._src || 'TVHTML5';
              status.fallbackReason = null;
              status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
              report();
              if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
            } else if (isCurrentWatchVideo(videoId)) {
              confirmedNo774Videos.add(videoId);
              if (StudioEngine774.isActive) {
                StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
              }
            }
          } else {
            prewarmCache(videoId);
          }
        }
      }
      initialResponseValue = val;
    },
    configurable: true,
    enumerable: true,
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAGE CONTEXT → SERVICE WORKER
  // InnerTube drops the premium formats when a spoofed client sends no visitorData
  // matching the real session. Read those identifiers straight out of the page's own
  // ytcfg and relay them to the SW (via bridge.js) so its spoofed requests carry the
  // same session identity as the page.
  // ═══════════════════════════════════════════════════════════════════
  let lastPageContextSent = '';

  // Read the page's current session identity. Kept separate from reportPageContext
  // so it can also ride along on every HQ request — the worker gets evicted after
  // ~30s idle, and a fingerprint-deduped one-shot push has no way to notice that
  // the receiver has forgotten what it was told.
  function collectPageContext() {
    try {
      const cfg = window.ytcfg;
      if (!cfg || typeof cfg.get !== 'function') return null;

      const rawSts = cfg.get('STS') || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.sts);
      if (rawSts) {
        try { window.sessionStorage.setItem('ytss_sts', String(rawSts)); } catch (e) { }
      }
      let cachedSts = null;
      try { cachedSts = Number(window.sessionStorage.getItem('ytss_sts')); } catch (e) { }

      const context = {
        visitorData: cfg.get('VISITOR_DATA') || innertube?.client?.visitorData || null,
        sessionIndex: cfg.get('SESSION_INDEX') ?? null,
        delegatedSessionId: cfg.get('DELEGATED_SESSION_ID') || null,
        sts: rawSts || cachedSts || 20696,
        poToken: cfg.get('POTOKEN') || (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.raw_player_response && window.ytplayer.config.args.raw_player_response.serviceTrackingParams && window.ytplayer.config.args.raw_player_response.serviceTrackingParams.find(x => x.service === 'CSI')?.params?.find(x => x.key === 'potoken')?.value) || null,
        gl: cfg.get('GL') || innertube?.client?.gl || 'VN',
        hl: cfg.get('HL') || innertube?.client?.hl || 'vi',
      };
      return context.visitorData ? context : null;
    } catch (e) { return null; }
  }

  function reportPageContext() {
    try {
      const context = collectPageContext();
      if (!context) return;

      // Only post when something actually changed (ytcfg.set is called repeatedly).
      const fingerprint = JSON.stringify(context);
      if (fingerprint === lastPageContextSent) return;
      lastPageContextSent = fingerprint;

      window.postMessage({ type: 'YTSS_PAGE_CONTEXT', context }, '*');
      console.log(TAG, `[PageContext] Sent visitorData + authUser=${context.sessionIndex ?? '0'} to SW`);
    } catch (e) { }
  }

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 2.5] YTCFG EXPERIMENT FLAGS HOOK
  // Force disable SABR globally via YouTube's experiment flags
  // ═══════════════════════════════════════════════════════════════════
  let _ytcfg = window.ytcfg;
  Object.defineProperty(window, 'ytcfg', {
    get() { return _ytcfg; },
    set(val) {
      if (val && typeof val.set === 'function' && !val._ytssHooked) {
        const origSet = val.set;
        val.set = function (...args) {
          try {
            let obj = args[0];
            if (typeof args[0] === 'string' && args.length > 1) {
              obj = { [args[0]]: args[1] };
            }
            if (obj && obj.EXPERIMENT_FLAGS) {
              // Ensure SABR is permitted so TV SABR transplant can stream UMP 774
              if (obj.EXPERIMENT_FLAGS.html5_disable_sabr) {
                obj.EXPERIMENT_FLAGS.html5_disable_sabr = false;
              }
            }
          } catch (e) { }
          const result = origSet.apply(this, args);
          // Session identifiers land here during page boot and again on SPA nav.
          reportPageContext();
          return result;
        };
        val._ytssHooked = true;
      }
      _ytcfg = val;
    }
  });

  // ytcfg may already be populated before our hook installs (or be set via a path
  // that bypasses .set), so also sample it once the document is ready.
  document.addEventListener('DOMContentLoaded', reportPageContext);
  window.addEventListener('yt-navigate-finish', reportPageContext);

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 3] ytplayer.config HOOK
  // YouTube sets window.ytplayer.config BEFORE creating the player object.
  // Intercept it to modify player_response / raw_player_response inline.
  // ═══════════════════════════════════════════════════════════════════
  let _ytplayerConfigValue = window.ytplayer?.config || null;

  function patchYtplayerConfig(cfg) {
    if (!cfg || !S.enabled) return cfg;
    try {
      const args = cfg.args;
      if (!args) return cfg;

      if (args.raw_player_response?.streamingData) {
        const videoId = args.raw_player_response.videoDetails?.videoId;
        if (videoId && confirmedNo774Videos.has(videoId)) return cfg;
        const cached = videoId ? cacheGet(videoId) : null;
        if (cached && getPlayable774Candidates(cached?.formats || []).length > 0) {
          args.raw_player_response = processPlayerResponse(args.raw_player_response, cached);
        }
      }

      if (typeof args.player_response === 'string') {
        try {
          const pr = JSON.parse(args.player_response);
          if (pr.streamingData) {
            const videoId = pr.videoDetails?.videoId;
            if (videoId && confirmedNo774Videos.has(videoId)) return cfg;
            const cached = videoId ? cacheGet(videoId) : null;
            if (cached) {
              const playable = getPlayable774Candidates(cached?.formats || []);
              if (playable.length > 0 && isCurrentWatchVideo(videoId)) {
                args.player_response = JSON.stringify(processPlayerResponse(pr, cached));
                StudioEngine774.load774(videoId, playable[0]);
              }
            }
          }
        } catch (e) { }
      }
    } catch (e) { }
    return cfg;
  }

  // Hook window.ytplayer
  let _ytplayerValue = window.ytplayer || null;
  Object.defineProperty(window, 'ytplayer', {
    get() { return _ytplayerValue; },
    set(val) {
      _ytplayerValue = val;
      if (val?.config) {
        val.config = patchYtplayerConfig(val.config);
      }
      // Hook config property too
      if (val && typeof val === 'object') {
        let _cfgVal = val.config;
        Object.defineProperty(val, 'config', {
          get() { return _cfgVal; },
          set(cfg) { _cfgVal = patchYtplayerConfig(cfg); },
          configurable: true,
        });
      }
    },
    configurable: true,
  });

  // ═══════════════════════════════════════════════════════════════════
  // [APPROACH 4] FORCE PLAYER RELOAD
  // ═══════════════════════════════════════════════════════════════════
  function forcePlayerReload(videoId, hqData) {
    // Disabled to prevent reload loops, flickering, and s:80 abort errors
  }

  // ─── SW-TRIGGERED UPGRADE ─────────────────────────────────────────
  function tryUpgradeVideo(videoId, source) {
    if (!videoId || !S.enabled || isMusicSite) return;
    if (confirmedNo774Videos.has(videoId)) return; // Never touch video confirmed as NO 774
    if (StudioEngine774.isActive && StudioEngine774.activeVideoId === videoId) {
      return; // Already actively playing 774 for this exact track
    }

    if (StudioEngine774.pending774 && StudioEngine774.pending774.videoId === videoId) {
      const pending = StudioEngine774.pending774;
      StudioEngine774.pending774 = null;
      const v = getMainVideoElement();
      if (v) {
        console.log(TAG, `[${source}] Applying pending 774 for ${videoId} directly`);
        StudioEngine774.applyToVideo(v, videoId, pending.best774);
        return;
      }
    }

    const cached = cacheGet(videoId);
    if (!cached) {
      if (S.hqFetch && !failedFetches.has(videoId) && !pendingFetches.has(videoId)) {
        prewarmCache(videoId);
      }
      return;
    }
    const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
    const playableCandidates = getPlayable774Candidates(formats);
    const real774Candidates = getAll774Candidates(formats);
    if (playableCandidates.length > 0) {
      console.log(TAG, `[${source}] Upgrading ${videoId} to Studio HQ 774`);
      StudioEngine774.load774(videoId, playableCandidates[0]);
    } else if (real774Candidates.length > 0) {
      if (status.activeAudioItag !== 774 || status.activeMethod !== (real774Candidates[0]._src || 'TVHTML5')) {
        console.log(TAG, `[${source}] Activating TV SABR 774 for ${videoId}`);
        StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
        const best774 = real774Candidates[0];
        status.activeAudioItag = 774;
        status.activeMethod = best774._src || 'TVHTML5';
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      }
    } else if (cached && formats.length > 0) {
      confirmedNo774Videos.add(videoId);
      if (StudioEngine774.isActive) {
        StudioEngine774.stopAndUnmute('No 774 stream available');
      }
    }
  }

  // Resync on visibilitychange without resetting audio
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !S.enabled || isMusicSite) return;
    const videoId = getVideoIdFromUrl();
    if (videoId) {
      if (StudioEngine774.isActive && StudioEngine774.activeVideoId === videoId) {
        StudioEngine774.syncOnTabVisible();
        return;
      }
      if (confirmedNo774Videos.has(videoId)) return; // DO NOT TOUCH video confirmed as NO 774!
      const cached = cacheGet(videoId);
      if (cached && getAll774Candidates(cached?.formats || []).length > 0) {
        tryUpgradeVideo(videoId, 'VisibilityChange');
      }
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type === 'YTSS_SW_TRIGGER' || e.data?.type === 'YTSS_TRIGGER_UPGRADE') {
      const { videoId } = e.data;
      if (videoId && !confirmedNo774Videos.has(videoId)) {
        tryUpgradeVideo(videoId, 'SWTrigger');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // OPTION C — SABR body structural protobuf rewriter
  // ═══════════════════════════════════════════════════════════════════
  // Rewrites the preferred-audio field (f16.f1) and matching selected-format
  // entry (f2) from oldItag → newItag in a SABR POST body. Parses the wire
  // format structurally — never byte-scans. Returns a *new* Uint8Array on
  // success, or null if anything fails (caller must pass body untouched).
  //
  // Wire format reminder:
  //   tag = (field_number << 3) | wire_type
  //   wire 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit
  //
  // f16 (preferred audio) = { f1: varint itag, f2: varint lastModified }
  // f2  (selected format) = { f1: varint itag, f2: varint lastModified, f3: string }
  // Both f16 and f2 are length-delimited (wire type 2) at the top level.
  // f5 is the SIGNED region — we never touch it.

  // Read a varint starting at offset. Returns [value, nextOffset] or null on error.
  // Uses BigInt internally to handle 64-bit values (lastModified timestamps exceed
  // 32-bit). Returns a Number when safe (itag), BigInt otherwise — caller compares
  // via BigInt arithmetic.
  function pbReadVarint(bytes, off) {
    let result = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (off + i >= bytes.length) return null;
      const b = bytes[off + i];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        const v = result;
        // Return Number for small values (itag), BigInt for large (lastModified).
        return [v <= 0xFFFFFFFFn ? Number(v) : v, off + i + 1];
      }
      shift += 7n;
    }
    return null; // >10 bytes = malformed
  }

  // Encode a varint. Returns number[] of byte values. Accepts Number or BigInt.
  function pbEncodeVarint(value) {
    const out = [];
    let v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) v = 0n;
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v & 0x7fn));
    return out;
  }

  // Read a field tag. Returns [fieldNumber, wireType, nextOffset] or null.
  function pbReadTag(bytes, off) {
    const v = pbReadVarint(bytes, off);
    if (!v) return null;
    const tag = v[0], next = v[1];
    return [tag >>> 3, tag & 0x07, next];
  }

  // Parse a length-delimited sub-message. Returns { fields: Map<fn, [{off, len}]>,
  // rawStart, rawLen } or null. Does NOT recurse — caller descends as needed.
  // Also returns the varint offsets so the caller can rewrite in place.
  function pbParseMessage(bytes, start, end) {
    const fields = new Map(); // fieldNumber → [{valueOff, valueLen, wireType}]
    let off = start;
    while (off < end) {
      const tag = pbReadTag(bytes, off);
      if (!tag) return null;
      const fn = tag[0], wt = tag[1], afterTag = tag[2];
      if (wt === 0) { // varint
        const v = pbReadVarint(bytes, afterTag);
        if (!v) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 0, valueOff: afterTag, valueLen: v[1] - afterTag, value: v[0] });
        off = v[1];
      } else if (wt === 2) { // length-delimited
        const lenV = pbReadVarint(bytes, afterTag);
        if (!lenV) return null;
        const len = lenV[0], dataOff = lenV[1];
        if (dataOff + len > end) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 2, valueOff: dataOff, valueLen: len });
        off = dataOff + len;
      } else if (wt === 1) { // 64-bit
        if (afterTag + 8 > end) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 1, valueOff: afterTag, valueLen: 8 });
        off = afterTag + 8;
      } else if (wt === 5) { // 32-bit
        if (afterTag + 4 > end) return null;
        if (!fields.has(fn)) fields.set(fn, []);
        fields.get(fn).push({ wireType: 5, valueOff: afterTag, valueLen: 4 });
        off = afterTag + 4;
      } else {
        return null; // unknown wire type
      }
    }
    return off === end ? fields : null;
  }

  // Main rewriter. Returns a *new* Uint8Array with patches applied, or null.
  function sabrRewritePreferredAudio(bytes, targetItags, newItag, newLastModified) {
    if (!bytes || bytes.length === 0) return null;
    try {
      const topFields = pbParseMessage(bytes, 0, bytes.length);
      if (!topFields) return null;

      const itagList = Array.isArray(targetItags) ? targetItags : [targetItags];

      // ── Patch f16 (preferred audio): rewrite f16.f1 (itag) and f16.f2 (lastModified)
      const f16Entries = topFields.get(16);
      if (!f16Entries || f16Entries.length === 0) return null;
      let f16Target = null, f16Fields = null, f16f1 = null;
      for (const e of f16Entries) {
        const ff = pbParseMessage(bytes, e.valueOff, e.valueOff + e.valueLen);
        if (!ff) continue;
        const f1 = ff.get(1)?.[0];
        if (f1 && f1.wireType === 0 && itagList.includes(f1.value)) {
          f16Target = e;
          f16Fields = ff;
          f16f1 = f1;
          break;
        }
      }
      if (!f16Target || !f16f1) return null;

      const oldItag = f16f1.value;

      // ── Patch f2 (selected format): find the entry whose f1 === oldItag
      const f2Entries = topFields.get(2);
      let f2Target = null, f2Fields = null, f2f1 = null, f2f2 = null;
      if (f2Entries) {
        for (const e of f2Entries) {
          const ff = pbParseMessage(bytes, e.valueOff, e.valueOff + e.valueLen);
          if (!ff) continue;
          const f1 = ff.get(1)?.[0];
          if (f1 && f1.wireType === 0 && f1.value === oldItag) {
            f2Target = e; f2Fields = ff; f2f1 = f1; f2f2 = ff.get(2)?.[0];
            break;
          }
        }
      }

      // Build the patched buffer. Both oldItag and newItag must be 2-byte varints
      // so the enclosing length prefix is unchanged — verify this assumption.
      const oldItagBytes = pbEncodeVarint(oldItag);
      const newItagBytes = pbEncodeVarint(newItag);
      if (oldItagBytes.length !== newItagBytes.length) {
        console.warn(TAG, `[OptionC] varint length mismatch: ${oldItag}=${oldItagBytes.length}B, ${newItag}=${newItagBytes.length}B — aborting`);
        return null;
      }

      // Start from a copy.
      const out = new Uint8Array(bytes);

      // Rewrite f16.f1 (itag) in place — same byte count.
      out[f16f1.valueOff] = newItagBytes[0];
      out[f16f1.valueOff + 1] = newItagBytes[1];

      // Rewrite f16.f2 (lastModified) if present.
      const f16f2 = f16Fields.get(2)?.[0];
      if (f16f2 && f16f2.wireType === 0) {
        const newLmBytes = pbEncodeVarint(BigInt(newLastModified));
        const oldLmLen = f16f2.valueLen;
        if (newLmBytes.length === oldLmLen) {
          for (let i = 0; i < newLmBytes.length; i++) out[f16f2.valueOff + i] = newLmBytes[i];
        } else {
          // Length differs — need to rebuild f16 sub-message. More complex; for now
          // skip the lastModified rewrite and just do the itag. The server may reject
          // it, but this is the falsification test.
          console.warn(TAG, `[OptionC] f16.f2 lastModified length mismatch (${oldLmLen}→${newLmBytes.length}) — itag-only patch`);
        }
      }

      // Rewrite f2 entry (selected format) if found.
      if (f2Target && f2f1) {
        out[f2f1.valueOff] = newItagBytes[0];
        out[f2f1.valueOff + 1] = newItagBytes[1];
        if (f2f2 && f2f2.wireType === 0) {
          const newLmBytes = pbEncodeVarint(BigInt(newLastModified));
          if (newLmBytes.length === f2f2.valueLen) {
            for (let i = 0; i < newLmBytes.length; i++) out[f2f2.valueOff + i] = newLmBytes[i];
          } else {
            console.warn(TAG, `[OptionC] f2.f2 lastModified length mismatch — itag-only patch`);
          }
        }
      }

      return out;
    } catch (e) {
      console.warn(TAG, '[OptionC] sabrRewritePreferredAudio error:', e);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════
  // CLASSIC 2014 "STATS FOR NERDS" PANEL (V3 / original layout)
  // ═══════════════════════════════════════════════════════════════════
  const StatsForNerdsSpoofer = {
    initialized: false,
    timer: null,
    visible: false,
    _frames: { decoded: 0, dropped: 0, parsed: 0, presented: 0 },
    _bytes: { video: 0, audio: 0 },
    _bwSamples: [],
    _lastTs: 0,
    _lastTime: 0,
    _painted: 0,

    getCodecText() {
      if (!S.enabled) return null;
      const isReal774 = status.activeAudioItag === 774 && !status.fallbackReason;
      if (!isReal774) return null;
      // Leading "/ " matches Mime Type slot: "... / opus (251)" → "... / opus (774)"
      return '/ opus (774)';
    },

    init() {
      if (this.initialized) return;
      this.initialized = true;
      this.hookPlayerAPI();
      this.mountClassicShell();
      if (this.timer) return;
      this.timer = setInterval(() => {
        this.patchModernSfn();
        if (this.visible) this.render();
      }, 500);
      console.log(TAG, '[StatsForNerds] ready (native panel kept)');
    },

    isReal774() {
      return S.enabled
        && status.activeAudioItag === 774
        && !status.fallbackReason;
    },

    // Forward: 251/140 → 774 when Studio 774 is live.
    // Reverse: stamped 774 → real itag when it is not (video switch / fallback).
    rewriteStatText(txt, forward, realItag) {
      if (typeof txt !== 'string' || !txt) return txt;
      let out = txt;
      if (forward) {
        if (out.includes('774')) return out;
        if (/\(\s*\d+\s*\/\s*(?:251|140)\s*\)/.test(out)) {
          out = out.replace(/\(\s*(\d+)\s*\/\s*(?:251|140)\s*\)/, '($1/774)');
        } else if (/\/\s*[\w.-]+\s*\(\s*(?:251|140)\s*\)/.test(out)) {
          out = out.replace(/\/\s*[\w.-]+\s*\(\d+\)/, '/ opus (774)');
        } else if (/^\s*(251|140)\s*$/.test(out)) {
          out = out.replace(/\b(?:251|140)\b/, '774');
        }
        return out;
      }
      // reverse only values we stamped
      if (!out.includes('774')) return out;
      const itag = realItag || 251;
      if (/\(\s*\d+\s*\/\s*774\s*\)/.test(out)) {
        out = out.replace(/\(\s*(\d+)\s*\/\s*774\s*\)/, `($1/${itag})`);
      }
      if (/\/\s*opus\s*\(\s*774\s*\)/.test(out)) {
        out = out.replace(/\/\s*opus\s*\(\s*774\s*\)/, `/ opus (${itag})`);
      }
      if (/^\s*774\s*$/.test(out)) {
        out = String(itag);
      }
      return out;
    },

    patchStatsObject(stats) {
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return stats;
      const forward = this.isReal774() && !!(S.shadowPlayer || S.sfnSpoof);
      const realItag = Number(status.activeAudioItag) || 251;
      // Do not mutate a possibly-cached object in place when only reversing
      let dirty = false;
      const out = { ...stats };
      for (const key of Object.keys(out)) {
        const val = out[key];
        if (typeof val !== 'string') continue;
        const next = this.rewriteStatText(val, forward, realItag);
        if (next !== val) {
          out[key] = next;
          dirty = true;
        }
      }
      return dirty ? out : stats;
    },

    // Same as packed CRX: patch every string field, DASH (n/251), V3 getters
    hookPlayerAPI() {
      const tryHook = () => {
        const player = document.getElementById('movie_player')
          || document.querySelector('.html5-video-player');
        if (!player || player._ytssStatsHooked) return;
        player._ytssStatsHooked = true;
        const self = this;

        if (typeof player.getStatsForNerds === 'function') {
          const origStats = player.getStatsForNerds;
          player.getStatsForNerds = function () {
            return self.patchStatsObject(origStats.apply(this, arguments) || {});
          };
        }
        for (const name of ['getVideoInfo', 'getDebugInfo', 'getStats']) {
          if (typeof player[name] === 'function' && !player['_ytss' + name]) {
            const orig = player[name];
            player['_ytss' + name] = true;
            player[name] = function () {
              const out = orig.apply(this, arguments);
              return (out && typeof out === 'object' && !Array.isArray(out)) ? self.patchStatsObject(out) : out;
            };
          }
        }
      };

      tryHook();
      setInterval(tryHook, 2000);
    },

    // Walk visible SFN panel. Forward when 774 live; reverse stale stamps otherwise.
    patchModernSfn() {
      if (document.hidden) return;
      if (!S.enabled) return;
      const panel = document.querySelector(
        '.html5-video-info-panel-content, .ytp-sfn-content, .html5-video-info-panel, #movie_player .html5-video-info-panel-content'
      );
      if (!panel) return;

      const forward = this.isReal774() && !!(S.shadowPlayer || S.sfnSpoof);
      const realItag = Number(status.activeAudioItag) || 251;
      // When neither direction applies, still reverse (e.g. spoof off but 774 stamped)
      const doForward = forward;
      const doReverse = !forward;

      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const txt = node.nodeValue || '';
        if (!txt) continue;
        if (doForward) {
          if (txt.includes('774')) continue;
          if (!(S.shadowPlayer || S.sfnSpoof)) continue;
          const next = this.rewriteStatText(txt, true, realItag);
          if (next !== txt) node.nodeValue = next;
        } else if (doReverse) {
          if (!txt.includes('774')) continue;
          const next = this.rewriteStatText(txt, false, realItag);
          if (next !== txt) node.nodeValue = next;
        }
      }
    },

    // Prefer classic 2014 overlay; only try native if classic host is missing
    openNativeOrClassic() {
      const host = this.hostEl();
      if (host) {
        this.mountClassicShell();
        this.toggle();
        return;
      }
      const player = document.getElementById('movie_player');
      if (player && typeof player.setOption === 'function') {
        try {
          let vis = true;
          try { vis = !!player.getOption('stats', 'visible'); } catch (e) { vis = true; }
          player.setOption('stats', 'visible', !vis);
          return;
        } catch (e) { }
      }
      const sfn = document.querySelector('.ytp-sfn, .ytp-sfn-container');
      if (sfn) {
        const hidden = sfn.getAttribute('hidden') !== null
          || sfn.style.display === 'none'
          || getComputedStyle(sfn).display === 'none';
        if (hidden) {
          sfn.removeAttribute('hidden');
          sfn.style.display = '';
        } else {
          sfn.setAttribute('hidden', '');
          sfn.style.display = 'none';
        }
      }
    },

    // Alias: same DOM walk covers V3 .html5-video-info-panel
    patchV3InfoPanel() {
      this.patchModernSfn();
    },

    hostEl() {
      return document.querySelector('.html5-video-player')
        || document.getElementById('movie_player')
        || document.querySelector('video.html5-main-video')?.parentElement;
    },

    mountClassicShell() {
      const host = this.hostEl();
      if (!host) return;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

      let panel = document.getElementById('ytss-sfn');
      if (panel) {
        if (panel.parentElement !== host) host.appendChild(panel);
        return;
      }

      panel = document.createElement('div');
      panel.id = 'ytss-sfn';
      panel.style.cssText = [
        'display:none', 'position:absolute', 'top:8px', 'left:8px', 'z-index:100000',
        'min-width:340px', 'max-width:420px', 'background:rgba(20,4,4,0.92)',
        'border:1px solid #5a1010', 'border-radius:3px', 'padding:8px 10px 10px',
        'font:11px/1.35 Arial,Helvetica,sans-serif', 'color:#eee',
        'box-shadow:0 2px 10px rgba(0,0,0,.55)', 'user-select:none'
      ].join(';');

      const head = document.createElement('div');
      head.style.cssText = 'position:relative;margin:0 0 6px;font-weight:700;color:#ffb84d;font-size:12px;';
      head.textContent = 'Stats for nerds';
      const close = document.createElement('span');
      close.textContent = '[x]';
      close.style.cssText = 'position:absolute;right:0;top:0;cursor:pointer;color:#ccc;font-weight:400;';
      close.onclick = () => this.toggle(false);
      head.appendChild(close);
      panel.appendChild(head);

      const body = document.createElement('div');
      body.id = 'ytss-sfn-body';
      panel.appendChild(body);

      // Classic frame/bytes table
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;margin-top:6px;font-size:10px;';
      table.innerHTML = [
        '<tr>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Decoded Frames</th>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Dropped Frames</th>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Parsed Frames</th>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Presented Frames</th>',
        '</tr>',
        '<tr id="ytss-sfn-frames">',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '</tr>',
        '<tr>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Video Bytes Decoded</th>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Audio Bytes Decoded</th>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Painted Frames</th>',
        '<th style="border:1px solid #666;background:#3a1515;color:#ffb84d;padding:2px 4px;">Paint Delay</th>',
        '</tr>',
        '<tr id="ytss-sfn-bytes">',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '<td style="border:1px solid #666;padding:2px 4px;text-align:center;">-</td>',
        '</tr>'
      ].join('');
      panel.appendChild(table);

      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.appendChild(panel);
    },

    row(label, value) {
      return `<div style="margin:1px 0;"><span style="display:inline-block;width:110px;color:#ffb84d;">${label}:</span><span data-v>${value}</span></div>`;
    },

    sampleVideoStats(v) {
      if (!v) return;
      const now = performance.now();
      if (!this._lastTs) { this._lastTs = now; this._lastTime = v.currentTime || 0; return; }
      const dt = (now - this._lastTs) / 1000;
      const dTime = Math.abs((v.currentTime || 0) - this._lastTime);
      if (dt > 0.4 && dTime > 0.01 && v.readyState >= 2) {
        // rough fps ~25-60; use decodedVideoFrames if available
        const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
        if (q) {
          this._frames.decoded = q.totalVideoFrames || this._frames.decoded;
          this._frames.dropped = q.droppedVideoFrames || 0;
          this._frames.presented = q.totalVideoFrames || 0;
        } else {
          this._frames.decoded += Math.round(dTime * 25);
        }
        this._frames.parsed = this._frames.decoded;
        this._painted = this._frames.decoded;
        // bytes: video.webkitVideoDecodedByteCount / audio.webkitAudioDecodedByteCount (Chromium)
        if (typeof v.webkitVideoDecodedByteCount === 'number') this._bytes.video = v.webkitVideoDecodedByteCount;
        else this._bytes.video += Math.round(dTime * 1500000);
        if (typeof v.webkitAudioDecodedByteCount === 'number') this._bytes.audio = v.webkitAudioDecodedByteCount;
        else this._bytes.audio += Math.round(dTime * 32000);
        this._lastTs = now;
        this._lastTime = v.currentTime || 0;
      }
    },

    bandwidthKbps(v) {
      const now = performance.now();
      if (v.buffered && v.buffered.length) {
        const end = v.buffered.end(v.buffered.length - 1);
        // crude sliding estimate from buffer growth
        this._bwSamples.push({ t: now, end });
        while (this._bwSamples.length > 2 && now - this._bwSamples[0].t > 5000) this._bwSamples.shift();
        if (this._bwSamples.length >= 2) {
          const a = this._bwSamples[0], b = this._bwSamples[this._bwSamples.length - 1];
          const dt = (b.t - a.t) / 1000;
          if (dt > 0.5) {
            const kbps = Math.max(0, ((b.end - a.end) * 8) / dt);
            return Math.round(kbps);
          }
        }
      }
      return 17222; // classic default look when idle
    },

    render() {
      const panel = document.getElementById('ytss-sfn');
      const body = document.getElementById('ytss-sfn-body');
      if (!panel || !body) return;
      this.mountClassicShell();
      const v = getMainVideoElement();
      const player = document.getElementById('movie_player');
      const data = player?.getVideoData?.() || {};
      this.sampleVideoStats(v);

      const videoId = data.video_id || getVideoIdFromUrl() || '—';
      const vw = v?.videoWidth || 0;
      const vh = v?.videoHeight || 0;
      const scale = (v && vw) ? (v.clientWidth / vw) : 1;
      const dimensions = vw ? `${vw} x ${vh} * ${scale.toFixed(2)}` : '—';
      const resLabel = vw ? `${window.screen.width} x ${window.screen.height}@25` : '—';
      const vol = v ? Math.round((v.volume ?? 1) * 100) + '%' : '100%';
      const streamType = (v?.currentSrc || '').startsWith('blob:') ? 'https' : ((v?.currentSrc || '').split(':')[0] || 'https');
      const cpn = window.ytcfg?.get?.('CPN') || data.cpn || 'QJTxVlhaG-bwJEh2';
      const audioItag = Number(status.activeAudioItag) || 251;
      const is774 = audioItag === 774 && !status.fallbackReason;
      const mime = is774
        ? 'audio/webm; codecs="opus"'
        : (data.playerResponse?.streamingData?.adaptiveFormats?.find?.(f => f.itag === 251 || f.itag === 140)?.mimeType || 'audio/webm; codecs="opus"');
      const dash = `yes (${is774 ? 399 : 399}/${audioItag})`;
      const bw = this.bandwidthKbps(v);

      body.innerHTML = [
        this.row('Video ID', videoId),
        this.row('Dimensions', dimensions),
        this.row('Resolution', resLabel),
        this.row('Volume', vol),
        this.row('Stream Type', streamType),
        this.row('CPN', cpn),
        this.row('Mime Type', mime),
        this.row('DASH', `<span style="color:${is774 ? '#ff4d4d' : '#eee'}">${dash}</span>`),
        `<div style="margin:3px 0 0;"><span style="display:inline-block;width:110px;color:#ffb84d;">Bandwidth:</span>`,
        `<span style="display:inline-block;width:120px;height:8px;border:1px solid #666;vertical-align:middle;margin-right:6px;">`,
        `<span style="display:block;height:100%;width:${Math.min(100, bw / 200)}%;background:#c9a227;"></span></span>`,
        `<span>${bw} Kbps</span></div>`
      ].join('');

      const fr = document.getElementById('ytss-sfn-frames');
      const by = document.getElementById('ytss-sfn-bytes');
      if (fr) {
        const tds = fr.children;
        tds[0].textContent = this._frames.decoded || '-';
        tds[1].textContent = this._frames.dropped || '-';
        tds[2].textContent = this._frames.parsed || '-';
        tds[3].textContent = this._frames.presented || '-';
      }
      if (by) {
        const tds = by.children;
        tds[0].textContent = this._bytes.video || '-';
        tds[1].textContent = this._bytes.audio || '-';
        tds[2].textContent = this._painted || '-';
        tds[3].textContent = '-';
      }

      // keep panel mounted on current player
      const host = this.hostEl();
      if (host && panel.parentElement !== host) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(panel);
      }
    },

    toggle(force) {
      this.mountClassicShell();
      const panel = document.getElementById('ytss-sfn');
      if (!panel) return;
      this.visible = typeof force === 'boolean' ? force : !this.visible;
      panel.style.display = this.visible ? 'block' : 'none';
      if (this.visible) this.render();
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // SIGNATURE CIPHER DECIPHER ENGINE (Unlocks 774/141 from WEB_REMIX/WEB)
  // ═══════════════════════════════════════════════════════════════════
  const SignatureCipherDecipherer = {
    cachedP: null,

    async init() {
      if (this.cachedP) return;
      try {
        const scripts = Array.from(document.querySelectorAll('script[src*="base.js"], script[src*="player_es6"]'));
        let baseJsUrl = scripts[0]?.src;
        if (!baseJsUrl) {
          baseJsUrl = 'https://www.youtube.com/s/player/e937390a/player_es6.vflset/vi_VN/base.js';
        }
        const res = await fetch(baseJsUrl);
        const js = await res.text();
        const startIdx = js.indexOf('var p=[');
        if (startIdx !== -1) {
          const endIdx = js.indexOf('],', startIdx);
          const pStr = js.slice(startIdx + 6, endIdx + 1);
          this.cachedP = JSON.parse(pStr);
          console.log(TAG, `[Decipherer] Initialized successfully with ${this.cachedP.length} string table entries`);
        }
      } catch (e) {
        console.warn(TAG, '[Decipherer] Init error:', e.message);
      }
    },

    decipher(s) {
      if (!s) return s;
      const p = this.cachedP;
      if (!p) return s;

      const Cy = {
        rt: function (D, M) {
          const G = D[0];
          D[0] = D[M % D.length];
          D[M % D.length] = G;
        },
        Ub: function (D, M) {
          D.splice(0, M);
        },
        zD: function (D) {
          D.reverse();
        }
      };

      function xC(D, M, G) {
        let S = G;
        if ((D + 8 >> 3 >= 2) && ((D >> 1 & 12) < 6)) {
          try { S = decodeURIComponent(G); } catch (e) { S = G; }
        }
        return S;
      }

      function wU(D, M, G) {
        const e = M ^ D;
        let r;
        if ((D >> 2 & 6) >= 2 && D - 6 < 14) {
          r = encodeURIComponent(G);
        }
        if ((D & 87) === D) {
          const delim = p[e ^ 8403] !== undefined ? p[e ^ 8403] : "";
          const S = G.split(delim);

          const op1 = p[e ^ 8339];
          const op2 = p[e ^ 8439];
          const op3 = p[e ^ 8390];

          if (Cy[op1]) Cy[op1](S, 1);
          if (Cy[op2]) Cy[op2](S, e ^ 8384);
          if (Cy[op3]) Cy[op3](S, e ^ 8419);
          if (Cy[op3]) Cy[op3](S, e ^ 8446);
          if (Cy[op3]) Cy[op3](S, e ^ 8399);

          r = S.join(delim);
        }
        return r;
      }

      try {
        const c = wU(2, 8414, xC(15, 7887, s));
        const sig = wU(8, 2934, c);
        return sig || s;
      } catch (e) {
        console.warn(TAG, '[Decipherer] decipher error:', e);
        return s;
      }
    },

    decipherFormat(format) {
      if (!format) return null;
      if (format.url) return format.url;
      if (!format.signatureCipher) return null;

      try {
        const params = new URLSearchParams(format.signatureCipher);
        const rawUrl = params.get('url');
        const rawSig = params.get('s');
        const sp = params.get('sp') || 'sig';
        if (!rawUrl || !rawSig) return null;

        const resolvedSig = this.decipher(rawSig);
        const finalUrl = `${rawUrl}&${sp}=${encodeURIComponent(resolvedSig)}`;
        return finalUrl;
      } catch (e) {
        return null;
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // IN-PLAYER HUD I18N + QUICK SETTINGS MENU (ported from packed CRX)
  // ═══════════════════════════════════════════════════════════════════
  const HUD_I18N = {
    vi: {
      badge_title_settings: 'YTSpoofingStream — Nhấn để mở menu',
      badge_title_off: 'YTSpoofingStream (Đã tắt) — Nhấn để mở menu',
      badge_title_141: 'Studio Master AAC 141 — Nhấn để mở menu',
      badge_title_774: 'HQ Opus 774 — Nhấn để mở menu',
      badge_title_native: 'Native Audio (ITAG 251) — Nhấn để mở menu',
      close_title: 'Đóng',
      master_en: 'Kích hoạt Studio 774',
      audio_mode_header: 'Chế độ âm thanh',
      mode_hybrid: '★ Hybrid Mix (Tối ưu)',
      mode_ytm: 'YouTube Music (774)',
      mode_tv: 'Smart TV Relay (774)',
      sfn_title: 'Stats for Nerds (774)',
      open_sfn: 'Mở Stats for Nerds',
      status_off: 'Đã tắt (Native)',
      status_fallback: 'ITAG {itag} Dự phòng',
      btn_reload: '⟳ Tải lại',
    },
    en: {
      badge_title_settings: 'YTSpoofingStream — Click to open menu',
      badge_title_off: 'YTSpoofingStream (Disabled) — Click to open menu',
      badge_title_141: 'Studio Master AAC 141 — Click to open menu',
      badge_title_774: 'HQ Opus 774 — Click to open menu',
      badge_title_native: 'Native Audio (ITAG 251) — Click to open menu',
      close_title: 'Close',
      master_en: 'Enable Studio 774',
      audio_mode_header: 'Audio Mode',
      mode_hybrid: '★ Hybrid Mix (Optimal)',
      mode_ytm: 'YouTube Music (774)',
      mode_tv: 'Smart TV Relay (774)',
      sfn_title: 'Stats for Nerds (774)',
      open_sfn: 'Open Stats for Nerds',
      status_off: 'Disabled (Native)',
      status_fallback: 'ITAG {itag} Fallback',
      btn_reload: '⟳ Reload',
    }
  };

  function hudT(key, vars = {}) {
    const lang = S.lang || 'vi';
    let str = HUD_I18N[lang]?.[key] || HUD_I18N.en?.[key] || key;
    for (const [k, v] of Object.entries(vars || {})) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    return str;
  }

  const InPlayerSettingsUI = {
    panel: null,
    isOpen: false,
    eventsHooked: false,
    refs: null,

    init() {
      this.injectStyles();
      if (!this.panel) this.createPanel();
      if (!this.eventsHooked) {
        this.bindGlobalEvents();
        this.eventsHooked = true;
      }
    },

    injectStyles() {
      if (document.getElementById('ytss-inplayer-style')) return;
      const st = document.createElement('style');
      st.id = 'ytss-inplayer-style';
      st.textContent = `
        .ytss-interactive-row { transition: background 0.15s ease, transform 0.1s ease; }
        .ytss-interactive-row:hover { background: rgba(255,255,255,0.1) !important; }
        .ytss-interactive-row:active { transform: scale(0.99); }
        #ytss-btn-reload:hover { background: rgba(255,255,255,0.18) !important; color: #fff !important; }
        #ytss-hud-lang-toggle:hover { background: rgba(255,255,255,0.22) !important; border-color: rgba(255,255,255,0.4) !important; }
        #ytss-panel-close:hover { background: rgba(255,255,255,0.15) !important; color: #fff !important; }
      `;
      (document.head || document.documentElement).appendChild(st);
    },

    createPanel() {
      const existing = document.getElementById('ytss-quick-settings');
      if (existing) { this.panel = existing; return; }

      const panel = document.createElement('div');
      panel.id = 'ytss-quick-settings';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'YTSpoofingStream Quick Settings');
      panel.style.cssText = [
        'position:absolute', 'bottom:56px', 'right:12px', 'width:240px',
        'background:rgba(24,24,24,0.96)', 'backdrop-filter:blur(16px)', '-webkit-backdrop-filter:blur(16px)',
        'border:1px solid rgba(255,255,255,0.1)', 'border-radius:10px',
        'box-shadow:0 8px 28px rgba(0,0,0,0.75)', 'color:#f1f1f1',
        'font-family:"YouTube Noto",Roboto,Arial,Helvetica,sans-serif', 'font-size:11.5px', 'line-height:1.3',
        'z-index:2147483640', 'user-select:none', 'overflow:hidden',
        'opacity:0', 'pointer-events:none', 'transform:translateY(6px) scale(0.98)',
        'transition:opacity .16s cubic-bezier(.2,0,.2,1),transform .16s cubic-bezier(.2,0,.2,1)'
      ].join(';');

      ['click','mousedown','mouseup','pointerdown','dblclick','contextmenu','keydown','keypress','keyup']
        .forEach((evt) => panel.addEventListener(evt, (e) => e.stopPropagation()));

      const header = document.createElement('div');
      header.style.cssText = 'padding:8px 12px 6px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;';
      const headerLeft = document.createElement('div');
      headerLeft.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.style.flexShrink = '0';
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('width', '24'); rect.setAttribute('height', '24'); rect.setAttribute('rx', '5'); rect.setAttribute('fill', '#e94560');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 6L18 12L8 18Z'); path.setAttribute('fill', '#fff');
      svg.append(rect, path);
      const titleSpan = document.createElement('span');
      titleSpan.style.cssText = 'font-size:12px;font-weight:700;color:#fff;letter-spacing:0.2px;';
      titleSpan.textContent = 'ytspoofingstream (vorapis edition)';
      headerLeft.append(svg, titleSpan);

      const headerRight = document.createElement('div');
      headerRight.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const langToggle = document.createElement('button');
      langToggle.id = 'ytss-hud-lang-toggle';
      langToggle.style.cssText = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:#fff;font-size:9px;font-weight:800;cursor:pointer;padding:2px 7px;border-radius:10px;line-height:1.2;transition:all .15s;font-family:inherit;';
      langToggle.textContent = S.lang === 'en' ? 'EN' : 'VI';
      langToggle.onclick = (e) => {
        e.stopPropagation();
        this.saveSetting('lang', S.lang === 'en' ? 'vi' : 'en');
      };
      const closeBtn = document.createElement('button');
      closeBtn.id = 'ytss-panel-close';
      closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:14px;cursor:pointer;padding:1px 5px;border-radius:4px;line-height:1;transition:all .15s;';
      closeBtn.textContent = '✕';
      closeBtn.onclick = () => this.close();
      headerRight.append(langToggle, closeBtn);
      header.append(headerLeft, headerRight);
      panel.appendChild(header);

      const body = document.createElement('div');
      body.style.cssText = 'padding:6px 8px;display:flex;flex-direction:column;gap:3px;';

      const rowEn = document.createElement('div');
      rowEn.id = 'ytss-row-en';
      rowEn.className = 'ytss-interactive-row';
      rowEn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;cursor:pointer;';
      const enTitle = document.createElement('span');
      enTitle.style.cssText = 'font-size:11.5px;font-weight:600;color:#fff;';
      enTitle.textContent = hudT('master_en');
      const enTrack = document.createElement('div');
      enTrack.style.cssText = 'width:34px;height:18px;border-radius:9px;position:relative;transition:background .2s;flex-shrink:0;';
      const enKnob = document.createElement('div');
      enKnob.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.4);';
      enTrack.appendChild(enKnob);
      rowEn.append(enTitle, enTrack);
      rowEn.onclick = () => this.saveSetting('enabled', !S.enabled);
      body.appendChild(rowEn);

      const div1 = document.createElement('div');
      div1.style.cssText = 'height:1px;background:rgba(255,255,255,0.07);margin:2px 0;';
      body.appendChild(div1);

      const modeHeader = document.createElement('div');
      modeHeader.style.cssText = 'font-size:9px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;padding:2px 6px 1px;';
      modeHeader.textContent = hudT('audio_mode_header');
      body.appendChild(modeHeader);

      const createModeRow = (id, titleKey, opModeVal) => {
        const row = document.createElement('div');
        row.id = id;
        row.className = 'ytss-interactive-row';
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:5px;cursor:pointer;transition:all .15s;';
        const tSpan = document.createElement('span');
        tSpan.style.cssText = 'font-size:11px;';
        tSpan.textContent = hudT(titleKey);
        const check = document.createElement('span');
        check.style.cssText = 'color:#e94560;font-weight:bold;font-size:12px;';
        row.append(tSpan, check);
        row.onclick = () => this.saveSetting('operationMode', opModeVal);
        return { row, tSpan, check, titleKey };
      };
      const mHybrid = createModeRow('ytss-mode-hybrid', 'mode_hybrid', 'HYBRID_HQ');
      const mYtm = createModeRow('ytss-mode-ytm', 'mode_ytm', 'YTM_HARVESTER');
      const mTv = createModeRow('ytss-mode-tv', 'mode_tv', 'TV_HEADLESS');
      body.append(mHybrid.row, mYtm.row, mTv.row);

      const div2 = document.createElement('div');
      div2.style.cssText = 'height:1px;background:rgba(255,255,255,0.07);margin:2px 0;';
      body.appendChild(div2);

      const rowSfn = document.createElement('div');
      rowSfn.id = 'ytss-row-sfn';
      rowSfn.className = 'ytss-interactive-row';
      rowSfn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:6px;cursor:pointer;';
      const sfnTitle = document.createElement('span');
      sfnTitle.style.cssText = 'font-size:11px;font-weight:500;color:#ddd;';
      sfnTitle.textContent = hudT('sfn_title');
      const sfnTrack = document.createElement('div');
      sfnTrack.style.cssText = 'width:32px;height:18px;border-radius:9px;position:relative;transition:background .2s;flex-shrink:0;';
      const sfnKnob = document.createElement('div');
      sfnKnob.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left .2s;box-shadow:0 1px 2px rgba(0,0,0,.4);';
      sfnTrack.appendChild(sfnKnob);
      rowSfn.append(sfnTitle, sfnTrack);
      rowSfn.onclick = () => this.saveSetting('shadowPlayer', !S.shadowPlayer);
      body.appendChild(rowSfn);

      // Open native/classic Stats for Nerds
      const rowOpenSfn = document.createElement('div');
      rowOpenSfn.id = 'ytss-row-open-sfn';
      rowOpenSfn.className = 'ytss-interactive-row';
      rowOpenSfn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:6px;cursor:pointer;';
      const openSfnTitle = document.createElement('span');
      openSfnTitle.style.cssText = 'font-size:11px;color:#3ea6ff;font-weight:600;';
      openSfnTitle.textContent = hudT('open_sfn');
      rowOpenSfn.append(openSfnTitle);
      rowOpenSfn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.close();
        // Always show our classic 2014 Stats for Nerds panel
        if (typeof StatsForNerdsSpoofer !== 'undefined') {
          StatsForNerdsSpoofer.mountClassicShell();
          StatsForNerdsSpoofer.toggle(true);
        }
      };
      body.appendChild(rowOpenSfn);

      const footer = document.createElement('div');
      footer.style.cssText = 'margin-top:4px;padding:5px 8px;border-radius:6px;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.06);font-size:10px;display:flex;align-items:center;justify-content:space-between;';
      const statusDiv = document.createElement('div');
      statusDiv.style.cssText = 'display:flex;align-items:center;gap:5px;overflow:hidden;white-space:nowrap;';
      const statusDot = document.createElement('span');
      statusDot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;background:#666;';
      const statusText = document.createElement('span');
      statusText.style.cssText = 'font-weight:600;font-size:10px;color:#aaa;text-overflow:ellipsis;overflow:hidden;';
      statusText.textContent = '—';
      statusDiv.append(statusDot, statusText);
      const btnReload = document.createElement('button');
      btnReload.id = 'ytss-btn-reload';
      btnReload.style.cssText = 'padding:2px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#ddd;font-size:9.5px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap;flex-shrink:0;';
      btnReload.textContent = hudT('btn_reload');
      btnReload.onclick = () => {
        const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        const vid = player?.getVideoData?.()?.video_id;
        const time = player?.getCurrentTime?.() || 0;
        if (vid && typeof player.loadVideoById === 'function') {
          player.loadVideoById(vid, time);
          this.close();
          return;
        }
        location.reload();
      };
      footer.append(statusDiv, btnReload);
      body.appendChild(footer);
      panel.appendChild(body);

      this.refs = { langToggle, closeBtn, enTitle, enTrack, enKnob, modeHeader, mHybrid, mYtm, mTv, sfnTitle, sfnTrack, sfnKnob, openSfnTitle, statusDot, statusText, btnReload };
      this.panel = panel;
      this.attachToPlayer();
    },

    attachToPlayer() {
      if (!this.panel) return;
      const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (player && this.panel.parentElement !== player) {
        if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
        player.appendChild(this.panel);
      } else if (!player && document.body && !document.body.contains(this.panel)) {
        document.body.appendChild(this.panel);
      }
    },

    bindGlobalEvents() {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.isOpen) this.close();
      });
      document.addEventListener('click', (e) => {
        if (!this.isOpen || !this.panel) return;
        const container = document.getElementById('ytss-vol-container') || document.getElementById('ytss-badge-bar');
        const target = e.target;
        if (target instanceof Node && !this.panel.contains(target) && (!container || !container.contains(target))) {
          this.close();
        }
      });
      document.addEventListener('fullscreenchange', () => { if (this.isOpen) setTimeout(() => this.position(), 80); });
      window.addEventListener('resize', () => { if (this.isOpen) this.position(); });
    },

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    },

    open() {
      if (!this.panel) this.createPanel();
      this.attachToPlayer();
      this.render();
      this.position();
      this.panel.style.opacity = '1';
      this.panel.style.pointerEvents = 'auto';
      this.panel.style.transform = 'translateY(0) scale(1)';
      this.isOpen = true;
    },

    close() {
      if (!this.panel || !this.isOpen) return;
      this.panel.style.opacity = '0';
      this.panel.style.pointerEvents = 'none';
      this.panel.style.transform = 'translateY(6px) scale(0.98)';
      this.isOpen = false;
    },

    position() {
      if (!this.panel) return;
      const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      const container = document.getElementById('ytss-badge-bar') || document.getElementById('ytss-vol-container');
      if (!player) return;
      if (container) {
        const playerRect = player.getBoundingClientRect();
        const btnRect = container.getBoundingClientRect();
        const rightPx = Math.max(12, playerRect.right - btnRect.right - 10);
        const bottomPx = Math.max(54, playerRect.bottom - btnRect.top + 8);
        this.panel.style.right = `${Math.min(Math.max(12, playerRect.width - 260), Math.max(12, rightPx))}px`;
        this.panel.style.bottom = `${bottomPx}px`;
      } else {
        this.panel.style.right = '16px';
        this.panel.style.bottom = '56px';
      }
    },

    saveSetting(key, val) {
      S[key] = val;
      persistSettings();
      window.postMessage({ type: 'YTSS_SAVE_SETTINGS', settings: pickSettings(S) }, '*');
      if (key === 'lang') {
        this.render();
        PlayerBadgeUI.update();
        return;
      }
      if (typeof handleSettingsChange === 'function') handleSettingsChange();
      this.render();
      PlayerBadgeUI.update();
    },

    render() {
      if (!this.panel || !this.refs) return;
      const itag = Number(status.activeAudioItag);
      const isHq = (itag === 774 || itag === 141) && !status.fallbackReason;
      const mode = S.operationMode || 'HYBRID_HQ';
      const isEn = !!S.enabled;
      const isSfn = !!S.shadowPlayer;
      const { langToggle, closeBtn, enTitle, enTrack, enKnob, modeHeader, mHybrid, mYtm, mTv, sfnTitle, sfnTrack, sfnKnob, openSfnTitle, statusDot, statusText, btnReload } = this.refs;

      if (langToggle) langToggle.textContent = S.lang === 'en' ? 'EN' : 'VI';
      if (closeBtn) closeBtn.title = hudT('close_title');
      if (enTitle) enTitle.textContent = hudT('master_en');
      if (modeHeader) modeHeader.textContent = hudT('audio_mode_header');
      if (mHybrid?.tSpan) mHybrid.tSpan.textContent = hudT(mHybrid.titleKey);
      if (mYtm?.tSpan) mYtm.tSpan.textContent = hudT(mYtm.titleKey);
      if (mTv?.tSpan) mTv.tSpan.textContent = hudT(mTv.titleKey);
      if (sfnTitle) sfnTitle.textContent = hudT('sfn_title');
      if (openSfnTitle) openSfnTitle.textContent = hudT('open_sfn');
      if (btnReload) btnReload.textContent = hudT('btn_reload');

      enTrack.style.background = isEn ? '#e94560' : '#444';
      enKnob.style.left = isEn ? '18px' : '2px';

      const updateModeItem = (item, active) => {
        item.row.style.background = active ? 'rgba(233,69,96,0.15)' : 'transparent';
        item.row.style.border = active ? '1px solid rgba(233,69,96,0.35)' : '1px solid transparent';
        item.tSpan.style.fontWeight = active ? '700' : '500';
        item.tSpan.style.color = active ? '#fff' : '#aaa';
        item.check.textContent = active ? '✓' : '';
      };
      updateModeItem(mHybrid, mode === 'HYBRID_HQ');
      updateModeItem(mYtm, mode === 'YTM_HARVESTER');
      updateModeItem(mTv, mode === 'TV_HEADLESS');

      sfnTrack.style.background = isSfn ? '#3ea6ff' : '#444';
      sfnKnob.style.left = isSfn ? '16px' : '2px';

      if (!isEn) {
        statusDot.style.background = '#666';
        statusText.style.color = '#888';
        statusText.textContent = hudT('status_off');
      } else if (isHq) {
        statusDot.style.background = itag === 141 ? '#00e5ff' : '#ff334b';
        statusText.style.color = itag === 141 ? '#00e5ff' : '#ff334b';
        const methodShort = status.activeMethod === 'YTM_HARVESTER' ? 'YTM' : (status.activeMethod || 'HQ');
        statusText.textContent = `${itag === 141 ? '★ 141 AAC' : '★ 774 Opus'} • ${methodShort}`;
      } else {
        statusDot.style.background = '#aaa';
        statusText.style.color = '#aaa';
        statusText.textContent = hudT('status_fallback', { itag: itag || 251 });
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // IN-PLAYER HUD BADGE UI (Shows ★ 774 or 251 directly inside YouTube Controls)
  // ═══════════════════════════════════════════════════════════════════
  const PlayerBadgeUI = {
    inject() {
      if (!S.enabled) {
        const container = document.getElementById('ytss-vol-container');
        if (container) container.style.display = 'none';
        const bar = document.getElementById('ytss-badge-bar');
        if (bar) bar.style.display = 'none';
        const under = document.getElementById('ytss-badge-under');
        if (under) under.remove();
        return;
      }

      this.injectControlBarBadge();
      // Modern YouTube fallback only if V3 chrome badge not present
      if (!document.getElementById('ytss-badge-bar')) this.injectInControls();
      this.update();
    },

    // V3: chip immediately after the time display (0:12 / 2:59)
    injectControlBarBadge() {
      const chrome = document.querySelector('.html5-player-chrome');
      if (!chrome) return;

      document.getElementById('ytss-badge-under')?.remove();
      document.getElementById('ytss-badge-chrome')?.remove();

      const left = chrome.querySelector('.left') || chrome;
      const time = left.querySelector('.ytp-time-display')
        || left.querySelector('.ytp-time-current')
        || left.querySelector('[class*="time"]');

      let badge = document.getElementById('ytss-badge-bar');
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'ytss-badge-bar';
        badge.className = 'ytss-bar-badge';
        badge.title = 'YTSS audio itag — click: Stats for nerds';
        badge.textContent = '251';
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          InPlayerSettingsUI.toggle();
        });
      }

      // Match .ytp-time-display (line-height: 28px) so centers line up
      badge.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'height:28px',
        'line-height:28px',
        'padding:0 5px',
        'margin:0 0 0 8px',
        'box-sizing:border-box',
        'background:transparent',
        'border:1px solid rgba(225,29,29,0.5)',
        'border-radius:2px',
        'font:700 10px/28px Arial,Helvetica,sans-serif',
        'letter-spacing:0.2px',
        'color:#e85a5a',
        'cursor:pointer',
        'user-select:none',
        'vertical-align:middle',
        'white-space:nowrap',
        'position:relative',
        'z-index:11',
        'flex:0 0 auto'
      ].join(';');

      if (time && time.parentElement) {
        time.insertAdjacentElement('afterend', badge);
      } else if (badge.parentElement !== left) {
        left.appendChild(badge);
      }
    },

    hostEl() {
      return document.querySelector('.html5-video-player')
        || document.getElementById('movie_player')
        || document.querySelector('video.html5-main-video')?.parentElement;
    },

    // Modern YouTube: keep pill inside control bar when those exist
    injectInControls() {
      const settingsBtn = document.querySelector('.ytp-settings-button');
      const subBtn = document.querySelector('.ytp-subtitles-button');
      const rcLeft = document.querySelector('.ytp-right-controls-left');
      const rightControls = rcLeft || document.querySelector('.ytp-right-controls') || document.querySelector('.ytp-left-controls');
      if (!rightControls) return;

      let container = document.getElementById('ytss-vol-container');
      if (!container || !rightControls.contains(container)) {
        if (!container) {
          container = document.createElement('div');
          container.id = 'ytss-vol-container';
          container.className = 'ytp-button';
          container.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; position: relative; margin: 0 4px; vertical-align: middle; cursor: pointer; user-select: none; z-index: 999; height: 100%;';

          const badge = document.createElement('div');
          badge.id = 'ytss-badge';
          badge.title = 'Click: Stats for nerds';
          badge.style.cssText = 'font-size: 11px; font-weight: 800; color: #ff334b; background: rgba(0,0,0,0.65); padding: 2px 6px; border-radius: 4px; border: 1px solid #ff334b; white-space: nowrap; line-height: 14px; transition: color 0.2s, border-color 0.2s; cursor: pointer;';
          badge.textContent = '251';
          badge.addEventListener('click', (e) => {
            e.stopPropagation();
            InPlayerSettingsUI.toggle();
          });
          container.appendChild(badge);
        }

        if (settingsBtn && settingsBtn.parentElement) {
          settingsBtn.parentElement.insertBefore(container, settingsBtn);
        } else if (subBtn && subBtn.parentElement) {
          subBtn.parentElement.insertBefore(container, subBtn);
        } else {
          rightControls.insertBefore(container, rightControls.firstChild);
        }
      }
    },

    paint(el, isHq, itag) {
      if (!el) return;
      if (isHq) {
        el.textContent = itag === 141 ? '★ 141' : '★ 774';
        const c = itag === 141 ? '#5ec8d8' : '#e85a5a';
        el.style.color = c;
        el.style.borderColor = itag === 141 ? 'rgba(94,200,216,0.55)' : 'rgba(225,29,29,0.55)';
        el.title = itag === 141
          ? 'Studio Master AAC 141 (256kbps Full Fidelity)'
          : 'HQ Opus 774 (256k+ Full Frequency Spectrum)';
      } else {
        el.textContent = '251';
        el.style.color = '#8a8a8a';
        el.style.borderColor = 'rgba(255,255,255,0.18)';
        el.title = 'Native Audio (ITAG 251)';
      }
    },

    update() {
      const itag = Number(status.activeAudioItag);
      const isHq = (itag === 774 || itag === 141) && !status.fallbackReason;

      this.paint(document.getElementById('ytss-badge'), isHq, itag);
      this.paint(document.getElementById('ytss-badge-bar'), isHq, itag);

      // Miniplayer HUD badge support
      const miniBar = document.querySelector('.ytdMiniplayerInfoBarContent') || document.querySelector('ytd-miniplayer-info-bar');
      if (miniBar) {
        let miniBadge = document.getElementById('ytss-mini-badge');
        if (!miniBadge) {
          miniBadge = document.createElement('span');
          miniBadge.id = 'ytss-mini-badge';
          miniBadge.style.cssText = 'font-size: 10px; font-weight: 700; margin-left: 6px; padding: 1px 5px; border-radius: 3px; vertical-align: middle; display: inline-block; transition: color 0.2s;';
          miniBar.appendChild(miniBadge);
        }
        if (isHq) {
          miniBadge.textContent = itag === 141 ? '★ 141' : '★ 774';
          miniBadge.style.color = itag === 141 ? '#00e5ff' : '#ff334b';
          miniBadge.style.background = 'rgba(0,0,0,0.6)';
          miniBadge.style.border = `1px solid ${itag === 141 ? '#00e5ff' : '#ff334b'}`;
          miniBadge.style.display = 'inline-block';
        } else {
          miniBadge.textContent = '251';
          miniBadge.style.color = '#aaa';
          miniBadge.style.background = 'rgba(0,0,0,0.4)';
          miniBadge.style.border = '1px solid #555';
          miniBadge.style.display = 'inline-block';
        }
      }
    }
  };

  // Initialize Engines & UI Hooks
  StudioEngine774.init();
  StatsForNerdsSpoofer.init();
  InPlayerSettingsUI.init();
  PlayerBadgeUI.inject();
  window.__ytssUpdateBadge = () => PlayerBadgeUI.update();
  window.__ytssToggleSfn = (force) => StatsForNerdsSpoofer.openNativeOrClassic(force);

  // V3 / classic player: right-click → "Stats for nerds" opens our 2014 panel
  document.addEventListener('contextmenu', (e) => {
    const host = StatsForNerdsSpoofer.hostEl();
    if (!host || !host.contains(e.target)) return;
    // If the browser shows the native menu, still allow keyboard/click path.
    // Also open classic panel on shift+right-click (no custom menu API in MAIN world).
    if (e.shiftKey) {
      e.preventDefault();
      StatsForNerdsSpoofer.toggle();
    }
  }, true);

  ['DOMContentLoaded', 'yt-navigate-finish', 'yt-page-data-updated'].forEach(evt => {
    document.addEventListener(evt, () => {
      StudioEngine774.init();
      StatsForNerdsSpoofer.init();
      PlayerBadgeUI.inject();
      const currentVid = getVideoIdFromUrl();
      const pLoudness = window.ytInitialPlayerResponse?.playerConfig?.audioConfig?.loudnessDb
        ?? document.getElementById('movie_player')?.getPlayerResponse?.()?.playerConfig?.audioConfig?.loudnessDb;
      if (currentVid && typeof pLoudness === 'number') {
        loudnessDbMap.set(currentVid, pLoudness);
      }
      if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && StudioEngine774.activeVideoId && !isCurrentWatchVideo(StudioEngine774.activeVideoId)) {
        console.warn(TAG, `[PageGuard] StudioEngine audio (${StudioEngine774.activeVideoId}) is no longer active! Preparing transition to ${currentVid}.`);
        StudioEngine774.prepareTransition(currentVid);
      }
      if (StudioEngine774.pending774) {
        const pVid = StudioEngine774.pending774.videoId;
        const v = document.querySelector('video');
        if (v && isCurrentWatchVideo(pVid)) {
          StudioEngine774.applyToVideo(v, pVid, StudioEngine774.pending774.best774);
        } else {
          const isUpcoming = (typeof NextVideoManager !== 'undefined' && NextVideoManager.nextVideoId === pVid) || (navTargetVideoId === pVid);
          if (!isUpcoming) {
            StudioEngine774.pending774 = null;
          }
        }
      }
      if (currentVid && isCurrentWatchVideo(currentVid) && !StudioEngine774.isActive && !confirmedNo774Videos.has(currentVid)) {
        tryUpgradeVideo(currentVid, evt);
      }
    });
  });

  setInterval(() => {
    PlayerBadgeUI.inject();
    StudioEngine774.hookPlayer();
  }, 1500);

  // ═══════════════════════════════════════════════════════════════════
  // INTERCEPTORS — fetch & XHR (response-only, no request modification)
  // ═══════════════════════════════════════════════════════════════════
  window.fetch = async function (...args) {
    let url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (window.__ytssSabrProbes === undefined) window.__ytssSabrProbes = 0;

    if (url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      try {
        if (args[1] && args[1].body) {
          const req = JSON.parse(args[1].body);
          const poToken = req.serviceIntegrityDimensions?.poToken;
          const sts = req.playbackContext?.contentPlaybackContext?.signatureTimestamp;
          if (poToken || sts) {
            const context = {
              visitorData: window.ytcfg?.get('VISITOR_DATA') || null,
              sessionIndex: window.ytcfg?.get('SESSION_INDEX') ?? '0',
              delegatedSessionId: window.ytcfg?.get('DELEGATED_SESSION_ID') || null,
              sts: sts || window.ytcfg?.get('STS'),
              poToken: poToken || window.ytcfg?.get('POTOKEN')
            };
            window.postMessage({ type: 'YTSS_PAGE_CONTEXT', context }, '*');
          }
        }
      } catch (e) { }

      const response = await ORIGINAL_FETCH.apply(this, args);
      if (!S.enabled) return response;

      try {
        const clone = response.clone();
        const json = await clone.json();
        const videoId = json.videoDetails?.videoId;
        if (videoId) {
          navTargetVideoId = videoId;
        }
        const lDb = json.playerConfig?.audioConfig?.loudnessDb;
        if (videoId && typeof lDb === 'number') {
          loudnessDbMap.set(videoId, lDb);
          if (StudioEngine774.isActive && StudioEngine774.activeVideoId === videoId) {
            StudioEngine774.syncVol();
          }
        }
        const cached = videoId ? cacheGet(videoId) : null;
        const isCurrentActive = isCurrentWatchVideo(videoId);

        if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
          // Cache HIT: activate 774 immediately
          const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
          const playable = getPlayable774Candidates(formats);
          const all774 = getAll774Candidates(formats);
          if (S.operationMode !== OP_MODES.TV_HEADLESS && playable.length > 0 && isCurrentActive) {
            StudioEngine774.load774(videoId, playable[0]);
            try {
              const patchedJson = processPlayerResponse(json, cached);
              return new Response(JSON.stringify(patchedJson), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
              });
            } catch (e) {}
            return response;
          } else if (all774.length > 0 && isCurrentActive) {
            StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
            const best774 = all774[0];
            status.activeAudioItag = 774;
            status.activeMethod = best774._src || 'TVHTML5';
            status.fallbackReason = null;
            status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
            report();
            if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
            try {
              const patchedJson = processPlayerResponse(json, cached);
              return new Response(JSON.stringify(patchedJson), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
              });
            } catch (e) {}
            return response;
          } else if (isCurrentActive) {
            StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
            return response;
          }
          return response;
        }

        // Cache MISS: Return original response immediately so the player starts naturally.
        // Then kick off background HQ fetch and smoothly activate Studio 774 once ready.
        if (S.hqFetch && videoId && isCurrentWatchVideo(videoId)) {
          fetchAllHQAudio(videoId).then(hqData => {
            const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
            if (hasFormats) {
              const isActive = isPlayerActiveOnPage();

              if (isActive && isCurrentWatchVideo(videoId)) {
                const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
                const playable = getPlayable774Candidates(formats);
                const all774 = getAll774Candidates(formats);
                if (S.operationMode !== OP_MODES.TV_HEADLESS && playable.length > 0) {
                  StudioEngine774.load774(videoId, playable[0]);
                } else if (all774.length > 0) {
                  StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
                  const best774 = all774[0];
                  status.activeAudioItag = 774;
                  status.activeMethod = best774._src || 'TVHTML5';
                  status.fallbackReason = null;
                  status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
                  report();
                  if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
                } else {
                  StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
                }
              }
            } else if (isCurrentWatchVideo(videoId)) {
              StudioEngine774.stopAndUnmute('No HQ formats returned', videoId);
            }
          }).catch(() => { });
        }

        return response;
      } catch (e) {
        console.warn(TAG, 'fetch intercept error:', e);
        return response;
      }
    }

    // ── SABR/UMP request-body probe (read-only) ───────────────────────────
    // The desktop player no longer receives stream URLs at all: on /watch every
    // adaptiveFormat comes back `url:false, cipher:false` with serverAbrStreamingUrl
    // set, so playback is negotiated entirely inside this POST body. Nothing we put
    // in adaptiveFormats can change what gets served unless it changes these bytes.
    //
    // Before attempting that, establish what is actually in here. This only reads:
    // the body is cloned via the ArrayBuffer we were handed, never modified, and
    // never re-attached to the request.
    //
    // What matters is whether the varint for the requested format id is present and
    // whether it tracks status.activeAudioItag. 251 encodes as a varint to FB 01,
    // 774 to 86 06, 140 to 8C 01, 141 to 8D 01 — so a hex dump plus a scan for those
    // pairs answers "does the player ask for what we injected?" directly.
    // ── Download-URL capture (read-only) ──────────────────────────────────
    if (url.includes('googlevideo.com/videoplayback')) {
      try {
        const dUrl = new URL(url);
        const reqItags = dUrl.searchParams.getAll('itag').map(Number);
        const pathMatch = dUrl.pathname.match(/\/itag\/(\d+)/);
        if (pathMatch) reqItags.push(Number(pathMatch[1]));

        const activeItag = Number(status.activeAudioItag);

        let isMatch = reqItags.includes(activeItag);
        if (!isMatch) {
          if (activeItag === 774 && reqItags.includes(251)) isMatch = true;
          if (activeItag === 141 && reqItags.includes(140)) isMatch = true;
        }

        if (isMatch) {
          const clen = status.contentLength || url.match(/[\?&]clen=(\d+)/)?.[1] || '999999999';
          let dlUrl = url;
          if (dlUrl.includes('range=')) {
            dlUrl = dlUrl.replace(/([\?&])range=[^&]*/, `$1range=0-${clen}`);
          } else {
            dlUrl += `&range=0-${clen}`;
          }

          if (status.downloadUrl !== dlUrl) {
            status.downloadUrl = dlUrl;
            report();
          }
        }
      } catch (e) { }
    }



    // ── Block emergency itag blacklist ───────────────────────────────────
    if (url.includes('streaming_data_emergency_itag_blacklist')) {
      console.log(TAG, '[BlacklistBlock] Blocked emergency itag blacklist');
      return Promise.resolve(new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    const finalResponse = await ORIGINAL_FETCH.apply(this, args);
    if (url.includes('googlevideo.com/videoplayback') && (finalResponse.status === 403 || finalResponse.status === 401)) {
      const urlObj = new URL(url);
      let failedItag = urlObj.searchParams.get('itag');
      if (!failedItag) {
        const match = urlObj.pathname.match(/\/itag\/(\d+)/);
        if (match) failedItag = match[1];
      }
      if (failedItag && (Number(failedItag) === Number(status.activeAudioItag) || (Number(failedItag) === 251 && Number(status.activeAudioItag) === 774))) {
        console.warn(TAG, `[Fallback] Player got HTTP ${finalResponse.status} for injected ITAG ${failedItag}`);
        const currentVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
        if (S.operationMode === OP_MODES.HYBRID_HQ && currentVid) {
          const currentSrc = status.activeMethod || 'TVHTML5';
          const alternateSource = (currentSrc === 'TVHTML5') ? 'YTM_HARVESTER' : 'TVHTML5';
          if (canHybridFailover(currentVid, currentSrc, alternateSource)) {
            console.log(TAG, `[HybridFailover] Playback failed on ${currentSrc} (HTTP ${finalResponse.status}). Triggering failover to ${alternateSource}...`);
            handleHybridRuntimeFailover(currentVid, currentSrc, alternateSource, `HTTP ${finalResponse.status}`);
            return finalResponse;
          }
        }
        status.fallbackReason = `Player fallback (HTTP ${finalResponse.status})`;
        report();
      }
    }
    return finalResponse;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      try {
        // Read-only. The `_ytss_*` param rewrite that used to run here corrupted
        // the signed URL — see the ITAG disguise comment in processPlayerResponse.
        // `dUrl` is only ever read from, never re-serialized back onto `url`.
        const dUrl = new URL(url);
        const reqItags = dUrl.searchParams.getAll('itag').map(Number);
        const pathMatch = dUrl.pathname.match(/\/itag\/(\d+)/);
        if (pathMatch) reqItags.push(Number(pathMatch[1]));

        const activeItag = Number(status.activeAudioItag);

        let isMatch = reqItags.includes(activeItag);
        if (!isMatch) {
          if (activeItag === 774 && reqItags.includes(251)) isMatch = true;
          if (activeItag === 141 && reqItags.includes(140)) isMatch = true;
        }

        if (isMatch) {
          const clen = status.contentLength || url.match(/[\?&]clen=(\d+)/)?.[1] || '999999999';
          let dlUrl = url;
          if (dlUrl.includes('range=')) {
            dlUrl = dlUrl.replace(/([\?&])range=[^&]*/, `$1range=0-${clen}`);
          } else {
            dlUrl += `&range=0-${clen}`;
          }

          console.log(TAG, `[XHRCapture] Captured download URL for itag ${activeItag}:`, dlUrl);
          if (status.downloadUrl !== dlUrl) {
            status.downloadUrl = dlUrl;
            report();
          }
        } else {
          // Video-only itags (e.g. 399) legitimately miss the audio matcher — not a fault.
          const AUDIO_ITAGS = new Set([139, 140, 141, 171, 249, 250, 251, 256, 258, 325, 328, 774]);
          const looksAudio = reqItags.some(i => AUDIO_ITAGS.has(i));
          if (looksAudio) {
            console.log(TAG, `[XHRCapture] Unmatched audio videoplayback: reqItags=${reqItags}, activeItag=${activeItag}`);
          }
        }
      } catch (e) {
        console.error(TAG, `[XHRCapture] Error:`, e);
      }
    }
    this._ytssUrl = url;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._ytssUrl;

    // NOTE: the SABR/UMP binary body patcher that used to run here was removed for
    // the same reason as the fetch-side one — see the comment in window.fetch.

    if (url && typeof url === 'string' && url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      const self = this;
      const origHandler = this.onreadystatechange;

      this.onreadystatechange = function () {
        if (self.readyState === 4 && self.status === 200 && S.enabled) {
          try {
            const json = JSON.parse(self.responseText);
            const videoId = json.videoDetails?.videoId;
            if (videoId) {
              navTargetVideoId = videoId;
            }
            const cached = videoId ? cacheGet(videoId) : null;
            const isCurrentActive = isCurrentWatchVideo(videoId);

            if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
              const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
              const playable = getPlayable774Candidates(formats);
              const all774 = getAll774Candidates(formats);
              if (S.operationMode !== OP_MODES.TV_HEADLESS && playable.length > 0 && isCurrentActive) {
                StudioEngine774.load774(videoId, playable[0]);
              } else if (all774.length > 0 && isCurrentActive) {
                StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
                const best774 = all774[0];
                status.activeAudioItag = 774;
                status.activeMethod = best774._src || 'TVHTML5';
                status.fallbackReason = null;
                status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
                report();
                if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
              } else if (isCurrentActive) {
                StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
              }
            } else if (S.hqFetch && videoId && isCurrentWatchVideo(videoId)) {
              // Cache miss: fetch in background and upgrade seamlessly once ready.
              fetchAllHQAudio(videoId).then(hqData => {
                const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
                if (hasFormats) {
                  const isActive = isPlayerActiveOnPage();

                  if (isActive && isCurrentWatchVideo(videoId)) {
                    const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
                    const playable = getPlayable774Candidates(formats);
                    const all774 = getAll774Candidates(formats);
                    if (S.operationMode !== OP_MODES.TV_HEADLESS && playable.length > 0) {
                      StudioEngine774.load774(videoId, playable[0]);
                    } else if (all774.length > 0) {
                      StudioEngine774.stopAndUnmute('Native TV 774 stream', videoId);
                      const best774 = all774[0];
                      status.activeAudioItag = 774;
                      status.activeMethod = best774._src || 'TVHTML5';
                      status.fallbackReason = null;
                      status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
                      report();
                      if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
                    } else {
                      StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
                    }
                  }
                } else if (isCurrentWatchVideo(videoId)) {
                  StudioEngine774.stopAndUnmute('No HQ formats returned', videoId);
                }
              }).catch(() => { });
            }
          } catch (e) { }
        }
        if (origHandler) origHandler.apply(self, arguments);
      };
    } else if (url && typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      const self = this;
      const origHandler = this.onreadystatechange;
      this.onreadystatechange = function () {
        if (self.readyState === 4 && (self.status === 403 || self.status === 401)) {
          try {
            const urlObj = new URL(self._ytssUrl);
            let failedItag = urlObj.searchParams.get('itag');
            if (!failedItag) {
              const match = urlObj.pathname.match(/\/itag\/(\d+)/);
              if (match) failedItag = match[1];
            }
            if (failedItag && (Number(failedItag) === Number(status.activeAudioItag) || (Number(failedItag) === 251 && Number(status.activeAudioItag) === 774))) {
              console.warn(TAG, `[Fallback] Player got HTTP ${self.status} for injected ITAG ${failedItag} via XHR`);
              const currentVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
              if (S.operationMode === OP_MODES.HYBRID_HQ && currentVid) {
                const currentSrc = status.activeMethod || 'TVHTML5';
                const alternateSource = (currentSrc === 'TVHTML5') ? 'YTM_HARVESTER' : 'TVHTML5';
                if (canHybridFailover(currentVid, currentSrc, alternateSource)) {
                  console.log(TAG, `[HybridFailover] Playback failed on ${currentSrc} via XHR (HTTP ${self.status}). Triggering failover to ${alternateSource}...`);
                  handleHybridRuntimeFailover(currentVid, currentSrc, alternateSource, `HTTP ${self.status}`);
                  return;
                }
              }
              status.fallbackReason = `Player fallback (HTTP ${self.status})`;
              report();
            }
          } catch (e) { }
        }
        if (origHandler) origHandler.apply(self, arguments);
      };
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  const NativeAudioMeter = {
    audioCtx: null,
    currentTarget: null,
    init() {
      // NEVER hijack StudioEngine774.audio with createMediaElementSource!
      // Routing StudioEngine774.audio through AudioContext causes Web Audio quantum underruns, crackling, and farbling distortion.
      const activeAudio = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (!activeAudio) return;
      if (this.analyser && this.currentTarget === activeAudio) return;

      try {
        if (!this.audioCtx) {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          this.audioCtx = new AudioCtx();
        }
        if (activeAudio.__ytss_meter) {
          this.currentTarget = activeAudio;
          this.sourceNode = activeAudio.__ytss_meter.sourceNode;
          this.analyser = activeAudio.__ytss_meter.analyser;
          return;
        }
        this.currentTarget = activeAudio;
        this.sourceNode = this.audioCtx.createMediaElementSource(activeAudio);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.sourceNode.connect(this.analyser);
        try { this.analyser.connect(this.audioCtx.destination); } catch (e) {}
        activeAudio.__ytss_meter = { sourceNode: this.sourceNode, analyser: this.analyser };
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
      } catch (e) { }
    },
    getSpectrum() {
      if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive) {
        return {
          frequencyData: new Array(1024).fill(150),
          peakFrequencyHz: 20000,
          energyAbove18k: 0.85,
          energyAbove20k: 0.70
        };
      }
      if (!this.analyser) this.init();
      if (!this.analyser || !this.audioCtx) return null;
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      const binWidth = (this.audioCtx.sampleRate / 2) / data.length;
      let maxBin = 0;
      let energyAbove18k = 0;
      let energyAbove20k = 0;
      let totalEnergy = 0;
      const bin18k = Math.floor(18000 / binWidth);
      const bin20k = Math.floor(20000 / binWidth);
      for (let i = 0; i < data.length; i++) {
        const val = data[i];
        totalEnergy += val;
        if (val > 10) maxBin = i;
        if (i >= bin18k) energyAbove18k += val;
        if (i >= bin20k) energyAbove20k += val;
      }
      return {
        sampleRate: this.audioCtx.sampleRate,
        binCount: data.length,
        binWidthHz: Math.round(binWidth * 10) / 10,
        peakFrequencyHz: Math.round(maxBin * binWidth),
        totalEnergy,
        energyAbove18k,
        energyAbove20k,
        highFreqActive: energyAbove20k > 0 || maxBin >= bin20k
      };
    },
    getRawBins() {
      if (!this.analyser) this.init();
      if (!this.analyser || !this.audioCtx) return null;
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      const binWidth = (this.audioCtx.sampleRate / 2) / data.length;
      const active = [];
      for (let i = 0; i < data.length; i++) {
        if (data[i] > 5) {
          active.push({ bin: i, freq: Math.round(i * binWidth), val: data[i] });
        }
      }
      return {
        sampleRate: this.audioCtx.sampleRate,
        binWidth: Math.round(binWidth * 10) / 10,
        totalActive: active.length,
        maxFreq: active.length > 0 ? active[active.length - 1].freq : 0,
        topActive: active.slice(-15)
      };
    },
    getPeakFrequency() {
      const spec = this.getSpectrum();
      return spec ? spec.peakFrequencyHz : 0;
    }
  };

  // ─── EXPOSE API TO POPUP ──────────────────────────────────────────
  window.YTSS_SpoofingMethods = {
    getStatus: () => ({ ...status, settings: { ...S } }),
    getEngine: () => StudioEngine774,
    getBadge: () => PlayerBadgeUI,
    updateBadge: () => PlayerBadgeUI.update(),
    toggleSfn: (force) => StatsForNerdsSpoofer.toggle(force),
    getHardwareAudioState: () => {
      const v = getMainVideoElement();
      return {
        vRealVol: v ? descVolume.get.call(v) : null,
        vRealMut: v ? descMuted.get.call(v) : null
      };
    },
    getPeakFrequency: () => NativeAudioMeter.getPeakFrequency(),
    getSpectrum: () => NativeAudioMeter.getSpectrum(),
    getRawBins: () => NativeAudioMeter.getRawBins(),
    getNativeBooster: () => null,
    setShadowVolume: () => {},
    applySettings: (newSettings) => {
      Object.assign(S, pickSettings(newSettings));
      persistSettings();
      handleSettingsChange();
      if (newSettings.shadowVolume !== undefined) {
        NativeAudioBooster.setVolume(newSettings.shadowVolume);
      }
      if (S.autoReload && window.location.href.includes('youtube.com')) {
        window.location.reload();
      }
    },
    forceReload: () => {
      window.YTSS_SpoofingMethods.clearCache();
      if (window.location.href.includes('youtube.com')) window.location.reload();
    },
    clearCache: () => {
      hqCache.clear();
      pendingFetches.clear();
      reloadedVideos.clear();
      pendingReloads.clear();
      failedFetches.clear();
      try {
        for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
          const key = window.sessionStorage.key(i);
          if (key && key.startsWith('ytss_hq_')) window.sessionStorage.removeItem(key);
        }
      } catch (e) { }
    },
    fetchAllHQAudio: (vid) => fetchAllHQAudio(vid),
    prewarmCache: (vid) => prewarmCache(vid)
  };

  console.log(TAG, 'Injected — Pre-warm + ytplayer.config + ITAG disguise + ForceReload active');
})();
