/*
 * Automatic backup of the app's saved data to a private GitHub gist in the user's own account.
 *
 * Why: a glasses software update can wipe a web app's saved data (the Plex sign-in, settings...).
 * With a backup the app restores itself on the next launch and nobody has to sign in again.
 *
 * How it is switched on: add  ?sync=YOUR_GITHUB_KEY  to the app's address (in the Meta AI app).
 * The key lives ONLY in that address: never in this code or the repository, and it is never stored on the device.
 * (A classic GitHub token that has only the "gist" permission is enough.)
 *
 * What is saved: the Plex sign-in, the chosen server and addresses, and preferences (remembered video quality,
 * last letter chosen per library). Not saved: library lists (they can be downloaded again) and diagnostics logs.
 *
 * It is encrypted before it leaves the glasses: PBKDF2-SHA256 (150,000 rounds, random salt) turns the key into an
 * AES-GCM-256 key; the gist only ever contains {app, v, savedAt, salt, iv, data}.
 */
(function () {
  'use strict';

  const cfg = window.PLEX_CONFIG || {};
  const APP = 'gladeyes';
  const FILE = APP + '-backup.json';
  const DESCRIPTION = 'GladEyes backup (encrypted)';
  const API = (cfg.githubApi || 'https://api.github.com').replace(/\/+$/, '');
  const ROUNDS = 150000;
  const GIST_ID_KEY = APP + '.gistId';       // (not under "plex.", so it is never part of the backup itself)
  const SYNCED_KEY = APP + '.syncedAt';

  // The key comes from the address. Read it now, before anything tidies the address bar.
  function readKey() {
    const pick = (s) => { try { return new URLSearchParams(s).get('sync') || ''; } catch (e) { return ''; } };
    return pick(location.search.replace(/^\?/, '')) || pick(location.hash.replace(/^#\??/, ''));
  }
  const KEY = readKey();

  const SKIP = /^plex\.(idx\.|log)/;                                               // library lists and logs are not backed up
  const IMPORTANT = /^plex\.(token|acct|auth|srv|srvid|srvname|user|clientId|viaLink)$/;   // saved within seconds

  let status = KEY ? 'idle' : 'off';
  let lastOk = 0;
  let blocked = false;          // a backup made with a different key exists: never overwrite it
  let checkedRemote = false;    // have we confirmed (this session) that we can read what is in the gist?
  let gistId = null;
  let lastSnap = '';
  let lastKeys = {};
  let dirty = false;
  let timer = 0;
  let dueAt = 0;
  let lastPush = 0;
  let inflight = null;
  let restoredAtBoot = false;
  let attempted = false;        // did we already look in the gist at launch?

  const api = { enabled: !!KEY, onStatus: null, onToast: null };

  // ---------- local data ----------
  function ls(fn, fallback) { try { return fn(window.localStorage); } catch (e) { return fallback; } }
  function collect() {
    const out = {};
    ls((s) => {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.indexOf('plex.') === 0 && !SKIP.test(k)) out[k] = s.getItem(k);
      }
    });
    return out;
  }
  const snap = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  function apply(keys) {
    ls((s) => {
      Object.keys(collect()).forEach((k) => s.removeItem(k));
      Object.keys(keys || {}).forEach((k) => { if (k.indexOf('plex.') === 0 && !SKIP.test(k)) s.setItem(k, keys[k]); });
    });
  }
  const hasLocal = () => !!ls((s) => s.getItem('plex.token') || s.getItem('plex.acct'), false);
  const synced = () => +ls((s) => s.getItem(SYNCED_KEY), 0) || 0;
  const markSynced = (t) => ls((s) => s.setItem(SYNCED_KEY, String(t)));

  // ---------- status ----------
  function setStatus(s) {
    status = s;
    if (s === 'ok') lastOk = Date.now();
    if (api.onStatus) { try { api.onStatus(api.describe()); } catch (e) { /* ignore */ } }
  }
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }
  api.describe = function () {
    switch (status) {
      case 'off': return '';
      case 'ok': return 'Backed up to GitHub \u00B7 ' + ago(lastOk);
      case 'saving': return 'Backing up\u2026';
      case 'restoring': return 'Restoring your backup\u2026';
      case 'offline': return 'Backup: waiting for a connection';
      case 'badkey': return 'Backup: key not accepted';
      case 'wrongkey': return 'Backup: made with a different key';
      case 'error': return 'Backup: GitHub had a problem, will try again';
      default: return 'Backup: on';
    }
  };
  const toast = (t) => { if (api.onToast) { try { api.onToast(t); } catch (e) { /* ignore */ } } };

  // ---------- encryption ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  let keyCache = null;          // the derived key for one salt, so we don't spend 150,000 rounds on every save

  async function deriveKey(salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(KEY), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ROUNDS, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(payload) {
    if (!keyCache) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      keyCache = { salt: b64(salt), key: await deriveKey(salt) };
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyCache.key, enc.encode(JSON.stringify(payload)));
    return { app: APP, v: 1, savedAt: payload.savedAt, salt: keyCache.salt, iv: b64(iv), data: b64(ct) };
  }
  async function decrypt(file) {
    const key = keyCache && keyCache.salt === file.salt ? keyCache.key : await deriveKey(unb64(file.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, key, unb64(file.data));
    keyCache = { salt: file.salt, key };      // same salt next time: no need to derive again
    return JSON.parse(dec.decode(plain));
  }

  // ---------- GitHub ----------
  function problem(kind, message) { const e = new Error(message || kind); e.kind = kind; return e; }

  async function gh(method, path, body, keepalive) {
    const ctl = new AbortController();
    const timer2 = setTimeout(() => ctl.abort(), 15000);
    try {
      const headers = { Authorization: 'Bearer ' + KEY, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (body) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal, keepalive: !!keepalive });
      } catch (cause) {
        throw problem('offline');
      }
      if (res.status === 401) throw problem('badkey');
      if (res.status === 403 || res.status === 429) throw problem('error', 'GitHub is limiting requests or the key lacks the gist permission');
      if (res.status === 404) throw problem('missing');
      if (!res.ok) throw problem('error', 'GitHub said ' + res.status);
      try { return await res.json(); } catch (e) { throw problem('error'); }
    } finally {
      clearTimeout(timer2);
    }
  }

  /** Our gist: the one remembered on this device if it still exists, otherwise search the account by file name. */
  async function readRemote() {
    const remembered = ls((s) => s.getItem(GIST_ID_KEY), null);
    const open = async (id) => {
      const g = await gh('GET', '/gists/' + encodeURIComponent(id));
      const f = g.files && g.files[FILE];
      if (!f) return null;
      if (f.truncated) throw problem('error', 'backup too large to read');
      let env = null;
      try { env = JSON.parse(f.content); } catch (e) { env = null; }
      return { id: g.id, env };
    };
    if (remembered) {
      try { const r = await open(remembered); if (r) return r; } catch (e) { if (e.kind !== 'missing') throw e; }
      ls((s) => s.removeItem(GIST_ID_KEY));
    }
    for (let page = 1; page <= 10; page++) {
      const list = await gh('GET', '/gists?per_page=100&page=' + page);
      if (!Array.isArray(list) || !list.length) break;
      const hit = list.find((g) => g.files && g.files[FILE]);
      if (hit) { const r = await open(hit.id); if (r) { ls((s) => s.setItem(GIST_ID_KEY, r.id)); return r; } }
      if (list.length < 100) break;
    }
    return null;
  }

  // ---------- saving ----------
  async function save(keepalive) {
    if (!KEY || blocked) return;
    setStatus('saving');
    try {
      if (!checkedRemote) {
        // Before the first overwrite of a session, make sure we aren't about to replace a backup made with another key.
        const r = await readRemote();
        if (r && r.env) {
          try { await decrypt(r.env); } catch (e) { blocked = true; setStatus('wrongkey'); return; }
        }
        gistId = r ? r.id : null;
        checkedRemote = true;
      }
      dirty = false;
      const keys = collect();
      const payload = { savedAt: Date.now(), keys };
      const content = JSON.stringify(await encrypt(payload));
      if (!gistId) {
        const g = await gh('POST', '/gists', { description: DESCRIPTION, public: false, files: { [FILE]: { content } } }, keepalive);
        gistId = g.id;
        ls((s) => s.setItem(GIST_ID_KEY, gistId));
      } else {
        try {
          await gh('PATCH', '/gists/' + encodeURIComponent(gistId), { files: { [FILE]: { content } } }, keepalive);
        } catch (e) {
          if (e.kind !== 'missing') throw e;
          gistId = null;                                  // the gist was deleted: make a new one next time
          ls((s) => s.removeItem(GIST_ID_KEY));
          dirty = true; plan(3000);
          return;
        }
      }
      lastSnap = snap(keys);
      lastKeys = keys;
      lastPush = Date.now();
      markSynced(payload.savedAt);
      setStatus('ok');
      if (dirty) plan(3000);                              // something changed while we were saving
    } catch (e) {
      dirty = true;
      setStatus(e.kind === 'badkey' ? 'badkey' : e.kind === 'offline' ? 'offline' : 'error');
      if (e.kind === 'offline' || e.kind === 'error') plan(30000);   // try again later
    }
  }
  function run(keepalive) {
    if (inflight) return inflight.then(() => (dirty ? run(keepalive) : undefined));
    inflight = save(keepalive).finally(() => { inflight = null; });
    return inflight;
  }

  /** Something may have changed: save soon (important things) or at most once a minute (the rest). */
  function plan(delay) {
    if (!KEY || blocked || status === 'badkey') return;
    const now = Date.now();
    const when = delay >= 60000 ? Math.max(lastPush + delay, now + 3000) : now + delay;
    if (timer && dueAt <= when) return;
    clearTimeout(timer);
    dueAt = when;
    timer = setTimeout(() => { timer = 0; dueAt = 0; if (dirty) run(); }, Math.max(0, when - now));
  }

  /** Called by the app whenever it writes or deletes a saved value. */
  api.noted = function (key) {
    if (!KEY || blocked || typeof key !== 'string' || key.indexOf('plex.') !== 0 || SKIP.test(key)) return;
    const keys = collect();
    if (snap(keys) === lastSnap) return;                  // nothing really changed (e.g. the same value written again)
    const important = Object.keys(keys).concat(Object.keys(lastKeys)).some((k) => IMPORTANT.test(k) && keys[k] !== lastKeys[k]);
    dirty = true;
    plan(important ? 3000 : 60000);
  };

  /** Save right now (leaving the app, signing out, or "Back up now"). */
  api.flush = function () {
    if (!KEY || blocked) return Promise.resolve();
    clearTimeout(timer); timer = 0; dueAt = 0;
    dirty = true;
    return run(true);
  };

  // ---------- restoring ----------
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(problem('offline')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

  api.hasLocal = hasLocal;

  /** At launch, before anything else: if this device has lost its data, bring it back from the backup. */
  api.restoreIfEmpty = async function (ms) {
    if (!KEY) return 'off';
    if (hasLocal()) return 'have';
    attempted = true;
    setStatus('restoring');
    try {
      const r = await withTimeout(readRemote(), ms || 10000);
      checkedRemote = true;
      if (!r || !r.env) { gistId = r ? r.id : null; setStatus('idle'); return 'none'; }
      let payload;
      try { payload = await decrypt(r.env); } catch (e) { blocked = true; setStatus('wrongkey'); return 'wrongkey'; }
      apply(payload.keys);
      gistId = r.id;
      lastKeys = payload.keys || {};
      lastSnap = snap(lastKeys);
      markSynced(payload.savedAt || Date.now());
      restoredAtBoot = true;
      setStatus('ok');
      return 'restored';
    } catch (e) {
      setStatus(e.kind === 'badkey' ? 'badkey' : e.kind === 'offline' ? 'offline' : 'error');
      return e.kind || 'error';
    }
  };

  /**
   * After launch, when this device still has its data: make sure the backup exists and is in step. If another device
   * saved something newer (its savedAt is later than our last sync), take it and restart so it takes effect.
   */
  api.afterBoot = async function () {
    if (!KEY || restoredAtBoot || attempted) return;
    try {
      const r = await readRemote();
      if (!r || !r.env) { gistId = r ? r.id : null; checkedRemote = true; dirty = true; plan(3000); return; }
      let payload;
      try { payload = await decrypt(r.env); } catch (e) { blocked = true; setStatus('wrongkey'); return; }
      gistId = r.id;
      checkedRemote = true;
      const mine = synced();
      if (mine && payload.savedAt > mine + 1000) {
        apply(payload.keys);
        markSynced(payload.savedAt);
        toast('Restored newer settings from your backup. Restarting\u2026');
        setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, 1500);
        return;
      }
      lastKeys = payload.keys || {};
      lastSnap = snap(lastKeys);
      if (!mine) markSynced(payload.savedAt || Date.now());
      setStatus('ok');
      lastOk = payload.savedAt || Date.now();
      if (snap(collect()) !== lastSnap) { dirty = true; plan(3000); }
    } catch (e) {
      setStatus(e.kind === 'badkey' ? 'badkey' : e.kind === 'offline' ? 'offline' : 'error');
      if (e.kind === 'offline' || e.kind === 'error') { dirty = true; plan(30000); }
    }
  };

  // ---------- when to save ----------
  document.addEventListener('visibilitychange', () => {
    if (!KEY || blocked) return;
    if (document.visibilityState === 'hidden' && dirty) api.flush();
    else if (document.visibilityState === 'visible' && (status === 'offline' || status === 'error')) { dirty = true; plan(3000); }
  });
  window.addEventListener('pagehide', () => { if (KEY && !blocked && dirty) api.flush(); });
  window.addEventListener('online', () => { if (KEY && !blocked && status !== 'badkey') { dirty = true; plan(1500); } });

  window.Backup = api;
})();
