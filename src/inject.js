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

  const OP_MODES = { HYBRID_HQ: 'HYBRID_HQ', YTM_HARVESTER: 'YTM_HARVESTER', TV_HEADLESS: 'TV_HEADLESS', TV_UMP_MSE: 'TV_UMP_MSE', TV_RELAY: 'TV_RELAY' };

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
    audioOnly: false,
    lang: 'vi',
    volumeBalance: true,
    uiLanguage: 'en',
  };

  let currentLocale = {};
  const DEFAULT_STRINGS = {
    audioOnlyActive: 'AUDIO-ONLY MODE ACTIVE',
    audioOnlyHint: 'Video rendering paused to save RAM & CPU • Click anywhere to restore video',
    hudAudioOnlyOn: 'Audio-Only Mode: ACTIVE (Click to restore video)',
    hudAudioOnlyOff: 'Audio-Only Mode: OFF (Click to enable)',
    badgeTooltipNative: 'ITAG {itag} ({bitrate}) • Method: {method} • Engine: Native SABR 774',
    badgeTooltipStudio: 'ITAG 774 ({bitrate}) • Method: {method} • Engine: Studio Engine 774',
    badgeTooltip251: 'ITAG 251 (160kbps) • Original YouTube Stream',
    statusAudioBuffer: 'Audio Buffer',
  };

  function t(key, params = {}) {
    let str = currentLocale[key] || DEFAULT_STRINGS[key] || key;
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return str;
  }

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
    if (out.operationMode === OP_MODES.TV_UMP_MSE) {
      out.operationMode = OP_MODES.TV_HEADLESS;
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
      // Rewrite immediately if the stored blob carried anything it shouldn't or legacy mode name.
      if (Object.keys(parsed).some(k => !SETTING_KEYS.includes(k)) || parsed.operationMode === OP_MODES.TV_UMP_MSE) {
        persistSettings();
        try { localStorage.removeItem('ytSpoofingStream_settings'); } catch (e) { }
        console.log(TAG, 'Normalized stored settings config.');
      }
    }
  } catch (e) { }

  let lastOpMode = S.operationMode;
  let lastEnabled = S.enabled;
  let fetchGeneration = 0;
  function handleSettingsChange() {
    if (!S.enabled) {
      lastEnabled = false;
      fetchGeneration++;
      try { window.postMessage({ type: 'YTSS_STOP_HARVEST' }, '*'); } catch (e) {}
      pendingFetches.clear();
      if (typeof StudioEngine774 !== 'undefined') StudioEngine774.stopAndUnmute('Extension Disabled');
      const container = document.getElementById('ytss-vol-container');
      if (container) container.style.display = 'none';
      if (typeof applyAudioOnlyState === 'function') applyAudioOnlyState();
      status.activeMethod = 'original';
      status.activeAudioItag = 251;
      status.fallbackReason = 'Extension Disabled';
      status.bestAudioInfo = 'Extension Disabled';
      report();
    } else {
      const wasDisabled = !lastEnabled;
      lastEnabled = true;
      const container = document.getElementById('ytss-vol-container');
      if (container) container.style.display = 'inline-flex';
      if (typeof applyAudioOnlyState === 'function') applyAudioOnlyState();
      if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive) {
        StudioEngine774.updateNormalizedGain(StudioEngine774.activeVideoId);
        StudioEngine774.syncVol(getMainVideoElement());
      }

      // Invalidate cache & re-fetch if operation mode changed OR extension was just re-enabled!
      // Changing audioOnly, volumeBalance, uiLanguage, or shadowPlayer must NEVER drop the active 774 stream!
      if (S.operationMode !== lastOpMode || wasDisabled) {
        lastOpMode = S.operationMode;
        fetchGeneration++;
        try { window.postMessage({ type: 'YTSS_STOP_HARVEST' }, '*'); } catch (e) {}
        hqCache.clear();
        confirmedNo774Videos.clear();
        failedFetches.clear();
        pendingFetches.clear();
        try {
          for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
            const k = window.sessionStorage.key(i);
            if (k && k.startsWith('ytss_hq_')) window.sessionStorage.removeItem(k);
          }
        } catch (e) {}
        const curVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
        if (curVid) {
          try { window.postMessage({ type: 'YTSS_CLEAR_VIDEO_CACHE', videoId: curVid }, '*'); } catch (e) {}
          console.log(TAG, `[SettingsChange] ${wasDisabled ? 'Re-enabled' : `Switched to ${S.operationMode}`} -> Triggering HQ harvest for ${curVid}`);
          prewarmCache(curVid, { forceFresh: true });
        }
      }
      if (typeof PlayerBadgeUI !== 'undefined') {
        PlayerBadgeUI.update();
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
    if (e.data?.type === 'YTSS_LOCALE_DATA' && e.data.strings) {
      currentLocale = e.data.strings;
      if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      if (typeof applyAudioOnlyState === 'function') applyAudioOnlyState();
    }
    if (e.data?.type === 'YTSS_SET_AUDIO_ONLY') {
      const targetState = typeof e.data.audioOnly === 'boolean' ? e.data.audioOnly : !S.audioOnly;
      if (typeof toggleAudioOnly === 'function') {
        toggleAudioOnly(targetState);
      } else {
        S.audioOnly = targetState;
        persistSettings();
      }
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
    activeBitrate: '—',
    fallbackReason: null,
    lastError: null,
    activeMode: S.audioMode,
    clientStats: {},
    clientFallback: null,   // set when the chosen Spoofing Method returned no HQ
    noUrlDrop: null,        // set when HQ formats arrived as metadata only (SABR-only, no url)
    prewarmStatus: '—',
    audioBufferSec: null,
  };

  function getAudioBufferSec() {
    try {
      if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive && StudioEngine774.audio) {
        const a = StudioEngine774.audio;
        const cur = a.currentTime;
        const b = a.buffered;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) <= cur && cur <= b.end(i)) {
            return Math.max(0, b.end(i) - cur);
          }
        }
        return 0;
      }
      const isReal774 = Number(status.activeAudioItag) === 774 && !status.fallbackReason;
      if (isReal774) {
        const v = (typeof getMainVideoElement === 'function' ? getMainVideoElement() : document.querySelector('video'));
        if (v) {
          const cur = v.currentTime;
          const b = v.buffered;
          for (let i = 0; i < b.length; i++) {
            if (b.start(i) <= cur && cur <= b.end(i)) {
              return Math.max(0, b.end(i) - cur);
            }
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function getActiveBitrate() {
    if (status.activeBitrate && status.activeBitrate !== '—') return status.activeBitrate;
    if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.best774Candidate) {
      try { return formatBitrate(StudioEngine774.best774Candidate); } catch (e) {}
    }
    const match = (status.bestAudioInfo || '').match(/Opus\s+(\d+\s*k?bps)/i);
    if (match) return match[1];
    return Number(status.activeAudioItag) === 774 ? '272kbps' : '160kbps';
  }

  let lastReportJson = '';
  function report() {
    status.activeMode = S.audioMode;
    const isReal774 = Number(status.activeAudioItag) === 774 && !status.fallbackReason;
    if (isReal774) {
      const buf = getAudioBufferSec();
      status.audioBufferSec = (buf !== null && !isNaN(buf)) ? Number(buf.toFixed(1)) : null;
    } else {
      status.audioBufferSec = null;
    }
    const currentJson = JSON.stringify(status);
    if (currentJson === lastReportJson) return;
    lastReportJson = currentJson;

    try { localStorage.setItem('ytSpoofingStream_status', currentJson); } catch (e) { }
    if (typeof window.__ytssUpdateBadge === 'function') {
      try { window.__ytssUpdateBadge(); } catch (e) { }
    }
  }

  // Single writer for TV 774 status — activates UmpMseController774 (UMP Demuxer + MSE)
  const sabrRewrite = {
    on: false,
    lastModified: 0,
    xtags: null,
    ustreamerConfig: null,
    serverAbrStreamingUrl: null,
    swapUstreamer: false,
    videoId: null,
    verified774: false,
    downgradedCount: 0,
    downgradedVideoId: null,
  };
  function noteTvNative774(best774, streamCount, videoId, streamingContext = null) {
    const vId = videoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    const cachedEntry = vId ? cacheGet(vId) : null;
    const tvCtx = streamingContext || cachedEntry?.streamingContext || null;
    sabrRewrite.on = false;
    if (S.operationMode === OP_MODES.TV_RELAY) {
      UmpMseController774.stop();
      StudioEngine774.stopAndUnmute('Native TV 774 SABR stream');
      sabrRewrite.on = true;
      sabrRewrite.videoId = vId;
      sabrRewrite.lastModified = Number(best774?.lastModified || best774?.last_modified || 0);
      sabrRewrite.xtags = best774?.xtags || null;
      sabrRewrite.serverAbrStreamingUrl = tvCtx?.serverAbrStreamingUrl || null;
      sabrRewrite.ustreamerConfig = null;
      sabrRewrite.swapUstreamer = false;
      sabrRewrite.verified774 = false;
      sabrRewrite.downgradedCount = 0;
      status.activeMethod = 'TVHTML5 (Native SABR 774)';
      status.activeAudioItag = 774;
      status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: TVHTML5 (Native SABR 774)`;
      status.injectedStreams = streamCount > 0 ? streamCount : 1;
      status.fallbackReason = null;
      report();
      if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      return;
    }
    if (vId && best774 && tvCtx) {
      status.injectedStreams = streamCount > 0 ? streamCount : 1;
      UmpMseController774.attachAndLoad(vId, best774, tvCtx);
    }
  }

  // Periodic 5s Audio Buffer sync for popup and background
  setInterval(() => {
    if (Number(status.activeAudioItag) === 774 && !status.fallbackReason) {
      const buf = getAudioBufferSec();
      if (buf !== null && !isNaN(buf)) {
        status.audioBufferSec = Number(buf.toFixed(1));
        try { localStorage.setItem('ytSpoofingStream_status', JSON.stringify(status)); } catch (e) {}
      }
    }
  }, 5000);

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
  let isSpaNavigating = false;
  let lastSpaNavStartAt = 0;
  let lastSpaNavFinishAt = 0;

  function isMiniplayerActive() {
    const app = document.querySelector('ytd-app');
    if (app && (app.hasAttribute('miniplayer-is-active') || app.hasAttribute('miniplayer-active'))) {
      return true;
    }
    const mini = document.querySelector('ytd-miniplayer');
    if (mini && (mini.hasAttribute('active') || (mini.classList.contains('active') && mini.offsetHeight > 0 && mini.offsetWidth > 0))) {
      return true;
    }
    return false;
  }

  function isPlayerActiveOnPage() {
    if (location.pathname.startsWith('/shorts/')) return false;
    const isWatch = location.pathname.startsWith('/watch') || location.pathname.startsWith('/live') || location.pathname.startsWith('/tv') || isMusicSite;
    if (isWatch) return true;
    if (isMiniplayerActive()) return true;

    // Maintain active state during SPA transition to miniplayer until Polymer attributes settle
    const now = Date.now();
    const inSpaTransitionGrace = (isSpaNavigating && (now - lastSpaNavStartAt < 5000)) || (now - lastSpaNavFinishAt < 450);
    if (inSpaTransitionGrace && typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive) {
      const player = document.getElementById('movie_player');
      const pState = player?.getPlayerState?.();
      const pVid = player?.getVideoData?.()?.video_id;
      const v = document.querySelector('#movie_player video.html5-main-video');
      if (pVid && (pState === 1 || pState === 3) && (!v || (!v.paused && !v.ended))) {
        return true;
      }
    }
    return false;
  }

  function getVideoIdFromUrl() {
    try {
      if (window.location.pathname.startsWith('/shorts/')) {
        return null;
      }
      const onWatchLike = window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/live') || window.location.pathname.startsWith('/tv') || isMusicSite;
      if (onWatchLike) {
        const urlVid = new URLSearchParams(window.location.search).get('v');
        if (urlVid && VIDEO_ID_RE.test(urlVid)) return urlVid;
        const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
        if (playerVid && VIDEO_ID_RE.test(playerVid)) return playerVid;
      } else if (isPlayerActiveOnPage()) {
        const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
        if (playerVid && VIDEO_ID_RE.test(playerVid)) return playerVid;
      }
      return null;
    } catch (e) { return null; }
  }

  function getMainVideoElement() {
    return document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('ytd-miniplayer video.html5-main-video')
      || document.querySelector('#movie_player video')
      || Array.from(document.querySelectorAll('video.html5-main-video')).find(v => !v.closest('#inline-preview-player, ytd-video-preview, ytd-thumbnail'))
      || null;
  }

  function isCurrentWatchVideo(vid) {
    if (!vid) return false;
    // CRITICAL: If the player is NOT active on this page (user navigated to Home, Explore, Subscriptions, etc.
    // without an active miniplayer), NO video is the current watch video!
    if (!isPlayerActiveOnPage()) return false;

    if (typeof StudioEngine774 !== 'undefined' && StudioEngine774._isTransitioning && StudioEngine774._transitionTargetVid) {
      return vid === StudioEngine774._transitionTargetVid;
    }
    const urlVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    if (navTargetVideoId && urlVid && navTargetVideoId === urlVid) {
      return vid === urlVid;
    }
    if (urlVid && urlVid === vid) return true;
    if (navTargetVideoId && navTargetVideoId === vid) return true;
    const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
    if (playerVid && playerVid === vid) return true;
    return false;
  }
  const isCurrentTarget = isCurrentWatchVideo;

  function getVideoTimeFor(videoId) {
    const player = document.getElementById('movie_player');
    const playerVid = player?.getVideoData?.()?.video_id;
    if (playerVid && videoId && playerVid !== videoId) {
      return 0; // Player DOM still holds outgoing video's timestamp during transition!
    }
    const pState = player?.getPlayerState?.();
    if (pState === 5 || pState === -1) {
      return 0; // Player is cued or unstarted (e.g. reopening video after miniplayer was closed)
    }
    const v = (typeof getMainVideoElement === 'function' ? getMainVideoElement() : document.querySelector('#movie_player video'));
    if (!v || isNaN(v.currentTime) || v.ended) return 0;
    return v.currentTime;
  }

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

  function cacheSet(videoId, formats, streamingContext = null, clientStats = null, loudnessDb = null) {
    const entry = { videoId, formats, streamingContext, opMode: S.operationMode, clientStats: clientStats || status.clientStats, loudnessDb, ts: Date.now() };
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
        resolve({ results: [], streamingContext: null, error: 'HARVEST_TIMEOUT' });
      }, 12000);
    });
  }

  async function fetchAllHQAudio(videoId, opts = {}) {
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return { formats: [], streamingContext: null };
    if (opts.forceFresh) {
      confirmedNo774Videos.delete(videoId);
      failedFetches.delete(videoId);
    }
    if (confirmedNo774Videos.has(videoId)) {
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

    const myGen = fetchGeneration;
    const fetchPromise = fetchHQViaSW(videoId, opts).then(({ results, streamingContext, confirmedNo774, error }) => {
      if (myGen !== fetchGeneration || !S.enabled) {
        if (pendingFetches.get(videoId) === fetchPromise) {
          pendingFetches.delete(videoId);
        }
        return { formats: [], streamingContext: null, cancelled: true, superseded: true };
      }

      if (error === 'HARVEST_CANCELLED' || error === 'HARVEST_TIMEOUT') {
        if (pendingFetches.get(videoId) === fetchPromise) {
          pendingFetches.delete(videoId);
        }
        return { formats: [], streamingContext: null, cancelled: true };
      }

      if (confirmedNo774) {
        if (isCurrentWatchVideo(videoId)) {
          confirmedNo774Videos.add(videoId);
          failedFetches.set(videoId, Date.now());
        }
        if (pendingFetches.get(videoId) === fetchPromise) {
          pendingFetches.delete(videoId);
        }
        console.log(TAG, `[HQ] Video ${videoId} reported NO 774 from SW. Marked as confirmedNo774.`);
        if (isCurrentWatchVideo(videoId) && (StudioEngine774.isActive || StudioEngine774._isTransitioning)) {
          StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
        }
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
      const only774 = merged.filter(f => f.itag === 774 || f._origItag === 774);
      const has774 = only774.length > 0;
      if (has774) {
        confirmedNo774Videos.delete(videoId);
        // Strip 251 and non-774 audio formats so 251 never goes into the player after fetch
        cacheSet(videoId, only774, tvCtx, statsForVideo, loudnessDbMap.get(videoId) ?? null);
        failedFetches.delete(videoId);
        if (isCurrentWatchVideo(videoId)) {
          tryUpgradeVideo(videoId, 'FetchComplete');
        }
      } else if (isCurrentWatchVideo(videoId)) {
        failedFetches.set(videoId, Date.now());
        confirmedNo774Videos.add(videoId);
        console.log(TAG, `[HQ] Video ${videoId} has NO 774. Marked as confirmedNo774 (SW and extension will not touch further).`);
        try {
          window.postMessage({ type: 'YTSS_CONFIRM_NO_774', videoId }, '*');
        } catch (e) {}
        if (StudioEngine774.isActive || StudioEngine774._isTransitioning) {
          StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
        }
      }
      if (pendingFetches.get(videoId) === fetchPromise) {
        pendingFetches.delete(videoId);
      }

      if (isCurrentWatchVideo(videoId)) {
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

  // ─── PRE-WARM CACHE ────────────────────────────────────────────────
  // Start fetching HQ formats immediately from URL videoId, BEFORE player initializes.
  // When ytInitialPlayerResponse fires, cache should already be ready → sync merge.

  // Leaving /watch via the logo or a sidebar entry (SPA click, no popstate) makes YouTube stop
  // its player (state 5) without a miniplayer. The hidden 774 <audio> isn't tied to that, so
  // it has to be stopped here or it keeps playing on the home/browse page.
  function stopIfLeftWatchPage(source) {
    if (typeof StudioEngine774 === 'undefined') return false;
    if (!StudioEngine774.isActive && !StudioEngine774._isTransitioning && !StudioEngine774.pending774) return false;
    if (isPlayerActiveOnPage()) return false;
    console.log(TAG, `[PageGuard] Left watch page without miniplayer (${source}) -> stopping 774`);
    const mainVideo = getMainVideoElement();
    StudioEngine774.stopAndUnmute('Navigated away from watch page');
    navTargetVideoId = null;
    if (mainVideo && !mainVideo.paused) {
      try { mainVideo.pause(); } catch (e) {}
    }
    return true;
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

  function readStoredYoutubeVolumeState() {
    try {
      const raw = window.sessionStorage?.getItem('yt-player-volume') || window.localStorage?.getItem('yt-player-volume');
      if (raw) {
        const outer = JSON.parse(raw);
        const inner = typeof outer?.data === 'string' ? JSON.parse(outer.data) : (outer?.data || outer);
        if (inner && typeof inner === 'object') {
          const vol = (typeof inner.volume === 'number' && !isNaN(inner.volume) && inner.volume > 0)
            ? Math.max(0.05, Math.min(1.0, inner.volume / 100))
            : 1.0;
          return { volume: vol, muted: Boolean(inner.muted) };
        }
      }
    } catch (e) {}
    return { volume: 1.0, muted: false };
  }

  // Prototype-level Volume & Mute Interception
  // Enforces hardware silence across all <video> elements on YouTube while keeping player UI volume intact
  try {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      get() {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descVolume.get.call(this);
        }
        if (!this.isConnected) {
          return descVolume.get.call(this);
        }
        const isInlinePreview = Boolean(this.closest && this.closest('#inline-preview-player, ytd-video-preview, ytd-thumbnail'));
        const isMainVideo = !isInlinePreview && Boolean(
          (this.classList && this.classList.contains('html5-main-video')) ||
          (this.closest && this.closest('#movie_player, ytd-miniplayer'))
        );
        if (!isMainVideo) {
          return descVolume.get.call(this);
        }
        if (typeof StudioEngine774 !== 'undefined' && (StudioEngine774.isActive || StudioEngine774._isTransitioning)) {
          if (typeof this._userVol === 'number' && !isNaN(this._userVol)) {
            return this._userVol;
          }
          return (typeof StudioEngine774._userVol === 'number' && !isNaN(StudioEngine774._userVol))
            ? StudioEngine774._userVol
            : (readStoredYoutubeVolumeState().volume || 1.0);
        }
        return descVolume.get.call(this);
      },
      set(v) {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descVolume.set.call(this, v);
        }
        if (!this.isConnected) {
          try { descVolume.set.call(this, v); } catch (e) {}
          return;
        }
        const isInlinePreview = Boolean(this.closest && this.closest('#inline-preview-player, ytd-video-preview, ytd-thumbnail'));
        const isMainVideo = !isInlinePreview && Boolean(
          (this.classList && this.classList.contains('html5-main-video')) ||
          (this.closest && this.closest('#movie_player, ytd-miniplayer'))
        );
        if (!isMainVideo || (typeof isPlayerActiveOnPage === 'function' && !isPlayerActiveOnPage())) {
          try { descVolume.set.call(this, v); } catch (e) {}
          return;
        }
        const numV = (typeof v === 'number' && !isNaN(v)) ? Math.max(0, Math.min(1.0, v)) : 1.0;
        if (typeof StudioEngine774 !== 'undefined') {
          StudioEngine774._lastUserMuteOrVolIntentAt = Date.now();
          this._userVol = numV;
          StudioEngine774._userVol = numV;
          if (numV > 0) {
            this._userMuted = false;
            StudioEngine774._userMuted = false;
          } else {
            this._userVol = 0;
            this._userMuted = true;
            StudioEngine774._userMuted = true;
          }
          if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && !StudioEngine774.isAdActive()) {
            if (typeof StudioEngine774._silenceElement === 'function') {
              StudioEngine774._silenceElement(this);
            }
            if (StudioEngine774.audio && StudioEngine774.isActive) {
              StudioEngine774.syncVolDirect(numV);
            }
          } else {
            try { descVolume.set.call(this, numV); } catch (e) {}
          }
        } else {
          this._userVol = numV;
          try { descVolume.set.call(this, numV); } catch (e) {}
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
        if (!this.isConnected) {
          return descMuted.get.call(this);
        }
        const isInlinePreview = Boolean(this.closest && this.closest('#inline-preview-player, ytd-video-preview, ytd-thumbnail'));
        const isMainVideo = !isInlinePreview && Boolean(
          (this.classList && this.classList.contains('html5-main-video')) ||
          (this.closest && this.closest('#movie_player, ytd-miniplayer'))
        );
        if (!isMainVideo) {
          return descMuted.get.call(this);
        }
        if (typeof StudioEngine774 !== 'undefined' && (StudioEngine774.isActive || StudioEngine774._isTransitioning)) {
          return Boolean(StudioEngine774._userMuted);
        }
        return descMuted.get.call(this);
      },
      set(m) {
        if (typeof StudioEngine774 !== 'undefined' && this === StudioEngine774.audio) {
          return descMuted.set.call(this, m);
        }
        if (!this.isConnected) {
          try { descMuted.set.call(this, !!m); } catch (e) {}
          return;
        }
        const isInlinePreview = Boolean(this.closest && this.closest('#inline-preview-player, ytd-video-preview, ytd-thumbnail'));
        const isMainVideo = !isInlinePreview && Boolean(
          (this.classList && this.classList.contains('html5-main-video')) ||
          (this.closest && this.closest('#movie_player, ytd-miniplayer'))
        );
        if (!isMainVideo || (typeof isPlayerActiveOnPage === 'function' && !isPlayerActiveOnPage())) {
          try { descMuted.set.call(this, m); } catch (e) {}
          return;
        }
        let targetMuted = !!m;
        if (typeof StudioEngine774 !== 'undefined') {
          // Ignore internal YouTube mutes unless user or player UI expressed mute intent
          if (targetMuted && !StudioEngine774.hasRecentUserMuteOrVolIntent()) {
            const p = document.getElementById('movie_player');
            const pMuted = (p && typeof p.isMuted === 'function') ? p.isMuted() : false;
            if (!pMuted) {
              targetMuted = false;
            }
          }
          this._userMuted = targetMuted;
          StudioEngine774._userMuted = targetMuted;
          if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && !StudioEngine774.isAdActive()) {
            if (typeof StudioEngine774._silenceElement === 'function') {
              StudioEngine774._silenceElement(this);
            }
            if (StudioEngine774.audio && StudioEngine774.isActive) {
              if (StudioEngine774.isUserMuted()) {
                StudioEngine774.audio.volume = 0;
              } else {
                const curVol = (typeof this._userVol === 'number' && !isNaN(this._userVol)) ? this._userVol : (StudioEngine774._userVol || 1.0);
                StudioEngine774.syncVolDirect(curVol);
              }
            }
          } else {
            try { descMuted.set.call(this, targetMuted); } catch (e) {}
          }
        } else {
          this._userMuted = targetMuted;
          try { descMuted.set.call(this, targetMuted); } catch (e) {}
        }
      },
      configurable: true
    });
  } catch (e) {}

  // Hardware play interceptor. When the user has paused we must NOT let page
  // scripts (Vorapis/V3 keep calling play/playVideo) resurrect playback.
  const origPlay = HTMLMediaElement.prototype.play;
  const origPause = HTMLMediaElement.prototype.pause;
  window.__ytssPauseGesture = { at: 0, wasPaused: true };

  HTMLMediaElement.prototype.play = function(...args) {
    const eng = (typeof StudioEngine774 !== 'undefined') ? StudioEngine774 : null;
    if (eng) {
      const isEngAudio = this === eng.audio;
      const isMainVid = this !== eng.audio && (
        this === getMainVideoElement() ||
        (this.classList && this.classList.contains('html5-main-video')) ||
        (this.closest && this.closest('#movie_player, .html5-video-player'))
      );
      if (eng._userPaused && (isEngAudio || isMainVid)) {
        // Use player API id — URL often still shows the previous video
        // right when YT calls play() for the new one (autoplay/selection).
        const curVid = (typeof eng.currentPlaybackVid === 'function')
          ? eng.currentPlaybackVid()
          : (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
        const v = getMainVideoElement();
        const freshLoad = !!(v && v.paused && (v.currentTime === 0 || v.readyState === 0));
        if (eng.pauseLockIsStale && (eng.pauseLockIsStale(curVid) || freshLoad)) {
          eng.unlockPlay();
        } else {
          // Same video: one-shot trusted "play" gesture. Consume it so V3's
          // play() loop cannot keep re-entering during the window (flicker).
          const g = window.__ytssPauseGesture;
          const gestureOk = g && g.wasPaused && !g.used && (Date.now() - g.at) < 800;
          if (!gestureOk) {
            return Promise.resolve();
          }
          g.used = true;
          eng.unlockPlay();
        }
      }
      if (!eng._userPaused && this !== eng.audio && (eng.isActive || eng._isTransitioning) && !eng.isAdActive()) {
        eng._silenceElement(this);
      }
    }
    return origPlay.apply(this, args);
  };

  // Pause interceptor. Only arm the sticky lock on real user-intent pause.
  // Engine/MSE pause() calls must not start a 150ms fight with play() (icon flicker).
  HTMLMediaElement.prototype.pause = function(...args) {
    try {
      if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive && !StudioEngine774.isAdActive()) {
        const isEngineAudio = this === StudioEngine774.audio;
        const isMainVideo = this !== StudioEngine774.audio &&
          ((this.classList && this.classList.contains('html5-main-video')) ||
           (this.closest && this.closest('#movie_player, .html5-video-player')));
        if (isEngineAudio || isMainVideo) {
          const g = window.__ytssPauseGesture;
          const userPauseIntent = g && !g.wasPaused && !fsBusy() && (Date.now() - g.at) < 450;
          if (userPauseIntent && typeof StudioEngine774.lockPause === 'function') {
            StudioEngine774.lockPause();
          } else if (!StudioEngine774._userPaused) {
            // Non-user pause (buffer/seek/MSE): park the sibling only, no sticky lock.
            const other = isEngineAudio ? getMainVideoElement() : StudioEngine774.audio;
            if (other && !other.paused) {
              try { origPause.call(other); } catch (e) {}
            }
          }
          const other = isEngineAudio ? getMainVideoElement() : StudioEngine774.audio;
          if (other && !other.paused) {
            try { origPause.call(other); } catch (e) {}
          }
        }
      }
    } catch (e) {}
    return origPause.apply(this, args);
  };

  // Trusted gesture tracker: distinguish user "play" from V3 auto-resume.
  // Any trusted press counts — V3 chrome may use custom buttons outside .ytp-*.
  window.__ytssFsBusyUntil = 0;
  const onFsChange = () => {
    // Enter/exit fullscreen emits pause/emptied/state noise. Never let that
    // look like a user pause (that froze playback on exit fullscreen).
    window.__ytssFsBusyUntil = Date.now() + 900;
    window.__ytssPauseGesture = { at: 0, wasPaused: true, used: true };
    try {
      const eng = (typeof StudioEngine774 !== 'undefined') ? StudioEngine774 : null;
      if (eng && eng._userPaused) {
        const p = document.getElementById('movie_player');
        const ytPlaying = p && typeof p.getPlayerState === 'function' &&
          (p.getPlayerState() === 1 || p.getPlayerState() === 3);
        const v = getMainVideoElement();
        if (ytPlaying || (v && !v.paused && !v.ended)) {
          eng.unlockPlay();
        }
      }
    } catch (e) {}
  };
  document.addEventListener('fullscreenchange', onFsChange, true);
  document.addEventListener('webkitfullscreenchange', onFsChange, true);
  const fsBusy = () => Date.now() < (window.__ytssFsBusyUntil || 0);

  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    const v = getMainVideoElement();
    window.__ytssPauseGesture = {
      at: Date.now(),
      wasPaused: !!(v && (v.paused || v.ended)),
      used: false,
    };
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.code === 'Space' || e.code === 'KeyK' || e.code === 'MediaPlayPause' || e.code === 'MediaPlay') {
      const v = getMainVideoElement();
      window.__ytssPauseGesture = {
        at: Date.now(),
        wasPaused: !!(v && (v.paused || v.ended)),
        used: false,
      };
    }
  }, true);

  function cleanStreamUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.startsWith('blob:')) return rawUrl;
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
    if (typeof rawUrl === 'string' && !rawUrl.startsWith('blob:')) {
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

    // Reset StudioEngine774 & UmpMseController774 if active and restore native player audio
    UmpMseController774.stop();
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
      window.sessionStorage.removeItem(CACHE_PREFIX + videoId);
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
        console.log(TAG, `[HybridFailover] Smart failover SUCCESS: Delivering TV 774 stream via ${targetSource} (UMP 774 MSE)`);
        noteTvNative774(all774[0], all774.length, videoId, hqData?.streamingContext || null);
      } else {
        console.log(TAG, `[HybridFailover] Alternate source ${targetSource} also failed / has no 774 for ${videoId}. Cleanly retaining native YouTube stream (ITAG 251).`);
        failedSet.add(targetSource);
        StudioEngine774.stopAndUnmute(`Both modes failed (${reason})`);
      }
    }).catch(err => {
      console.log(TAG, `[HybridFailover] Error during smart failover fetch for ${videoId}:`, err);
      failedSet.add(targetSource);
      StudioEngine774.stopAndUnmute(`Failover error: ${err.message}`);
    });
  }

  // ─── UMP-TO-MSE DIRECT DEMUXER FOR TVHTML5 ITAG 774 ────────────────
  // Deciphers TVHTML5 serverAbrStreamingUrl `n` param, sends AUDIO_ONLY
  // SABR POSTs (f40=1), and demuxes UMP Part 20/21 WebM/Opus 774 frames
  // directly into MediaSource SourceBuffer on StudioEngine774.audio.
  function umpReadVarint(u8, pos) {
    if (pos >= u8.length) return null;
    const b0 = u8[pos];
    if ((b0 & 0x80) === 0) return [b0, pos + 1];
    if ((b0 & 0xc0) === 0x80) {
      if (pos + 1 >= u8.length) return null;
      return [(b0 & 0x3f) | (u8[pos + 1] << 6), pos + 2];
    }
    if ((b0 & 0xe0) === 0xc0) {
      if (pos + 2 >= u8.length) return null;
      return [(b0 & 0x1f) | (u8[pos + 1] << 5) | (u8[pos + 2] << 13), pos + 3];
    }
    if ((b0 & 0xf0) === 0xe0) {
      if (pos + 3 >= u8.length) return null;
      return [((b0 & 0x0f) | (u8[pos + 1] << 4) | (u8[pos + 2] << 12) | (u8[pos + 3] << 20)) >>> 0, pos + 4];
    }
    if (pos + 4 >= u8.length) return null;
    return [(u8[pos + 1] | (u8[pos + 2] << 8) | (u8[pos + 3] << 16) | (u8[pos + 4] << 24)) >>> 0, pos + 5];
  }

  var UmpMseController774 = {
    session: null,
    isActive: false,
    videoId: null,

    decipherSabrUrl(rawUrl) {
      if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
      try {
        const ytp = window._yt_player;
        if (!ytp) return null;
        if (typeof ytp.NT === 'function') {
          const inst = new ytp.NT(rawUrl, true);
          if (typeof inst.kZ === 'function') {
            const v = inst.kZ();
            if (typeof v === 'string' && v.startsWith('https://')) return v;
          }
          for (const k of Object.getOwnPropertyNames(ytp.NT.prototype || {})) {
            if (k !== 'constructor' && typeof inst[k] === 'function' && inst[k].length === 0) {
              try {
                const v = inst[k]();
                if (typeof v === 'string' && v.startsWith('https://')) return v;
              } catch (e) {}
            }
          }
        }
        const origN = new URL(rawUrl).searchParams.get('n');
        for (const [, fn] of Object.entries(ytp)) {
          if (typeof fn === 'function' && fn.prototype && typeof fn.prototype.set === 'function' && typeof fn.prototype.get === 'function') {
            try {
              const inst = new fn(rawUrl, true);
              for (const mk of Object.getOwnPropertyNames(fn.prototype)) {
                if (mk !== 'constructor' && typeof inst[mk] === 'function' && inst[mk].length === 0) {
                  const v = inst[mk]();
                  if (typeof v === 'string' && v.startsWith('https://')) {
                    const newN = new URL(v).searchParams.get('n');
                    if (!origN || (newN && newN !== origN)) {
                      ytp.NT = fn;
                      return v;
                    }
                  }
                }
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        console.log(TAG, '[UmpMse774] decipherSabrUrl error:', e);
      }
      return rawUrl;
    },

    async ensureDecipheredUrl(session) {
      if (session.decipheredUrl) return session.decipheredUrl;
      const startWait = Date.now();
      while ((!window._yt_player || Object.keys(window._yt_player).length < 50) && Date.now() - startWait < 3500) {
        if (session.aborted) return null;
        await new Promise(r => setTimeout(r, 30));
      }
      if (session.aborted) return null;
      session.decipheredUrl = this.decipherSabrUrl(session.tvCtx.serverAbrStreamingUrl) || session.tvCtx.serverAbrStreamingUrl;
      return session.decipheredUrl;
    },

    buildAbrRequestBytes(session, playerTimeMs) {
      const wrapVarint = (fn, val) => new Uint8Array([...pbEncodeVarint((fn << 3) | 0), ...pbEncodeVarint(val)]);
      const wrapBytes = (fn, u8) => pbWrapLengthDelimited(fn, u8);
      const wrapStr = (fn, str) => pbWrapLengthDelimited(fn, new TextEncoder().encode(str));

      const clientState = pbConcatChunks([
        wrapVarint(28, Math.max(0, Math.floor(playerTimeMs))),
        wrapVarint(40, 1) // 1 = AUDIO_ONLY
      ]);

      const parts = [wrapBytes(1, clientState)];
      if (session.hasInit) {
        parts.push(wrapBytes(2, session.fmt774Msg));
      }
      parts.push(
        wrapBytes(5, session.ustreamerBytes),
        wrapBytes(16, session.fmt774Msg)
      );

      const scParts = [wrapBytes(1, session.clientInfoMsg)];
      if (session.playbackCookie && session.playbackCookie.length > 0) {
        scParts.push(wrapBytes(3, session.playbackCookie));
      }
      parts.push(wrapBytes(19, pbConcatChunks(scParts)));
      return pbConcatChunks(parts);
    },

    demuxUmp774(u8) {
      const headersById = new Map();
      let nextPlaybackCookie = null;
      let redirectUrl = null;
      let sabrError = null;
      let off = 0;

      while (off < u8.length) {
        const pt = umpReadVarint(u8, off);
        if (!pt) break;
        const ps = umpReadVarint(u8, pt[1]);
        if (!ps) break;
        const pType = pt[0], pSize = ps[0], dOff = ps[1];
        if (pSize < 0 || dOff + pSize > u8.length) break;

        if (pType === 20) { // MediaHeader
          const mh = pbParseMessage(u8, dOff, dOff + pSize);
          if (mh) {
            const hid = Number(mh.get(1)?.[0]?.value ?? 0);
            const itag = Number(mh.get(3)?.[0]?.value ?? 0);
            const isInit = Number(mh.get(8)?.[0]?.value ?? 0) === 1;
            const seq = Number(mh.get(9)?.[0]?.value ?? 0);
            const startMs = Number(mh.get(11)?.[0]?.value ?? 0);
            const durMs = Number(mh.get(12)?.[0]?.value ?? 0);
            headersById.set(hid, { hid, itag, isInit, seq, startMs, durMs, chunks: [] });
          }
        } else if (pType === 21) { // Media payload
          const hidV = umpReadVarint(u8, dOff);
          if (hidV) {
            const hdr = headersById.get(hidV[0]);
            if (hdr && hdr.itag === 774 && hidV[1] < dOff + pSize) {
              hdr.chunks.push(u8.subarray(hidV[1], dOff + pSize));
            }
          }
        } else if (pType === 35) { // NextRequestPolicy
          const nrp = pbParseMessage(u8, dOff, dOff + pSize);
          const f7 = nrp?.get(7)?.[0];
          if (f7 && f7.wireType === 2) {
            nextPlaybackCookie = u8.slice(f7.valueOff, f7.valueOff + f7.valueLen);
          }
        } else if (pType === 42 || pType === 43 || pType === 33) { // SabrRedirect / CMS Redirect
          const sr = pbParseMessage(u8, dOff, dOff + pSize);
          const f1 = sr?.get(1)?.[0];
          if (f1 && f1.wireType === 2 && f1.valueLen > 24 && f1.valueLen < 4096) {
            const candidate = new TextDecoder().decode(u8.subarray(f1.valueOff, f1.valueOff + f1.valueLen));
            if (/^https:\/\/[^/\s]+\/videoplayback\?/.test(candidate)) {
              redirectUrl = candidate;
            }
          }
          if (!redirectUrl) {
            // Robust fallback: direct binary text extraction if protobuf format had unexpected wire types
            try {
              const rawText = new TextDecoder().decode(u8.subarray(dOff, dOff + pSize));
              const match = rawText.match(/https:\/\/[^/\s]+\/videoplayback\?[^\x00-\x1f\s"']+/);
              if (match) {
                redirectUrl = match[0];
              }
            } catch (e) {}
          }
          if (!redirectUrl && pType === 43) {
            sabrError = true;
          }
        }
        off = dOff + pSize;
      }

      const segments = [];
      for (const h of headersById.values()) {
        if (h.itag === 774 && h.chunks.length > 0) {
          segments.push({
            isInit: h.isInit,
            seq: h.seq,
            startMs: h.startMs,
            durMs: h.durMs,
            data: pbConcatChunks(h.chunks)
          });
        }
      }
      return { segments, nextPlaybackCookie, redirectUrl, sabrError };
    },

    getBufferedEndFor(sb, timeSec) {
      if (!sb) return null;
      try {
        const b = sb.buffered;
        for (let i = 0; i < b.length; i++) {
          const s = b.start(i);
          const e = b.end(i);
          if (timeSec >= s - 0.8 && timeSec <= e + 0.4) {
            return e;
          }
        }
      } catch (e) {}
      return null;
    },

    flushQueue(session) {
      if (!session || session.aborted || !session.sourceBuffer) return;
      if (session.sourceBuffer.updating || session.appendQueue.length === 0) return;
      if (session.mediaSource.readyState !== 'open') return;
      const chunk = session.appendQueue.shift();
      try {
        session.sourceBuffer.appendBuffer(chunk);
      } catch (err) {
        console.log(TAG, '[UmpMse774] appendBuffer error:', err);
      }
    },

    async pump(session) {
      if (!session || session.aborted || this.session !== session) return;
      const isOwnedByEngine = (StudioEngine774.isActive && StudioEngine774.activeVideoId === session.videoId) ||
                              (StudioEngine774.pending774 && StudioEngine774.pending774.videoId === session.videoId);
      if (!isOwnedByEngine) {
        this.stopSession(session);
        return;
      }
      if (!session.sourceBuffer || session.inFlight) return;

      const video = getMainVideoElement();
      const audio = StudioEngine774.audio;
      const vTime = getVideoTimeFor(session.videoId);
      const curSec = vTime > 0
        ? vTime
        : (audio && !isNaN(audio.currentTime) ? audio.currentTime : 0);

      let targetMs = 0;
      const bufEndSec = this.getBufferedEndFor(session.sourceBuffer, curSec);

      if (!session.hasInit || bufEndSec === null) {
        targetMs = Math.max(0, Math.floor(curSec * 1000));
        session.reachedEof = false;
      } else {
        const durSec = session.durationSec || (video && video.duration > 0 ? video.duration : 0);
        if (session.reachedEof || (durSec > 0 && bufEndSec >= durSec - 0.8)) {
          if (!session.endedStream && !session.sourceBuffer.updating && session.appendQueue.length === 0 && session.mediaSource.readyState === 'open' && curSec >= (durSec || bufEndSec) - 2.0) {
            try {
              session.mediaSource.endOfStream();
              session.endedStream = true;
            } catch (e) {}
          }
          return;
        }
        const aheadSec = bufEndSec - curSec;
        if (aheadSec >= 25.0) {
          return; // Plenty of 774 Opus buffer ahead
        }
        targetMs = Math.round(bufEndSec * 1000) + 15;
        if (session.lastContigEndMs && Math.abs(bufEndSec * 1000 - session.lastContigEndMs) < 600) {
          targetMs = Math.max(targetMs, session.lastContigEndMs + 15);
        }
        if (durSec > 0 && targetMs >= durSec * 1000 - 200) {
          session.reachedEof = true;
          return;
        }
      }

      session.inFlight = true;
      const abortCtrl = new AbortController();
      session.abortCtrl = abortCtrl;

      try {
        const baseUrl = await this.ensureDecipheredUrl(session);
        if (!baseUrl || session.aborted) return;

        const reqBytes = this.buildAbrRequestBytes(session, targetMs);
        const u = new URL(baseUrl);
        u.searchParams.set('alr', 'yes');
        u.searchParams.set('rn', String(++session.rn));

        const resp = await ORIGINAL_FETCH.call(window, u.toString(), {
          method: 'POST',
          body: reqBytes,
          signal: abortCtrl.signal
        });

        if (session.aborted) return;
        if (!resp.ok) {
          console.log(TAG, `[UmpMse774] SABR POST HTTP ${resp.status} for ${session.videoId}`);
          session.errorCount = (session.errorCount || 0) + 1;
          if (session.errorCount >= 3) {
            if (S.operationMode === OP_MODES.HYBRID_HQ && canHybridFailover(session.videoId, 'TVHTML5', 'YTM_HARVESTER')) {
              handleHybridRuntimeFailover(session.videoId, 'TVHTML5', 'YTM_HARVESTER', `TV UMP HTTP ${resp.status}`);
              return;
            }
            StudioEngine774.stopAndUnmute(`TV UMP HTTP ${resp.status}`);
          }
          return;
        }

        const buf = new Uint8Array(await resp.arrayBuffer());
        if (session.aborted) return;

        const demuxed = this.demuxUmp774(buf);
        if (demuxed.nextPlaybackCookie) {
          session.playbackCookie = demuxed.nextPlaybackCookie;
        }
        if (demuxed.redirectUrl) {
          session.redirectCount = (session.redirectCount || 0) + 1;
          if (session.redirectCount > 8) {
            console.log(TAG, `[UmpMse774] Too many SabrRedirects (${session.redirectCount}) on ${session.videoId}`);
            session.errorCount = (session.errorCount || 0) + 1;
            if (session.errorCount >= 3) {
              if (S.operationMode === OP_MODES.HYBRID_HQ && canHybridFailover(session.videoId, 'TVHTML5', 'YTM_HARVESTER')) {
                handleHybridRuntimeFailover(session.videoId, 'TVHTML5', 'YTM_HARVESTER', 'TV UMP Redirect Loop');
                return;
              }
              StudioEngine774.stopAndUnmute('TV UMP Redirect Loop');
            }
            return;
          }
          console.log(TAG, `[UmpMse774] Following SabrRedirect #${session.redirectCount} to ${new URL(demuxed.redirectUrl).hostname}...`);
          // Note: The CMS redirect URL generated by Google Video CDN already carries valid signature & token; do NOT re-decipher n!
          session.decipheredUrl = demuxed.redirectUrl;
          session.inFlight = false;
          this.pump(session);
          return;
        }

        if (demuxed.segments.length === 0) {
          if (demuxed.sabrError) {
            session.errorCount = (session.errorCount || 0) + 1;
            if (session.errorCount >= 3) {
              if (S.operationMode === OP_MODES.HYBRID_HQ && canHybridFailover(session.videoId, 'TVHTML5', 'YTM_HARVESTER')) {
                handleHybridRuntimeFailover(session.videoId, 'TVHTML5', 'YTM_HARVESTER', 'TV UMP SabrError');
                return;
              }
              StudioEngine774.stopAndUnmute('TV UMP SabrError');
            }
          } else if (session.hasInit && targetMs > 5000) {
            session.reachedEof = true;
          }
          return;
        }

        session.errorCount = 0;
        session.redirectCount = 0;
        for (const seg of demuxed.segments) {
          if (seg.isInit) {
            if (!session.hasInit) {
              session.appendQueue.push(seg.data);
              session.hasInit = true;
              console.log(TAG, `[UmpMse774] Queued 774 WebM Init Segment (${seg.data.length}B) for ${session.videoId}`);
            }
          } else {
            if (session.lastAppendedSeq === seg.seq) {
              session.lastContigEndMs = Math.max(session.lastContigEndMs || 0, seg.startMs + seg.durMs);
            } else {
              session.appendQueue.push(seg.data);
              session.lastAppendedSeq = seg.seq;
              session.lastContigEndMs = seg.startMs + seg.durMs;
              console.log(TAG, `[UmpMse774] ★ Demuxed 774 segment seq=${seg.seq} (${(seg.startMs / 1000).toFixed(2)}s..${((seg.startMs + seg.durMs) / 1000).toFixed(2)}s, ${seg.data.length}B)`);
            }
          }
        }

        this.flushQueue(session);
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.log(TAG, '[UmpMse774] pump fetch error:', err);
        }
      } finally {
        if (session.abortCtrl === abortCtrl) {
          session.abortCtrl = null;
        }
        session.inFlight = false;
      }
    },

    onSeek(targetSec) {
      const session = this.session;
      if (!session || session.aborted || !this.isActive || !session.sourceBuffer) return;
      const cov = this.getBufferedEndFor(session.sourceBuffer, targetSec);
      if (cov === null) {
        // Target seek time is outside current MSE buffer -> abort any old in-flight fetch (if init already done) and pump immediately!
        session.lastContigEndMs = 0;
        session.reachedEof = false;
        if (session.hasInit && session.abortCtrl) {
          try { session.abortCtrl.abort(); } catch (e) {}
          session.inFlight = false;
        }
        this.pump(session);
      }
    },

    stopSession(session) {
      if (!session || session.aborted) return;
      session.aborted = true;
      if (session.timer) {
        clearInterval(session.timer);
        session.timer = null;
      }
      if (session.abortCtrl) {
        try { session.abortCtrl.abort(); } catch (e) {}
        session.abortCtrl = null;
      }
      if (session.blobUrl) {
        const oldUrl = session.blobUrl;
        session.blobUrl = null;
        setTimeout(() => {
          try { URL.revokeObjectURL(oldUrl); } catch (e) {}
        }, 1000);
      }
      if (this.session === session) {
        this.session = null;
        this.isActive = false;
        this.videoId = null;
      }
    },

    stop() {
      if (this.session) {
        this.stopSession(this.session);
      }
      this.isActive = false;
      this.videoId = null;
    },

    attachAndLoad(videoId, best774, tvCtx) {
      if (!videoId || !best774 || !tvCtx?.serverAbrStreamingUrl || !tvCtx?.ustreamerConfig) {
        return false;
      }
      const isEngineHolding = (StudioEngine774.isActive && StudioEngine774.activeVideoId === videoId) ||
                              (StudioEngine774.pending774 && StudioEngine774.pending774.videoId === videoId);
      if (this.isActive && this.videoId === videoId && this.session && !this.session.aborted && isEngineHolding) {
        return true;
      }

      this.stop();

      const ustreamerBytes = pbDecodeBase64ToU8(tvCtx.ustreamerConfig);
      if (!ustreamerBytes || ustreamerBytes.length < 16) {
        console.log(TAG, '[UmpMse774] Invalid ustreamerConfig bytes');
        return false;
      }

      const wrapVarint = (fn, val) => new Uint8Array([...pbEncodeVarint((fn << 3) | 0), ...pbEncodeVarint(val)]);
      const wrapStr = (fn, str) => pbWrapLengthDelimited(fn, new TextEncoder().encode(str));
      const lmt = BigInt(best774.lastModified || best774.last_modified || 0);
      const fmtParts = [wrapVarint(1, 774), wrapVarint(2, lmt)];
      if (typeof best774.xtags === 'string' && best774.xtags.length > 0) {
        fmtParts.push(wrapStr(3, best774.xtags));
      }
      const fmt774Msg = pbConcatChunks(fmtParts);
      const clientInfoMsg = pbConcatChunks([
        wrapStr(1, 'vi'),
        wrapStr(2, 'VN'),
        wrapVarint(16, 7),
        wrapStr(17, tvCtx.clientVersion || '7.20260728.17.00')
      ]);

      const mediaSource = new MediaSource();
      const blobUrl = URL.createObjectURL(mediaSource);
      const durationSec = Number(best774.approxDurationMs || 0) > 0
        ? Number(best774.approxDurationMs) / 1000
        : 0;

      const session = {
        videoId,
        best774,
        tvCtx,
        ustreamerBytes,
        fmt774Msg,
        clientInfoMsg,
        mediaSource,
        blobUrl,
        sourceBuffer: null,
        decipheredUrl: null,
        playbackCookie: null,
        appendQueue: [],
        hasInit: false,
        inFlight: false,
        aborted: false,
        endedStream: false,
        reachedEof: false,
        rn: 0,
        redirectCount: 0,
        lastAppendedSeq: -1,
        lastContigEndMs: 0,
        durationSec,
        abortCtrl: null,
        timer: null,
      };

      this.session = session;
      this.isActive = true;
      this.videoId = videoId;

      mediaSource.addEventListener('sourceopen', () => {
        if (session.aborted || this.session !== session) return;
        try {
          if (session.durationSec > 0 && isFinite(session.durationSec)) {
            mediaSource.duration = session.durationSec;
          }
          const sb = mediaSource.addSourceBuffer('audio/webm; codecs="opus"');
          sb.mode = 'segments';
          session.sourceBuffer = sb;

          sb.addEventListener('updateend', () => {
            if (session.aborted || this.session !== session) return;
            if (session.appendQueue.length > 0) {
              this.flushQueue(session);
              return;
            }
            const v = getMainVideoElement();
            const a = StudioEngine774.audio;
            const cur = getVideoTimeFor(session.videoId);
            const cov = this.getBufferedEndFor(sb, cur);
            if (cov !== null) {
              if (v && a && StudioEngine774.isActive) {
                const audioCov = this.getBufferedEndFor(sb, a.currentTime);
                // Only align audio.currentTime on initial segment or when audio is outside buffered range (e.g. after seek).
                // NEVER seek audio while it is actively playing inside a valid buffered range!
                if ((!session.initialSyncDone || audioCov === null) && !a.seeking) {
                  session.initialSyncDone = true;
                  if (cur > 0.8 || audioCov === null) {
                    try { a.currentTime = cur; } catch (e) {}
                  }
                }
                if (!v.paused && a.paused && !StudioEngine774.isAdActive()) {
                  a.play().catch(() => {});
                }
              }
              report();
              // Pre-buffer up to 25s ahead immediately after initial segment arrives
              if (cov - cur < 18.0 && !session.inFlight && !session.reachedEof) {
                this.pump(session);
              }
            }
          });

          this.pump(session);
          session.timer = setInterval(() => {
            this.pump(session);
          }, 400);
        } catch (err) {
          console.log(TAG, '[UmpMse774] sourceopen init error:', err);
          StudioEngine774.stopAndUnmute('MSE SourceBuffer init failed');
        }
      }, { once: true });

      const umpFmt = {
        ...best774,
        itag: 774,
        _origItag: 774,
        url: blobUrl,
        _directUrl: blobUrl,
        _isUmpMse: true,
        _src: 'TVHTML5 (UMP 774)'
      };

      console.log(TAG, `[UmpMse774] Attaching MediaSource UMP 774 engine for ${videoId} (dur=${durationSec.toFixed(1)}s)`);
      return StudioEngine774.load774(videoId, umpFmt);
    }
  };

  // ─── STUDIO ENGINE 774 ─────────────────────────────────────────────
  // High-Fidelity Audio Engine: Direct Hardware Opus Playback • Sync Engine • Unified Player Binding
  const initialVolState = readStoredYoutubeVolumeState();
  var StudioEngine774 = {
    audio: null,
    activeVideoId: null,
    best774Candidate: null,
    pending774: null,
    isActive: false,
    _isTransitioning: false,
    _transitionTargetVid: null,
    _transitionStartedAt: 0,
    _lastSeekTime: 0,
    _lastUserMuteOrVolIntentAt: 0,
    _lastUserSeekIntentAt: 0,
    _initialMetaSynced: false,
    _waiterTimer: null,
    _watchdogTimer: null,
    _inSyncVol: false,
    _globalEventsHooked: false,
    _hookedVideos: new WeakSet(),
    _userVol: initialVolState.volume,
    _userMuted: false,
    _userPaused: false,
    _pauseLockUntil: 0,
    _pauseReassert: null,
    _pauseLockVid: null,
    _locking: false,
    // Sticky pause for ONE video. New video / autoplay must not inherit the lock
    // (that killed autoplay and made play need two clicks). Also sync YT player
    // state so the control bar does not show a stale pause/play icon.
    lockPause() {
      if (this._locking) return;
      this._locking = true;
      try {
        this._userPaused = true;
        this._pauseLockUntil = Date.now() + 60000;
        this._pauseLockVid = (typeof this.currentPlaybackVid === 'function' && this.currentPlaybackVid())
          || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null)
          || this.activeVideoId;
        const apply = () => {
          if (!this._userPaused) return;
          try {
            if (this.audio && !this.audio.paused) this.audio.pause();
            const v = getMainVideoElement();
            if (v && !v.paused && !v.ended) v.pause();
            // Do NOT call player.pauseVideo() here. That fights play() and makes
            // the control-bar icon flicker; only the media elements are stamped.
          } catch (e) {}
        };
        apply();
        if (this._pauseReassert) clearInterval(this._pauseReassert);
        this._pauseReassert = setInterval(apply, 150);
      } finally {
        this._locking = false;
      }
    },
    unlockPlay() {
      this._userPaused = false;
      this._pauseLockUntil = 0;
      this._pauseLockVid = null;
      if (this._pauseReassert) {
        clearInterval(this._pauseReassert);
        this._pauseReassert = null;
      }
    },
    // True when a pause lock does not belong to `vid` (or lock has no identity).
    pauseLockIsStale(vid) {
      if (!this._userPaused) return false;
      if (!this._pauseLockVid) return true;
      if (!vid) return false;
      return this._pauseLockVid !== vid;
    },
    // Best current video id: player API first (URL can lag SPA navigation).
    currentPlaybackVid() {
      try {
        const p = document.getElementById('movie_player');
        const pv = p?.getVideoData?.()?.video_id;
        if (pv) return pv;
      } catch (e) {}
      return (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    },
    // Engine-internal resume: never yank playback after a user/media-key pause.
    _tryPlayAudio() {
      if (this._userPaused || Date.now() < this._pauseLockUntil) return;
      if (!this.isActive || !this.audio || this.isAdActive()) return;
      if (!this.audio.paused) return;
      this.audio.play().catch(() => {});
    },
    _isAudioBuffering: false,
    _isInternalVideoSync: false,
    _isTabResyncing: false,
    _isSeeking: false,
    _seekDebounceTimer: null,
    _waitingPauseTimer: null,
    _advanceFallbackTimer: null,
    _hasDispatchedEnded: false,
    _trackEnded: false,
    _reconnectAttempts: 0,
    _lastAudioTime: -1,
    _lastAudioAdvance: 0,
    _audioStalledAt: 0,
    _currentNormGain: 1.0,

    hasRecentUserMuteOrVolIntent() {
      return (Date.now() - (this._lastUserMuteOrVolIntentAt || 0)) < 1500;
    },

    hasRecentUserSeekIntent() {
      return (Date.now() - (this._lastUserSeekIntentAt || 0)) < 2500;
    },

    isInTransitionWindow() {
      return (Date.now() - (this._transitionStartedAt || 0)) < 3500;
    },

    isTimeBuffered(mediaEl, timeSec) {
      if (!mediaEl || !mediaEl.buffered) return false;
      try {
        const b = mediaEl.buffered;
        for (let i = 0; i < b.length; i++) {
          if (timeSec >= b.start(i) - 0.25 && timeSec <= b.end(i) - 0.15) {
            return true;
          }
        }
      } catch (e) {}
      return false;
    },

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
          const rawSrc = this.best774Candidate?._src || status.activeMethod || 'YTM_HARVESTER';
          const currentSrc = String(rawSrc).includes('TVHTML5') ? 'TVHTML5' : 'YTM_HARVESTER';
          console.log(TAG, `[StudioEngine774] Stream error (code: ${err?.code}, message: ${err?.message}) on source: ${currentSrc}`);

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
            this._initialMetaSynced = true;
            const vTime = getVideoTimeFor(this.activeVideoId);
            if (vTime > 0.5 && Math.abs(this.audio.currentTime - vTime) > 0.35) {
              try {
                this.audio.currentTime = vTime;
                if (UmpMseController774.isActive) {
                  UmpMseController774.onSeek(vTime);
                }
              } catch (e) {}
            }
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
            console.log(TAG, '[StudioEngine774] Audio buffer replenished. Master clock continues seamlessly.');
          }
          // CRITICAL: Never seek this.audio.currentTime = video.currentTime here!
          // Seeking audio on canplay/canplaythrough causes a feedback loop of re-buffering and audio jumps.
        };

        this.audio.addEventListener('canplay', onAudioBufferReady);
        this.audio.addEventListener('canplaythrough', onAudioBufferReady);

        // When 774 audio is ACTUALLY playing, seamlessly silence native video and align silent video to Master Clock audio
        this.audio.addEventListener('playing', () => {
          this._reconnectAttempts = 0;
          this._lastAudioTime = this.audio.currentTime;
          this._lastAudioAdvance = Date.now();
          onAudioBufferReady();
          if (this.isAdActive()) {
            try { this.audio.pause(); } catch (e) {}
            const v = getMainVideoElement();
            if (v) this.restoreNativeVideo(v);
            return;
          }
          if (this.isActive || this._isTransitioning) {
            const video = getMainVideoElement();
            if (video) {
              const pState = document.getElementById('movie_player')?.getPlayerState?.();
              // If user paused video while audio was still buffering/loading, immediately pause audio to prevent sound leak
              if (video.paused && pState !== 3 && (!document.hidden || this._userPaused || pState === 2 || pState === 0)) {
                try { this.audio.pause(); } catch (e) {}
                return;
              }
              this._silenceElement(video);
              const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
              // Align silent video to master audio clock if video drifted while audio was buffering
              if ((!playerVid || playerVid === this.activeVideoId) && !video.seeking && !this._isSeeking && !this._isInternalVideoSync) {
                const diff = Math.abs(video.currentTime - this.audio.currentTime);
                if (diff > 0.40 && this.isTimeBuffered(video, this.audio.currentTime)) {
                  this._isInternalVideoSync = true;
                  try { video.currentTime = this.audio.currentTime; } catch (e) {}
                  setTimeout(() => { this._isInternalVideoSync = false; }, 250);
                }
              }
            }
          }
        });

        this.audio.addEventListener('waiting', () => {
          if (!this.isActive || this.isAdActive()) return;
          this._audioStalledAt = Date.now();
          this._isAudioBuffering = true;
        });

        this.audio.addEventListener('stalled', () => {
          if (!this.isActive || this.isAdActive()) return;
          this._audioStalledAt = Date.now();
          this._isAudioBuffering = true;
        });

        this.audio.addEventListener('pause', () => {
          if (this.isActive && this.isAdActive()) {
            const video = getMainVideoElement();
            if (video) this.restoreNativeVideo(video);
          }
        });

        this.audio.addEventListener('ended', () => {
          if (!this.isActive) return;

          // 0. Loop Mode Check: if user enabled Loop on the player or video element, replay seamlessly from 0:00
          if (this.isLoopActive()) {
            console.log(TAG, '[StudioEngine774] Loop mode is ACTIVE -> Seamlessly looping current 774 track from 0:00');
            this._trackEnded = false;
            if (this.audio) {
              this.audio.currentTime = 0;
              this.audio.play().catch(() => {});
            }
            const video = getMainVideoElement();
            if (video) {
              this._silenceElement(video);
              try { video.currentTime = 0; } catch (e) {}
              if (video.paused) {
                video.play().catch(() => {});
              }
            }
            return;
          }

          console.log(TAG, '[StudioEngine774] Audio playback completed. Evaluating autoplay/playlist state...');
          this._trackEnded = true;
          if (this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (e) {}
          }
          const video = getMainVideoElement();
          const player = document.getElementById('movie_player');
          const shouldAdvance = this.shouldAutoplayNext();

          if (video) {
            this._silenceElement(video);
            this._isInternalVideoSync = true;
            try {
              if (video.duration && !isNaN(video.duration)) {
                video.currentTime = video.duration;
              }
            } catch (e) {}
            // ALWAYS pause video at track end so it stays cleanly stopped on the end screen
            try { video.pause(); } catch (e) {}
            if (shouldAdvance) {
              // Dispatch ended once to trigger YouTube's native transition ONLY if video not already ended
              if (!video.ended) {
                video.dispatchEvent(new Event('ended', { bubbles: true }));
              }
            }
            setTimeout(() => { this._isInternalVideoSync = false; }, 300);
          }

          if (shouldAdvance) {
            if (player) {
              if (this._advanceFallbackTimer) clearTimeout(this._advanceFallbackTimer);
              const isPl = (typeof player.getPlaylistId === 'function' && !!player.getPlaylistId()) || !!document.querySelector('ytd-playlist-panel-renderer');
              // Allow YouTube's native countdown (3..2..1) to complete naturally. Fallback only acts if player gets stuck.
              const delay = isPl ? 3500 : 7000;
              this._advanceFallbackTimer = setTimeout(() => {
                this._advanceFallbackTimer = null;
                if ((this.isActive || this._isTransitioning) && player.getVideoData?.()?.video_id === this.activeVideoId) {
                  if (typeof player.nextVideo === 'function') {
                    console.log(TAG, '[StudioEngine774] Video did not auto-advance; calling fallback player.nextVideo()...');
                    try { player.nextVideo(); } catch (e) {}
                  }
                }
              }, delay);
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

    isLoopActive() {
      // 1. Native HTML5 video element loop property (set when user right clicks video -> "Loop")
      const video = getMainVideoElement();
      if (video && video.loop) return true;

      // 2. YouTube movie_player API: getLoopVideo()
      const player = document.getElementById('movie_player');
      if (player && typeof player.getLoopVideo === 'function') {
        try {
          if (player.getLoopVideo()) return true;
        } catch (e) {}
      }

      // 3. YouTube single video playlist repeat button
      try {
        const loopBtn = document.querySelector('ytd-playlist-loop-button-renderer button, .ytp-playlist-loop-button');
        if (loopBtn) {
          const ariaLabel = (loopBtn.getAttribute('aria-label') || '').toLowerCase();
          const title = (loopBtn.getAttribute('title') || '').toLowerCase();
          if (ariaLabel.includes('1') || ariaLabel.includes('current') || ariaLabel.includes('hiện tại') ||
              title.includes('1') || title.includes('current') || title.includes('hiện tại')) {
            return true;
          }
        }
      } catch (e) {}

      return false;
    },

    shouldAutoplayNext() {
      // Loop mode strictly overrides autoplay: never advance while looping current track!
      if (this.isLoopActive()) return false;

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
      if (!el || el === this.audio || (!this.isActive && !this._isTransitioning) || this.isAdActive()) return;
      this.hookVideoVolume(el);
      try {
        if (descVolume.get.call(el) !== 0) {
          descVolume.set.call(el, 0);
        }
      } catch (e) {}
      try {
        const targetMuted = Boolean(this._userMuted);
        if (descMuted.get.call(el) !== targetMuted) {
          descMuted.set.call(el, targetMuted);
        }
      } catch (e) {}
    },

    hookVideoVolume(video) {
      if (!video || video._ytssVolHooked) return;
      video._ytssVolHooked = true;
      try {
        const rawV = descVolume.get.call(video);
        video._userVol = (typeof rawV === 'number' && !isNaN(rawV) && rawV > 0)
          ? rawV
          : (this._userVol || readStoredYoutubeVolumeState().volume || 1.0);
      } catch (e) {
        video._userVol = this._userVol || 1.0;
      }
      video._userMuted = Boolean(this._userMuted);

      // 1. Intercept volume setter/getter
      try {
        Object.defineProperty(video, 'volume', {
          get() {
            if (StudioEngine774.isActive || StudioEngine774._isTransitioning) {
              if (typeof this._userVol === 'number' && !isNaN(this._userVol)) {
                return this._userVol;
              }
              return (typeof StudioEngine774._userVol === 'number' && !isNaN(StudioEngine774._userVol))
                ? StudioEngine774._userVol
                : 1.0;
            }
            return descVolume.get.call(this);
          },
          set(v) {
            const numV = (typeof v === 'number' && !isNaN(v)) ? Math.max(0, Math.min(1.0, v)) : 1.0;
            StudioEngine774._lastUserMuteOrVolIntentAt = Date.now();
            this._userVol = numV;
            StudioEngine774._userVol = numV;
            if (numV > 0) {
              this._userMuted = false;
              StudioEngine774._userMuted = false;
            } else {
              this._userVol = 0;
              this._userMuted = true;
              StudioEngine774._userMuted = true;
            }
            if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && !StudioEngine774.isAdActive()) {
              StudioEngine774._silenceElement(this);
              if (StudioEngine774.audio && StudioEngine774.isActive) {
                StudioEngine774.syncVolDirect(numV);
              }
            } else {
              try { descVolume.set.call(this, numV); } catch (e) {}
            }
          },
          configurable: true
        });
      } catch (e) {}

      // 2. Intercept muted setter/getter
      try {
        Object.defineProperty(video, 'muted', {
          get() {
            if (StudioEngine774.isActive || StudioEngine774._isTransitioning) {
              return Boolean(StudioEngine774._userMuted);
            }
            return descMuted.get.call(this);
          },
          set(m) {
            let targetMuted = !!m;
            if (!this.isConnected) {
              this._userMuted = targetMuted;
              try { descMuted.set.call(this, targetMuted); } catch (e) {}
              return;
            }
            if (typeof isPlayerActiveOnPage === 'function' && !isPlayerActiveOnPage()) {
              try { descMuted.set.call(this, targetMuted); } catch (e) {}
              return;
            }
            if (targetMuted && !StudioEngine774.hasRecentUserMuteOrVolIntent()) {
              const p = document.getElementById('movie_player');
              const pMuted = (p && typeof p.isMuted === 'function') ? p.isMuted() : false;
              if (!pMuted) {
                targetMuted = false;
              }
            }
            this._userMuted = targetMuted;
            StudioEngine774._userMuted = targetMuted;
            if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && !StudioEngine774.isAdActive()) {
              StudioEngine774._silenceElement(this);
              if (StudioEngine774.audio && StudioEngine774.isActive) {
                if (StudioEngine774.isUserMuted()) {
                  StudioEngine774.audio.volume = 0;
                } else {
                  const curVol = (typeof this._userVol === 'number' && !isNaN(this._userVol)) ? this._userVol : (StudioEngine774._userVol || 1.0);
                  StudioEngine774.syncVolDirect(curVol);
                }
              }
            } else {
              try { descMuted.set.call(this, targetMuted); } catch (e) {}
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
          : (this._userVol || 1.0);
        const isMuted = Boolean(this._userMuted);

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

      // Track explicit user interactions for Mute/Volume vs Seek so we never confuse
      // internal YouTube transition/buffer glitches with genuine user actions
      const markPointerIntent = (e) => {
        const t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        if (t.closest('.ytp-mute-button, .ytp-volume-panel, .ytp-volume-area, .ytp-volume-slider, .ytp-volume-slider-handle, .ytp-volume-icon, [class*="volume"]')) {
          this._lastUserMuteOrVolIntentAt = Date.now();
        }
        if (t.closest('.ytp-progress-bar, .ytp-progress-bar-container, .ytp-scrubber-container, .ytp-chapter-container, .ytp-fine-scrubbing-container, a[href*="t="], ytd-macro-markers-list-item-renderer')) {
          this._lastUserSeekIntentAt = Date.now();
        }
      };
      ['pointerdown', 'mousedown', 'touchstart', 'click', 'wheel'].forEach(evt => {
        document.addEventListener(evt, markPointerIntent, { capture: true, passive: true });
      });

      document.addEventListener('keydown', (e) => {
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
        const k = e.key;
        const c = e.code;
        if (k === 'm' || k === 'M' || c === 'KeyM' || k === 'AudioVolumeMute' || k === 'ArrowUp' || k === 'ArrowDown') {
          this._lastUserMuteOrVolIntentAt = Date.now();
        }
        if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'j' || k === 'J' || k === 'l' || k === 'L' ||
            k === 'Home' || k === 'End' || k === ',' || k === '.' || (k >= '0' && k <= '9')) {
          this._lastUserSeekIntentAt = Date.now();
        }
      }, { capture: true, passive: true });

      // HTML5 video events do not bubble, so we capture them at the document root
      const onVideoEvent = (e) => {
        if (!e.target || e.target.tagName !== 'VIDEO' || e.target.id === 'ytss-studio-774') return;
        const video = e.target;
        // Ignore hover thumbnail previews on home/feed pages
        if (video.closest('ytd-video-preview') || video.closest('ytd-thumbnail')) return;
        if (!video.closest('#movie_player, ytd-miniplayer, .html5-video-player') && !video.classList.contains('html5-main-video')) return;
        const curVid = getVideoIdFromUrl();
        if (curVid && confirmedNo774Videos.has(curVid)) {
          if (this.isActive || this._isTransitioning) {
            this.stopAndUnmute('Video has no 774', curVid);
          }
          return; // Confirmed NO 774: do not touch native video!
        }
        this.hookVideo(video);

        // If an ad is active, immediately pause 774 audio and restore native video audio
        // (must run before activePlayerVid check and before document.hidden check)
        if (this.isAdActive()) {
          if (this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (err) {}
          }
          this.restoreNativeVideo(video);
          return;
        }

        // If we have a pending 774 stream waiting for video
        if (this.pending774) {
          const { videoId, best774 } = this.pending774;
          if (isCurrentWatchVideo(videoId)) {
            this.applyToVideo(video, videoId, best774);
          }
        }

        if (this.isActive || this._isTransitioning) {
          this._silenceElement(video);
        }

        if (!this.isActive || !this.audio) return;

        // Guard: if StudioEngine774 is already attached to the new target video while #movie_player
        // is still tearing down the outgoing video, ignore outgoing video's time/seek/pause events!
        const activePlayerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
        if (activePlayerVid && this.activeVideoId && activePlayerVid !== this.activeVideoId) {
          if (!isCurrentWatchVideo(this.activeVideoId)) {
            this.prepareTransition(getVideoIdFromUrl());
          }
          return;
        }

        // 1. Seeking & Seeked — Process BEFORE document.hidden check so background seeking works!
        if (e.type === 'seeking') {
          if (this._isVolScrubbing || this._isInternalVideoSync || this._isTabResyncing) return;
          this._isSeeking = true;
          this._lastSeekTime = Date.now();
          this._hasDispatchedEnded = false;
          if (!this.isAdActive()) {
            this._silenceElement(video);
            this.syncVol(video);
          }
          return;
        }

        if (e.type === 'seeked') {
          if (this._isVolScrubbing || this._isInternalVideoSync || this._isTabResyncing) return;
          if (this._seekDebounceTimer) {
            clearTimeout(this._seekDebounceTimer);
            this._seekDebounceTimer = null;
          }
          this._isSeeking = false;
          this._hasDispatchedEnded = false;

          const vTargetSec = getVideoTimeFor(this.activeVideoId);

          // If loop mode is active and video just looped back to start from the end:
          if (this.isLoopActive() && vTargetSec < 1.0 && this.audio && this.audio.duration && this.audio.currentTime >= this.audio.duration - 2.5) {
            console.log(TAG, '[StudioEngine774] Native video looped back to start -> Resetting 774 audio to 0:00');
            this._trackEnded = false;
            this.audio.currentTime = vTargetSec;
            if (this.audio.paused) {
              this.audio.play().catch(() => {});
            }
            return;
          }

          // Prevent unwanted replay from 0:00 when video finishes and resets to end screen (loop is inactive)
          if (!this.isLoopActive() && vTargetSec < 1.0 && (this._trackEnded || video.ended || (this.audio && this.audio.duration && this.audio.currentTime >= this.audio.duration - 2.5))) {
            return;
          }

          if (!this.isAdActive()) {
            this._silenceElement(video);
            this.syncVol(video);
            const drift = Math.abs(this.audio.currentTime - vTargetSec);
            // Responsive seek: immediately align audio whenever drift > 0.12s (covers short seeks, scrubbing, chapter clicks)
            if (drift > 0.12) {
              this._lastSeekTime = Date.now();
              this.audio.currentTime = vTargetSec;
              if (UmpMseController774.isActive) {
                UmpMseController774.onSeek(vTargetSec);
              }
            }
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
          if (this.isLoopActive()) {
            this._trackEnded = false;
            if (this.audio) {
              this.audio.currentTime = 0;
              this.audio.play().catch(() => {});
            }
            try { video.currentTime = 0; } catch (e) {}
            if (video.paused) {
              video.play().catch(() => {});
            }
            return;
          }
          this._trackEnded = true;
          if (video && !video.paused) {
            try { video.pause(); } catch (e) {}
          }
          if (this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (e) {}
          }
          return;
        }

        // 4. Background / Hidden optimization: let audio play continuously in background unless player is truly paused/stopped
        if (document.hidden) {
          if ((e.type === 'play' || e.type === 'playing') && !this.isAdActive()) {
            this._silenceElement(video);
            this.syncVol(video);
            this.audio.playbackRate = video.playbackRate;
            if (this.audio.paused) {
              const vTargetSec = getVideoTimeFor(this.activeVideoId);
              if (Math.abs(this.audio.currentTime - vTargetSec) > 1.0) {
                this.audio.currentTime = vTargetSec;
              }
              this._tryPlayAudio();
            }
            return;
          }
          if (e.type === 'pause') {
            const pState = document.getElementById('movie_player')?.getPlayerState?.();
            // If YouTube player state is 1 (playing), Chrome is just background-throttling the video element; keep playing audio!
            if (pState === 1 && !video.ended) {
              try {
                e.stopImmediatePropagation();
                e.stopPropagation();
              } catch (err) {}
              return;
            }
            // Otherwise (pState === 2 for paused, or 0 for ended, or -1 for unstarted), genuine pause!
            this._userPaused = true;
            if (this.audio && !this.audio.paused) {
              try { this.audio.pause(); } catch (err) {}
            }
            return;
          }
          if (e.type === 'error') {
            if (this.audio && !this.audio.paused) {
              try { this.audio.pause(); } catch (err) {}
            }
            UmpMseController774.stop();
            return;
          }
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
          // Guard: if track has naturally ended, do NOT reset _trackEnded or resume audio unless loop mode is active
          if (video.ended && !this.isLoopActive()) {
            this._trackEnded = true;
            if (this.audio && !this.audio.paused) try { this.audio.pause(); } catch (e) {}
            return;
          }
          if (this._userPaused) {
            const curVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
            if (this.pauseLockIsStale(curVid)) {
              // Autoplay / new video — do not inherit previous pause.
              this.unlockPlay();
            } else {
              // V3/MSE auto-resume race on the SAME video — keep the user's pause.
              this.lockPause();
              return;
            }
          }
          this._trackEnded = false;
          // Playback Safety Guard: verify audio engine is playing for current active video
          if (this.isActive && this.activeVideoId && !isCurrentWatchVideo(this.activeVideoId)) {
            console.log(TAG, `[PlaybackSafetyGuard] Audio engine playing ${this.activeVideoId} but video is no longer active! Preparing transition.`);
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
            const vTargetSec = getVideoTimeFor(this.activeVideoId);
            const diff = Math.abs(this.audio.currentTime - vTargetSec);
            // Only align audio.currentTime when resuming from paused if drift is > 0.6s
            if (diff > 0.6) {
              this.audio.currentTime = vTargetSec;
            }
            this.audio.playbackRate = video.playbackRate || 1.0;
            if (!this._userPaused) {
              this.audio.play().catch((err) => {
                if (err && err.name === 'NotAllowedError') {
                  const resume = () => {
                    if (this.isActive && this.audio && !video.paused && !this.isAdActive() && !this._userPaused) {
                      this.audio.play().catch(() => {});
                    }
                  };
                  window.addEventListener('click', resume, { once: true, capture: true });
                  window.addEventListener('keydown', resume, { once: true, capture: true });
                }
              });
            }
          }
        } else if (e.type === 'pause') {
          if (video.ended) {
            return;
          }
          // Ignore transient video pause if YouTube player is merely buffering (state === 3)
          const pState = document.getElementById('movie_player')?.getPlayerState?.();
          if (pState === 3) {
            return;
          }
          if (this._isInternalVideoSync || this._isSeeking) return;
          const g = window.__ytssPauseGesture;
          const userPauseIntent = g && !g.wasPaused && !fsBusy() && (Date.now() - g.at) < 450;
          // Only sticky-lock on user pause. Engine/MSE pause events otherwise
          // just stop 774 audio alongside the video.
          if (userPauseIntent) {
            this.lockPause();
          } else if (!this._userPaused && this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (e) {}
          }
        } else if (e.type === 'error') {
          console.log(TAG, '[StudioEngine774] Main video element error -> Halting audio stream');
          if (this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (err) {}
          }
          UmpMseController774.stop();
          this.isActive = false;
          return;
        } else if (e.type === 'loadedmetadata' || e.type === 'canplay') {
          if (!this.isAdActive() && !document.hidden && !this._isInternalVideoSync && !this._isVolScrubbing) {
            this._silenceElement(video);
            this.syncVol(video);
            if (video.paused && !this.audio.paused) {
              this.audio.pause();
            } else if (!video.paused && this.audio.paused) {
              this._tryPlayAudio();
            }
          }
        }
      };

      const captureOpts = { capture: true, passive: true };
      ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange', 'loadedmetadata', 'canplay', 'ended', 'error', 'loadstart', 'emptied'].forEach(evt => {
        document.addEventListener(evt, onVideoEvent, captureOpts);
      });
    },

    hookVideo(video) {
      if (!video || this._hookedVideos.has(video)) return;
      this._hookedVideos.add(video);
      try {
        video.addEventListener('loadstart', () => {
          // New media load = new playback context. Always drop pause lock so
          // click-to-play / autoplay after a pause is never swallowed.
          if (this._userPaused) this.unlockPlay();
        }, { passive: true });
        video.addEventListener('emptied', () => {
          if (this._userPaused) this.unlockPlay();
        }, { passive: true });
      } catch (e) {}
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
          let isMuted = data ? !!data.muted : (typeof player.isMuted === 'function' && player.isMuted());
          let vol = (typeof this._userVol === 'number' && !isNaN(this._userVol)) ? this._userVol : 1.0;
          if (data && typeof data.volume === 'number' && !isNaN(data.volume)) {
            vol = data.volume / 100;
          } else if (typeof player.getVolume === 'function') {
            const pv = player.getVolume();
            if (typeof pv === 'number' && !isNaN(pv)) vol = pv / 100;
          }
          vol = Math.max(0, Math.min(1.0, vol));

          // Guard against YouTube's spurious auto-mute during track selection / transition
          if (isMuted && !this._userMuted && !this.hasRecentUserMuteOrVolIntent() && (this._isTransitioning || this.isInTransitionWindow())) {
            isMuted = false;
            if (typeof player.unMute === 'function') {
              try { player.unMute(); } catch (e) {}
            }
          }

          if (this.hasRecentUserMuteOrVolIntent() || !isMuted) {
            this._userMuted = isMuted;
          }
          this._userVol = vol;
          if (vol === 0) {
            this._userMuted = true;
          }
          const mainV = getMainVideoElement();
          if (mainV) {
            mainV._userMuted = this._userMuted;
            mainV._userVol = vol;
          }

          if (this.isActive && !this.isAdActive() && this.audio) {
            if (this._userMuted || vol <= 0) {
              this.audio.volume = 0;
            } else {
              this.syncVolDirect(this._userVol);
            }
          }
        };

        player.addEventListener('onVolumeChange', handleVolumeChange);

        // Sync YouTube player pause/play with the detached 774 <audio>.
        if (!player._ytssPauseHooked && typeof player.pauseVideo === 'function') {
          player._ytssPauseHooked = true;
          const origPauseVideo = player.pauseVideo.bind(player);
          const origPlayVideo = typeof player.playVideo === 'function' ? player.playVideo.bind(player) : null;
          player.pauseVideo = (...a) => {
            this.lockPause();
            return origPauseVideo(...a);
          };
          if (origPlayVideo) {
            player.playVideo = (...a) => {
              // Do NOT unlock here — V3 also calls playVideo(). The play()
              // interceptor only unlocks on a trusted play gesture.
              return origPlayVideo(...a);
            };
          }
        }

        // OS media keys / Chrome media widget
        try {
          if (navigator.mediaSession && typeof navigator.mediaSession.setActionHandler === 'function') {
            navigator.mediaSession.setActionHandler('pause', () => {
              this.lockPause();
              try { player.pauseVideo?.(); } catch (e) {}
              if (this.audio && !this.audio.paused) {
                try { this.audio.pause(); } catch (e) {}
              }
              const v = getMainVideoElement();
              if (v && !v.paused) {
                try { origPause.call(v); } catch (e) {}
              }
            });
            navigator.mediaSession.setActionHandler('play', () => {
              this.unlockPlay();
              try { player.playVideo?.(); } catch (e) {}
              const v = getMainVideoElement();
              if (v && v.paused) {
                try { v.play(); } catch (e) {}
              }
            });
          }
        } catch (e) {}

        let isPlaybackEnded = false;
        const handleVideoDataChange = () => {
          const urlVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
          const pVid = player.getVideoData?.()?.video_id || null;
          // During SPA transition, player.getVideoData().video_id often lags on the outgoing track
          // while onStateChange fires. Never let the outgoing track override the transition target!
          if (this._isTransitioning && this._transitionTargetVid && pVid && pVid !== this._transitionTargetVid) {
            return;
          }
          if (urlVid && pVid && pVid !== urlVid && navTargetVideoId === urlVid) {
            return;
          }
          const newVid = pVid || urlVid;
          if (!newVid) return;

          if (confirmedNo774Videos.has(newVid)) {
            this.activeVideoId = newVid;
            if (this.isActive || this._isTransitioning) {
              this.stopAndUnmute('Video has no 774', newVid);
            }
            return;
          }

          if (newVid !== this.activeVideoId || !this.isActive) {
            if (this._transitionTargetVid === newVid && pendingFetches.has(newVid)) {
              return;
            }
            console.log(TAG, `[PlayerVideoDataChange] Video active inside player: ${newVid} (was ${this.activeVideoId}, active: ${this.isActive})`);
            // New track only: never inherit the previous video's pause lock.
            // Do NOT unlock just because _userPaused — videodatachange can fire
            // on the SAME video while paused and would fight the user (flicker).
            if (this.pauseLockIsStale(newVid)) {
              this.unlockPlay();
            }
            navTargetVideoId = newVid;
            failedSourcesPerVideo.delete(newVid);
            failedFetches.delete(newVid);
            confirmedNo774Videos.clear(); // Ephemeral: clear previous video no-774 state
            NextVideoManager.reset(newVid);
            isPlaybackEnded = false;

            if (newVid !== this.activeVideoId && this._transitionTargetVid !== newVid) {
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
              if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0) {
                this.load774(newVid, playable[0]);
              } else if (all774.length > 0) {
                noteTvNative774(all774[0], all774.length, newVid, cached?.streamingContext || null);
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
          if (state === 2) {
            // YT paused (UI button / space / media session through player)
            // Ignore state 2 noise during fullscreen transitions.
            if (!fsBusy()) this.lockPause();
            return;
          }
          // state 1/3 can be fired by V3 auto-resume — never unlock here.
          if (state === 0) {
            if (this.isLoopActive()) {
              this._trackEnded = false;
              if (this.audio) {
                this.audio.currentTime = 0;
                this.audio.play().catch(() => {});
              }
              const v = getMainVideoElement();
              if (v) {
                try { v.currentTime = 0; } catch (e) {}
                if (v.paused) v.play().catch(() => {});
              }
              return;
            }
            isPlaybackEnded = true;
            this._trackEnded = true;
            const v = getMainVideoElement();
            if (v && !v.paused) {
              try { v.pause(); } catch (e) {}
            }
            if (this.audio && !this.audio.paused) {
              try { this.audio.pause(); } catch (e) {}
            }
          } else if (state === 1 || state === 3) {
            this._trackEnded = false;
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
            if (!isPlayerActiveOnPage()) {
              navTargetVideoId = null;
              this.stopAndUnmute('Navigated away from watch page');
              return;
            }
            if (state === 5 && this.audio && !this.audio.paused) {
              try { this.audio.pause(); } catch (e) {}
            }
            handleVideoDataChange();
          }
        });

        // Miniplayer close button click handler
        document.addEventListener('click', (e) => {
          const closeMini = e.target?.closest?.('.ytp-miniplayer-close-button, ytd-miniplayer #close-button, ytd-miniplayer button[aria-label="Đóng"], ytd-miniplayer button[aria-label="Close"]');
          if (closeMini) {
            navTargetVideoId = null;
            StudioEngine774.stopAndUnmute('Navigated away from watch page');
          }
        }, true);

        player.addEventListener('onError', (errCode) => {
          console.log(TAG, `[StudioEngine774] Player onError: ${errCode} -> pausing 774 audio`);
          if (this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (err) {}
          }
          UmpMseController774.stop();
        });

        // Replay button click handler for ended video replay
        document.addEventListener('click', (e) => {
          const replayBtn = e.target?.closest?.('.ytp-play-button, .ytp-replay-button');
          if (replayBtn) {
            // Pause intent must stick even if a later canplay tries to resume 774 audio.
            try {
              const st = typeof player.getPlayerState === 'function' ? player.getPlayerState() : null;
              const mainV = getMainVideoElement();
              const wasPlaying = st === 1 || st === 3 || (mainV && !mainV.paused && !mainV.ended);
              if (wasPlaying) {
                this.lockPause();
              } else {
                this.unlockPlay();
              }
            } catch (err) {}
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

        const origSeekTo = player.seekTo;
        if (typeof origSeekTo === 'function') {
          player.seekTo = (...args) => {
            this._lastUserSeekIntentAt = Date.now();
            return origSeekTo.apply(player, args);
          };
        }

        const origSetVol = player.setVolume;
        player.setVolume = (v) => {
          this._lastUserMuteOrVolIntentAt = Date.now();
          const numV = (typeof v === 'number' && !isNaN(v)) ? Math.max(0, Math.min(100, v)) : 100;
          if (numV > 0) {
            this._userVol = numV / 100;
            this._userMuted = false;
            const mainV = getMainVideoElement();
            if (mainV) {
              mainV._userVol = this._userVol;
              mainV._userMuted = false;
            }
          } else {
            this._userVol = 0;
            this._userMuted = true;
            const mainV = getMainVideoElement();
            if (mainV) {
              mainV._userVol = 0;
              mainV._userMuted = true;
            }
          }
          const res = origSetVol.call(player, numV);
          if ((this.isActive || this._isTransitioning) && !this.isAdActive()) {
            const mainV = getMainVideoElement();
            if (mainV) this._silenceElement(mainV);
            if (this.audio && this.isActive) {
              this.syncVolDirect(this._userVol);
            }
          }
          return res;
        };

        const origMute = player.mute;
        if (typeof origMute === 'function') {
          player.mute = () => {
            this._lastUserMuteOrVolIntentAt = Date.now();
            if (!this._userMuted && (this._isTransitioning || this.isInTransitionWindow())) {
              // Suppress spurious YouTube auto-mute during track switch
              const mainV = getMainVideoElement();
              if (mainV) this._silenceElement(mainV);
              return;
            }
            this._userMuted = true;
            const mainV = getMainVideoElement();
            if (mainV) mainV._userMuted = true;
            const res = origMute.call(player);
            if ((this.isActive || this._isTransitioning) && !this.isAdActive()) {
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
            this._lastUserMuteOrVolIntentAt = Date.now();
            this._userMuted = false;
            const mainV = getMainVideoElement();
            if (mainV) mainV._userMuted = false;
            const res = origUnmute.call(player);
            if ((this.isActive || this._isTransitioning) && !this.isAdActive()) {
              const mainV = getMainVideoElement();
              if (mainV) this._silenceElement(mainV);
              if (this.audio && this.isActive) {
                const curVol = (typeof this._userVol === 'number' && !isNaN(this._userVol)) ? this._userVol : 1.0;
                this.syncVolDirect(curVol);
              }
            }
            return res;
          };
        }
      }
    },

    prepareTransition(newVid) {
      if (!newVid || !VIDEO_ID_RE.test(newVid) || window.location.pathname.startsWith('/shorts/')) {
        this.stopAndUnmute('Navigated away from watch page');
        return;
      }
      console.log(TAG, `[StudioEngine774] Preparing transition to: ${newVid}`);
      // New video = new playback context. A pause lock from the previous track
      // must not block play() on this one.
      this.unlockPlay();
      UmpMseController774.stop();
      this._isTransitioning = true;
      this._transitionTargetVid = newVid;
      this._transitionStartedAt = Date.now();
      this._initialMetaSynced = false;
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
      this._trackEnded = false;
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
      if (this._transitionSafetyTimer) {
        clearTimeout(this._transitionSafetyTimer);
        this._transitionSafetyTimer = null;
      }
      this._transitionSafetyTimer = setTimeout(() => {
        this._transitionSafetyTimer = null;
        if (this._isTransitioning && !this.isActive) {
          console.log(TAG, `[StudioEngine774] Transition safety timeout for ${newVid} -> restoring native audio`);
          this.stopAndUnmute('Transition timeout fallback', newVid);
        }
      }, 6000);
      if (this.audio) {
        try {
          this.audio.pause();
          this.audio.removeAttribute('src');
          this.audio.load();
        } catch (e) {}
      }
      this.silenceNativeVideo();
    },

    isUserMuted() {
      if (this._userMuted && !this.hasRecentUserMuteOrVolIntent()) {
        try {
          const p = document.getElementById('movie_player');
          if (p && typeof p.isMuted === 'function' && !p.isMuted()) {
            const pv = (typeof p.getVolume === 'function') ? p.getVolume() : 100;
            if (typeof pv !== 'number' || isNaN(pv) || pv > 0) {
              this._userMuted = false;
            }
          }
        } catch (e) {}
      }
      return Boolean(this._userMuted);
    },

    getUserVolume() {
      if (this.isUserMuted()) return 0;
      if (typeof this._userVol === 'number' && !isNaN(this._userVol)) {
        return Math.max(0, Math.min(1.0, this._userVol));
      }
      const player = document.getElementById('movie_player');
      if (player && typeof player.getVolume === 'function') {
        try {
          const v = player.getVolume();
          if (typeof v === 'number' && !isNaN(v)) {
            this._userVol = Math.max(0, Math.min(1.0, v / 100));
            return this._userVol;
          }
        } catch (e) {}
      }
      const video = getMainVideoElement();
      if (video && typeof video._userVol === 'number' && !isNaN(video._userVol)) {
        this._userVol = Math.max(0, Math.min(1.0, video._userVol));
        return this._userVol;
      }
      return 1.0;
    },

    updateNormalizedGain(videoId) {
      if (!S.volumeBalance) {
        this._currentNormGain = 1.0;
        return 1.0;
      }
      const vid = videoId || this.activeVideoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
      let lDb = null;

      if (vid && loudnessDbMap.has(vid)) {
        lDb = loudnessDbMap.get(vid);
      }

      // 1. Check YouTube player's playerResponse audioConfig
      if (lDb === null) {
        try {
          const player = document.getElementById('movie_player');
          const pr = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          const pVid = pr?.videoDetails?.videoId;
          if (!vid || !pVid || pVid === vid) {
            if (typeof pr?.playerConfig?.audioConfig?.loudnessDb === 'number') {
              lDb = pr.playerConfig.audioConfig.loudnessDb;
            }
          }
        } catch (e) {}
      }

      // 2. Check cached metadata if available
      if (lDb === null && vid) {
        const cached = cacheGet(vid);
        if (typeof cached?.loudnessDb === 'number') {
          lDb = cached.loudnessDb;
        } else if (typeof cached?.audioConfig?.loudnessDb === 'number') {
          lDb = cached.audioConfig.loudnessDb;
        }
      }

      // 3. Fallback: Parse Stats for Nerds volume string if accessible
      if (lDb === null) {
        try {
          const player = document.getElementById('movie_player');
          const sVol = player?.getStatsForNerds?.()?.volume; // e.g. "100%/61% (cont.-9.7dB tgt.-14.0dB)"
          const m = sVol && sVol.match(/(\d+)%\s*\/\s*(\d+)%/);
          if (m && m[1] && m[2]) {
            const userPct = parseFloat(m[1]);
            const normPct = parseFloat(m[2]);
            if (userPct > 0 && normPct > 0) {
              this._currentNormGain = Math.max(0.15, Math.min(1.0, normPct / userPct));
              return this._currentNormGain;
            }
          }
        } catch (e) {}
      }

      if (typeof lDb === 'number' && !isNaN(lDb)) {
        if (vid) loudnessDbMap.set(vid, lDb);
        if (lDb > 0) {
          // Attenuate loud track to match target loudness (-14 LUFS): gain = 10^(-loudnessDb / 20)
          this._currentNormGain = Math.max(0.15, Math.min(1.0, Math.pow(10, -lDb / 20)));
        } else {
          // Track is at or below target loudness: no attenuation needed
          this._currentNormGain = 1.0;
        }
      } else {
        // Fallback empirical threshold: -4.8 dB attenuation (gain ~0.575)
        // Derived from benchmark tests on typical modern music tracks
        this._currentNormGain = 0.575;
      }
      return this._currentNormGain;
    },

    getNormalizedGain() {
      if (!S.volumeBalance) return 1.0;
      return (typeof this._currentNormGain === 'number' && !isNaN(this._currentNormGain))
        ? this._currentNormGain
        : 1.0;
    },

    syncVolDirect(v) {
      if (!this.isActive || !this.audio) return;
      this._markVolScrubbing();
      if (this.isAdActive()) return;
      const numV = (typeof v === 'number' && !isNaN(v)) ? Math.max(0, Math.min(1.0, v)) : 1.0;
      this._userVol = numV;
      if (numV > 0) {
        this._userMuted = false;
      }
      const normGain = this.getNormalizedGain();
      const target = (this.isUserMuted() || numV <= 0) ? 0 : Math.max(0, Math.min(1.0, numV * normGain));
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
          const userV = this.getUserVolume();
          const normGain = this.getNormalizedGain();
          const target = Math.max(0, Math.min(1.0, userV * normGain));
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
          // Only seek video if Chrome throttled background video significantly (> 0.8s)
          if (drift > 0.8) {
            this._isInternalVideoSync = true;
            this._isTabResyncing = true;
            video.currentTime = this.audio.currentTime;
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              setTimeout(() => {
                this._isInternalVideoSync = false;
                this._isTabResyncing = false;
              }, 200);
            };
            video.addEventListener('seeked', onSeeked, { once: true });
            setTimeout(() => {
              this._isInternalVideoSync = false;
              this._isTabResyncing = false;
            }, 1200);
          }
          video.play().catch(() => {});
          this._silenceElement(video);
        } else {
          const drift = this.audio.currentTime - video.currentTime;
          if (drift > 1.2) {
            this._isInternalVideoSync = true;
            this._isTabResyncing = true;
            video.currentTime = this.audio.currentTime;
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              setTimeout(() => {
                this._isInternalVideoSync = false;
                this._isTabResyncing = false;
              }, 200);
            };
            video.addEventListener('seeked', onSeeked, { once: true });
            setTimeout(() => {
              this._isInternalVideoSync = false;
              this._isTabResyncing = false;
            }, 1200);
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
      const targetTime = (this.audio && this.audio.currentTime > 0) ? this.audio.currentTime : (video ? getVideoTimeFor(this.activeVideoId) : 0);
      if (this.best774Candidate._isUmpMse && UmpMseController774.isActive) {
        UmpMseController774.onSeek(targetTime);
        return;
      }
      const rawUrl = this.best774Candidate.url || this.best774Candidate._directUrl;
      const streamUrl = cleanStreamUrl(rawUrl);
      if (!streamUrl) return;

      this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
      if (this._reconnectAttempts > 4) {
        console.log(TAG, '[StudioEngine774] Exceeded max reconnect attempts');
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
          this._tryPlayAudio();
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
      if (!isPlayerActiveOnPage()) {
        if (this.isActive || this._isTransitioning || this.pending774) {
          this.stopAndUnmute('Navigated away from watch page');
        }
        return;
      }
      if (typeof NextVideoManager !== 'undefined') {
        NextVideoManager.tick();
      }
      if (!this.isActive || !this.audio || !this.audio.src) return;
      if (this.isAdActive()) {
        if (!this.audio.paused) {
          try { this.audio.pause(); } catch (e) {}
        }
        const v = getMainVideoElement();
        if (v) this.restoreNativeVideo(v);
        return;
      }

      const video = getMainVideoElement();
      if (!video) return;

      // 0. Native Audio Leak Guard: ensure native video is NEVER outputting sound while StudioEngine774 is active
      try {
        document.querySelectorAll('video').forEach(v => {
          if (v !== this.audio) {
            const vVol = descVolume.get.call(v);
            if (vVol > 0) {
              this._silenceElement(v);
            }
          }
        });
      } catch (e) {}

      // 0b. Audio Volume & UI Mute Sync Guard: keep 774 audio and player UI mute icon strictly in sync
      if (!this._isVolScrubbing) {
        const userVol = this.getUserVolume();
        const normGain = this.getNormalizedGain();
        const targetVol = this.isUserMuted() ? 0 : Math.max(0, Math.min(1.0, userVol * normGain));
        if (Math.abs(this.audio.volume - targetVol) > 0.01) {
          this.audio.volume = targetVol;
        }
      }

      // If #movie_player has not yet finished transitioning its video_id to activeVideoId,
      // do not compare clocks or pause states against the outgoing video!
      const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
      if (playerVid && this.activeVideoId && playerVid !== this.activeVideoId) {
        return;
      }

      if (document.hidden) {
        // BACKGROUND TAB CLOCK SYNCHRONIZATION:
        // When tab is hidden, Chrome throttles or pauses background <video> to save GPU/power.
        // In this mode, <audio> is the MASTER CLOCK since it is what the user hears.
        // Periodically advance video.currentTime to keep YouTube player state in sync.
        if (!this.audio.paused && !this.audio.ended && !this._trackEnded) {
          const aTime = this.audio.currentTime;
          const vTime = video.currentTime;
          const drift = aTime - vTime;
          // Audio ahead of video (video throttled by browser): advance video
          if (drift > 1.5 && !video.seeking && !this._isInternalVideoSync) {
            this._isInternalVideoSync = true;
            video.currentTime = aTime;
            setTimeout(() => { this._isInternalVideoSync = false; }, 200);
          }

          if (video.duration && aTime >= video.duration - 0.5) {
            if (!this._hasDispatchedEnded) {
              this._hasDispatchedEnded = true;
              this._trackEnded = true;
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
          if (this.isLoopActive()) {
            this._trackEnded = false;
            if (this.audio) {
              this.audio.currentTime = 0;
              this.audio.play().catch(() => {});
            }
            try { video.currentTime = 0; } catch (e) {}
            if (video.paused) {
              video.play().catch(() => {});
            }
            return;
          }
          // Video ended naturally; do NOT abruptly kill audio while audio is finishing its last moments
          if (this.audio.ended || (this.audio.duration && this.audio.currentTime >= this.audio.duration - 0.5)) {
            if (!this.audio.paused) this.audio.pause();
            this._trackEnded = true;
          }
          return;
        }
        // Do not pause audio if YouTube player is merely buffering video (state === 3)
        const pState = document.getElementById('movie_player')?.getPlayerState?.();
        if (pState === 3) {
          return;
        }
        if (pState === 0) {
          // Video reached ended state
          if (this.isLoopActive()) {
            this._trackEnded = false;
            if (this.audio) {
              this.audio.currentTime = 0;
              this.audio.play().catch(() => {});
            }
            try { video.currentTime = 0; } catch (e) {}
            if (video.paused) {
              video.play().catch(() => {});
            }
            return;
          }
          this._trackEnded = true;
          if (video && !video.paused) {
            try { video.pause(); } catch (e) {}
          }
          if (!this.audio.paused) this.audio.pause();
          return;
        }
        if (!this.audio.paused) {
          this.audio.pause();
        }
        return;
      }

      // 0c. Track-end guard: only pause audio when audio itself or video has truly ended
      const isAudioFinished = this.audio && (this.audio.ended || (this.audio.duration && this.audio.currentTime >= this.audio.duration - 0.15));
      if (this._trackEnded || video.ended || isAudioFinished) {
        if (!this.isLoopActive()) {
          this._trackEnded = true;
          if (video && !video.paused) {
            try { video.pause(); } catch (e) {}
          }
          if (this.audio && !this.audio.paused) {
            try { this.audio.pause(); } catch (e) {}
          }
          if (this.shouldAutoplayNext()) {
            const player = document.getElementById('movie_player');
            if (player && !this._advanceFallbackTimer) {
              const isPl = (typeof player.getPlaylistId === 'function' && !!player.getPlaylistId()) || !!document.querySelector('ytd-playlist-panel-renderer');
              const delay = isPl ? 3500 : 7000;
              this._advanceFallbackTimer = setTimeout(() => {
                this._advanceFallbackTimer = null;
                if ((this.isActive || this._isTransitioning) && player.getVideoData?.()?.video_id === this.activeVideoId) {
                  if (typeof player.nextVideo === 'function') {
                    console.log(TAG, '[StudioEngine774] Track-end advance fallback: calling player.nextVideo()...');
                    try { player.nextVideo(); } catch (e) {}
                  }
                }
              }, delay);
            }
          }
          return;
        }
      }

      // If user is actively adjusting volume, do not interfere with clock
      if (this._isVolScrubbing) return;

      // Video is playing
      const vTime = video.currentTime;
      const aTime = this.audio.currentTime;

      // 1. Detect frozen / stalled audio stream (not merely buffering)
      if (Math.abs(aTime - this._lastAudioTime) < 0.05 && !this.audio.paused && !this._trackEnded) {
        const stalledDuration = Date.now() - (this._lastAudioAdvance || Date.now());
        if (stalledDuration > 2500) {
          // If audio is stalled and video is ahead (e.g. gap between MSE chunks), jump audio across the gap!
          if (vTime > aTime && vTime - aTime < 3.0) {
            console.log(TAG, `[StudioEngine774 Watchdog] Audio gap detected at ${aTime.toFixed(2)}s (video at ${vTime.toFixed(2)}s). Jumping gap to ${vTime.toFixed(2)}s...`);
            this.audio.currentTime = vTime;
            this._tryPlayAudio();
            this._lastAudioTime = vTime;
            this._lastAudioAdvance = Date.now();
            return;
          }
          if (stalledDuration > 8000) {
            console.log(TAG, `[StudioEngine774 Watchdog] Audio frozen at ${aTime.toFixed(2)}s for ${(stalledDuration / 1000).toFixed(1)}s (video at ${vTime.toFixed(2)}s). Auto-recovering...`);
            this._lastAudioAdvance = Date.now();
            if (stalledDuration > 15000) {
              this._reconnectStream('Watchdog detected frozen stream');
            } else {
              this._tryPlayAudio();
            }
            return;
          }
        }
      } else {
        this._lastAudioTime = aTime;
        this._lastAudioAdvance = Date.now();
      }

      // 2. Audio paused while video is playing.
      // NEVER auto-resume if the user (or OS media keys / browser media widget) paused.
      // Media Session pause often hits only the audible <audio> element; without
      // _userPaused the watchdog used to play() it back and pause felt broken.
      if (this.audio.paused && !video.paused && !this._isAudioBuffering && !this._userPaused) {
        if (!this._trackEnded && !this.audio.ended && (!this.audio.duration || this.audio.currentTime < this.audio.duration - 0.5)) {
          this._tryPlayAudio();
        }
      }

      // 3. Keep playbackRate strictly 1:1 with video at all times.
      const userRate = video.playbackRate || 1.0;
      if (this.audio.playbackRate !== userRate) {
        this.audio.playbackRate = userRate;
      }

      // 4. MASTER CLOCK CONTINUITY & SEEK RESILIENCE:
      const drift = aTime - vTime;
      const absDiff = Math.abs(drift);
      const now = Date.now();

      // If difference is large (> 1.5s), it is a seek or track jump, NOT natural playback drift!
      // Audio MUST follow video! NEVER pull video back to old audio position!
      if (absDiff > 1.5 && !video.seeking && !this._isSeeking && !this._isAudioBuffering) {
        this._lastSeekTime = now;
        this.audio.currentTime = vTime;
        if (UmpMseController774.isActive) {
          UmpMseController774.onSeek(vTime);
        }
        return;
      }

      // Small natural playback drift (0.45s < absDiff <= 1.5s): gently align video to audio
      const canResyncVideo = (now - (this._lastSeekTime || 0) > 3000) && !this._isSeeking && !this.audio.seeking && !video.seeking && !this._trackEnded;

      if (absDiff > 0.45 && absDiff <= 1.5 && !this._isAudioBuffering && !this.audio.paused && canResyncVideo) {
        if (this.isTimeBuffered(video, aTime)) {
          this._lastSeekTime = now;
          this._isInternalVideoSync = true;
          try { video.currentTime = aTime; } catch (e) {}
          setTimeout(() => { this._isInternalVideoSync = false; }, 250);
        }
      }
    },

    applyToVideo(mainVideo, videoId, best774) {
      if (!isCurrentWatchVideo(videoId)) {
        console.log(TAG, `[StudioEngine774] Rejecting applyToVideo for stale video ${videoId} (current is ${getVideoIdFromUrl()})`);
        return false;
      }
      const streamUrl = cleanStreamUrl(best774.url || best774._directUrl);
      if (!streamUrl) return false;

      // If already active and playing 774 for this exact video without error, NEVER reload/rewind!
      if (this.isActive && this.activeVideoId === videoId && this.audio && this.audio.src && !this.audio.error) {
        this.syncVol(mainVideo);
        return true;
      }

      confirmedNo774Videos.delete(videoId);
      this.pending774 = null;
      this.activeVideoId = videoId;
      this.best774Candidate = best774;
      this._isTransitioning = false;
      this._transitionTargetVid = null;
      if (this._transitionSafetyTimer) {
        clearTimeout(this._transitionSafetyTimer);
        this._transitionSafetyTimer = null;
      }
      this._initialMetaSynced = false;
      this.isActive = true;
      this._reconnectAttempts = 0;
      this._isAudioBuffering = false;
      this._isSeeking = false;
      // Keep an existing user pause. applyToVideo can run from canplay/tryUpgrade
      // after the user already paused — clearing this then play() un-paused audio.
      if (mainVideo && !mainVideo.paused) {
        this._userPaused = false;
      }
      this._hasDispatchedEnded = false;
      this._trackEnded = false;
      this._lastSeekTime = Date.now();
      this.updateNormalizedGain(videoId);

      // Ensure _userMuted and _userVol match the real YouTube player UI
      const player = document.getElementById('movie_player');
      if (player && typeof player.isMuted === 'function' && !player.isMuted()) {
        const pv = (typeof player.getVolume === 'function') ? player.getVolume() : 100;
        if (typeof pv !== 'number' || isNaN(pv) || pv > 0) {
          this._userMuted = false;
          if (typeof pv === 'number' && !isNaN(pv) && pv > 0) {
            this._userVol = pv / 100;
          }
        }
      } else if (!player && !this.hasRecentUserMuteOrVolIntent()) {
        const stored = readStoredYoutubeVolumeState();
        if (!stored.muted && stored.volume > 0) {
          this._userMuted = false;
          this._userVol = stored.volume;
        }
      }
      if (mainVideo) {
        mainVideo._userMuted = this._userMuted;
        mainVideo._userVol = this._userVol;
      }

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

      // Only seek audio on initial attach if video is already past 0.8s for THIS exact videoId!
      // Using getVideoTimeFor(videoId) prevents reading the outgoing track's currentTime during SPA transitions.
      const startSec = getVideoTimeFor(videoId);
      if (startSec > 0.8) {
        try {
          this.audio.currentTime = startSec;
        } catch (e) {}
      }
      this.audio.playbackRate = mainVideo.playbackRate || 1.0;

      this.syncVol(mainVideo);

      const isPlayerPlaying = !mainVideo.paused || (document.hidden && document.getElementById('movie_player')?.getPlayerState?.() === 1);
      if (isPlayerPlaying && !this.isAdActive() && !this._userPaused) {
        this.audio.play().catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            const resume = () => {
              if (this.isActive && this.audio && !mainVideo.paused && !this.isAdActive() && !this._userPaused) {
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
      if (!status.injectedStreams) status.injectedStreams = 1;
      report();
      if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();

      console.log(TAG, `[StudioEngine774] Successfully loaded ITAG 774 for ${videoId} at ${startSec.toFixed(2)}s`);
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

      // If already active and playing 774 for this exact video without error, do not reload/rewind!
      if (this.isActive && this.activeVideoId === videoId && this.audio && this.audio.src && !this.audio.error) {
        this.updateNormalizedGain(videoId);
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
        if (isCurrent && this.audio && this.audio.src !== streamUrl) {
          try {
            this.audio.src = streamUrl;
            this.audio.load();
          } catch (e) {}
        }
        this.waitForVideo();

        status.activeAudioItag = 774;
        status.activeMethod = best774._src || 'YTM_HARVESTER';
        status.fallbackReason = null;
        status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
        if (!status.injectedStreams) status.injectedStreams = 1;
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
        return true;
      }

      // If mainVideo is currently playing an earlier video (e.g. pre-warming upcoming track at 15s remaining),
      // do NOT cut off the current track! Store as pending and apply when player switches.
      // However, if the user explicitly initiated a transition to videoId (navTargetVideoId === videoId or _transitionTargetVid === videoId),
      // attach immediately at 0.00s!
      const playerVid = document.getElementById('movie_player')?.getVideoData?.()?.video_id;
      if (playerVid && playerVid !== videoId && navTargetVideoId !== videoId && this._transitionTargetVid !== videoId) {
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

      UmpMseController774.stop();

      if (!this.isActive && !this._isTransitioning && !this.pending774) {
        return; // Already cleanly running native; do not disrupt video!
      }
      const wasActive = this.isActive || this._isTransitioning;
      this._isTransitioning = false;
      this._transitionTargetVid = null;
      if (this._transitionSafetyTimer) {
        clearTimeout(this._transitionSafetyTimer);
        this._transitionSafetyTimer = null;
      }
      this.isActive = false;
      const isLeavingPage = reason.includes('Navigated') || reason.includes('Shorts') || (typeof isPlayerActiveOnPage === 'function' && !isPlayerActiveOnPage());
      this.activeVideoId = (isLeavingPage && !preserveVideoId) ? null : vId;
      this.best774Candidate = null;
      this.pending774 = null;
      this._reconnectAttempts = 0;
      this._isAudioBuffering = false;
      this._isSeeking = false;
      // Clear pause lock + reassert interval (do not leave the 150ms timer running)
      this.unlockPlay();
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
      const isTvNativeReason = Boolean(reason && reason.includes('Native TV 774'));
      if (!isTvNativeReason) {
        sabrRewrite.on = false;
        sabrRewrite.videoId = null;
        status.activeAudioItag = 251;
        status.activeMethod = 'original';
        status.fallbackReason = reason || 'Native 251 Fallback';
        status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
      }
      if (isTvNativeReason) {
        console.log(TAG, '[StudioEngine774] Using native TV 774 (SABR/disguise) — dual engine off');
      } else if (reason) {
        console.log(TAG, `[StudioEngine774] Fallback to native. Reason: ${reason}`);
      }
    }
  };

  function upgradePlayerToNative774(videoId, best774) {
    return StudioEngine774.load774(videoId, best774);
  }

  // ─── NEXT VIDEO PREFETCH CONTROLLER ─────────────────────────────────
  // Last 3s countdown & ephemeral cache prefetch controller
  var NextVideoManager = {
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
      // Loop mode strictly overrides autoplay/prefetch: never prefetch or advance while looping!
      if (typeof StudioEngine774 !== 'undefined' && typeof StudioEngine774.isLoopActive === 'function') {
        if (StudioEngine774.isLoopActive()) return false;
      }
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

      // Trigger prefetch once when entering the <= 3.0s window (do NOT fire a competing forceFresh Call 2 that races with transition!)
      if (!this.hasFetchedCall1) {
        this.hasFetchedCall1 = true;
        console.log(TAG, `[NextVideoManager] In last 3s (${remaining.toFixed(2)}s left) -> Triggering prefetch for next video ${nextVid} (autoplay/playlist active)`);
        fetchAllHQAudio(nextVid, { isNextPrefetch: true }).then(hqData => {
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
      const isTvSabrActive = (status.activeAudioItag === 774 && String(status.activeMethod).includes('TV')) || sabrRewrite.downgradedVideoId === vid;
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
    if (opts.forceFresh) {
      confirmedNo774Videos.delete(videoId);
      failedFetches.delete(videoId);
      sabrRewrite.downgradedVideoId = null;
    }
    if (confirmedNo774Videos.has(videoId)) return;
    navTargetVideoId = videoId;
    reloadedVideos.delete(videoId);
    status.prewarmStatus = `pre-fetching ${videoId}…`;
    report();
    fetchAllHQAudio(videoId, opts).then(hqData => {
      if (hqData?.superseded) return;
      if (hqData?.cancelled) {
        if (isCurrentWatchVideo(videoId) && !pendingFetches.has(videoId) && StudioEngine774._isTransitioning && !StudioEngine774.isActive) {
          StudioEngine774.stopAndUnmute('Harvest cancelled or timed out', videoId);
        }
        return;
      }
      const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
      const tvCtx = hqData?.streamingContext || null;
      const count = formats.length;
      status.prewarmStatus = (count > 0 || tvCtx)
        ? `ready: ${count} formats${tvCtx ? ' + TV UMP' : ''}`
        : 'no HQ formats';
      report();
      console.log(TAG, `[Pre-warm] ${status.prewarmStatus} for ${videoId}`);

      const playableCandidates = getPlayable774Candidates(formats);
      const all774Candidates = getAll774Candidates(formats);

      if (playableCandidates.length > 0 && S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY) {
        if (isCurrentWatchVideo(videoId)) {
          StudioEngine774.load774(videoId, playableCandidates[0]);
        } else if (typeof NextVideoManager !== 'undefined' && NextVideoManager.nextVideoId === videoId) {
          StudioEngine774.pending774 = { videoId, best774: playableCandidates[0] };
        }
      } else if (all774Candidates.length > 0 && isCurrentWatchVideo(videoId)) {
        // Authenticated TVHTML5 stream (TV UMP MSE)
        noteTvNative774(all774Candidates[0], all774Candidates.length, videoId, tvCtx);
      } else if (isCurrentWatchVideo(videoId)) {
        confirmedNo774Videos.add(videoId);
        status.activeAudioItag = 251;
        status.activeMethod = 'original';
        status.fallbackReason = 'No 774 stream available for this video';
        status.bestAudioInfo = 'Native Audio (ITAG 251) | Opus 160kbps';
        report();
        if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
        if (StudioEngine774.isActive || StudioEngine774._isTransitioning) {
          StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
        }
      }
    });
  }

  // Pre-warm on initial page load
  const earlyVideoId = getVideoIdFromUrl();
  if (earlyVideoId) {
    if (S.enabled && S.hqFetch) {
      StudioEngine774.prepareTransition(earlyVideoId);
    }
    prewarmCache(earlyVideoId);
  }

  // Also pre-warm on YouTube SPA navigation (yt-navigate-start fires before new page renders)
  window.addEventListener('yt-navigate-start', (e) => {
    isInitialPageLoad = false; // We are now in SPA territory, never reload page
    isSpaNavigating = true;
    lastSpaNavStartAt = Date.now();

    let isShortsNav = Boolean(e?.detail?.endpoint?.reelWatchEndpoint || e?.detail?.command?.reelWatchEndpoint || window.location.pathname.startsWith('/shorts/'));
    let incomingVid = e?.detail?.endpoint?.watchEndpoint?.videoId
      || e?.detail?.command?.watchEndpoint?.videoId
      || e?.detail?.params?.videoId
      || null;

    if (typeof e?.detail?.url === 'string') {
      try {
        const u = new URL(e.detail.url, window.location.origin);
        if (u.pathname.startsWith('/shorts/')) {
          isShortsNav = true;
          incomingVid = null;
        } else if (!incomingVid) {
          incomingVid = u.searchParams.get('v');
        }
      } catch (err) { }
    }

    if (isShortsNav) {
      navTargetVideoId = null;
      StudioEngine774.stopAndUnmute('Navigated to Shorts');
      return;
    }

    if (incomingVid) {
      navTargetVideoId = incomingVid;
      failedSourcesPerVideo.delete(incomingVid);
      sabrRewrite.downgradedVideoId = null;
    }

    const currentActiveVid = StudioEngine774.isActive ? (StudioEngine774.activeVideoId || getVideoIdFromUrl()) : null;

    if (incomingVid && incomingVid !== currentActiveVid) {
      confirmedNo774Videos.clear();
      failedFetches.delete(incomingVid);
      NextVideoManager.reset(incomingVid);
      StudioEngine774.prepareTransition(incomingVid);
      status.fallbackReason = 'Loading HQ stream...';
      report();
      prewarmCache(incomingVid);
    } else if (incomingVid && incomingVid === currentActiveVid) {
      // Re-opening same video while 774 is inactive
      if (!StudioEngine774.isActive && !pendingFetches.has(incomingVid)) {
        console.log(TAG, `[Navigate] Re-triggering HQ fetch for ${incomingVid}`);
        confirmedNo774Videos.clear();
        failedFetches.delete(incomingVid);
        NextVideoManager.reset(incomingVid);
        StudioEngine774.prepareTransition(incomingVid);
        prewarmCache(incomingVid);
      }
    } else if (!incomingVid) {
      navTargetVideoId = null;
      // Retain active 774 stream during miniplayer transitions until settled
      if (!StudioEngine774.isActive && !isMiniplayerActive() && !NextVideoManager.isInPlaylist()) {
        StudioEngine774.stopAndUnmute('Navigated away from watch page');
        try { window.postMessage({ type: 'YTSS_STOP_HARVEST' }, '*'); } catch (e) {}
      }
    }
  });

  window.addEventListener('popstate', () => {
    lastSpaNavStartAt = Date.now();
    const currentVid = getVideoIdFromUrl();
    if (!currentVid) {
      if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && !isPlayerActiveOnPage()) {
        StudioEngine774.stopAndUnmute('Navigated away from watch page');
      }
      return;
    }
    if (currentVid !== StudioEngine774.activeVideoId) {
      confirmedNo774Videos.clear();
      failedFetches.delete(currentVid);
      sabrRewrite.downgradedVideoId = null;
      NextVideoManager.reset(currentVid);
      navTargetVideoId = currentVid;
      failedSourcesPerVideo.delete(currentVid);
      StudioEngine774.prepareTransition(currentVid);
      prewarmCache(currentVid);
    }
  });

  // ─── HQ FILTER & MERGE ENGINE (Direct Fallback) ─────────────────────
  function processPlayerResponse(json, hqData = null) {
    if (!json?.streamingData?.adaptiveFormats) {
      // SABR-only / rewritten response: nothing to merge, but still surface harvest stats
      // so the popup Streams counter is not stuck at 0 while 774 is already playing.
      const vidEarly = json?.videoDetails?.videoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
      const cachedEarly = vidEarly ? cacheGet(vidEarly) : null;
      const formatsEarly = cachedEarly?.formats || (Array.isArray(cachedEarly) ? cachedEarly : (hqData?.formats || []));
      const all774Early = getAll774Candidates(formatsEarly);
      if (all774Early.length > 0 && Number(status.activeAudioItag) === 774) {
        status.injectedStreams = all774Early.length;
        report();
      }
      return json;
    }

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
        console.log(TAG, `[Client] ${status.clientFallback}`);
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
            console.log(TAG, `[Pool] dropped format without direct URL or SABR: itag=${f.itag} _src=${f._src}`);
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
      console.log(TAG, `[Pool] ${status.noUrlDrop}`);
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

      if (S.operationMode === OP_MODES.TV_RELAY) {
        // TVHTML5 Authenticated 774 Stream: upgrade 251 and retain SABR pipeline
        const orig251 = json._origFormats?.find(f => f.itag === 251) || {};
        const preciseBps = getPreciseBitrate(best774);
        const upgraded251 = {
          ...orig251,
          itag: 251,
          _origItag: 774,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: preciseBps,
          averageBitrate: best774.averageBitrate || preciseBps,
          audioQuality: 'AUDIO_QUALITY_HIGH',
        };
        const otherAudio = origAudio.filter(f => f.itag !== 251);
        json.streamingData.adaptiveFormats = [...videoFormats, ...otherAudio, upgraded251];
        StudioEngine774.stopAndUnmute('Native TV 774 SABR stream');
        UmpMseController774.stop();

        if (isCurrent) {
          status.videoTitle = json.videoDetails?.title || document.title || 'audio';
          status.activeMethod = 'TVHTML5 (Native SABR 774)';
          status.activeAudioItag = 774;
          status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: TVHTML5 (Native SABR 774)`;
          status.injectedStreams = Math.max(pool.length, 6);
          status.fallbackReason = null;
          sabrRewrite.on = true;
          sabrRewrite.videoId = currentVid || json.videoDetails?.videoId;
          sabrRewrite.lastModified = Number(best774?.lastModified || best774?.last_modified || 0);
          sabrRewrite.xtags = best774?.xtags || null;
          sabrRewrite.serverAbrStreamingUrl = tvStreamingContext?.serverAbrStreamingUrl || null;
          sabrRewrite.ustreamerConfig = null;
          sabrRewrite.swapUstreamer = false;
          sabrRewrite.verified774 = false;
          sabrRewrite.downgradedCount = 0;
          report();
          if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
        }
      } else {
        // Both direct HTTP 774 streams (YTM) and TV UMP MSE 774 streams are handled exclusively by StudioEngine774 (the 2nd player):
        // Retain origAudio in adaptiveFormats so YouTube player initializes MSE normally with full HD/4K adaptive video qualities.
        json.streamingData.adaptiveFormats = [...videoFormats, ...origAudio];

        if (isCurrent) {
          status.videoTitle = json.videoDetails?.title || document.title || 'audio';
          if (!streamUrl) {
            noteTvNative774(best774, Math.max(pool.length, 6), currentVid, tvStreamingContext);
          } else {
            status.activeMethod = best774._src || 'YTM_HARVESTER';
            status.activeAudioItag = 774;
            status.bestAudioInfo = `ITAG 774 [HQ ★] | Opus ${formatBitrate(best774)} | Method: ${status.activeMethod}`;
            status.injectedStreams = Math.max(pool.length, 6);
            status.fallbackReason = null;
            report();
            if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
          }
        }
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

  // ─── YTINITIALPLAYERRESPONSE HOOK ──────────────────────────────────
  // Runs synchronously when YouTube sets this global.
  // If pre-warm cache already done → merge sync. Otherwise async merge + player reload.
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
            StudioEngine774.updateNormalizedGain(videoId);
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
            if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0 && isCurrentWatchVideo(videoId)) {
              val = processPlayerResponse(val, cached);
              StudioEngine774.load774(videoId, playable[0]);
            } else if (all774.length > 0 && isCurrentWatchVideo(videoId)) {
              val = processPlayerResponse(val, cached);
              noteTvNative774(all774[0], all774.length, videoId, cached?.streamingContext || null);
            } else if (isCurrentWatchVideo(videoId)) {
              confirmedNo774Videos.add(videoId);
              if (StudioEngine774.isActive || StudioEngine774._isTransitioning) {
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

  // ─── PAGE CONTEXT → SERVICE WORKER ─────────────────────────────────
  // InnerTube drops the premium formats when a spoofed client sends no visitorData
  // matching the real session. Read those identifiers straight out of the page's own
  // ytcfg and relay them to the SW (via bridge.js) so its spoofed requests carry the
  // same session identity as the page.
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

  // ─── YTCFG EXPERIMENT FLAGS HOOK ───────────────────────────────────
  // Ensure SABR flags permit streaming UMP 774
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

  // ─── YTPLAYER.CONFIG HOOK ──────────────────────────────────────────
  // YouTube sets window.ytplayer.config BEFORE creating the player object.
  // Intercept it to modify player_response / raw_player_response inline.
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
        if (cached && getAll774Candidates(cached?.formats || []).length > 0) {
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
              const formats = cached?.formats || [];
              const playable = getPlayable774Candidates(formats);
              const all774 = getAll774Candidates(formats);
              if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0 && isCurrentWatchVideo(videoId)) {
                args.player_response = JSON.stringify(processPlayerResponse(pr, cached));
                StudioEngine774.load774(videoId, playable[0]);
              } else if (all774.length > 0 && isCurrentWatchVideo(videoId)) {
                args.player_response = JSON.stringify(processPlayerResponse(pr, cached));
                noteTvNative774(all774[0], all774.length, videoId, cached?.streamingContext || null);
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

  // ─── SW-TRIGGERED UPGRADE ─────────────────────────────────────────
  function tryUpgradeVideo(videoId, source) {
    if (!videoId || !S.enabled || isMusicSite) return;
    if (!isCurrentWatchVideo(videoId)) {
      return; // Ignore stale video from previous track or rapid playlist navigation
    }
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
    if (playableCandidates.length > 0 && S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY) {
      console.log(TAG, `[${source}] Upgrading ${videoId} to Studio HQ 774`);
      StudioEngine774.load774(videoId, playableCandidates[0]);
    } else if (real774Candidates.length > 0 && sabrRewrite.downgradedVideoId !== videoId) {
      if (S.operationMode === OP_MODES.TV_RELAY) {
        if (!sabrRewrite.on || sabrRewrite.videoId !== videoId) {
          console.log(TAG, `[${source}] Activating Legacy TV SABR 774 for ${videoId}`);
          noteTvNative774(real774Candidates[0], real774Candidates.length, videoId, cached?.streamingContext || null);
        }
      } else if (!UmpMseController774.isActive || UmpMseController774.videoId !== videoId) {
        console.log(TAG, `[${source}] Activating TV UMP MSE 774 for ${videoId}`);
        noteTvNative774(real774Candidates[0], real774Candidates.length, videoId, cached?.streamingContext || null);
      }
    } else if (cached && formats.length > 0) {
      confirmedNo774Videos.add(videoId);
      if (StudioEngine774.isActive || StudioEngine774._isTransitioning) {
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

  // ─── SABR BODY STRUCTURAL PROTOBUF REWRITER ────────────────────────
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

  // Parse a protobuf message range into an ordered list of raw field descriptors AND a lookup map.
  function pbParseRawFields(bytes, start, end) {
    const list = [];
    const map = new Map();
    let off = start;
    while (off < end) {
      const tagOff = off;
      const tag = pbReadTag(bytes, off);
      if (!tag) return null;
      const fn = tag[0], wt = tag[1], afterTag = tag[2];
      if (wt === 0) { // varint
        const v = pbReadVarint(bytes, afterTag);
        if (!v) return null;
        const entry = { fn, wireType: 0, tagOff, valueOff: afterTag, valueLen: v[1] - afterTag, nextOff: v[1], value: v[0] };
        list.push(entry);
        if (!map.has(fn)) map.set(fn, []);
        map.get(fn).push(entry);
        off = v[1];
      } else if (wt === 2) { // length-delimited
        const lenV = pbReadVarint(bytes, afterTag);
        if (!lenV) return null;
        const len = Number(lenV[0]), dataOff = lenV[1];
        if (len < 0 || dataOff + len > end) return null;
        const entry = { fn, wireType: 2, tagOff, valueOff: dataOff, valueLen: len, nextOff: dataOff + len };
        list.push(entry);
        if (!map.has(fn)) map.set(fn, []);
        map.get(fn).push(entry);
        off = dataOff + len;
      } else if (wt === 1) { // 64-bit
        if (afterTag + 8 > end) return null;
        const entry = { fn, wireType: 1, tagOff, valueOff: afterTag, valueLen: 8, nextOff: afterTag + 8 };
        list.push(entry);
        if (!map.has(fn)) map.set(fn, []);
        map.get(fn).push(entry);
        off = afterTag + 8;
      } else if (wt === 5) { // 32-bit
        if (afterTag + 4 > end) return null;
        const entry = { fn, wireType: 5, tagOff, valueOff: afterTag, valueLen: 4, nextOff: afterTag + 4 };
        list.push(entry);
        if (!map.has(fn)) map.set(fn, []);
        map.get(fn).push(entry);
        off = afterTag + 4;
      } else {
        return null; // unknown wire type
      }
    }
    return off === end ? { list, map } : null;
  }

  function pbParseMessage(bytes, start, end) {
    const parsed = pbParseRawFields(bytes, start, end);
    return parsed ? parsed.map : null;
  }

  function pbConcatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  function pbWrapLengthDelimited(fieldNum, payloadU8) {
    const header = [...pbEncodeVarint((fieldNum << 3) | 2), ...pbEncodeVarint(payloadU8.length)];
    const out = new Uint8Array(header.length + payloadU8.length);
    out.set(header, 0);
    out.set(payloadU8, header.length);
    return out;
  }

  function pbDecodeBase64ToU8(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    try {
      const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
      const bin = atob(norm + pad);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  // Rebuild a FormatId sub-message { f1: itag, f2: lastModified, f3: xtags } dynamically
  // if its f1 matches targetItags. Handles any varint byte-length change in f1 or f2 and
  // strips stale 251 xtags (f3) unless newXtags is explicitly provided.
  function pbRebuildFormatIdIfMatched(bytes, start, end, itagList, newItag, newLastModified, newXtags) {
    const parsed = pbParseRawFields(bytes, start, end);
    if (!parsed) return null;
    const f1 = parsed.map.get(1)?.[0];
    if (!f1 || f1.wireType !== 0 || !itagList.includes(Number(f1.value))) return null;

    const outBytes = [];
    // f1: itag (tag 0x08)
    outBytes.push(0x08, ...pbEncodeVarint(newItag));

    // f2: lastModified (tag 0x10)
    const lmBig = newLastModified ? BigInt(newLastModified) : 0n;
    if (lmBig > 0n) {
      outBytes.push(0x10, ...pbEncodeVarint(lmBig));
    } else {
      const origF2 = parsed.map.get(2)?.[0];
      if (origF2) {
        for (let i = origF2.tagOff; i < origF2.nextOff; i++) outBytes.push(bytes[i]);
      }
    }

    // f3: xtags (tag 0x1a) — only include if newXtags belongs to 774; strip 251's xtags
    if (typeof newXtags === 'string' && newXtags.length > 0) {
      const xBytes = new TextEncoder().encode(newXtags);
      outBytes.push(0x1a, ...pbEncodeVarint(xBytes.length), ...xBytes);
    }

    // Preserve any unknown fields > 3
    for (const f of parsed.list) {
      if (f.fn > 3) {
        for (let i = f.tagOff; i < f.nextOff; i++) outBytes.push(bytes[i]);
      }
    }

    return new Uint8Array(outBytes);
  }

  // Dynamic structural Protobuf rebuilder for VideoPlaybackAbrRequest (TV Relay mode).
  // Rewrites f16 (preferredAudioFormatIds) and f2 (selectedFormatIds).
  // Returns a new Uint8Array with patches applied, or null.
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
        if (f1 && f1.wireType === 0 && itagList.includes(Number(f1.value))) {
          f16Target = e;
          f16Fields = ff;
          f16f1 = f1;
          break;
        }
      }
      if (!f16Target || !f16f1) return null;

      const oldItag = Number(f16f1.value);

      // ── Patch f2 (selected format): find the entry whose f1 === oldItag
      const f2Entries = topFields.get(2);
      let f2Target = null, f2Fields = null, f2f1 = null, f2f2 = null;
      if (f2Entries) {
        for (const e of f2Entries) {
          const ff = pbParseMessage(bytes, e.valueOff, e.valueOff + e.valueLen);
          if (!ff) continue;
          const f1 = ff.get(1)?.[0];
          if (f1 && f1.wireType === 0 && Number(f1.value) === oldItag) {
            f2Target = e; f2Fields = ff; f2f1 = f1; f2f2 = ff.get(2)?.[0];
            break;
          }
        }
      }

      // Build the patched buffer. Both oldItag and newItag must be 2-byte varints
      // so the enclosing length prefix is unchanged.
      const oldItagBytes = pbEncodeVarint(oldItag);
      const newItagBytes = pbEncodeVarint(newItag);
      if (oldItagBytes.length !== newItagBytes.length) {
        return null;
      }

      // Start from a copy.
      const out = new Uint8Array(bytes);

      // Rewrite f16.f1 (itag) in place — same byte count.
      out[f16f1.valueOff] = newItagBytes[0];
      out[f16f1.valueOff + 1] = newItagBytes[1];

      // Rewrite f16.f2 (lastModified) if present and byte length matches
      const f16f2 = f16Fields.get(2)?.[0];
      if (f16f2 && f16f2.wireType === 0 && newLastModified) {
        const newLmBytes = pbEncodeVarint(BigInt(newLastModified));
        if (newLmBytes.length === f16f2.valueLen) {
          for (let i = 0; i < newLmBytes.length; i++) out[f16f2.valueOff + i] = newLmBytes[i];
        }
      }

      // Rewrite f2 entry (selected format) if found.
      if (f2Target && f2f1) {
        out[f2f1.valueOff] = newItagBytes[0];
        out[f2f1.valueOff + 1] = newItagBytes[1];
        if (f2f2 && f2f2.wireType === 0 && newLastModified) {
          const newLmBytes = pbEncodeVarint(BigInt(newLastModified));
          if (newLmBytes.length === f2f2.valueLen) {
            for (let i = 0; i < newLmBytes.length; i++) out[f2f2.valueOff + i] = newLmBytes[i];
          }
        }
      }

      return out;
    } catch (e) {
      console.warn(TAG, '[SabrRewrite] sabrRewritePreferredAudio error:', e);
      return null;
    }
  }

  // Convert fetch/XHR body to Uint8Array, or null if not binary.
  function ytssBodyToU8(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  // Rewrite a SABR/UMP POST body so preferred-audio / selected-format ask for 774.
  // Returns a Uint8Array to send, or null when the caller should pass the body through.
  function ytssMaybeRewriteSabrBody(body) {
    if (!S.enabled || !sabrRewrite.on || StudioEngine774.isActive) return null;
    if (status.fallbackReason) return null;
    if (sabrRewrite.videoId && typeof isCurrentWatchVideo === 'function' && !isCurrentWatchVideo(sabrRewrite.videoId)) return null;
    const bytes = ytssBodyToU8(body);
    if (!bytes || bytes.length < 8) return null;
    const patched = sabrRewritePreferredAudio(
      bytes,
      [251],
      774,
      sabrRewrite.lastModified || 0
    );
    if (patched && patched !== bytes) {
      console.log(TAG, `[SabrRewrite] SABR body rewritten in-place: itag 251→774 (${bytes.length}B)`);
      return patched;
    }
    return null;
  }

  // ─── UMP (Unified Media Protocol) STREAM INSPECTOR ─────────────────
  // Verifies real-time MediaHeader (part 20) & SabrError (part 43) on the wire
  const UMP_AUDIO_ITAGS = new Set([139, 140, 141, 171, 249, 250, 251, 256, 258, 325, 328, 774]);

  function ytssHandleSabrDowngrade(videoId, reason, servedItag = 251) {
    if (!sabrRewrite.on || StudioEngine774.isActive) return;
    const curVid = videoId || sabrRewrite.videoId || (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
    if (curVid && !isCurrentWatchVideo(curVid)) return;

    console.log(TAG, `[UMP Inspector] TVHTML5 SABR 774 rejected/downgraded on ${curVid}: ${reason}`);

    if (S.operationMode === OP_MODES.HYBRID_HQ && curVid) {
      if (canHybridFailover(curVid, 'TVHTML5', 'YTM_HARVESTER')) {
        sabrRewrite.on = false;
        sabrRewrite.downgradedVideoId = curVid;
        handleHybridRuntimeFailover(curVid, 'TVHTML5', 'YTM_HARVESTER', reason);
        return;
      }
    }

    if (S.operationMode === OP_MODES.TV_HEADLESS) {
      // In TV_HEADLESS mode, keep the stream playing smoothly without triggering fatal player errors.
      // Mark verified774=true so we stop inspecting further UMP chunks for this video.
      sabrRewrite.verified774 = true;
      return;
    }

    sabrRewrite.on = false;
    sabrRewrite.videoId = null;
    sabrRewrite.downgradedVideoId = curVid;
    status.activeAudioItag = servedItag || 251;
    status.activeMethod = 'original';
    status.fallbackReason = `SABR downgrade (${reason})`;
    status.bestAudioInfo = `Native Audio (ITAG ${status.activeAudioItag}) | ${reason}`;
    report();
    if (typeof PlayerBadgeUI !== 'undefined') PlayerBadgeUI.update();
  }

  function ytssInspectUmpBytes(u8, videoId) {
    if (!u8 || u8.length < 4 || !sabrRewrite.on || StudioEngine774.isActive) return false;
    let off = 0;
    let foundAudioDecision = false;

    while (off < u8.length) {
      const typeV = pbReadVarint(u8, off);
      if (!typeV) break;
      const partType = Number(typeV[0]);
      const sizeV = pbReadVarint(u8, typeV[1]);
      if (!sizeV) break;
      const partSize = Number(sizeV[0]);
      const dataOff = sizeV[1];
      if (partSize < 0 || dataOff + partSize > u8.length) break; // Partial frame at end of chunk

      if (partType === 20) { // MEDIA_HEADER
        const mh = pbParseMessage(u8, dataOff, dataOff + partSize);
        if (mh) {
          let servedItag = Number(mh.get(3)?.[0]?.value || 0);
          if (!servedItag) {
            const f13 = mh.get(13)?.[0];
            if (f13 && f13.wireType === 2) {
              const fmt = pbParseMessage(u8, f13.valueOff, f13.valueOff + f13.valueLen);
              servedItag = Number(fmt?.get(1)?.[0]?.value || 0);
            }
          }
          if (UMP_AUDIO_ITAGS.has(servedItag)) {
            foundAudioDecision = true;
            if (servedItag === 774) {
              if (!sabrRewrite.verified774) {
                sabrRewrite.verified774 = true;
                sabrRewrite.downgradedCount = 0;
                console.log(TAG, `[UMP Inspector] ★ VERIFIED real ITAG 774 MediaHeader served by CDN for ${videoId || sabrRewrite.videoId}!`);
              }
              return true;
            } else {
              sabrRewrite.downgradedCount = (sabrRewrite.downgradedCount || 0) + 1;
              console.log(TAG, `[UMP Inspector] CDN MediaHeader served audio ITAG ${servedItag} instead of 774 (count=${sabrRewrite.downgradedCount})`);
              if (!sabrRewrite.verified774 && sabrRewrite.downgradedCount >= 3) {
                ytssHandleSabrDowngrade(videoId, `CDN served ITAG ${servedItag}`, servedItag);
              }
              return true;
            }
          }
        }
      } else if (partType === 43) { // SABR_ERROR or CMS Redirect
        const sr = pbParseMessage(u8, dataOff, dataOff + partSize);
        const f1 = sr?.get(1)?.[0];
        let isRedirect = false;
        if (f1 && f1.wireType === 2 && f1.valueLen > 24) {
          const candidate = new TextDecoder().decode(u8.subarray(f1.valueOff, f1.valueOff + f1.valueLen));
          if (/^https:\/\/[^/\s]+\/videoplayback\?/.test(candidate)) {
            isRedirect = true;
          }
        }
        if (!isRedirect) {
          foundAudioDecision = true;
          console.log(TAG, `[UMP Inspector] CDN returned SabrError (part 43)`);
          if (!sabrRewrite.verified774) {
            ytssHandleSabrDowngrade(videoId, 'CDN SabrError (part 43)', 251);
          }
          return true;
        }
      }

      off = dataOff + partSize;
    }
    return foundAudioDecision;
  }

  async function ytssInspectUmpResponse(responseClone, videoId) {
    try {
      if (!responseClone?.body) return;
      const reader = responseClone.body.getReader();
      let acc = new Uint8Array(0);
      const MAX_INSPECT_BYTES = 65536; // Inspect up to 64KB of initial UMP headers
      while (acc.length < MAX_INSPECT_BYTES) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        const merged = new Uint8Array(acc.length + value.length);
        merged.set(acc, 0);
        merged.set(value, acc.length);
        acc = merged;
        if (ytssInspectUmpBytes(acc, videoId)) {
          break;
        }
      }
      try { await reader.cancel(); } catch (e) {}
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // CLASSIC 2014 "STATS FOR NERDS" PANEL (V3 / original layout) & SPOOFER
  // ═══════════════════════════════════════════════════════════════════
  var StatsForNerdsSpoofer = {
    initialized: false,
    timer: null,
    visible: false,
    _frames: { decoded: 0, dropped: 0, parsed: 0, presented: 0 },
    _bytes: { video: 0, audio: 0 },
    _bwSamples: [],
    _lastTs: 0,
    _lastTime: 0,
    _painted: 0,
    _ttPolicy: null,

    toSafeHtml(html) {
      try {
        if (window.trustedTypes && window.trustedTypes.createPolicy) {
          if (!this._ttPolicy) {
            this._ttPolicy = window.trustedTypes.defaultPolicy
              || window.trusted_policy
              || window.trustedTypes.createPolicy('ytss-html', { createHTML: (s) => s });
          }
          if (this._ttPolicy && typeof this._ttPolicy.createHTML === 'function') {
            return this._ttPolicy.createHTML(html);
          }
        }
      } catch (e) {}
      return html;
    },

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


      // Stats for Nerds Audio Buffer Row (774 stream health)
      const isReal774Buf = Number(status.activeAudioItag) === 774 && !status.fallbackReason;
      let audioRow = document.getElementById('ytss-sfn-audio-row');
      if (isReal774Buf) {
        const bufSec = getAudioBufferSec();
        const valText = (bufSec !== null && !isNaN(bufSec)) ? `${bufSec.toFixed(2)} s` : '—';
        const engineLabel = (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive) ? 'Studio Engine 774' : 'Native SABR 774';
        const newFullVal = ` ${valText}`;
        const newTag = `(Opus 774 ★ ${engineLabel})`;

        if (!audioRow) {
          audioRow = document.createElement('div');
          audioRow.id = 'ytss-sfn-audio-row';
          audioRow.style.cssText = 'color: #00e5ff; font-weight: bold; margin-top: 1px;';

          const labelDiv = document.createElement('div');
          labelDiv.className = 'ytss-sfn-label';
          labelDiv.textContent = t('statusAudioBuffer') || 'Audio Buffer';

          const span = document.createElement('span');
          const valSpan = document.createElement('span');
          valSpan.className = 'ytss-sfn-val';
          valSpan.style.color = '#00e5ff';
          valSpan.style.fontWeight = 'bold';
          valSpan.textContent = newFullVal;

          const tagSpan = document.createElement('span');
          tagSpan.className = 'ytss-sfn-tag';
          tagSpan.style.opacity = '0.75';
          tagSpan.style.fontSize = '0.88em';
          tagSpan.style.fontWeight = 'normal';
          tagSpan.style.marginLeft = '4px';
          tagSpan.textContent = newTag;

          span.appendChild(valSpan);
          span.appendChild(tagSpan);
          audioRow.appendChild(labelDiv);
          audioRow.appendChild(span);

          let bufHealthRow = null;
          for (const child of panel.children) {
            const txt = child.textContent || '';
            if (txt.includes('Buffer Health') || txt.includes('Bộ đệm') || txt.includes('Buffer')) {
              bufHealthRow = child;
              break;
            }
          }
          if (bufHealthRow && bufHealthRow.nextSibling) {
            panel.insertBefore(audioRow, bufHealthRow.nextSibling);
          } else {
            panel.appendChild(audioRow);
          }
        } else {
          const valSpan = audioRow.querySelector('.ytss-sfn-val');
          if (valSpan && valSpan.textContent !== newFullVal) {
            valSpan.textContent = newFullVal;
          }
          const tagSpan = audioRow.querySelector('.ytss-sfn-tag');
          if (tagSpan && tagSpan.textContent !== newTag) {
            tagSpan.textContent = newTag;
          }
          const labelDiv = audioRow.querySelector('.ytss-sfn-label');
          const expectedLabel = t('statusAudioBuffer') || 'Audio Buffer';
          if (labelDiv && labelDiv.textContent !== expectedLabel) {
            labelDiv.textContent = expectedLabel;
          }
        }
      } else if (audioRow) {
        audioRow.remove();
      }

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
      table.innerHTML = this.toSafeHtml([
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
      ].join(''));
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

      body.innerHTML = this.toSafeHtml([
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
      ].join(''));

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

  var InPlayerSettingsUI = {
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
      const root = document.head || document.documentElement;
      if (root) {
        root.appendChild(st);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          (document.head || document.documentElement)?.appendChild(st);
        }, { once: true });
      }
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

  // ─── AUDIO-ONLY MODE CONTROLLER ────────────────────────────────────
  // Pure HQ audio stream with zero video GPU rendering overhead
  function applyAudioOnlyState() {
    const player = document.getElementById('movie_player');
    let overlay = document.getElementById('ytss-audio-only-overlay');
    const video = (typeof getMainVideoElement === 'function' ? getMainVideoElement() : document.querySelector('video'));

    if (S.audioOnly && S.enabled) {
      if (!overlay && player) {
        overlay = document.createElement('div');
        overlay.id = 'ytss-audio-only-overlay';
        // Solid opaque background, NO backdrop-filter blur -> 0% GPU shader cost
        overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:#0a0a0a;z-index:15;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;user-select:none;color:#fff;font-family:Roboto,Arial,sans-serif;';

        const icon = document.createElement('div');
        icon.id = 'ytss-ao-icon';
        icon.style.cssText = 'font-size:52px;margin-bottom:12px;color:#00e5ff;';
        icon.textContent = '🎧';

        const title = document.createElement('div');
        title.id = 'ytss-ao-title';
        title.style.cssText = 'font-size:16px;font-weight:700;letter-spacing:1px;color:#00e5ff;text-transform:uppercase;margin-bottom:6px;';
        title.textContent = t('audioOnlyActive');

        const desc = document.createElement('div');
        desc.id = 'ytss-ao-desc';
        desc.style.cssText = 'font-size:12px;color:#888;max-width:85%;text-align:center;line-height:1.5;';
        desc.textContent = t('audioOnlyHint');

        overlay.replaceChildren(icon, title, desc);
        overlay.onclick = (ev) => {
          ev.stopPropagation();
          toggleAudioOnly(false);
        };
        player.appendChild(overlay);
      } else if (overlay) {
        overlay.style.display = 'flex';
        const title = document.getElementById('ytss-ao-title');
        if (title) title.textContent = t('audioOnlyActive');
        const desc = document.getElementById('ytss-ao-desc');
        if (desc) desc.textContent = t('audioOnlyHint');
      }

      if (video) {
        video.style.opacity = '0';
        video.style.visibility = 'hidden';
        video.style.pointerEvents = 'none';
      }

      // Request 144p video to minimize video decoding CPU/GPU load
      if (player && typeof player.setPlaybackQuality === 'function') {
        try { player.setPlaybackQuality('tiny'); } catch (e) {}
      }
    } else {
      if (overlay) {
        overlay.style.display = 'none';
      }
      if (video) {
        video.style.opacity = '1';
        video.style.visibility = 'visible';
        video.style.pointerEvents = '';
        if (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive && StudioEngine774.audio) {
          const diff = Math.abs(video.currentTime - StudioEngine774.audio.currentTime);
          if (diff > 0.2) {
            video.currentTime = StudioEngine774.audio.currentTime;
          }
          if (video.paused && !StudioEngine774.audio.paused) {
            video.play().catch(() => {});
          }
        }
      }
      if (player && typeof player.setPlaybackQuality === 'function') {
        try { player.setPlaybackQuality('auto'); } catch (e) {}
      }
      if (player && typeof player.wakeUp === 'function') {
        try { player.wakeUp(); } catch (e) {}
      }
    }

    const audioOnlyBtn = document.getElementById('ytss-audio-only-btn');
    if (audioOnlyBtn) {
      if (S.audioOnly && S.enabled) {
        audioOnlyBtn.style.color = '#00e5ff';
        audioOnlyBtn.style.borderColor = 'rgba(0,229,255,0.55)';
        audioOnlyBtn.style.background = 'rgba(0, 229, 255, 0.12)';
        audioOnlyBtn.style.boxShadow = 'none';
        audioOnlyBtn.title = t('hudAudioOnlyOn');
      } else {
        // Same chip as the codec badge; cyan tint kept for the headphone glyph
        audioOnlyBtn.style.color = 'rgba(0,229,255,0.85)';
        audioOnlyBtn.style.borderColor = 'rgba(0,229,255,0.35)';
        audioOnlyBtn.style.background = 'transparent';
        audioOnlyBtn.style.boxShadow = 'none';
        audioOnlyBtn.title = t('hudAudioOnlyOff');
      }
    }
  }

  function toggleAudioOnly(forceState) {
    S.audioOnly = (typeof forceState === 'boolean') ? forceState : !S.audioOnly;
    persistSettings();
    window.postMessage({ type: 'YTSS_AUDIO_ONLY_CHANGED', audioOnly: S.audioOnly }, '*');
    applyAudioOnlyState();
  }

  // ─── IN-PLAYER HUD BADGE UI ─────────────────────────────────────────
  // Displays ★ 774 or fallback badge directly inside native YouTube controls
  var PlayerBadgeUI = {
    inject() {
      if (!S.enabled) {
        const container = document.getElementById('ytss-vol-container');
        if (container) container.style.display = 'none';
        const group = document.getElementById('ytss-bar-group');
        if (group) group.style.display = 'none';
        const bar = document.getElementById('ytss-badge-bar');
        if (bar) bar.style.display = 'none';
        const ao = document.getElementById('ytss-audio-only-btn');
        if (ao) ao.style.display = 'none';
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

      // One flex group holds codec badge + audio-only pill so they cannot drift apart
      let group = document.getElementById('ytss-bar-group');
      if (!group) {
        group = document.createElement('div');
        group.id = 'ytss-bar-group';
        group.style.cssText = 'display:inline-flex;align-items:center;height:28px;margin:0 0 0 14px;vertical-align:middle;flex:0 0 auto;position:relative;z-index:11;user-select:none;';
      } else {
        group.style.display = 'inline-flex';
      }

      let badge = document.getElementById('ytss-badge-bar');
      if (!badge || badge.parentElement !== group) {
        badge = document.createElement('span');
        badge.id = 'ytss-badge-bar';
        badge.className = 'ytss-bar-badge';
        badge.title = 'YTSS audio itag — click: Stats for nerds';
        badge.textContent = '251';
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          InPlayerSettingsUI.toggle();
        });
        group.appendChild(badge);
      }

      // Match .ytp-time-display (line-height: 28px) so centers line up
      badge.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'height:28px',
        'line-height:28px',
        'padding:0 5px',
        'margin:0',
        'box-sizing:border-box',
        'background:transparent',
        'border:1px solid rgba(225,29,29,0.5)',
        'border-radius:2px',
        'font:700 10px/28px Arial,Helvetica,sans-serif',
        'letter-spacing:0.2px',
        'color:#e85a5a',
        'cursor:pointer',
        'white-space:nowrap',
        'flex:0 0 auto'
      ].join(';');

      // Audio-Only pill — always sibling of the badge inside the same group
      let aoBtn = document.getElementById('ytss-audio-only-btn');
      if (!aoBtn || aoBtn.parentElement !== group) {
        if (aoBtn) aoBtn.remove();
        aoBtn = document.createElement('div');
        aoBtn.id = 'ytss-audio-only-btn';
        aoBtn.setAttribute('role', 'button');
        aoBtn.setAttribute('aria-label', 'Audio-Only Mode');
        // Headphone icon (currentColor) — cyan accent like stock YT control
        aoBtn.innerHTML = StatsForNerdsSpoofer.toSafeHtml('<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>');
        aoBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleAudioOnly();
        });
        group.appendChild(aoBtn);
      }
      // Base look = same chip geometry as the codec badge (2px radius / 28px / 1px border)
      aoBtn.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'height:28px',
        'line-height:28px',
        'width:30px',
        'margin:0 0 0 4px',
        'padding:0 4px',
        'box-sizing:border-box',
        'background:transparent',
        'border:1px solid rgba(0,229,255,0.5)',
        'border-radius:2px',
        'color:#00e5ff',
        'cursor:pointer',
        'flex:0 0 auto',
        'transition:color 0.2s,border-color 0.2s,background 0.2s,box-shadow 0.2s'
      ].join(';');

      // Keep group anchored right after the time display
      if (time && time.parentElement) {
        if (group.previousElementSibling !== time) {
          time.insertAdjacentElement('afterend', group);
        }
      } else if (group.parentElement !== left) {
        left.appendChild(group);
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
          container.className = 'ytss-controls-container';
          container.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; position: relative; margin: 0 4px; vertical-align: top; user-select: none; z-index: 999; height: 100%; gap: 5px; width: auto !important; overflow: visible !important;';

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

          const audioOnlyBtn = document.createElement('div');
          audioOnlyBtn.id = 'ytss-audio-only-btn';
          audioOnlyBtn.style.cssText = 'font-size: 13px; line-height: 16px; padding: 2px 6px; border-radius: 4px; border: 1px solid #555; background: rgba(0,0,0,0.5); color: #aaa; cursor: pointer; transition: all 0.2s; user-select: none; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap;';
          audioOnlyBtn.textContent = '🎧';
          audioOnlyBtn.title = 'Audio-Only Mode';
          audioOnlyBtn.onclick = (e) => {
            e.stopPropagation();
            toggleAudioOnly();
          };
          container.appendChild(audioOnlyBtn);
        }

        if (settingsBtn && settingsBtn.parentElement) {
          settingsBtn.parentElement.insertBefore(container, settingsBtn);
        } else if (subBtn && subBtn.parentElement) {
          subBtn.parentElement.insertBefore(container, subBtn);
        } else {
          rightControls.insertBefore(container, rightControls.firstChild);
        }
      } else {
        container.className = 'ytss-controls-container';
        container.style.cssText = 'display: inline-flex; align-items: center; justify-content: center; position: relative; margin: 0 4px; vertical-align: top; user-select: none; z-index: 999; height: 100%; gap: 5px; width: auto !important; overflow: visible !important;';

        let audioOnlyBtn = document.getElementById('ytss-audio-only-btn');
        if (!audioOnlyBtn && container) {
          audioOnlyBtn = document.createElement('div');
          audioOnlyBtn.id = 'ytss-audio-only-btn';
          audioOnlyBtn.style.cssText = 'font-size: 13px; line-height: 16px; padding: 2px 6px; border-radius: 4px; border: 1px solid #555; background: rgba(0,0,0,0.5); color: #aaa; cursor: pointer; transition: all 0.2s; user-select: none; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap;';
          audioOnlyBtn.textContent = '🎧';
          audioOnlyBtn.title = 'Audio-Only Mode';
          audioOnlyBtn.onclick = (e) => {
            e.stopPropagation();
            toggleAudioOnly();
          };
          container.appendChild(audioOnlyBtn);
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
        const bitrate = getActiveBitrate();
        const method = status.activeMethod || ((S.operationMode === 'TV_HEADLESS' || S.operationMode === 'TV_RELAY') ? 'TVHTML5' : 'YTM_HARVESTER');
        const isStudio = (typeof StudioEngine774 !== 'undefined' && StudioEngine774.isActive);
        el.title = itag === 141
          ? 'Studio Master AAC 141 (256kbps Full Fidelity)'
          : t(isStudio ? 'badgeTooltipStudio' : 'badgeTooltipNative', { itag, bitrate, method });
      } else {
        el.textContent = '251';
        el.style.color = '#8a8a8a';
        el.style.borderColor = 'rgba(255,255,255,0.18)';
        el.title = t('badgeTooltip251');
      }
    },

    update() {
      const itag = Number(status.activeAudioItag);
      const isHq = (itag === 774 || itag === 141) && !status.fallbackReason;

      this.paint(document.getElementById('ytss-badge'), isHq, itag);
      this.paint(document.getElementById('ytss-badge-bar'), isHq, itag);

      applyAudioOnlyState();

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
      // Burst inject so the chips land with the bar, not 1.5s later
      [0, 50, 150, 400, 900].forEach((ms) => setTimeout(() => PlayerBadgeUI.inject(), ms));
      applyAudioOnlyState();
      const currentVid = getVideoIdFromUrl();
      const pLoudness = window.ytInitialPlayerResponse?.playerConfig?.audioConfig?.loudnessDb
        ?? document.getElementById('movie_player')?.getPlayerResponse?.()?.playerConfig?.audioConfig?.loudnessDb;
      if (currentVid && typeof pLoudness === 'number') {
        loudnessDbMap.set(currentVid, pLoudness);
      }
      if ((StudioEngine774.isActive || StudioEngine774._isTransitioning) && StudioEngine774.activeVideoId && !isCurrentWatchVideo(StudioEngine774.activeVideoId)) {
        console.log(TAG, `[PageGuard] StudioEngine audio (${StudioEngine774.activeVideoId}) is no longer active! Preparing transition to ${currentVid}.`);
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
    if (!isPlayerActiveOnPage() && (StudioEngine774.isActive || StudioEngine774._isTransitioning || StudioEngine774.pending774)) {
      StudioEngine774.stopAndUnmute('Navigated away from watch page');
    }
  }, 1000);

  document.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => {
      if (!isPlayerActiveOnPage() && (StudioEngine774.isActive || StudioEngine774._isTransitioning || StudioEngine774.pending774)) {
        StudioEngine774.stopAndUnmute('Navigated away from watch page');
      }
    }, 200);
  });

  // ─── INTERCEPTORS — fetch & XHR ────────────────────────────────────
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
        const isPlayerActive = isPlayerActiveOnPage();
        const urlVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
        if (videoId && isPlayerActive && (!urlVid || videoId === urlVid)) {
          navTargetVideoId = videoId;
        }
        const lDb = json.playerConfig?.audioConfig?.loudnessDb;
        if (videoId && typeof lDb === 'number') {
          loudnessDbMap.set(videoId, lDb);
          if (StudioEngine774.isActive && StudioEngine774.activeVideoId === videoId) {
            StudioEngine774.updateNormalizedGain(videoId);
            StudioEngine774.syncVol();
          }
        }
        let cached = videoId ? cacheGet(videoId) : null;
        const isCurrentActive = isPlayerActive && isCurrentWatchVideo(videoId);

        // Async Gate on Cache Miss — hold /youtubei/v1/player up to 1200ms
        // while in-flight HQ harvest completes so processPlayerResponse runs synchronously
        // before the player initializes MSE.
        if (!cached && S.hqFetch && videoId && isCurrentActive && !confirmedNo774Videos.has(videoId)) {
          try {
            await Promise.race([
              fetchAllHQAudio(videoId),
              new Promise(resolve => setTimeout(resolve, 1200))
            ]);
            cached = cacheGet(videoId);
          } catch (e) {}
        }

        if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
          // Cache HIT: activate 774 immediately
          const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
          const playable = getPlayable774Candidates(formats);
          const all774 = getAll774Candidates(formats);
          if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0 && isCurrentActive) {
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
            noteTvNative774(all774[0], all774.length, videoId, cached?.streamingContext || null);
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

        // Cache MISS (after gate timeout): Return original response so the player starts naturally,
        // and finish background HQ fetch when ready.
        if (S.hqFetch && videoId && isCurrentWatchVideo(videoId)) {
          fetchAllHQAudio(videoId).then(hqData => {
            if (hqData?.cancelled) {
              if (isCurrentWatchVideo(videoId) && !pendingFetches.has(videoId) && StudioEngine774._isTransitioning) {
                StudioEngine774.stopAndUnmute('Harvest cancelled or timed out', videoId);
              }
              return;
            }
            const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
            if (hasFormats) {
              const isActive = isPlayerActiveOnPage();

              if (isActive && isCurrentWatchVideo(videoId)) {
                const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
                const playable = getPlayable774Candidates(formats);
                const all774 = getAll774Candidates(formats);
                if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0) {
                  StudioEngine774.load774(videoId, playable[0]);
                } else if (all774.length > 0) {
                  noteTvNative774(all774[0], all774.length, videoId, hqData?.streamingContext || null);
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
        console.log(TAG, 'fetch intercept error:', e);
        return response;
      }
    }

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

    // ── SABR/UMP body rewrite: ask the server for real itag 774 ──
    // YouTube's player passes either (url, { method: 'POST', body: Uint8Array }) OR
    // a single `new Request(url, { method: 'POST', body: Uint8Array })` as args[0].
    let wasSabrRewritten = false;
    if (url.includes('googlevideo.com/videoplayback')) {
      try {
        const curVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
        if (S.enabled && S.hqFetch && !sabrRewrite.on && !StudioEngine774.isActive && curVid && pendingFetches.has(curVid)) {
          await Promise.race([
            pendingFetches.get(curVid),
            new Promise(resolve => setTimeout(resolve, 900))
          ]);
        }

        if (args[1] && args[1].body) {
          const patched = ytssMaybeRewriteSabrBody(args[1].body);
          if (patched) {
            const opts = { ...args[1], body: patched };
            args = [args[0], opts];
            wasSabrRewritten = true;
          }
        } else if (args[0] && typeof args[0] === 'object' && typeof args[0].clone === 'function' && args[0].method === 'POST') {
          if (S.enabled && sabrRewrite.on && !StudioEngine774.isActive && !status.fallbackReason) {
            const rawBuf = await args[0].clone().arrayBuffer();
            if (rawBuf && rawBuf.byteLength >= 8) {
              const patched = ytssMaybeRewriteSabrBody(new Uint8Array(rawBuf));
              if (patched) {
                args = [new Request(args[0], { body: patched }), ...args.slice(1)];
                wasSabrRewritten = true;
              }
            }
          }
        }
      } catch (e) {
        console.log(TAG, '[SabrRewrite] fetch body rewrite failed:', e);
      }
    }

    const finalResponse = await ORIGINAL_FETCH.apply(this, args);
    if (wasSabrRewritten && finalResponse.ok && !sabrRewrite.verified774) {
      try {
        ytssInspectUmpResponse(finalResponse.clone(), sabrRewrite.videoId);
      } catch (e) {}
    }
    if (url.includes('googlevideo.com/videoplayback') && (finalResponse.status === 403 || finalResponse.status === 401)) {
      const urlObj = new URL(url);
      let failedItag = urlObj.searchParams.get('itag');
      if (!failedItag) {
        const match = urlObj.pathname.match(/\/itag\/(\d+)/);
        if (match) failedItag = match[1];
      }
      const isRewrittenSabr = wasSabrRewritten && Number(status.activeAudioItag) === 774;
      if (isRewrittenSabr || (failedItag && (Number(failedItag) === Number(status.activeAudioItag) || (Number(failedItag) === 251 && Number(status.activeAudioItag) === 774)))) {
        console.log(TAG, `[Fallback] Player got HTTP ${finalResponse.status} for injected ITAG ${failedItag || 774}`);
        const currentVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
        if (S.operationMode === OP_MODES.HYBRID_HQ && currentVid) {
          const currentSrc = (status.activeMethod && status.activeMethod.includes('TVHTML5')) ? 'TVHTML5' : (status.activeMethod || 'TVHTML5');
          const alternateSource = (currentSrc === 'TVHTML5') ? 'YTM_HARVESTER' : 'TVHTML5';
          if (canHybridFailover(currentVid, currentSrc, alternateSource)) {
            console.log(TAG, `[HybridFailover] Playback failed on ${currentSrc} (HTTP ${finalResponse.status}). Triggering failover to ${alternateSource}...`);
            handleHybridRuntimeFailover(currentVid, currentSrc, alternateSource, `HTTP ${finalResponse.status}`);
            return finalResponse;
          }
        }
        sabrRewrite.on = false;
        sabrRewrite.videoId = null;
        status.fallbackReason = `Player fallback (HTTP ${finalResponse.status})`;
        report();
      }
    }
    return finalResponse;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      try {
        const dUrl = new URL(url);
        const reqItags = dUrl.searchParams.getAll('itag').map(Number);
        const pathMatch = dUrl.pathname.match(/\/itag\/(\d+)/);
        if (pathMatch) reqItags.push(Number(pathMatch[1]));

        const activeItag = Number(status.activeAudioItag);

        let isMatch = reqItags.includes(activeItag);
        if (!isMatch) {
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
        console.log(TAG, `[XHRCapture] Error:`, e);
      }
    }
    this._ytssUrl = url;
    this._ytssSabrRewritten = false;
    return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._ytssUrl;

    // SABR/UMP binary body rewrite.
    if (url && typeof url === 'string' && url.includes('googlevideo.com/videoplayback') && args[0]) {
      try {
        const patched = ytssMaybeRewriteSabrBody(args[0]);
        if (patched) {
          args = [patched, ...args.slice(1)];
          this._ytssSabrRewritten = true;
        }
      } catch (e) {
        console.log(TAG, '[SabrRewrite] XHR body rewrite failed:', e);
      }
    }

    if (url && typeof url === 'string' && url.includes('/youtubei/v1/player') && !url.includes('_ytss=1')) {
      const self = this;
      let xhrPatched = false;
      const handlePlayerXhr = function () {
        if (xhrPatched || self.readyState !== 4 || self.status !== 200 || !S.enabled) return;
        xhrPatched = true;
        try {
          const rawText = (!self.responseType || self.responseType === 'text') ? self.responseText : null;
          if (!rawText) return;
          const json = JSON.parse(rawText);
          const videoId = json.videoDetails?.videoId;
          const isPlayerActive = isPlayerActiveOnPage();
          const urlVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
          if (videoId && isPlayerActive && (!urlVid || videoId === urlVid)) {
            navTargetVideoId = videoId;
          }
          const cached = videoId ? cacheGet(videoId) : null;
          const isCurrentActive = isPlayerActive && isCurrentWatchVideo(videoId);

          if (cached && (cached.formats?.length > 0 || cached.length > 0 || cached.streamingContext)) {
            const formats = cached?.formats || (Array.isArray(cached) ? cached : []);
            const playable = getPlayable774Candidates(formats);
            const all774 = getAll774Candidates(formats);
            if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0 && isCurrentActive) {
              StudioEngine774.load774(videoId, playable[0]);
            } else if (all774.length > 0 && isCurrentActive) {
              noteTvNative774(all774[0], all774.length, videoId, cached?.streamingContext || null);
            } else if (isCurrentActive) {
              StudioEngine774.stopAndUnmute('No 774 stream available for this video', videoId);
            }
            try {
              const patchedJson = processPlayerResponse(json, cached);
              const patchedStr = JSON.stringify(patchedJson);
              Object.defineProperty(self, 'responseText', { get: () => patchedStr, configurable: true });
              Object.defineProperty(self, 'response', { get: () => patchedStr, configurable: true });
            } catch (e) {}
          } else if (S.hqFetch && videoId && isCurrentWatchVideo(videoId)) {
            // Cache miss: fetch in background and upgrade seamlessly once ready.
            fetchAllHQAudio(videoId).then(hqData => {
              if (hqData?.cancelled) {
                if (isCurrentWatchVideo(videoId) && !pendingFetches.has(videoId) && StudioEngine774._isTransitioning) {
                  StudioEngine774.stopAndUnmute('Harvest cancelled or timed out', videoId);
                }
                return;
              }
              const hasFormats = hqData && (hqData.formats?.length > 0 || hqData.length > 0 || hqData.streamingContext);
              if (hasFormats) {
                const isActive = isPlayerActiveOnPage();

                if (isActive && isCurrentWatchVideo(videoId)) {
                  const formats = hqData?.formats || (Array.isArray(hqData) ? hqData : []);
                  const playable = getPlayable774Candidates(formats);
                  const all774 = getAll774Candidates(formats);
                  if (S.operationMode !== OP_MODES.TV_HEADLESS && S.operationMode !== OP_MODES.TV_RELAY && playable.length > 0) {
                    StudioEngine774.load774(videoId, playable[0]);
                  } else if (all774.length > 0) {
                    noteTvNative774(all774[0], all774.length, videoId, hqData?.streamingContext || null);
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
      };

      this.addEventListener('readystatechange', handlePlayerXhr);
      const origHandler = this.onreadystatechange;
      if (origHandler) {
        this.onreadystatechange = function () {
          handlePlayerXhr();
          return origHandler.apply(self, arguments);
        };
      }
    } else if (url && typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
      const self = this;
      let xhrInspected = false;
      const handleVideoplaybackXhr = function () {
        if (self.readyState !== 4 || xhrInspected) return;
        xhrInspected = true;
        if (self.status === 200 && self._ytssSabrRewritten && !sabrRewrite.verified774) {
          try {
            const respBytes = ytssBodyToU8(self.response);
            if (respBytes && respBytes.length > 0) {
              ytssInspectUmpBytes(respBytes, sabrRewrite.videoId);
            }
          } catch (e) {}
        } else if (self.status === 403 || self.status === 401) {
          try {
            const urlObj = new URL(self._ytssUrl);
            let failedItag = urlObj.searchParams.get('itag');
            if (!failedItag) {
              const match = urlObj.pathname.match(/\/itag\/(\d+)/);
              if (match) failedItag = match[1];
            }
            const isRewrittenSabr = self._ytssSabrRewritten && Number(status.activeAudioItag) === 774;
            if (isRewrittenSabr || (failedItag && (Number(failedItag) === Number(status.activeAudioItag) || (Number(failedItag) === 251 && Number(status.activeAudioItag) === 774)))) {
              console.log(TAG, `[Fallback] Player got HTTP ${self.status} for injected ITAG ${failedItag || 774} via XHR`);
              const currentVid = (typeof getVideoIdFromUrl === 'function' ? getVideoIdFromUrl() : null);
              if (S.operationMode === OP_MODES.HYBRID_HQ && currentVid) {
                const currentSrc = (status.activeMethod && status.activeMethod.includes('TVHTML5')) ? 'TVHTML5' : (status.activeMethod || 'TVHTML5');
                const alternateSource = (currentSrc === 'TVHTML5') ? 'YTM_HARVESTER' : 'TVHTML5';
                if (canHybridFailover(currentVid, currentSrc, alternateSource)) {
                  console.log(TAG, `[HybridFailover] Playback failed on ${currentSrc} via XHR (HTTP ${self.status}). Triggering failover to ${alternateSource}...`);
                  handleHybridRuntimeFailover(currentVid, currentSrc, alternateSource, `HTTP ${self.status}`);
                  return;
                }
              }
              sabrRewrite.on = false;
              sabrRewrite.videoId = null;
              status.fallbackReason = `Player fallback (HTTP ${self.status})`;
              report();
            }
          } catch (e) { }
        }
      };

      this.addEventListener('readystatechange', handleVideoplaybackXhr);
      const origHandler = this.onreadystatechange;
      if (origHandler) {
        this.onreadystatechange = function () {
          handleVideoplaybackXhr();
          return origHandler.apply(self, arguments);
        };
      }
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };

  // ─── EXPOSE API TO POPUP ──────────────────────────────────────────
  window.YTSS_SpoofingMethods = {
    getStatus: () => ({ ...status, settings: { ...S } }),
    getEngine: () => StudioEngine774,
    getUmp: () => UmpMseController774,
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
    getNativeBooster: () => null,
    setShadowVolume: () => {},
    applySettings: (newSettings) => {
      Object.assign(S, pickSettings(newSettings));
      persistSettings();
      handleSettingsChange();
      // shadowVolume is persisted for storage compat; actual gain is applied via
      // StudioEngine774.syncVol. NativeAudioBooster no longer exists.
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
      confirmedNo774Videos.clear();
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
    fetchAllHQAudio: (vid, opts) => fetchAllHQAudio(vid, opts),
    prewarmCache: (vid, opts) => prewarmCache(vid, opts)
  };

  console.log(TAG, 'Injected — Pre-warm + ytplayer.config + ITAG disguise + ForceReload active');
})();
