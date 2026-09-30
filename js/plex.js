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

  const nextFrame = () => new Promise((r) => (window.requestAnimationFrame ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

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

  /** What the first bytes of a response look like (used only for the on-screen "what did the server send?" report). */
  function sniff(b) {
    if (!b || !b.length) return 'empty reply';
    const t = String.fromCharCode.apply(null, Array.prototype.slice.call(b, 0, 8));
    if (t.indexOf('#EXTM3U') === 0) return 'an HLS playlist';
    if (t.slice(4, 8) === 'ftyp') return 'MP4 data';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'Matroska/WebM data';
    if (b[0] === 0x47) return 'MPEG-TS data';
    if (t.charAt(0) === '<') return 'a web page/XML (an error?)';
    return 'unrecognised data';
  }

  const Plex = {
    server: '',
    token: '',
    clientId: '',
    timeoutMs: Math.max(1000, (cfg.requestTimeoutSeconds || 15) * 1000),

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
        'X-Plex-Version': '3.0.0',
        'X-Plex-Client-Identifier': this.clientId,
        // "Chrome" makes the server apply its built-in Chrome client profile (H.264/AAC etc.).
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

    /** GET JSON with a hard time limit covering the whole download, so nothing can hang forever. */
    async json(path, extra, ms) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms || this.timeoutMs);
      try {
        let res;
        try {
          res = await fetch(this.url(path, extra), { headers: { Accept: 'application/json' }, signal: ctl.signal });
        } catch (cause) {
          const e = new Error(cause && cause.name === 'AbortError' ? 'timeout' : 'network');
          e.kind = e.message; e.cause = cause; throw e;
        }
        if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.kind = 'auth'; throw e; }
        if (!res.ok) { const e = new Error('Server said ' + res.status); e.kind = 'http'; e.status = res.status; throw e; }
        let text;
        try { text = await res.text(); } catch (cause) {
          const e = new Error(cause && cause.name === 'AbortError' ? 'timeout' : 'network');
          e.kind = e.message; throw e;
        }
        let body;
        try { body = JSON.parse(text); } catch (cause) { const e = new Error('The server sent something that wasn\u2019t JSON.'); e.kind = 'http'; throw e; }
        return body.MediaContainer || {};
      } finally {
        clearTimeout(timer);
      }
    },

    /** Fetch every page of a Metadata list (used for seasons/episodes, which are short). */
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
        if (!md.length) break;
      }
      return out;
    },

    // ---------- browsing ----------
    async libraries() {
      const mc = await this.json('/library/sections');
      return (mc.Directory || []).map((d) => ({
        id: String(d.key), title: d.title || '', type: d.type,
        stamp: String(d.contentChangedAt || d.updatedAt || d.scannedAt || ''),
      }));
    },

    /**
     * A compact list of everything in a library ({k,t,s,y,ty,c} per item), built for big libraries:
     *  - asks the server for the count first (size 0), so we know what to expect;
     *  - downloads in a few parallel chunks, each with a time limit;
     *  - a chunk that stalls or fails is split in half and retried; anything still failing is skipped
     *    (and reported) rather than freezing the app;
     *  - the result is cached on the device, so reopening the library is instant.
     */
    async libraryIndex(id, stamp, onProgress) {
      const base = '/library/sections/' + encodeURIComponent(id) + '/all';
      const args = Object.assign({ sort: 'titleSort:asc' }, TRIM);
      const page = (start, size, ms) => this.json(base, Object.assign({}, args, {
        'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size,
      }), ms);
      const toRow = (m) => ({ k: String(m.ratingKey), t: m.title || '', s: m.titleSort || '', y: m.year || 0, ty: m.type || '', c: m.childCount || 0 });
      const report = (done, total, note) => { if (onProgress) onProgress(done, total, note); };

      const head = await page(0, 0);
      const total = typeof head.totalSize === 'number' ? head.totalSize : null;

      const ck = 'plex.idx.' + this.server + '|' + id;
      if (total !== null) {
        const hit = this.readIndexCache(ck, total, stamp);
        if (hit) return { rows: hit, total, skipped: 0, cached: true };
      }

      let done = 0;
      let skipped = 0;
      const CHUNK = 500;
      const CONCURRENCY = 3;

      const once = async (start, count, attempt) => {
        try {
          const mc = await page(start, count, attempt ? Math.ceil(this.timeoutMs / 2) : this.timeoutMs);
          return (mc.Metadata || []).map(toRow);
        } catch (e) {
          if (e.kind === 'auth') throw e;
          report(done, total, 'retrying');
          if (count > 40) {                       // split the troublesome range and try each half
            const half = Math.ceil(count / 2);
            const a = await range(start, half);
            const b = await range(start + half, count - half);
            return a.concat(b);
          }
          if (attempt < 1) return once(start, count, attempt + 1);
          skipped += count;                       // give up on this small range, keep going
          return [];
        }
      };
      // The server may return fewer items than asked for; keep asking until the range is filled.
      const range = async (start, count) => {
        let out = [];
        let s = start;
        let left = count;
        while (left > 0) {
          const got = await once(s, left, 0);
          if (!got.length) break;
          out = out.concat(got);
          s += got.length;
          left -= got.length;
        }
        return out;
      };

      let rows;
      if (total === null) {                       // very old server: no count available, page until it runs out
        rows = [];
        for (;;) {
          const got = await range(rows.length, 300);
          rows = rows.concat(got);
          done = rows.length;
          report(done, null);
          await nextFrame();
          if (got.length < 300) break;
        }
      } else {
        const starts = [];
        for (let s = 0; s < total; s += CHUNK) starts.push(s);
        const parts = new Array(starts.length);
        let next = 0;
        const worker = async () => {
          while (next < starts.length) {
            const i = next++;
            parts[i] = await range(starts[i], Math.min(CHUNK, total - starts[i]));
            done += parts[i].length;
            report(done, total);
            await nextFrame();                    // let the screen repaint between chunks
          }
        };
        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, starts.length); w++) workers.push(worker());
        await Promise.all(workers);
        rows = [].concat.apply([], parts);
      }

      if (!skipped && total !== null) this.writeIndexCache(ck, total, stamp, rows);
      return { rows, total: total === null ? rows.length : total, skipped, cached: false };
    },

    readIndexCache(key, total, stamp) {
      try {
        const raw = store.get(key);
        if (!raw) return null;
        const c = JSON.parse(raw);
        const ttl = (stamp ? 24 : 6) * 3600 * 1000;
        if (c.v !== 1 || c.total !== total || (c.stamp || '') !== (stamp || '') || Date.now() - c.t > ttl) return null;
        return c.rows.map((r) => ({ k: r[0], t: r[1], s: r[2], y: r[3], ty: r[4], c: r[5] }));
      } catch (e) { return null; }
    },
    writeIndexCache(key, total, stamp, rows) {
      try {
        store.set(key, JSON.stringify({ v: 1, t: Date.now(), total, stamp: stamp || '', rows: rows.map((r) => [r.k, r.t, r.s, r.y, r.ty, r.c]) }));
      } catch (e) { /* too big or blocked: fine, it just won't be cached */ }
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

    /** The URL to give the player. The server starts transcoding on request. */
    streamUrl(item, o) {
      const ext = o.pb.protocol === 'hls' ? 'm3u8' : (o.pb.container || 'mp4');
      return this.url('/video/:/transcode/universal/start.' + ext, this.transcodeArgs(item, o));
    },

    /** Ask the server how it plans to serve this item (best effort, used for diagnostics). */
    async decision(item, o) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
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

    /** Fetch the start of a stream URL and describe what came back ("HTTP 200, video/mp4, MP4 data"). */
    async probe(url) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(url, { signal: ctl.signal });
        const type = (res.headers.get('content-type') || '').split(';')[0] || 'no type';
        let what = '';
        if (res.ok && res.body && res.body.getReader) {
          const rd = res.body.getReader();
          const r = await rd.read();
          what = sniff(r.value);
        }
        return 'HTTP ' + res.status + ', ' + type + (what ? ', ' + what : '');
      } catch (e) {
        return e && e.name === 'AbortError' ? 'no reply within 8s' : 'blocked or unreachable';
      } finally {
        clearTimeout(timer);
        try { ctl.abort(); } catch (e) { /* ignore */ }
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
