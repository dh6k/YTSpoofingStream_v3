// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Offscreen Harvester                          ║
// ║  Harvests direct authentic Studio Opus 774 formats via YTM       ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
  'use strict';

  const TAG = '[YTSpoofHarvester]';
  const isFirefox = /Firefox\//.test(navigator.userAgent);
  let frameWatch = null;
  let activeFrameSession = null;

  function teardownFrame() {
    clearInterval(frameWatch); frameWatch = null;
    activeFrameSession = null;
    const iframes = document.querySelectorAll('iframe#harvesterFrame, iframe');
    iframes.forEach(iframe => {
      try {
        const media = iframe.contentDocument?.querySelectorAll('video, audio');
        media?.forEach(m => {
          try { m.pause(); m.src = ''; m.load(); } catch (e) {}
        });
      } catch (e) {}
      try { iframe.src = 'about:blank'; } catch (e) {}
      try { iframe.remove(); } catch (e) {}
    });
  }
  teardownFrame();

  function ensureHost() {
    let host = document.getElementById('ytss-harvester-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ytss-harvester-host';
      host.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;';
      const root = document.body || document.documentElement;
      if (root) {
        root.appendChild(host);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          (document.body || document.documentElement)?.appendChild(host);
        }, { once: true });
      }
    }
    return host;
  }

  function createFrame() {
    teardownFrame();
    const host = ensureHost();
    const iframe = document.createElement('iframe');
    iframe.id = 'harvesterFrame';
    if (!navigator.userAgent.includes('Firefox')) {
      iframe.setAttribute('allow', 'autoplay');
    }
    iframe.style.cssText = 'position:absolute; top:-9999px; left:-9999px; width:640px; height:360px; border:none;';
    host.appendChild(iframe);
    return iframe;
  }

  function handleHarvesterCommand(msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'OFFSCREEN_HARVEST_YTM') {
      const { videoId } = msg;
      if (isFirefox && (!/^[\w-]{11}$/.test(videoId || '') || !/^\d+\.\d+$/.test(msg.sessionId || ''))) {
        if (sendResponse) sendResponse({ success: false });
        return true;
      }
      const iframe = createFrame();
      if (isFirefox) {
        activeFrameSession = { videoId, sessionId: msg.sessionId, iframe };
        const session = activeFrameSession;
        const abort = reason => {
          if (activeFrameSession !== session) return;
          teardownFrame();
          emitToBackground({ type: 'OFFSCREEN_HARVEST_ABORT', videoId, sessionId: session.sessionId, reason });
        };
        iframe.addEventListener('error', () => abort('FRAME_BLOCKED'), { once: true });
        frameWatch = setInterval(() => {
          if (!iframe.isConnected || document.getElementById('harvesterFrame') !== iframe) abort('FRAME_LOST');
        }, 200);
      }
      console.log(TAG, `Loading clean YTM harvest session for ${videoId}...`);
      iframe.src = `https://music.youtube.com/watch?v=${videoId}${isFirefox ? '#ytss_harvest=' + msg.sessionId : ''}`;
      if (sendResponse) sendResponse({ success: true });
      return true;
    }
    if (msg.type === 'OFFSCREEN_STOP_HARVEST') {
      teardownFrame();
      if (sendResponse) sendResponse({ success: true });
      return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(handleHarvesterCommand);

  function emitToBackground(payload) {
    if (typeof window.__ytssOnLocalHarvesterEvent === 'function') {
      try {
        window.__ytssOnLocalHarvesterEvent(payload);
        return;
      } catch (e) {}
    }
    chrome.runtime.sendMessage(payload).catch(() => {});
  }

  window.addEventListener('message', (e) => {
    // Only trust messages from our own harvester iframe running music.youtube.com.
    const frame = document.getElementById('harvesterFrame');
    if (e.origin !== 'https://music.youtube.com' || !frame || e.source !== frame.contentWindow) return;
    if (isFirefox && (e.data?.sessionId !== activeFrameSession?.sessionId || e.data?.videoId !== activeFrameSession?.videoId)) return;

    if (isFirefox && e.data?.type === 'HARVEST_PROGRESS') {
      emitToBackground({ type: 'OFFSCREEN_HARVEST_PROGRESS', videoId: e.data.videoId, sessionId: e.data.sessionId, stage: e.data.stage });
      return;
    }

    if (e.data?.type === 'HARVEST_774_URL') {
      console.log(TAG, `Iframe captured authentic 774 stream for ${e.data.videoId}`);
      teardownFrame();
      emitToBackground({
        type: 'OFFSCREEN_HARVEST_SUCCESS',
        ...(isFirefox ? { sessionId: e.data.sessionId } : {}),
        videoId: e.data.videoId,
        url: e.data.url,
        bitrate: e.data.bitrate,
        averageBitrate: e.data.averageBitrate,
        contentLength: e.data.contentLength,
        approxDurationMs: e.data.approxDurationMs,
        loudnessDb: e.data.loudnessDb
      });
      return;
    }

    if (e.data?.type === 'HARVEST_ABORT') {
      console.log(TAG, `Iframe reported abort for ${e.data.videoId}: ${e.data.reason}`);
      teardownFrame();
      emitToBackground({
        type: 'OFFSCREEN_HARVEST_ABORT',
        ...(isFirefox ? { sessionId: e.data.sessionId } : {}),
        videoId: e.data.videoId,
        reason: e.data.reason
      });
      return;
    }
  });

  if (isFirefox) document.addEventListener('securitypolicyviolation', e => {
    if (!activeFrameSession || !String(e.blockedURI || '').includes('music.youtube.com') || !/frame-src|child-src|frame-ancestors/.test(e.effectiveDirective || '')) return;
    const session = activeFrameSession;
    teardownFrame();
    emitToBackground({ type: 'OFFSCREEN_HARVEST_ABORT', videoId: session.videoId, sessionId: session.sessionId, reason: 'FRAME_BLOCKED' });
  });

  window.__ytssLocalHarvester = {
    ensureHost: () => Boolean(ensureHost()),
    hasHost: () => Boolean(document.getElementById('ytss-harvester-host')),
    hasFrame: () => Boolean(document.getElementById('harvesterFrame')),
    send: (msg) => new Promise((resolve) => {
      handleHarvesterCommand(msg, { id: chrome.runtime.id }, (res) => resolve(res));
    }),
    close: () => {
      teardownFrame();
      document.getElementById('ytss-harvester-host')?.remove();
    }
  };

  console.log(TAG, 'Offscreen Harvester initialized with strict DOM teardown.');
})();
