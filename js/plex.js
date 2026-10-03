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
      if (window.Backup) window.Backup.noted(k);
    },
    del(k) {
      delete mem[k];
      try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      if (window.Backup) window.Backup.noted(k);
    },
  };
  const readJson = (k) => { try { return JSON.parse(store.get(k) || 'null'); } catch (e) { return null; } };

  // ---------- finding a working address for the server ----------
  const PRI = { local: 0, remote: 1, relay: 2 };                  // preference: home network, then direct remote, then Plex relay
  const DELAY = { local: 0, remote: 400, relay: 1500 };           // start the slower options a little later
  const PROBE_MS = { local: 2500, remote: 5000, relay: 8000 };
  const TYPE_LABEL = { local: 'your home network', remote: 'a remote connection', relay: 'Plex relay' };
  // HTTPS only (the page is HTTPS), except this computer itself, which is allowed for testing.
  const okUri = (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127(\.\d+){3}|\[::1\])(:|\/|$)/i.test(u);
  function guessType(uri) {
    const m = /^https?:\/\/(\d+)-(\d+)-(\d+)-(\d+)\./i.exec(uri);
    if (!m) return /localhost|\/\/127(\.\d+){3}|\[::1\]/.test(uri) ? 'local' : 'remote';
    const a = +m[1]; const b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? 'local' : 'remote';
  }
  function fail(kind, message, extra) { const e = new Error(message || kind); e.kind = kind; return Object.assign(e, extra || {}); }

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
        u.searchParams.delete('token');
        u.searchParams.delete('server');
        const hp = new URLSearchParams(location.hash.replace(/^#\??/, ''));
        hp.delete('token');
        hp.delete('server');
        const rest = hp.toString();                         // anything else in the fragment (e.g. sync=...) stays
        u.hash = rest ? '#' + rest : '';
        history.replaceState(history.state, '', u.pathname + u.search + u.hash);
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

    connected: false,
    connType: '',
    serverId: '',
    serverName: '',
    userName: '',
    authMode: '',
    accountToken: '',
    viaLink: false,

    /** Resolve credentials. Order: launch URL > saved on device > config.js. */
    init() {
      const launch = readLaunchParams();
      if (launch.token) {
        if (launch.token !== store.get('plex.token')) {          // a new token: forget any earlier sign-in
          ['plex.acct', 'plex.srv', 'plex.conns', 'plex.srvid', 'plex.srvname', 'plex.user'].forEach((k) => store.del(k));
        }
        store.set('plex.token', launch.token);
        store.set('plex.auth', 'manual');
        store.set('plex.viaLink', '1');
      }
      if (launch.server) store.set('plex.server', launch.server.replace(/\/+$/, ''));
      this.token = store.get('plex.token') || cfg.token || '';
      this.accountToken = store.get('plex.acct') || this.token;
      const srv = readJson('plex.srv');
      if (srv) this.token = srv.token || this.accountToken;        // signed in with a code: use the server's own token
      this.authMode = store.get('plex.auth') || (this.token ? 'manual' : '');
      // your own address in config.js is only a starting point for the "manual" set-up; a server chosen through Plex replaces it
      this.server = (store.get('plex.server') || (srv ? '' : cfg.serverUrl) || '').replace(/\/+$/, '');
      this.serverId = store.get('plex.srvid') || '';
      this.serverName = store.get('plex.srvname') || '';
      this.userName = store.get('plex.user') || '';
      this.viaLink = store.get('plex.viaLink') === '1';
      this.clientId = store.get('plex.clientId') || uuid();
      store.set('plex.clientId', this.clientId);
      return { ok: this.hasCredentials() };
    },
    hasCredentials() { return !!(this.token || this.accountToken); },

    /** Tiny key/value memory on the device (last letter chosen per library, etc.). */
    remember(k, v) { store.set('plex.pref.' + k, String(v)); },
    recall(k) { return store.get('plex.pref.' + k); },
    forget(k) { store.del('plex.pref.' + k); },

    identityBase() {
      const chrome = (navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '120';
      return {
        'X-Plex-Product': 'GladEyes',
        'X-Plex-Version': '12.0.0',
        'X-Plex-Client-Identifier': this.clientId,
        // "Chrome" makes the server apply its built-in Chrome client profile (H.264/AAC etc.).
        'X-Plex-Platform': 'Chrome',
        'X-Plex-Platform-Version': chrome,
        'X-Plex-Device': 'Meta Ray-Ban Display',
        'X-Plex-Device-Name': 'Ray-Ban Display',
      };
    },
    identity() { return Object.assign(this.identityBase(), { 'X-Plex-Token': this.token }); },

    buildUrl(base, path, params) {
      const p = new URLSearchParams();
      Object.keys(params || {}).forEach((k) => {
        if (params[k] !== undefined && params[k] !== null && params[k] !== '') p.append(k, params[k]);
      });
      return base + path + '?' + p.toString();
    },

    url(path, extra) { return this.buildUrl(this.server, path, Object.assign({}, this.identity(), extra || {})); },

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

    // ---------- sign in with a code (plex.tv/link) ----------
    authBase() { return (cfg.authBase || 'https://plex.tv').replace(/\/+$/, ''); },
    resourcesBase() { return (cfg.resourcesBase || 'https://clients.plex.tv').replace(/\/+$/, ''); },

    /** A request to plex.tv (not to your server). Every value is in the query string so it stays a simple request. */
    async tvJson(base, path, extra, opts) {
      const o = opts || {};
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.ms || 10000);
      try {
        const params = Object.assign({}, this.identityBase(), o.token ? { 'X-Plex-Token': o.token } : {}, extra || {});
        let res;
        try {
          res = await fetch(this.buildUrl(base, path, params), { method: o.method || 'GET', headers: { Accept: 'application/json' }, signal: ctl.signal });
        } catch (cause) {
          throw fail(cause && cause.name === 'AbortError' ? 'timeout' : 'network', 'plex.tv');
        }
        if (res.status === 401 || res.status === 403) throw fail('auth', 'auth');
        if (!res.ok) throw fail('http', 'plex.tv said ' + res.status, { status: res.status });
        try { return await res.json(); } catch (cause) { throw fail('http', 'plex.tv sent something unexpected'); }
      } finally {
        clearTimeout(timer);
      }
    },

    /** Ask plex.tv for a short code. The user types it at plex.tv/link on their phone. */
    async startPin() {
      const d = await this.tvJson(this.authBase(), '/api/v2/pins', { strong: 'false' }, { method: 'POST' });
      return { id: d.id, code: String(d.code || ''), expires: Date.now() + (+d.expiresIn || 900) * 1000 };
    },
    /** Has the code been entered yet? Returns the account token once it has, otherwise ''. */
    async checkPin(pin) {
      const d = await this.tvJson(this.authBase(), '/api/v2/pins/' + encodeURIComponent(pin.id), { code: pin.code });
      return d.authToken || '';
    },
    async signedIn(token) {
      store.set('plex.acct', token);
      store.set('plex.auth', 'pin');
      ['plex.token', 'plex.srv', 'plex.conns', 'plex.srvid', 'plex.srvname', 'plex.server', 'plex.viaLink'].forEach((k) => store.del(k));
      this.accountToken = token; this.token = token; this.authMode = 'pin';
      this.server = ''; this.serverId = ''; this.serverName = ''; this.viaLink = false; this.connected = false;
      try {
        const u = await this.tvJson(this.authBase(), '/api/v2/user', {}, { token, ms: 6000 });
        this.userName = u.title || u.username || '';
        if (this.userName) store.set('plex.user', this.userName);
      } catch (e) { /* the name is only a nicety */ }
    },
    /** The old way: a token (and optionally an address) supplied by hand. */
    setManual(server, token) {
      ['plex.acct', 'plex.srv', 'plex.conns', 'plex.srvid', 'plex.srvname', 'plex.user'].forEach((k) => store.del(k));
      store.set('plex.token', token);
      store.set('plex.auth', 'manual');
      if (server) store.set('plex.server', server.replace(/\/+$/, '')); else store.del('plex.server');
      this.token = token; this.accountToken = token; this.authMode = 'manual';
      this.server = (server || cfg.serverUrl || '').replace(/\/+$/, '');
      this.serverId = ''; this.serverName = ''; this.userName = ''; this.connected = false;
    },
    signOut() {
      ['plex.token', 'plex.acct', 'plex.auth', 'plex.server', 'plex.srv', 'plex.conns', 'plex.srvid', 'plex.srvname', 'plex.user', 'plex.viaLink'].forEach((k) => store.del(k));
      try {
        Object.keys(window.localStorage).filter((k) => k.indexOf('plex.idx.') === 0).forEach((k) => window.localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
      this.token = ''; this.accountToken = ''; this.authMode = ''; this.server = (cfg.serverUrl || '').replace(/\/+$/, '');
      this.serverId = ''; this.serverName = ''; this.userName = ''; this.viaLink = false; this.connected = false; this.connType = '';
    },

    // ---------- finding your server, at home or away ----------
    /** The servers on this account, each with its addresses (home network, remote, relay), best first. */
    async discoverServers() {
      const extra = { includeHttps: 1, includeRelay: 1, includeIPv6: 1 };
      let d;
      try {
        d = await this.tvJson(this.resourcesBase(), '/api/v2/resources', extra, { token: this.accountToken });
      } catch (e) {
        if (e.kind === 'auth') throw e;
        d = await this.tvJson(this.authBase(), '/api/v2/resources', extra, { token: this.accountToken });
      }
      const arr = Array.isArray(d) ? d : ((d && d.MediaContainer && d.MediaContainer.Device) || []);
      return arr
        .filter((x) => String(x.provides || '').split(',').indexOf('server') >= 0)
        .map((x) => ({
          id: x.clientIdentifier,
          name: x.name || 'Plex server',
          owned: !!x.owned,
          token: x.accessToken || '',
          conns: (x.connections || [])
            .filter((c) => c.uri && okUri(c.uri) && !c.IPv6)
            .map((c) => ({ uri: String(c.uri).replace(/\/+$/, ''), type: c.relay ? 'relay' : c.local ? 'local' : 'remote' }))
            .filter((c, i, all) => all.findIndex((o) => o.uri === c.uri) === i)
            .sort((a, b) => PRI[a.type] - PRI[b.type]),
        }));
    },

    useServer(srv) {
      store.set('plex.srv', JSON.stringify({ id: srv.id, name: srv.name, token: srv.token }));
      store.set('plex.conns', JSON.stringify(srv.conns));
      store.set('plex.srvid', srv.id);
      store.set('plex.srvname', srv.name);
      this.serverId = srv.id; this.serverName = srv.name;
      this.token = srv.token || this.accountToken;
    },
    /** The user picked a server from the list. */
    chooseServer(srv) {
      this.useServer(srv);
      store.del('plex.server');
      this.server = '';
      this.connected = false;
    },

    knownCandidates() {
      const out = [];
      const cached = readJson('plex.conns') || [];
      const add = (uri, type) => {
        uri = String(uri || '').replace(/\/+$/, '');
        if (uri && okUri(uri) && !out.some((c) => c.uri === uri)) out.push({ uri, type: type || guessType(uri) });
      };
      add(this.server, (cached.find((c) => c.uri === this.server) || {}).type);
      cached.forEach((c) => add(c.uri, c.type));
      return out.map((c, i) => ({ c, i })).sort((a, b) => PRI[a.c.type] - PRI[b.c.type] || a.i - b.i).map((x) => x.c);
    },

    /** Is this address really our server? (Asks for its public identity.) */
    async checkAddress(c, expectedId) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_MS[c.type] || 5000);
      try {
        const res = await fetch(this.buildUrl(c.uri, '/identity', this.identity()), { headers: { Accept: 'application/json' }, signal: ctl.signal });
        if (!res.ok) return null;
        const id = (((await res.json()).MediaContainer) || {}).machineIdentifier || '';
        if (expectedId && id && id !== expectedId) return null;        // a different server answered
        return Object.assign({}, c, { machineId: id });
      } catch (e) {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Try all the addresses, home network first. The slower options start a moment later, so at home the
     * answer is instant and away from home we don't sit through a long wait on an address that can't work.
     * If a better address is still being tried when a worse one answers, we give it a short grace period.
     */
    race(cands, expectedId, say) {
      if (!cands.length) return Promise.resolve(null);
      return new Promise((resolve) => {
        const sorted = cands.slice().sort((a, b) => PRI[a.type] - PRI[b.type]);
        const state = sorted.map(() => 'wait');
        const found = {};
        let done = false;
        let grace = 0;
        const finish = (hit) => { if (done) return; done = true; clearTimeout(grace); resolve(hit); };
        const evaluate = () => {
          if (done) return;
          const best = state.indexOf('ok');
          if (best >= 0) {
            const higherPending = state.some((st, j) => j < best && (st === 'wait' || st === 'run'));
            if (!higherPending) { finish(found[best]); return; }
            if (!grace) grace = setTimeout(() => finish(found[state.indexOf('ok')]), 350);
            return;
          }
          if (state.every((st) => st === 'fail')) finish(null);
        };
        sorted.forEach((c, i) => {
          setTimeout(() => {
            if (done) return;
            state[i] = 'run';
            if (say) say('Trying ' + TYPE_LABEL[c.type] + '\u2026');
            this.checkAddress(c, expectedId).then((hit) => { if (hit) { state[i] = 'ok'; found[i] = hit; } else state[i] = 'fail'; evaluate(); });
          }, DELAY[c.type] || 0);
        });
      });
    },

    adopt(hit) {
      this.server = hit.uri;
      this.connType = hit.type;
      this.connected = true;
      if (hit.machineId) { this.serverId = hit.machineId; store.set('plex.srvid', hit.machineId); }
      store.set('plex.server', hit.uri);
    },

    /** Keep the list of addresses fresh for next time (home, remote and relay can change). Never blocks anything. */
    refreshServers() {
      if (!this.accountToken) return;
      this.discoverServers().then((list) => {
        const s = list.find((x) => x.id === this.serverId);
        if (!s) return;
        store.set('plex.conns', JSON.stringify(s.conns));
        if (s.name) { this.serverName = s.name; store.set('plex.srvname', s.name); }
        if (this.authMode === 'pin' && s.token) store.set('plex.srv', JSON.stringify({ id: s.id, name: s.name, token: s.token }));
      }).catch(() => {});
    },

    /**
     * Get connected. Uses the last address that worked (and any others we know), and only if none of those answer
     * asks plex.tv where the server is now. Throws kind: unreachable | noserver | choose (several servers) | auth.
     */
    async connect(onStatus) {
      const say = (t) => { if (onStatus) onStatus(t); };
      this.connected = false;
      this.connType = '';
      const srv = readJson('plex.srv');
      const wantId = (srv && srv.id) || this.serverId || '';
      const known = this.knownCandidates();
      if (known.length) {
        say('Connecting\u2026');
        const hit = await this.race(known, wantId, say);
        if (hit) { this.adopt(hit); this.refreshServers(); return hit; }
      }
      if (!this.accountToken) throw fail('unreachable', 'unreachable', { tried: known.map((c) => c.type) });

      say('Looking for your server\u2026');
      const servers = await this.discoverServers();
      let chosen = wantId ? servers.find((x) => x.id === wantId) : null;
      if (!chosen) {
        if (servers.length === 1) chosen = servers[0];
        else if (!servers.length) throw fail('noserver', 'noserver');
        else throw fail('choose', 'choose', { servers });
      }
      this.useServer(chosen);
      const hit = await this.race(chosen.conns, chosen.id, say);
      if (!hit) throw fail('unreachable', 'unreachable', { tried: chosen.conns.map((c) => c.type) });
      this.adopt(hit);
      return hit;
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

      const ck = 'plex.idx.' + (this.serverId || this.server) + '|' + id;
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
    /** Movies that are part-way through, most recently watched first. */
    async continueWatching(sectionId, n) {
      const mc = await this.json('/library/sections/' + encodeURIComponent(sectionId) + '/all', Object.assign({
        inProgress: 1, sort: 'lastViewedAt:desc', 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 60,
      }, TRIM));
      // (if a server ignores the inProgress filter, the check here still keeps only films that really are part-way)
      return (mc.Metadata || []).filter((m) => m.viewOffset > 0 && (!m.duration || m.viewOffset < m.duration * 0.95)).slice(0, n || 10);
    },
    async recentlyAdded(sectionId, n) {
      const size = n || 10;
      const mc = await this.json('/library/sections/' + encodeURIComponent(sectionId) + '/recentlyAdded', Object.assign({
        'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size,
      }, TRIM));
      return (mc.Metadata || []).slice(0, size);
    },
    collections(sectionId) {
      return this.pages('/library/sections/' + encodeURIComponent(sectionId) + '/collections', TRIM, { size: 300 });
    },
    collectionItems(id) {
      return this.pages('/library/collections/' + encodeURIComponent(id) + '/children', TRIM, { size: 300 });
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
