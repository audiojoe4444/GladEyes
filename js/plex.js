/*
 * Plex API client. Talks straight to the Plex Media Server from the browser.
 *
 * Every X-Plex-* value (including the token) is sent as a query-string argument,
 * as the PMS API docs allow. That keeps every request a "simple" CORS request
 * (no preflight), which matters because this page is served from a different origin.
 */
(function () {
  'use strict';

  const cfg = window.PLEX_CONFIG || {};

  // ---------- storage: localStorage can fail or be cleared, so keep a memory fallback ----------
  const mem = {};
  const store = {
    get(k) {
      try { const v = window.localStorage.getItem(k); if (v !== null) return v; } catch (e) { /* ignore */ }
      return mem[k] || null;
    },
    set(k, v) {
      mem[k] = v;
      try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    },
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // Keep list responses small: we only need a few fields per row.
  const TRIM = {
    excludeFields: 'summary,tagline',
    excludeElements: 'Media,Genre,Country,Role,Director,Writer,Producer,Guid,Rating,Image,Collection,Similar,Label',
  };

  // Pull token/server out of the launch URL (#token=...&server=... or ?token=...), then remove them from the address bar.
  function readLaunchParams() {
    const out = {};
    const sources = [location.hash.replace(/^#\??/, ''), location.search.replace(/^\?/, '')];
    for (const s of sources) {
      const p = new URLSearchParams(s);
      if (!out.token && p.get('token')) out.token = p.get('token');
      if (!out.server && p.get('server')) out.server = p.get('server');
    }
    if (out.token || out.server) {
      try {
        const u = new URL(location.href);
        u.hash = '';
        u.searchParams.delete('token');
        u.searchParams.delete('server');
        history.replaceState(history.state, '', u.pathname + u.search);
      } catch (e) { /* ignore */ }
    }
    return out;
  }

  const Plex = {
    server: '',
    token: '',
    clientId: '',

    /** Resolve credentials. Order: launch URL > saved on device > config.js. */
    init() {
      const launch = readLaunchParams();
      if (launch.token) store.set('plex.token', launch.token);
      if (launch.server) store.set('plex.server', launch.server.replace(/\/+$/, ''));
      this.token = store.get('plex.token') || cfg.token || '';
      this.server = (store.get('plex.server') || cfg.serverUrl || '').replace(/\/+$/, '');
      this.clientId = store.get('plex.clientId') || uuid();
      store.set('plex.clientId', this.clientId);
      return { ok: !!(this.token && this.server), missingToken: !this.token, missingServer: !this.server };
    },

    identity() {
      const chrome = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '120';
      return {
        'X-Plex-Product': 'Plex Glasses',
        'X-Plex-Version': '1.0.0',
        'X-Plex-Client-Identifier': this.clientId,
        // "Chrome" makes the server apply its built-in Chrome client profile (H.264/AAC in MP4 etc.).
        'X-Plex-Platform': 'Chrome',
        'X-Plex-Platform-Version': chrome,
        'X-Plex-Device': 'Meta Ray-Ban Display',
        'X-Plex-Device-Name': 'Ray-Ban Display',
        'X-Plex-Token': this.token,
      };
    },

    url(path, extra) {
      const all = Object.assign({}, this.identity(), extra || {});
      const p = new URLSearchParams();
      Object.keys(all).forEach((k) => {
        if (all[k] !== undefined && all[k] !== null && all[k] !== '') p.append(k, all[k]);
      });
      return this.server + path + '?' + p.toString();
    },

    async json(path, extra) {
      let res;
      try {
        res = await fetch(this.url(path, extra), { headers: { Accept: 'application/json' } });
      } catch (cause) {
        const e = new Error('network'); e.kind = 'network'; e.cause = cause; throw e;
      }
      if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.kind = 'auth'; throw e; }
      if (!res.ok) { const e = new Error('Server said ' + res.status); e.kind = 'http'; e.status = res.status; throw e; }
      const body = await res.json();
      return body.MediaContainer || {};
    },

    /** Fetch every page of a Metadata list (PMS paginates with X-Plex-Container-Start/Size). */
    async pages(path, extra, opts) {
      const size = (opts && opts.size) || 300;
      const cap = (opts && opts.cap) || 8000;
      const out = [];
      let start = 0;
      let total = Infinity;
      while (start < total && out.length < cap) {
        const mc = await this.json(path, Object.assign({}, extra, {
          'X-Plex-Container-Start': start,
          'X-Plex-Container-Size': size,
        }));
        const md = mc.Metadata || [];
        total = typeof mc.totalSize === 'number' ? mc.totalSize : start + md.length;
        for (const m of md) out.push(m);
        start += md.length;
        if (opts && opts.onProgress) opts.onProgress(out.length, total);
        if (!md.length) break;
      }
      return out;
    },

    // ---------- browsing ----------
    async libraries() {
      const mc = await this.json('/library/sections');
      return (mc.Directory || []).map((d) => ({ id: String(d.key), title: d.title || '', type: d.type }));
    },
    libraryItems(id, onProgress) {
      return this.pages('/library/sections/' + encodeURIComponent(id) + '/all', Object.assign({ sort: 'titleSort:asc' }, TRIM), { onProgress });
    },
    async metadata(id) {
      const mc = await this.json('/library/metadata/' + encodeURIComponent(id));
      return (mc.Metadata || [])[0] || null;
    },
    children(id) {
      return this.pages('/library/metadata/' + encodeURIComponent(id) + '/children', TRIM, { size: 500 });
    },

    /** Poster/thumbnail, resized by the server so the glasses don't download full-size art. */
    image(path, w, h) {
      if (!path) return '';
      return this.url('/photo/:/transcode', { width: w, height: h, minSize: 1, upscale: 1, url: path });
    },

    // ---------- Universal Transcoder ----------
    /**
     * Client-profile additions that pin the output to what a Chromium browser can always play:
     * H.264 (level <= 4.1) video and stereo AAC audio; for progressive "http" also an MP4 target.
     * Syntax: X-Plex-Client-Profile-Extra, directives joined with "+" (see PMS API docs).
     */
    profileExtra(pb) {
      const d = [];
      if (pb.protocol === 'http') {
        d.push('add-transcode-target(type=videoProfile&context=streaming&protocol=http&container=' +
          (pb.container || 'mp4') + '&videoCodec=h264&audioCodec=aac&replace=true)');
      }
      d.push('add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.level&value=41&isRequired=true)');
      d.push('add-limitation(scope=videoAudioCodec&scopeName=aac&type=upperBound&name=audio.channels&value=2&isRequired=true)');
      return d.join('+');
    },

    transcodeArgs(item, o) {
      const pb = o.pb;
      return {
        path: '/library/metadata/' + item.ratingKey,
        mediaIndex: 0,
        partIndex: 0,
        protocol: pb.protocol,
        offset: Math.max(0, Math.floor(o.offset || 0)),
        fastSeek: 1,
        directPlay: 0,                              // never hand the browser the raw file
        directStream: pb.forceTranscode ? 0 : 1,    // 0 = server re-encodes video and audio
        subtitleSize: 100,
        audioBoost: 100,
        videoQuality: 100,
        maxVideoBitrate: pb.maxVideoBitrate,
        videoResolution: pb.videoResolution,
        session: o.session,
        'X-Plex-Session-Identifier': o.session,
        'X-Plex-Client-Profile-Extra': this.profileExtra(pb),
      };
    },

    /** The URL to put in <video src>. The server starts transcoding on request. */
    streamUrl(item, o) {
      const ext = o.pb.protocol === 'hls' ? 'm3u8' : (o.pb.container || 'mp4');
      return this.url('/video/:/transcode/universal/start.' + ext, this.transcodeArgs(item, o));
    },

    /** Ask the server how it plans to serve this item (best effort, used for diagnostics). */
    async decision(item, o) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      try {
        const res = await fetch(this.url('/video/:/transcode/universal/decision', this.transcodeArgs(item, o)), {
          headers: { Accept: 'application/json' }, signal: ctl.signal,
        });
        if (!res.ok) return { text: 'decision HTTP ' + res.status };
        const mc = (await res.json()).MediaContainer || {};
        return { text: mc.transcodeDecisionText || mc.generalDecisionText || mc.mdeDecisionText || '' };
      } catch (e) {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    stop(session) {
      try { fetch(this.url('/video/:/transcode/universal/stop', { session }), { keepalive: true }).catch(() => {}); } catch (e) { /* ignore */ }
    },
    ping(session) {
      try { fetch(this.url('/video/:/transcode/universal/ping', { session })).catch(() => {}); } catch (e) { /* ignore */ }
    },
    /** Tell Plex what we're playing (shows in Now Playing, updates watched state). */
    timeline(item, state, timeMs, durationMs, session) {
      try {
        fetch(this.url('/:/timeline', {
          ratingKey: item.ratingKey,
          key: '/library/metadata/' + item.ratingKey,
          state,
          time: Math.floor(timeMs),
          duration: Math.floor(durationMs),
          identifier: 'com.plexapp.plugins.library',
          'X-Plex-Session-Identifier': session,
        }), { keepalive: true }).catch(() => {});
      } catch (e) { /* ignore */ }
    },
  };

  window.Plex = Plex;
})();
