/*
 * GladEyes: screens, navigation and playback. Vanilla JS, no build step.
 *
 * Input model (per the Meta Ray-Ban Display web-app docs): the glasses' browser does the
 * directional focus movement between native <button>s and Enter activates them (a normal
 * click). We do NOT run our own focus manager. The only key handling here is the narrow
 * "edge" rule: moving UP off the first row, or LEFT past the edge, lands on the Back button.
 *
 * Navigation uses real browser history (pushState/popstate), so the glasses' system Back
 * gesture and the on-screen Back button do exactly the same thing: history.back().
 * The host allows at most 5 history entries, and the deepest path here is exactly 5:
 * Libraries > Library > Show > Season > Player.
 */
(function () {
  'use strict';

  const APP_NAME = 'GladEyes';
  const VERSION = '11';
  const cfg = window.PLEX_CONFIG || {};
  const pb = Object.assign({
    strategy: 'auto', hlsEngine: 'auto', container: 'mp4', maxVideoBitrate: 600,
    forceTranscode: true, seekStepSeconds: 15, controlsHideMs: 6000, startTimeoutSeconds: 45, hlsJsUrl: '',
    rebufferSeconds: 10, rebufferMaxSeconds: 25, autoLowerQuality: true,
    relayBitrate: 400,
    rememberQuality: true, autoRaiseQuality: true, autoRaiseUpToKbps: 1200, raiseAfterSeconds: 150, raiseBufferSeconds: 4,
  }, cfg.playback || {});
  const STEP = pb.seekStepSeconds;
  const MAX_INDEX = 4;     // host keeps at most 5 history entries (indexes 0..4)
  const FLAT_MAX = 80;     // libraries this small are one plain list; bigger ones get the A-Z strip
  const PAGE = 100;        // rows drawn at a time inside one letter

  // ---------- helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => {
      const v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach((kid) => {
      if (kid == null || kid === false) return;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    });
    return n;
  }

  const ICONS = {
    // rounded play triangle and pause bars (stroke + round joins gives soft corners)
    play: '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false"><path d="M8.6 5.6v12.8l10.2-6.4z" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false"><rect x="6" y="4.5" width="4.6" height="15" rx="1.8" fill="currentColor"/><rect x="13.4" y="4.5" width="4.6" height="15" rx="1.8" fill="currentColor"/></svg>',
  };
  function icon(name) {
    const s = document.createElement('span');
    s.className = 'ico';
    s.innerHTML = ICONS[name]; // static, trusted strings only
    return s;
  }

  const fmtTime = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return hh ? hh + ':' + p(mm) + ':' + p(ss) : mm + ':' + p(ss);
  };
  const fmtDur = (ms) => {
    const m = Math.round((ms || 0) / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
  };
  const num = (n) => Number(n).toLocaleString();

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const rowKey = (r) => String(r.s || r.t || '').trim();
  const rowCmp = (a, b) => collator.compare(rowKey(a), rowKey(b));

  // ---------- diagnostics log (kept on the device, so a problem can be looked at after a restart) ----------
  const Log = (function () {
    const KEY = 'plex.log';
    const KEPT = 'plex.log.kept';
    const t0 = Date.now();
    let buf = [];
    let dirty = false;
    const read = (k) => { try { return JSON.parse(window.localStorage.getItem(k) || '[]'); } catch (e) { return []; } };
    const write = (k, v) => { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
    // The session before this one. If it was too short to be interesting, keep showing the last meaningful one.
    const before = read(KEY);
    let last = before.length >= 6 ? before : read(KEPT);
    if (before.length >= 6) write(KEPT, before);
    function add(msg) {
      buf.push(((Date.now() - t0) / 1000).toFixed(1) + 's ' + String(msg).slice(0, 100));
      if (buf.length > 80) buf.shift();
      dirty = true;
    }
    function flush() { if (dirty) { dirty = false; write(KEY, buf); } }
    setInterval(flush, 1500);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('error', (e) => add('ERROR ' + (e.message || '?') + (e.lineno ? ' @' + e.lineno : '')));
    window.addEventListener('unhandledrejection', (e) => add('REJECTED ' + ((e.reason && e.reason.message) || e.reason)));
    function clear() { buf = []; last = []; dirty = false; write(KEY, []); write(KEPT, []); }
    return { add, flush, clear, last: () => last, now: () => buf.slice() };
  })();

  // The encrypted GitHub backup (js/backup.js). Switched on by ?sync=KEY in the app's address.
  const Backup = window.Backup || {
    enabled: false, hasLocal() { return true; }, noted() {}, flush() { return Promise.resolve(); },
    describe() { return ''; }, restoreIfEmpty() { return Promise.resolve('off'); }, afterBoot() {},
  };

  // ---------- elements ----------
  const screenEl = $('#screen');
  const topbar = $('#topbar');
  const backBtn = $('#back');
  const titleEl = $('#title');
  const playerEl = $('#player');
  const video = $('#video');
  const surface = $('#surface');
  const loadingEl = $('#loading');
  const loadMsg = $('#loadmsg');
  const ctrl = $('#ctrl');
  const perr = $('#perr');
  const perrMsg = $('#perr-msg');
  const ptitle = $('#ptitle');
  const ptime = $('#ptime');
  const fill = $('#fill');
  const bRew = $('#b-rew');
  const bPlay = $('#b-play');
  const bFwd = $('#b-fwd');
  const bExit = $('#b-exit');
  const railEl = $('#rail');
  const rUp = $('#r-up');
  const rDown = $('#r-down');
  const toastEl = $('#toast');
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 5500);
  }
  Backup.onToast = toast;
  Backup.onStatus = (text) => {      // keep any visible backup line up to date
    const a = document.getElementById('backup-note');
    const b = document.getElementById('st-backup');
    if (a) a.textContent = text;
    if (b) b.textContent = text;
  };
  const brand = $('#brand');
  const pstat = $('#pstat');

  bRew.textContent = '\u2212' + STEP + 's';
  bFwd.textContent = '+' + STEP + 's';

  // ---------- state ----------
  const ROOT = { screen: 'libraries', d: 0, nid: 'root' };
  let current = null;
  let renderSeq = 0;
  let creds = { ok: false };
  const focusMemory = new Map();
  const lastLetter = new Map();
  let libCtx = null;            // the A-Z screen that is showing (for left/right letter stepping)
  let signTimers = [];
  let connecting = null;
  const NEEDS_SERVER = new Set(['moviemenu', 'continue', 'recent', 'collections', 'collection', 'library', 'movie', 'episode', 'show', 'season', 'player']);
  const progressMemory = new Map();   // what we last saw of each title's watch position (the server may be a moment behind)
  const cache = { libs: null, items: new Map(), meta: new Map(), kids: new Map() };

  function cached(map, key, load) {
    if (!map.has(key)) map.set(key, load().catch((e) => { map.delete(key); throw e; }));
    return map.get(key);
  }
  const stateKey = (s) => [s.screen, s.lib || '', s.id || ''].join('|');

  // ---------- navigation ----------
  // Real browser history (so the glasses' Back gesture works), plus each screen remembers its own way back (`up`),
  // so the on-screen Back / Exit never depend on the browser's history behaving.
  let idSeq = 0;
  const newId = () => Date.now().toString(36) + '.' + (++idSeq);
  const unsynced = new Set();   // screens the browser has no history entry for
  const chain = (st, n) => (!st || n <= 0 ? null : Object.assign({}, st, { up: chain(st.up, n - 1) }));

  function navigate(next) {
    next.nid = newId();                     // (navigation id; `id` is the movie/show/episode itself)
    next.up = chain(current, 4);
    let synced = false;
    try {
      if (current.d >= MAX_INDEX) {
        // Would exceed the host's 5-entry limit: replace instead of pushing.
        next.d = current.d;
        history.replaceState(next, '');
      } else {
        next.d = current.d + 1;
        history.pushState(next, '');
        synced = !!(history.state && history.state.nid === next.nid);   // did the host actually keep the new entry?
      }
    } catch (e) { Log.add('history error ' + (e && e.name)); }
    if (!synced) unsynced.add(next.nid);
    Log.add('open ' + next.screen + (synced ? '' : ' (no history entry)') + ' hl=' + history.length);
    render(next);
  }

  /** Go up one screen. Used by the Back button and the player's Exit. */
  function goBack(source) {
    const cur = current;
    const up = cur.up || (cur.screen === 'libraries' ? null : ROOT);
    Log.add(source + ' from ' + cur.screen);
    if (!up) { history.back(); return; }                     // already at the top: let the system take over
    if (unsynced.has(cur.nid)) { leaveInternally(cur, up); return; }
    history.back();
    // If the browser doesn't act on it, don't leave you stuck.
    setTimeout(() => {
      if (current === cur) { Log.add('history.back did nothing; leaving anyway'); leaveInternally(cur, up); }
    }, 700);
  }
  function leaveInternally(cur, up) {
    try { history.replaceState(up, ''); } catch (e) { /* ignore */ }
    render(up);
  }

  /** Back to the Libraries screen as the new top of the stack (after signing in/out, choosing a server...). */
  function goHome() {
    try { history.replaceState(ROOT, ''); } catch (e) { /* ignore */ }
    render(ROOT);
  }
  function resetCaches() {
    cache.libs = null; cache.items.clear(); cache.meta.clear(); cache.kids.clear();
    focusMemory.clear(); lastLetter.clear();
  }
  function clearSignTimers() { signTimers.forEach((t) => { clearTimeout(t); clearInterval(t); }); signTimers = []; }

  /** Make sure we're connected to the server (finding it through Plex if the saved address no longer works). */
  function ensureReady() {
    if (Plex.connected) return Promise.resolve();
    if (!Plex.hasCredentials()) return Promise.reject(failure('needsignin'));
    if (!connecting) {
      Log.add('connecting');
      connecting = Plex.connect((t) => { const el = $('#loadtext'); if (el) el.textContent = t; })
        .then((hit) => { Log.add('connected via ' + hit.type); return hit; })
        .finally(() => { connecting = null; });
    }
    return connecting;
  }

  window.addEventListener('popstate', (e) => {
    let st = e.state;
    if (!st || !st.screen) st = ROOT;
    else if (st.screen === 'player') st = st.up || ROOT;      // nothing to resume: go to the movie's page instead
    Log.add('system back to ' + st.screen + ' hl=' + history.length);
    render(st);
  });

  backBtn.addEventListener('click', () => goBack('back button'));

  // ---------- focus ----------
  // Track the last-focused row as it changes, so moving to Back and pressing Down returns to it.
  screenEl.addEventListener('focusin', (e) => {
    const t = e.target;
    if (current && t && t.dataset && t.dataset.key) focusMemory.set(stateKey(current), t.dataset.key);
  });

  function focusInitial() {
    const remembered = focusMemory.get(stateKey(current));
    let target = null;
    if (remembered) {
      target = Array.prototype.find.call(screenEl.querySelectorAll('[data-key]'), (n) => n.dataset.key === remembered);
    }
    target = target || $('[data-autofocus]', screenEl) || $('.item', screenEl) || $('button, [tabindex="0"]', screenEl) || backBtn;
    target.focus();
  }

  function visible(el) { return !el.hidden && el.getClientRects().length > 0; }

  function scopeEl() { return document.body.classList.contains('mode-player') ? playerEl : screenEl; }

  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll('button:not([disabled]), [tabindex="0"]'), visible);
  }

  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);

  /** True if nothing focusable lies further left (or above) than el, so the next press should go to Back. */
  function isEdge(el, key) {
    if (el.classList.contains('item')) {
      if (key === 'ArrowLeft') return true; // list rows span the full width
      const li = el.closest('li');
      return !!li && li.previousElementSibling === null;
    }
    const r = el.getBoundingClientRect();
    return !focusables(scopeEl()).some((o) => {
      if (o === el) return false;
      const q = o.getBoundingClientRect();
      return key === 'ArrowLeft'
        ? q.right <= r.left + 2 && overlap(q.top, q.bottom, r.top, r.bottom) > 0
        : q.bottom <= r.top + 2 && overlap(q.left, q.right, r.left, r.right) > 0;
    });
  }

  function focusPrimary() {
    if (document.body.classList.contains('mode-player')) { bPlay.focus(); return; }
    focusInitial();
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (topbar.hidden) return;
    const a = document.activeElement;
    if (railEl.contains(a)) {                                   // on the page rail
      if (e.key === 'ArrowUp') { e.preventDefault(); rUp.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); rDown.focus(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); focusFirstVisibleRow(); }
      else if (e.key === 'ArrowRight' && libCtx) { e.preventDefault(); stepLetter(1); }
      return;
    }
    if (a === backBtn) {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusPrimary(); }
      return;
    }
    if (!a || !scopeEl().contains(a)) return;

    // Library screen with the A-Z strip: strip sits between Back and the list.
    const strip = screenEl.hidden ? null : $('#letters', screenEl);
    if (strip && libCtx && libCtx.strip === strip) {
      // Right / Left from the list (or the strip) step to the next / previous letter, with focus on that letter.
      const onLib = a.classList.contains('item') || a.classList.contains('chip');
      // (when the page rail is showing, Right from a title goes to the rail first; Right again steps to the next letter)
      if (onLib && e.key === 'ArrowRight' && !(a.classList.contains('item') && railVisible())) { e.preventDefault(); stepLetter(1); return; }
      if (onLib && e.key === 'ArrowLeft' && letterIndex() > 0) { e.preventDefault(); stepLetter(-1); return; }
      // (on the first letter, Left falls through to the Back-button rule below)
    }
    if (strip) {
      if (e.key === 'ArrowDown' && a.classList.contains('chip')) {
        const first = $('#rows .item', screenEl);
        if (first) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === 'ArrowUp' && a.classList.contains('item')) {
        const li = a.closest('li');
        if (li && li.previousElementSibling === null) {
          e.preventDefault();
          ($('[aria-current="true"]', strip) || strip.firstElementChild).focus();
          return;
        }
      }
    }

    if (e.key === 'ArrowRight' && a.classList.contains('item') && railVisible()) { e.preventDefault(); rDown.focus(); return; }

    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    if (!isEdge(a, e.key)) return;
    e.preventDefault();
    backBtn.focus();
  });

  // ---------- page up / page down rail ----------
  // Shown when a list is longer than about a screen. Right from a title moves onto it; Up / Down choose a button,
  // Select pages the list by a screenful; Left goes back to the titles; Right (on a letter list) steps to the next letter.
  const railVisible = () => !railEl.hidden;
  function updateRail() {
    const rows = screenEl.hidden ? 0 : screenEl.querySelectorAll('.list > li').length;
    const show = rows >= 7 && !topbar.hidden && !document.body.classList.contains('mode-player');
    railEl.hidden = !show;
    screenEl.classList.toggle('rail-room', show);
    if (show) {
      const strip = $('#letters', screenEl);
      const top = (strip ? strip.getBoundingClientRect().bottom : screenEl.getBoundingClientRect().top) + 6;
      railEl.style.insetBlockStart = Math.round(top) + 'px';
    }
  }
  new MutationObserver(() => requestAnimationFrame(updateRail)).observe(screenEl, { childList: true, subtree: true });

  function pageBy(dir) {
    const strip = $('#letters', screenEl);
    const stripH = strip ? strip.getBoundingClientRect().height : 0;
    const view = Math.max(120, screenEl.clientHeight - stripH - 30);
    const atBottom = screenEl.scrollTop + screenEl.clientHeight >= screenEl.scrollHeight - 4;
    if (dir > 0 && atBottom && libCtx && libCtx.rowsHost._more) libCtx.rowsHost._more();     // reveal the next hundred titles
    screenEl.scrollBy({ top: dir * view, behavior: 'auto' });
  }
  rUp.addEventListener('click', () => pageBy(-1));
  rDown.addEventListener('click', () => pageBy(1));
  function focusFirstVisibleRow() {
    const top = ($('#letters', screenEl) || screenEl).getBoundingClientRect().bottom;
    const rows = Array.prototype.slice.call(screenEl.querySelectorAll('.item'));
    const row = rows.find((r) => r.getBoundingClientRect().top >= top - 4) || rows[rows.length - 1];
    if (row) row.focus();
  }

  // ---------- generic screen bits ----------
  function setTitle(text, showInBar) {
    titleEl.textContent = showInBar === false ? '' : text;
    document.title = text || APP_NAME;
  }

  function showLoading(text) {
    screenEl.replaceChildren(h('div', { class: 'status', role: 'status' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { id: 'loadtext' }, text || 'Loading\u2026')));
  }

  function makeItem(o) {
    const b = h('button', { class: 'item', type: 'button', 'data-key': o.key },
      h('span', { class: 'item-text' },
        h('span', { class: 'item-label' }, o.label),
        o.sub ? h('span', { class: 'item-sub' }, o.sub) : null),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '\u203A'));
    b.addEventListener('click', o.onSelect);
    return b;
  }

  function showList(rows, emptyText) {
    if (!rows.length) {
      screenEl.replaceChildren(h('div', { class: 'status' }, emptyText || 'Nothing here.'));
      return;
    }
    const ul = h('ul', { class: 'list' });
    rows.forEach((r) => ul.append(h('li', {}, makeItem(r))));
    screenEl.replaceChildren(ul);
    screenEl.scrollTop = 0;
  }

  function failure(kind, message, extra) {
    const e = new Error(message || kind);
    e.kind = kind;
    Object.assign(e, extra || {});
    return e;
  }

  function showFailure(e) {
    let title = 'Something went wrong';
    let msg = e && e.message ? e.message : 'Unexpected error.';
    let detail = '';
    const host = (function () { try { return new URL(Plex.server).host; } catch (x) { return Plex.server; } })();
    const buttons = [{ label: 'Try again', primary: true, run: () => render(current) }];
    const settings = { label: 'Settings', run: () => navigate({ screen: 'settings' }) };
    const signInAgain = { label: 'Sign in again', primary: true, run: () => { Plex.signOut(); Backup.flush(); resetCaches(); goHome(); } };
    if (e && e.kind === 'auth') {
      title = 'Plex rejected the sign-in';
      msg = 'Your saved sign-in is no longer valid.';
      detail = Plex.viaLink ? 'You opened the app from a link that contains a token. Replace it with a fresh one (README, step 3), or use a link without a token and sign in with a code.' : '';
      buttons.splice(0, 1, signInAgain);
    } else if (e && e.kind === 'unreachable') {
      const tried = (e.tried || []).map((t) => ({ local: 'home network', remote: 'remote', relay: 'relay' }[t] || t));
      title = 'Can\u2019t reach your Plex server';
      msg = tried.length ? 'Tried: ' + tried.join(', ') + '.' : 'No address worked.';
      detail = 'Check the server is on. Away from home it also needs Remote Access turned on (Plex > Settings > Remote Access), or Plex\u2019s relay to be available.';
      buttons.push(settings);
    } else if (e && e.kind === 'noserver') {
      title = 'No Plex server found';
      msg = 'Your Plex account doesn\u2019t have a Plex Media Server that this app can use.';
      detail = 'Check you signed in with the right account, and that the server is signed in to it.';
      buttons.push({ label: 'Sign out', run: () => { Plex.signOut(); Backup.flush(); resetCaches(); goHome(); } });
    } else if (e && (e.kind === 'network' || e.kind === 'timeout')) {
      title = e.kind === 'timeout' ? 'Your Plex server isn\u2019t answering' : 'Can\u2019t reach your Plex server';
      msg = 'Server: ' + host;
      detail = e.kind === 'timeout' ? 'It took too long to reply. Check the server is awake and the connection is good, then try again.'
        : 'The glasses (via your phone) must be able to reach that address, and the server must allow browser requests (CORS).';
      buttons.push(settings);
    } else if (e && e.kind === 'libs') {
      title = 'No movie or TV libraries';
      msg = 'This server has no movie or TV show libraries this app can play.';
      detail = 'Libraries on the server: ' + ((e.available || []).join(', ') || 'none') + '.';
    }
    screenEl.replaceChildren(h('div', { class: 'panel', role: 'alert' },
      h('h2', {}, title), h('p', {}, msg), detail ? h('p', { class: 'small' }, detail) : null,
      buttons.map((b, i) => h('button', { class: 'btn' + (b.primary ? ' btn-primary' : ''), type: 'button', 'data-autofocus': i === 0 ? '' : false, onclick: b.run }, b.label))));
    focusInitial();
  }

  // ---------- render ----------
  async function render(state) {
    const prev = current;
    current = state;
    const seq = ++renderSeq;
    libCtx = null;
    railEl.hidden = true;
    clearSignTimers();

    const isPlayer = state.screen === 'player';
    const leavingPlayer = !!prev && prev.screen === 'player' && !(isPlayer && state.id === prev.id);
    document.body.classList.toggle('mode-player', isPlayer);
    screenEl.hidden = isPlayer;
    playerEl.hidden = !isPlayer;
    topbar.hidden = isPlayer;
    brand.toggleAttribute('hidden', state.screen !== 'libraries');   // (SVG elements have no .hidden property, so use the attribute)
    // Screen first, then stop the video: whatever goes wrong while stopping can no longer trap you on the player.
    if (leavingPlayer) { try { detachPlayer(); } catch (e) { Log.add('stop error ' + (e && e.message)); } }

    try {
      if (NEEDS_SERVER.has(state.screen)) { await ensureReady(); if (seq !== renderSeq) return; }
      switch (state.screen) {
        case 'settings': showSettings(); break;
        case 'servers': await showServers(seq); break;
        case 'manual': showManual(); break;
        case 'moviemenu': showMovieMenu(state); break;
        case 'continue': await showMovieList(state, seq, 'continue'); break;
        case 'recent': await showMovieList(state, seq, 'recent'); break;
        case 'collections': await showCollections(state, seq); break;
        case 'collection': await showCollection(state, seq); break;
        case 'library': await showLibrary(state, seq); break;
        case 'movie':
        case 'episode': await showItem(state, seq); break;
        case 'show': await showShow(state, seq); break;
        case 'season': await showSeason(state, seq); break;
        case 'diag': showDiag(); break;
        case 'player': await showPlayer(state, seq); break;
        default: await showLibraries(seq);
      }
    } catch (e) {
      if (seq !== renderSeq) return;
      if (e && e.kind === 'needsignin') { goHome(); return; }
      if (e && e.kind === 'choose') { showServers(seq, e.servers); return; }
      if (isPlayer) { playerFailure(e); } else { showFailure(e); }
    }
  }

  // ---------- screen: Libraries ----------
  async function showLibraries(seq) {
    setTitle('Libraries');
    if (!Plex.hasCredentials()) { showSignIn(seq); return; }
    showLoading('Connecting\u2026');
    await ensureReady();
    if (seq !== renderSeq) return;
    const libs = await getLibraries();
    if (seq !== renderSeq) return;

    // Show every library this app can play (movies and TV). Names in "libraryOrder" come first, the rest follow in the server's order.
    const playable = (l) => l.type === 'movie' || l.type === 'show';
    const supported = libs.filter(playable);
    const skipped = libs.filter((l) => !playable(l));
    const pref = (cfg.libraryOrder || []).map((n) => String(n).trim().toLowerCase());
    const rank = (l) => { const i = pref.indexOf(l.title.trim().toLowerCase()); return i < 0 ? pref.length : i; };
    const shown = supported.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
    if (!shown.length) throw failure('libs', 'libs', { available: libs.map((l) => l.title + ' (' + l.type + ')') });

    showList(shown.map((l) => ({
      key: 'lib:' + l.id,
      label: l.title,
      onSelect: () => navigate({ screen: l.type === 'movie' && cfg.movieMenu !== false ? 'moviemenu' : 'library', lib: l.id, title: l.title }),
    })));
    if (skipped.length) {
      screenEl.append(h('p', { class: 'note' }, 'Not shown (this app plays movies and TV only): ' + skipped.map((l) => l.title).join(', ')));
    }
    const where = { local: 'your home network', remote: 'a remote connection', relay: 'Plex relay (slow, so video quality is lowered)' }[Plex.connType];
    if (where) screenEl.append(h('p', { class: 'note' }, 'Connected via ' + where + (Plex.serverName ? ' \u00B7 ' + Plex.serverName : '')));
    if (Backup.enabled) screenEl.append(h('p', { class: 'note', id: 'backup-note' }, Backup.describe()));
    screenEl.append(h('p', { class: 'note note-ver' }, APP_NAME + ' v' + VERSION),
      h('button', { class: 'btn btn-quiet', type: 'button', 'data-key': 'settings', onclick: () => navigate({ screen: 'settings' }) }, 'Settings'));
    focusInitial();
  }

  function getLibraries() {
    if (!cache.libs) cache.libs = Plex.libraries().catch((e) => { cache.libs = null; throw e; });
    return cache.libs;
  }

  // ---------- screen: a library's items, alphabetical ----------
  function openRow(r) {
    if (r.ty === 'movie') navigate({ screen: 'movie', id: r.k, title: r.t });
    else if (r.ty === 'collection') navigate({ screen: 'collection', id: r.k, title: r.t, lib: current.lib });
    else if (r.ty === 'show') navigate({ screen: 'show', id: r.k, title: r.t });
    else if (r.ty === 'season') navigate({ screen: 'season', id: r.k, title: r.t });
    else navigate({ screen: 'player', id: r.k, kind: r.ty });
  }

  function rowOpts(r) {
    return {
      key: 'it:' + r.k,
      label: r.t,
      sub: r.ty === 'collection' ? (r.c ? r.c + (r.c === 1 ? ' film' : ' films') : '')
        : r.vo >= PROGRESS_MIN && r.d && r.vo < r.d * 0.95 ? 'Resume ' + fmtTime(r.vo / 1000) + ' of ' + fmtTime(r.d / 1000)
        : r.ty === 'show' && r.c ? r.c + (r.c === 1 ? ' season' : ' seasons') : (r.y || ''),
      onSelect: () => openRow(r),
    };
  }

  /** First letter used for the A-Z strip: sort title, accents removed, anything not A-Z goes under "#". */
  function bucketOf(r) {
    const c = rowKey(r).normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : '#';
  }

  function makeIndex(res) {
    const buckets = new Map();
    res.rows.forEach((r) => {
      const L = bucketOf(r);
      if (!buckets.has(L)) buckets.set(L, []);
      buckets.get(L).push(r);
    });
    const letters = Array.from(buckets.keys()).sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : a < b ? -1 : 1));
    const memo = new Map();
    return {
      rows: res.rows, total: res.total, skipped: res.skipped, buckets, letters,
      sorted(L) {
        if (!memo.has(L)) memo.set(L, buckets.get(L).slice().sort(rowCmp));
        return memo.get(L);
      },
    };
  }

  async function libraryStamp(id) {
    try {
      const l = (await getLibraries()).find((x) => x.id === id);
      return l ? l.stamp : '';
    } catch (e) { return ''; }
  }

  async function showLibrary(state, seq) {
    setTitle(state.title);
    showLoading('Loading ' + state.title + '\u2026');
    const idx = await cached(cache.items, state.lib, async () => {
      const stamp = await libraryStamp(state.lib);
      const res = await Plex.libraryIndex(state.lib, stamp, (n, total, note) => {
        const t = $('#loadtext');
        if (t && seq === renderSeq) {
          t.textContent = 'Loading ' + state.title + '\u2026 ' + num(n) + (total ? ' / ' + num(total) : '') + (note ? ' (' + note + ')' : '');
        }
      });
      return makeIndex(res);
    });
    if (seq !== renderSeq) return;
    setTitle(state.title + ' \u00B7 ' + num(idx.total));

    if (!idx.rows.length) {
      screenEl.replaceChildren(h('div', { class: 'status' }, 'This library is empty.'));
      return;
    }

    if (idx.rows.length <= FLAT_MAX) {
      showList(idx.rows.slice().sort(rowCmp).map(rowOpts));
    } else {
      renderLetters(state, idx);
    }
    if (idx.skipped) {
      screenEl.append(h('p', { class: 'note' }, num(idx.skipped) + ' titles couldn\u2019t be loaded (the server didn\u2019t answer). Close and reopen to try again.'));
    }
    focusInitial();
  }

  const lkey = (st) => (st.screen === 'collections' ? st.lib + ':c' : st.lib);

  function renderLetters(state, idx) {
    const remembered = lastLetter.get(lkey(state)) || Plex.recall('letter.' + lkey(state));
    const letter = idx.buckets.has(state.letter) ? state.letter
      : idx.buckets.has(remembered) ? remembered : idx.letters[0];
    const rowsHost = h('div', { id: 'rows', class: 'rows' });
    const strip = h('nav', { id: 'letters', class: 'letters', 'aria-label': 'Jump to letter' });
    idx.letters.forEach((L) => {
      const n = idx.buckets.get(L).length;
      const b = h('button', {
        class: 'chip', type: 'button', 'data-key': 'ch:' + L,
        'aria-label': (L === '#' ? 'Numbers and symbols' : L) + ', ' + n + ' titles',
        'aria-current': L === letter ? 'true' : false,
      }, L);
      b.addEventListener('click', () => pickLetter(state, idx, strip, rowsHost, L, 'row'));
      strip.append(b);
    });
    screenEl.replaceChildren(h('div', { class: 'lib' }, strip, rowsHost));
    libCtx = { state, idx, strip, rowsHost, letter };
    screenEl.scrollTop = 0;

    // Coming back from a title: draw enough rows to include the one that was selected.
    const sorted = idx.sorted(letter);
    const remKey = focusMemory.get(stateKey(state));
    let limit = PAGE;
    if (remKey && remKey.indexOf('it:') === 0) {
      const i = sorted.findIndex((r) => 'it:' + r.k === remKey);
      if (i >= 0) limit = Math.ceil((i + 1) / PAGE) * PAGE;
    }
    fillRows(rowsHost, sorted, limit);
  }

  /** Show a letter's titles. `focus` says where the cursor goes afterwards: the first title, or the letter itself. */
  function pickLetter(state, idx, strip, rowsHost, L, focus) {
    lastLetter.set(lkey(state), L);            // Back from a title returns to this letter (remembered here, not in browser history)
    Plex.remember('letter.' + lkey(state), L);
    state.letter = L;
    if (libCtx) libCtx.letter = L;
    Array.prototype.forEach.call(strip.children, (c) => {
      if (c.dataset.key === 'ch:' + L) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
    });
    fillRows(rowsHost, idx.sorted(L), PAGE);
    screenEl.scrollTop = 0;
    if (focus === 'chip') {
      const chip = $('[aria-current="true"]', strip);
      if (chip) chip.focus();
    } else {
      const first = $('.item', rowsHost);
      if (first) first.focus();
    }
  }

  const letterIndex = () => (libCtx ? libCtx.idx.letters.indexOf(libCtx.letter) : -1);
  /** Right / Left from the list: move to the next / previous letter, cursor on that letter in the strip. */
  function stepLetter(dir) {
    if (!libCtx) return;
    const i = letterIndex() + dir;
    if (i < 0 || i >= libCtx.idx.letters.length) return;
    Log.add('letter ' + libCtx.idx.letters[i]);
    pickLetter(libCtx.state, libCtx.idx, libCtx.strip, libCtx.rowsHost, libCtx.idx.letters[i], 'chip');
  }

  /** Draw a letter's titles, PAGE at a time, with a "Show more" row at the end. */
  function fillRows(host, sorted, limit) {
    const ul = h('ul', { class: 'list' });
    let shown = 0;
    let moreLi = null;

    const addRows = (n) => {
      const first = shown;
      const end = Math.min(sorted.length, shown + n);
      const frag = document.createDocumentFragment();
      for (let i = shown; i < end; i++) frag.append(h('li', {}, makeItem(rowOpts(sorted[i]))));
      shown = end;
      if (moreLi) ul.insertBefore(frag, moreLi); else ul.append(frag);
      const left = sorted.length - shown;
      if (!left) {
        if (moreLi) { moreLi.remove(); moreLi = null; }
      } else if (!moreLi) {
        moreLi = h('li', {}, makeItem({
          key: 'more', label: 'Show more', sub: num(left) + ' more',
          onSelect: () => {
            const from = addRows(PAGE);
            const li = ul.children[from];
            if (li) $('.item', li).focus();
          },
        }));
        ul.append(moreLi);
      } else {
        $('.item-sub', moreLi).textContent = num(left) + ' more';
      }
      return first;
    };

    addRows(limit);
    host._more = () => { if (!moreLi) return false; addRows(PAGE); return true; };
    host.replaceChildren(ul);
  }

  // ---------- Movies: menu, Continue Watching, Recently Added, Collections ----------
  const MENU_COUNT = 10;
  const PROGRESS_MIN = 15000;       // under 15 seconds in doesn't count as "part-way"
  const toRow = (m) => ({ k: String(m.ratingKey), t: m.title || '', s: m.titleSort || '', y: m.year || 0, ty: m.type || '', c: m.childCount || 0, vo: viewOffsetOf(m), d: m.duration || 0 });

  /** Where this title was last up to (ms). Trust what we saw a moment ago over a server that may not have caught up. */
  function viewOffsetOf(m) {
    const mem = progressMemory.get(String(m.ratingKey));
    if (mem && Date.now() - mem.t < 10 * 60 * 1000) return mem.ms;
    return m.viewOffset || 0;
  }
  /** Seconds to resume from, or 0 when it isn't part-way (not started, or finished). */
  function resumeSeconds(m) {
    const ms = viewOffsetOf(m);
    const dur = m.duration || 0;
    return ms >= PROGRESS_MIN && (!dur || ms < dur * 0.95) ? Math.floor(ms / 1000) : 0;
  }

  function showMovieMenu(state) {
    setTitle(state.title);
    const go = (screen) => () => navigate({ screen, lib: state.lib, title: state.title });
    showList([
      { key: 'mm:continue', label: 'Continue Watching', sub: 'Pick up where you left off', onSelect: go('continue') },
      { key: 'mm:recent', label: 'Recently Added', sub: 'The newest ' + MENU_COUNT + ' films', onSelect: go('recent') },
      { key: 'mm:library', label: 'Library', sub: 'Everything, A to Z', onSelect: go('library') },
      { key: 'mm:collections', label: 'Collections', sub: 'Films grouped together', onSelect: go('collections') },
    ]);
    focusInitial();
  }

  async function showMovieList(state, seq, kind) {
    setTitle(state.title + ' \u00B7 ' + (kind === 'continue' ? 'Continue Watching' : 'Recently Added'));
    showLoading();
    let items = kind === 'continue' ? await Plex.continueWatching(state.lib, MENU_COUNT) : await Plex.recentlyAdded(state.lib, MENU_COUNT);
    if (seq !== renderSeq) return;
    if (kind === 'continue') items = items.filter((m) => resumeSeconds(m) > 0);
    showList(items.map(toRow).map(rowOpts), kind === 'continue' ? 'Nothing is part-way through right now.' : 'Nothing has been added recently.');
    focusInitial();
  }

  async function showCollections(state, seq) {
    setTitle(state.title + ' \u00B7 Collections');
    showLoading();
    const list = await Plex.collections(state.lib);
    if (seq !== renderSeq) return;
    if (!list.length) { screenEl.replaceChildren(h('div', { class: 'status' }, 'No collections in this library yet.')); return; }
    const rows = list.map((m) => ({ k: String(m.ratingKey), t: m.title || '', s: m.titleSort || '', y: 0, ty: 'collection', c: +(m.childCount || m.size || 0), vo: 0, d: 0 }));
    if (rows.length <= FLAT_MAX) showList(rows.slice().sort(rowCmp).map(rowOpts));
    else renderLetters(state, makeIndex({ rows, total: rows.length, skipped: 0 }));
    focusInitial();
  }

  async function showCollection(state, seq) {
    setTitle(state.title);
    showLoading();
    const items = await Plex.collectionItems(state.id);
    if (seq !== renderSeq) return;
    showList(items.map(toRow).map(rowOpts), 'This collection is empty.');   // in the order the collection is set up in Plex
    focusInitial();
  }

  // ---------- screen: a film's (or episode's) page, with Resume / Start from beginning ----------
  async function showItem(state, seq) {
    setTitle(state.title || 'Movie');
    showLoading();
    cache.meta.delete(state.id);          // always fresh: the watch position may have changed
    const m = await cached(cache.meta, state.id, () => Plex.metadata(state.id));
    if (seq !== renderSeq) return;
    if (!m) throw failure('http', 'That title is no longer on the server.');
    setTitle(m.title, false); // the page shows the title itself

    const isEp = m.type === 'episode';
    const resume = resumeSeconds(m);
    const meta = isEp
      ? [m.grandparentTitle, (m.parentIndex != null ? 'S' + m.parentIndex : '') + (m.index != null ? ' E' + m.index : ''), m.duration ? fmtDur(m.duration) : ''].filter(Boolean).join(' \u00B7 ')
      : [m.year, m.duration ? fmtDur(m.duration) : '', m.contentRating].filter(Boolean).join(' \u00B7 ');
    const poster = h('img', { class: 'poster' + (isEp ? ' wide' : ''), src: Plex.image(m.thumb, isEp ? 400 : 300, isEp ? 225 : 450), alt: '', decoding: 'async' });
    poster.addEventListener('error', () => poster.classList.add('poster-missing'));

    const start = (at) => navigate({ screen: 'player', id: m.ratingKey, kind: m.type, resume: at });
    const primary = (label, at, key) => h('button', {
      class: 'btn btn-primary btn-play', type: 'button', 'data-autofocus': '', 'data-key': key, onclick: () => start(at),
    }, h('span', { class: 'play-badge' }, icon('play')), h('span', { class: 'play-text' }, label));
    const buttons = resume
      ? [primary('Resume ' + fmtTime(resume), resume, 'resume'),
        h('button', { class: 'btn btn-start', type: 'button', 'data-key': 'beginning', onclick: () => start(0) }, 'Start from beginning')]
      : [primary('Play', 0, 'play')];
    let bar = null;
    if (resume && m.duration) {
      const fillEl = h('div', { class: 'pfill' });
      fillEl.style.width = Math.min(100, (resume * 1000 / m.duration) * 100) + '%';
      bar = h('div', { class: 'pbar', 'aria-hidden': 'true' }, fillEl);
    }

    screenEl.replaceChildren(h('article', { class: 'splash' },
      h('div', { class: 'splash-top' }, poster,
        h('div', { class: 'splash-info' }, h('h2', { class: 'splash-title' }, m.title), meta ? h('p', { class: 'meta' }, meta) : null, bar, buttons)),
      h('div', { class: 'summary', tabindex: '0', role: 'region', 'aria-label': 'Description', 'data-key': 'summary' },
        m.summary || 'No description available.')));
    screenEl.scrollTop = 0;
    focusInitial();
  }

  // ---------- screen: seasons of a show ----------
  async function showShow(state, seq) {
    setTitle(state.title);
    showLoading();
    const kids = await cached(cache.kids, state.id, () => Plex.children(state.id));
    if (seq !== renderSeq) return;
    const seasons = kids.filter((k) => k.type === 'season').sort((a, b) => (a.index || 0) - (b.index || 0));
    showList(seasons.map((s) => ({
      key: 'se:' + s.ratingKey,
      label: s.title || 'Season ' + s.index,
      sub: s.leafCount ? s.leafCount + (s.leafCount === 1 ? ' episode' : ' episodes') : '',
      onSelect: () => navigate({ screen: 'season', id: s.ratingKey, title: s.title || 'Season ' + s.index, show: state.title }),
    })), 'No seasons found.');
    focusInitial();
  }

  // ---------- screen: sign in with a code ----------
  async function showSignIn(seq) {
    setTitle('Sign in');
    const box = h('div', { class: 'signin' });
    screenEl.replaceChildren(box);
    box.append(h('div', { class: 'status', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Getting a code from plex.tv\u2026')));
    const manual = () => navigate({ screen: 'manual' });
    let pin;
    try {
      pin = await Plex.startPin();
    } catch (e) {
      if (seq !== renderSeq) return;
      Log.add('pin failed: ' + (e && e.kind));
      box.replaceChildren(h('div', { class: 'panel', role: 'alert' },
        h('h2', {}, 'Can\u2019t reach plex.tv'),
        h('p', { class: 'small' }, 'The glasses need an internet connection to sign in. Check the connection and try again.'),
        h('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': '', onclick: () => render(current) }, 'Try again'),
        h('button', { class: 'btn', type: 'button', onclick: manual }, 'Use a token instead')));
      focusInitial();
      return;
    }
    if (seq !== renderSeq) return;
    Log.add('sign-in code shown');
    const timerEl = h('p', { class: 'signin-timer' }, '');
    box.replaceChildren(
      h('h2', { class: 'signin-h' }, 'Sign in to Plex'),
      h('p', { class: 'signin-p' }, 'On your phone or computer, go to'),
      h('p', { class: 'signin-url' }, 'plex.tv/link'),
      h('p', { class: 'signin-p' }, 'and enter this code:'),
      h('div', { class: 'code', 'aria-label': 'Code ' + pin.code.split('').join(' ') }, pin.code.toUpperCase().split('').join(' ')),
      timerEl,
      h('p', { class: 'signin-p small' }, 'This screen continues by itself once you\u2019ve entered it.'),
      h('button', { class: 'btn btn-quiet', type: 'button', 'data-autofocus': '', onclick: manual }, 'Use a token instead'));
    focusInitial();

    const live = () => seq === renderSeq && current.screen === 'libraries';
    const drawTimer = () => {
      const left = Math.max(0, Math.round((pin.expires - Date.now()) / 1000));
      timerEl.textContent = 'Code valid for ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      if (!left && live()) render(current);                      // expired: show a fresh code
    };
    drawTimer();
    signTimers.push(setInterval(() => { if (live()) drawTimer(); }, 1000));
    const poll = async () => {
      if (!live()) return;
      try {
        const token = await Plex.checkPin(pin);
        if (!live()) return;
        if (token) {
          Log.add('signed in with a code');
          await Plex.signedIn(token);
          if (!live()) return;
          resetCaches();
          render(current);
          return;
        }
      } catch (e) {
        if (!live()) return;
        if (e && e.status === 404) { render(current); return; }  // the code expired: show a fresh one
      }
      signTimers.push(setTimeout(poll, 2000));
    };
    signTimers.push(setTimeout(poll, 2000));
  }

  // ---------- screen: use a token by hand ----------
  function showManual() {
    setTitle('Use a token');
    const field = (label, attrs) => h('label', { class: 'field-l' }, label, h('input', Object.assign({ class: 'field', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }, attrs)));
    const server = field('Server address (optional)', { type: 'url', name: 'server', value: Plex.server || '', placeholder: 'https://\u2026plex.direct:32400' });
    const token = field('Plex token', { type: 'text', name: 'token', placeholder: 'your X-Plex-Token' });
    const msgEl = h('p', { class: 'small' }, '');
    const save = () => {
      const t = $('input', token).value.trim();
      if (!t) { msgEl.textContent = 'Enter a token first.'; return; }
      Plex.setManual($('input', server).value.trim(), t);
      resetCaches();
      goHome();
    };
    screenEl.replaceChildren(h('div', { class: 'panel' },
      h('p', { class: 'small' }, 'Signing in with a code is easier. This is for people who already have their Plex token (and maybe the server\u2019s address).'),
      server, token, msgEl,
      h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, 'Save and continue')));
    screenEl.scrollTop = 0;
    focusInitial();
  }

  // ---------- screen: choose a server ----------
  async function showServers(seq, list) {
    setTitle('Choose server');
    if (!list) {
      showLoading('Asking Plex\u2026');
      list = await Plex.discoverServers();
      if (seq !== renderSeq) return;
    }
    if (!list.length) throw failure('noserver');
    showList(list.map((srv) => ({
      key: 'srv:' + srv.id,
      label: srv.name,
      sub: (srv.owned ? 'Yours' : 'Shared with you') + (Plex.connected && srv.id === Plex.serverId ? ' \u00B7 connected' : ''),
      onSelect: () => {
        Log.add('server chosen');
        Plex.chooseServer(srv);
        resetCaches();
        if (current.screen === 'servers') goHome(); else render(current);
      },
    })));
    focusInitial();
  }

  // ---------- screen: settings ----------
  function showSettings() {
    setTitle('Settings');
    const who = Plex.authMode === 'pin' ? 'Signed in' + (Plex.userName ? ' as ' + Plex.userName : '') : 'Signed in with a token';
    const how = { local: 'your home network', remote: 'a remote connection', relay: 'Plex relay (slow, so video quality is lowered)' }[Plex.connType] || 'not connected';
    let host = '';
    try { host = new URL(Plex.server).host; } catch (e) { /* ignore */ }
    const rows = [];
    if (Plex.accountToken) rows.push({ key: 'st:server', label: 'Change server', sub: Plex.serverName || 'Choose which Plex server to use', onSelect: () => navigate({ screen: 'servers' }) });
    if (Backup.enabled) rows.push({ key: 'st:backup', label: 'Back up now', sub: 'Save your sign-in and settings to GitHub', onSelect: () => { Backup.flush(); } });
    rows.push({ key: 'st:reconnect', label: 'Reconnect', sub: 'Test the connection again', onSelect: () => { Plex.connected = false; resetCaches(); goHome(); } });
    const savedQ = () => Object.keys(KINDS).map((k) => { const m = loadQuality(k); return m ? KINDS[k] + ' ' + fmtLevel(LEVELS[m.lvl]) : null; }).filter(Boolean);
    rows.push({
      key: 'st:quality', label: 'Reset saved video quality',
      sub: savedQ().length ? 'Saved: ' + savedQ().join(' \u00B7 ') : 'Nothing saved yet. It adjusts itself as you watch.',
      onSelect: (ev) => {
        Object.keys(KINDS).forEach((k) => Plex.forget('quality.' + k));
        $('.item-sub', ev.currentTarget).textContent = 'Cleared. The next film starts at the default quality.';
      },
    });
    rows.push({ key: 'st:diag', label: 'Diagnostics', sub: 'What the app has been doing', onSelect: () => navigate({ screen: 'diag' }) });
    let armed = false;
    rows.push({
      key: 'st:out', label: 'Sign out', sub: 'Forget this account on the glasses',
      onSelect: (ev) => {
        if (!armed) { armed = true; $('.item-sub', ev.currentTarget).textContent = 'Select again to confirm'; return; }
        Log.add('signed out');
        Plex.signOut();
        Backup.flush();
        resetCaches();
        goHome();
      },
    });
    const ul = h('ul', { class: 'list' });
    rows.forEach((r) => ul.append(h('li', {}, makeItem(r))));
    screenEl.replaceChildren(h('div', { class: 'info' },
      h('p', {}, who),
      h('p', {}, 'Server: ' + (Plex.serverName || host || 'not chosen yet') + (host && Plex.serverName ? ' (' + host + ')' : '')),
      h('p', {}, 'Connection: ' + how),
      h('p', { id: 'st-backup' }, Backup.enabled ? Backup.describe() : 'Backup: off. To switch it on, add ?sync=YOUR-KEY to this app\u2019s address (see the README).')), ul);
    screenEl.append(h('p', { class: 'note' }, APP_NAME + ' v' + VERSION + ' \u00B7 an unofficial app, not made by or connected to Plex or Meta. The app itself collects nothing; your sign-in stays on this device' + (Backup.enabled ? ', plus an encrypted backup in your own GitHub account.' : '.')));
    if (Plex.viaLink) screenEl.append(h('p', { class: 'note' }, 'Your launch link contains a token, so this app will sign in again on its next start. To stop that, edit the link in the Meta AI app and remove the #token part.'));
    screenEl.scrollTop = 0;
    focusInitial();
  }

  // ---------- screen: diagnostics ----------
  function showDiag() {
    setTitle('Diagnostics');
    const v = document.createElement('video');
    let host = '?';
    try { host = new URL(Plex.server).host.slice(0, 44); } catch (e) { /* ignore */ }
    const info = [
      'App v' + VERSION,
      (navigator.userAgent.match(/Chrome\/[\d.]+/) || ['browser ?'])[0],
      'Native HLS: ' + (v.canPlayType('application/vnd.apple.mpegurl') || 'no') + '  MSE: ' + (window.MediaSource ? 'yes' : 'no'),
      'History entries: ' + history.length,
      'Server: ' + host,
    ];
    const block = (title, lines) => h('div', { class: 'diag-block' }, h('h3', { class: 'diag-h' }, title),
      h('pre', { class: 'diag-pre' }, lines.length ? lines.join('\n') : '(nothing recorded)'));
    screenEl.replaceChildren(h('div', { class: 'diag' },
      block('This device', info),
      block('Last session (before the latest restart)', Log.last().slice(-40)),
      block('This session', Log.now().slice(-40)),
      h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => { Log.clear(); showDiag(); } }, 'Clear log')));
    screenEl.scrollTop = 0;
    focusInitial();
  }

  // ---------- screen: episodes of a season ----------
  async function showSeason(state, seq) {
    setTitle(state.show ? state.show + ' \u2014 ' + state.title : state.title);
    showLoading();
    const kids = await cached(cache.kids, state.id, () => Plex.children(state.id));
    if (seq !== renderSeq) return;
    const eps = kids.filter((k) => k.type === 'episode').sort((a, b) => (a.index || 0) - (b.index || 0));
    showList(eps.map((ep) => {
      const sec = resumeSeconds(ep);
      return {
        key: 'ep:' + ep.ratingKey,
        label: (ep.index != null ? ep.index + '. ' : '') + ep.title,
        sub: sec ? 'Resume ' + fmtTime(sec) + ' of ' + fmtTime((ep.duration || 0) / 1000)
          : (ep.viewCount > 0 && !viewOffsetOf(ep) ? 'Watched' : (ep.duration ? fmtDur(ep.duration) : '')),
        // part-way through: ask whether to resume; otherwise just play
        onSelect: () => (sec ? navigate({ screen: 'episode', id: ep.ratingKey, title: ep.title })
          : navigate({ screen: 'player', id: ep.ratingKey, kind: 'episode', resume: 0 })),
      };
    }), 'No episodes found.');
    focusInitial();
  }

  // =====================================================================
  //  Player
  //
  //  The server always does the transcoding. What differs is how the glasses' browser
  //  receives it, so we try these in order and fall back automatically:
  //    1. "hls-native": the browser plays Plex's HLS playlist itself (if it says it can)
  //    2. "hls-js":     the hls.js library plays the same HLS stream through the browser's
  //                     Media Source API (loaded from js/vendor/ or a CDN on first use)
  //    3. "mp4":        one progressive MP4 stream (seeking restarts it at a new offset)
  //  If all fail, the screen says what each attempt did and what the server replied.
  // =====================================================================
  const P = {
    item: null, session: '', mode: '', ladder: [], idx: 0, errors: [],
    lvl: 3, bad: -1, kind: 'local', fromMemory: false, raisedAt: 0, smoothSince: 0,
    offset: 0, base: 0, baseSet: false, dur: 0, streamSeq: 0, pending: null, started: false,
    needAdvance: false, advFrom: 0, forceStart: false, guardUntil: 0, startFix: 0, stalls: 0, stallTimes: [], rebuf: false, rebufTimer: 0,
    guardT0: 0, hideTimer: 0, tick: 0, watchdog: 0, hls: null, decisionText: '',
  };
  const MODE_NAME = { 'hls-native': 'HLS', 'hls-js': 'HLS (hls.js)', mp4: 'MP4' };
  // The quality steps, best first. The app moves along these by itself (down when playback keeps stalling, up when it has
  // been smooth for a while) and remembers the step that worked for each kind of connection, so the next film starts
  // in the right place. Only `maxVideoBitrate` / `relayBitrate` in config.js decide where a first-ever play starts.
  const LEVELS = [
    { r: '854x480', b: 2000 }, { r: '640x360', b: 1200 }, { r: '480x270', b: 800 }, { r: '480x270', b: 600 },
    { r: '448x252', b: 500 }, { r: '426x240', b: 400 }, { r: '384x216', b: 320 }, { r: '320x180', b: 250 },
  ];
  const levelFor = (kbps) => { const i = LEVELS.findIndex((l) => l.b <= kbps); return i < 0 ? LEVELS.length - 1 : i; };
  const fmtLevel = (l) => l.r.replace('x', '\u00D7') + ' @ ' + l.b / 1000 + ' Mbps';
  const BAD_TTL = 20 * 60 * 1000;     // a step that stalled is avoided for this long, then tried again (connections change)
  const KINDS = { local: 'Home', remote: 'Remote', relay: 'Relay' };

  function loadQuality(kind) {
    try {
      const m = JSON.parse(Plex.recall('quality.' + kind) || 'null');
      if (!m || typeof m.l !== 'number' || m.l < 0 || m.l >= LEVELS.length) return null;
      return { lvl: m.l, bad: (Date.now() - (m.t || 0) < BAD_TTL && typeof m.bad === 'number') ? m.bad : -1 };
    } catch (e) { return null; }
  }
  function saveQuality() {
    if (pb.rememberQuality) Plex.remember('quality.' + P.kind, JSON.stringify({ l: P.lvl, bad: P.bad, t: Date.now() }));
  }
  /** Where this play starts: what worked last time on this kind of connection, otherwise the configured default. */
  function chooseStartLevel() {
    P.kind = Plex.connType || 'local';
    let kbps = pb.maxVideoBitrate;
    if (P.kind === 'relay' && pb.relayBitrate && pb.relayBitrate < kbps) kbps = pb.relayBitrate;   // Plex's relay is slow
    P.lvl = levelFor(kbps);
    P.bad = -1;
    P.fromMemory = false;
    if (pb.rememberQuality) {
      const m = loadQuality(P.kind);
      if (m) { P.lvl = m.lvl; P.bad = m.bad; P.fromMemory = true; }
    }
    P.raisedAt = 0;
    P.smoothSince = 0;
    Log.add('quality ' + P.kind + ' starts at ' + fmtLevel(LEVELS[P.lvl]) + (P.fromMemory ? ' (saved)' : ''));
  }
  // A 1x1 transparent picture: stops the browser drawing its own grey "play" placeholder over the black screen.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const pbFor = (protocol) => {
    const q = LEVELS[P.lvl] || LEVELS[3];
    return Object.assign({}, pb, { protocol, videoResolution: q.r, maxVideoBitrate: q.b });
  };

  function fullTitle(it) {
    if (it.type === 'episode') {
      const s = it.parentIndex != null ? 'S' + it.parentIndex : '';
      const e = it.index != null ? 'E' + it.index : '';
      return [it.grandparentTitle, s + e, it.title].filter(Boolean).join(' \u00B7 ');
    }
    return it.title;
  }

  function buildLadder() {
    const ladder = [];
    const nativeHls = !!(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL'));
    const mse = !!(window.MediaSource || window.ManagedMediaSource);
    if (pb.strategy !== 'mp4') {
      // hlsEngine "hlsjs" tries the hls.js library before the browser's own HLS player (default is the reverse)
      const order = pb.hlsEngine === 'hlsjs' ? ['hls-js', 'hls-native'] : ['hls-native', 'hls-js'];
      order.forEach((m) => { if ((m === 'hls-native' && nativeHls) || (m === 'hls-js' && mse)) ladder.push(m); });
    }
    if (pb.strategy !== 'hls') ladder.push('mp4');
    if (!ladder.length) ladder.push('hls-native');
    return ladder;
  }

  let hlsLoad = null;
  /** Load hls.js on first use: your own copy in js/vendor/ if present, otherwise a pinned CDN build. */
  function loadHlsJs() {
    if (window.Hls) return Promise.resolve();
    if (hlsLoad) return hlsLoad;
    const urls = pb.hlsJsUrl ? [pb.hlsJsUrl] : ['js/hls.min.js', 'js/vendor/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js'];
    const attempt = (i) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = urls[i];
      s.async = true;
      s.onload = () => (window.Hls ? resolve() : reject(new Error('missing')));
      s.onerror = () => reject(new Error('failed'));
      document.head.append(s);
    }).catch((e) => (i + 1 < urls.length ? attempt(i + 1) : Promise.reject(e)));
    hlsLoad = attempt(0).catch((e) => { hlsLoad = null; throw e; });
    return hlsLoad;
  }

  function setLoading(on, text) {
    loadingEl.hidden = !on;
    if (on && text) loadMsg.textContent = text;
  }
  function setPlayLabel(paused) { bPlay.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Play' : 'Pause'); }

  const position = () => (P.mode === 'mp4' ? P.offset + Math.max(0, video.currentTime - P.base) : video.currentTime || 0);

  /** Seconds of video already downloaded ahead of the playhead. */
  function bufferedAhead() {
    const t = video.currentTime;
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.1 && t <= b.end(i)) return Math.max(0, b.end(i) - t);
    return 0;
  }

  function updateProgress() {
    if (ctrl.hidden) return;
    const pos = P.pending != null ? P.pending : position();
    if (P.dur > 0) fill.style.width = Math.min(100, (pos / P.dur) * 100) + '%';
    ptime.textContent = fmtTime(pos) + (P.dur > 0 ? ' / ' + fmtTime(P.dur) : '');
    pstat.textContent = [
      MODE_NAME[P.mode],
      fmtLevel(LEVELS[P.lvl]) + (P.fromMemory ? ' (saved)' : ''),
      'buffer ' + Math.round(bufferedAhead()) + 's',
      'stalls ' + P.stalls,
      P.startFix ? 'start fixed (was ' + P.startFix + 's)' : '',
    ].filter(Boolean).join(' \u00B7 ');
  }

  function clearHide() { clearTimeout(P.hideTimer); P.hideTimer = 0; }
  function armHide() {
    clearHide();
    if (!ctrl.hidden && perr.hidden && !video.paused && !video.ended) P.hideTimer = setTimeout(hideControls, pb.controlsHideMs);
  }

  let hintTimer = 0;
  /** The Controls pill shows its label for a few seconds, then shrinks to three faint dots. */
  function calmHint() {
    clearTimeout(hintTimer);
    surface.classList.remove('quiet');
    hintTimer = setTimeout(() => surface.classList.add('quiet'), 3500);
  }

  function showControls() {
    clearTimeout(hintTimer);
    ctrl.hidden = false;
    topbar.hidden = false;
    updateProgress();
    if (!ctrl.contains(document.activeElement) && document.activeElement !== backBtn) bPlay.focus();
    surface.hidden = true;
    armHide();
  }

  function hideControls() {
    if (!perr.hidden) return;
    clearHide();
    ctrl.hidden = true;
    topbar.hidden = true;
    surface.hidden = false;
    calmHint();
    surface.focus({ preventScroll: true });
  }

  function resetPlayerUi() {
    ctrl.hidden = true;
    perr.hidden = true;
    topbar.hidden = true;
    surface.hidden = false;
    calmHint();
    fill.style.width = '0%';
    ptime.textContent = '';
    pstat.textContent = '';
    setPlayLabel(true);
    setLoading(true, 'Loading\u2026');
  }

  async function showPlayer(state, seq) {
    resetPlayerUi();
    surface.focus({ preventScroll: true });
    video.poster = BLANK;
    const item = await cached(cache.meta, state.id, () => Plex.metadata(state.id));
    if (seq !== renderSeq) return;
    if (!item) throw failure('http', 'That title is no longer on the server.');

    P.item = item;
    P.session = uuid();
    P.errors = [];
    P.ladder = buildLadder();
    P.idx = 0;
    chooseStartLevel();
    P.stalls = 0;
    P.stallTimes = [];
    P.rebuf = false;
    clearTimeout(P.rebufTimer);
    P.forceStart = !(state.resume > 1);      // a fresh start begins at 0:00 (see fixStart); a resume begins where it was left
    P.guardUntil = 0;
    P.startFix = 0;
    P.pending = null;
    P.streamSeq = 0;
    P.dur = (item.duration || 0) / 1000;
    P.decisionText = '';
    ptitle.textContent = fullTitle(item);
    clearInterval(P.tick);
    P.tick = setInterval(heartbeat, 10000);

    // Diagnostics only: doesn't hold up playback.
    const session = P.session;
    Plex.decision(item, { offset: 0, session, pb: pbFor(P.ladder[0] === 'mp4' ? 'http' : 'hls') }).then((d) => {
      if (P.session === session && d && d.text) P.decisionText = d.text;
    });

    begin(state.resume > 1 ? state.resume : 0);
  }

  function armWatchdog(my) {
    clearTimeout(P.watchdog);
    P.watchdog = setTimeout(() => {
      if (my === P.streamSeq && !P.started) failMode('no video after ' + pb.startTimeoutSeconds + 's');
    }, pb.startTimeoutSeconds * 1000);
  }

  function teardownEngine() {
    clearTimeout(P.watchdog);
    clearTimeout(P.rebufTimer);
    P.rebuf = false;
    if (P.hls) { try { P.hls.destroy(); } catch (e) { /* ignore */ } P.hls = null; }
  }

  function playSafe() {
    const p = video.play();
    if (p && p.catch) {
      p.catch((e) => {
        if (e && e.name === 'NotAllowedError') { clearTimeout(P.watchdog); setLoading(false); showControls(); }
      });
    }
  }

  /** Start (or restart) playback with the current rung of the ladder, from `pos` seconds. */
  function begin(pos, message) {
    const my = ++P.streamSeq;
    teardownEngine();
    const mode = P.ladder[P.idx];
    P.mode = mode;
    P.started = false;
    P.needAdvance = false;
    if (pos > 1) { P.guardUntil = 0; P.forceStart = false; }   // resuming mid-movie (after a fallback or quality change), not a fresh start
    Log.add('start ' + mode + ' ' + LEVELS[P.lvl].r + ' @' + LEVELS[P.lvl].b + (pos > 1 ? ' from ' + fmtTime(pos) : ''));
    setLoading(true, message || (P.idx > 0 ? 'Trying another way (' + MODE_NAME[mode] + ')\u2026' : 'Starting the transcoder\u2026'));
    armWatchdog(my);

    if (mode === 'mp4') {
      P.offset = Math.max(0, Math.floor(pos));
      P.base = 0;
      P.baseSet = false;
      video.src = Plex.streamUrl(P.item, { offset: P.offset, session: P.session, pb: pbFor('http') });
      video.load();
      playSafe();
      return;
    }

    P.offset = 0; P.base = 0; P.baseSet = true;
    const url = Plex.streamUrl(P.item, { offset: 0, session: P.session, pb: pbFor('hls') });

    if (mode === 'hls-native') {
      video.src = url;
      video.load();
      // Be explicit about where to begin: some players start a growing HLS playlist near its newest end.
      video.addEventListener('loadedmetadata', () => { try { video.currentTime = pos > 1 ? pos : 0; } catch (e) { /* ignore */ } }, { once: true });
      playSafe();
      return;
    }

    // hls-js
    loadHlsJs().then(() => {
      if (my !== P.streamSeq) return;
      if (!window.Hls || !window.Hls.isSupported()) { failMode('not supported here'); return; }
      const hls = new window.Hls({
        enableWorker: true, lowLatencyMode: false, startFragPrefetch: true,
        maxBufferLength: 60, maxMaxBufferLength: 120, maxBufferSize: 80 * 1000 * 1000, backBufferLength: 20,
        startPosition: pos > 1 ? pos : 0,     // 0 = the beginning (the default -1 would start a live-style playlist at its newest end)
      });
      P.hls = hls;
      let mediaFixes = 0;
      let netFixes = 0;
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => playSafe());
      hls.on(window.Hls.Events.ERROR, (_ev, d) => {
        if (my !== P.streamSeq || !d || !d.fatal) return;
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && mediaFixes++ < 2) { hls.recoverMediaError(); return; }
        // A refused/unparseable playlist won't fix itself, so don't wait: move to the next method.
        const hopeless = /^manifest/.test(d.details || '') || (d.response && d.response.code >= 400 && d.response.code < 500);
        if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR && !hopeless && netFixes++ < 1) { hls.startLoad(); return; }
        failMode((d.details || d.type || 'error') + (d.response && d.response.code ? ' (HTTP ' + d.response.code + ')' : ''));
      });
      hls.attachMedia(video);
      hls.loadSource(url);
    }).catch(() => { if (my === P.streamSeq) failMode('the hls.js library couldn\u2019t be loaded'); });
  }

  /** The current rung didn't work: remember why, then try the next one from where we were. */
  function failMode(reason) {
    if (!P.item) return;
    const resumeAt = position();
    Log.add('fail ' + MODE_NAME[P.mode] + ': ' + reason);
    P.errors.push(MODE_NAME[P.mode] + ': ' + reason);
    teardownEngine();
    P.idx += 1;
    if (P.idx < P.ladder.length) { begin(resumeAt); return; }
    finalFailure();
  }

  async function finalFailure() {
    const item = P.item;
    const session = P.session;
    P.streamSeq += 1;
    video.removeAttribute('src');
    video.load();
    setLoading(false);
    setPlayLabel(true);
    const head = 'Version ' + VERSION + '. What was tried:\n' + P.errors.join('\n');
    perrMsg.textContent = head + '\nChecking what the server sends\u2026';
    perr.hidden = false;
    ctrl.hidden = false;
    topbar.hidden = false;
    surface.hidden = true;
    clearHide();
    bExit.focus();

    const hlsUrl = Plex.streamUrl(item, { offset: 0, session, pb: pbFor('hls') });
    const mp4Url = Plex.streamUrl(item, { offset: 0, session, pb: pbFor('http') });
    const a = P.ladder.indexOf('mp4') === 0 ? null : await Plex.probe(hlsUrl);
    const b = pb.strategy === 'hls' ? null : await Plex.probe(mp4Url);
    if (P.item !== item || P.session !== session) return;
    perrMsg.textContent = head + '\nServer replies \u2014 ' +
      (a ? 'HLS: ' + a : '') + (a && b ? ' | ' : '') + (b ? 'MP4: ' + b : '') +
      (P.decisionText ? '\nPlan: ' + P.decisionText : '');
  }

  function inBuffered(t) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) + 0.1 && t <= b.end(i) - 1) return true;
    return false;
  }

  /** Seek to an absolute position in the movie. */
  function seekTo(pos) {
    P.guardUntil = 0; P.forceStart = false;   // the user is in charge from here
    const max = P.dur > 0 ? Math.max(0, P.dur - 2) : Infinity;
    pos = Math.min(Math.max(0, pos), max);
    if (P.mode !== 'mp4') { video.currentTime = pos; updateProgress(); return; }  // HLS: the stream is the whole movie
    // MP4: inside what's already buffered is instant; otherwise the server restarts the stream at that offset.
    const rel = pos - P.offset + P.base;
    if (P.pending == null && inBuffered(rel)) { video.currentTime = rel; return; }
    P.pending = pos; // so rapid +15s presses accumulate instead of all starting from the old spot
    begin(pos, 'Loading\u2026');
    updateProgress();
  }
  const seekBy = (delta) => seekTo((P.pending != null ? P.pending : position()) + delta);

  function togglePlay() {
    if (P.rebuf) { P.rebuf = false; clearTimeout(P.rebufTimer); setLoading(false); setPlayLabel(true); return; } // you chose to pause while it was buffering
    if (video.ended) { seekTo(0); video.play().catch(() => {}); return; }
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  // ---- stalls: hold on for a healthy cushion, and if it keeps happening, lower the quality ----
  function onStall() {
    const now = Date.now();
    P.stalls += 1;
    Log.add('stall ' + P.stalls + ' buf ' + Math.round(bufferedAhead()) + 's');
    P.stallTimes = P.stallTimes.filter((t) => now - t < 90000).concat(now);
    P.smoothSince = now;
    // A stall soon after we raised the quality means that step is too much for this connection: go straight back.
    const raiseFailed = P.raisedAt && now - P.raisedAt < 60000;
    if (pb.autoLowerQuality && (raiseFailed || P.stallTimes.length >= 3) && P.lvl + 1 < LEVELS.length) { stepDown(); return; }
    if (P.dur > 0 && P.dur - position() < 20) return;            // nearly at the end: just let it finish
    // Browsers restart the instant a sliver of data arrives, which gives stop-start every few seconds.
    // With hls.js (where this app controls buffering) wait until several seconds are stored up, then resume.
    // Plain MP4 / native HLS buffer on the browser's own terms, so there we leave it alone.
    if (P.mode !== 'hls-js') return;
    P.rebuf = true;
    video.pause();
    const t0 = now;
    let best = bufferedAhead();
    let grewAt = now;
    const check = () => {
      if (!P.rebuf || !P.item) return;
      const ahead = bufferedAhead();
      const t = Date.now();
      if (ahead > best + 0.3) { best = ahead; grewAt = t; }
      // resume when there's a healthy cushion, or the buffer has stopped growing, or we've waited long enough
      if (ahead >= pb.rebufferSeconds || t - grewAt > 3000 || t - t0 > pb.rebufferMaxSeconds * 1000) {
        P.rebuf = false;
        video.play().catch(() => {});
        return;
      }
      P.rebufTimer = setTimeout(check, 400);
    };
    clearTimeout(P.rebufTimer);
    P.rebufTimer = setTimeout(check, 400);
  }

  function stepDown() {
    const pos = position();
    P.bad = Math.max(P.bad, P.lvl);       // this step (and anything better) stalled here
    P.lvl += 1;
    P.fromMemory = false;
    P.stallTimes = [];
    P.raisedAt = 0;
    P.smoothSince = 0;
    saveQuality();
    Log.add('quality down to ' + fmtLevel(LEVELS[P.lvl]));
    const old = P.session;
    P.session = uuid();                 // fresh transcode session at the lower quality
    Plex.stop(old);
    begin(pos, 'Lowering quality to keep it smooth\u2026');
  }

  /** After a good stretch without stalls, try one step up. (Never while the controls are open, or near the end.) */
  function maybeRaise() {
    if (!pb.autoRaiseQuality || !P.item || !P.started || P.needAdvance || video.paused || P.rebuf || !ctrl.hidden) return;
    const target = P.lvl - 1;
    if (target < 0 || target <= P.bad || LEVELS[target].b > pb.autoRaiseUpToKbps) return;
    if (!P.smoothSince || Date.now() - P.smoothSince < pb.raiseAfterSeconds * 1000) return;
    if (bufferedAhead() < pb.raiseBufferSeconds) return;
    if (P.dur > 0 && P.dur - position() < 120) return;
    const pos = position();
    P.lvl = target;
    P.fromMemory = false;
    P.raisedAt = Date.now();
    P.smoothSince = Date.now();
    P.stallTimes = [];
    saveQuality();
    Log.add('quality up to ' + fmtLevel(LEVELS[P.lvl]));
    const old = P.session;
    P.session = uuid();
    Plex.stop(old);
    begin(pos, 'Raising quality\u2026');
  }

  function heartbeat() {
    if (!P.item) return;
    Plex.ping(P.session);
    Plex.timeline(P.item, video.paused && !P.rebuf ? 'paused' : 'playing', position() * 1000, P.dur * 1000, P.session);
    Log.add('hb ' + fmtTime(position()) + ' buf ' + Math.round(bufferedAhead()) + 's ' + (video.paused ? 'paused' : 'playing') + ' stalls ' + P.stalls);
    maybeRaise();
  }

  /** Stop everything that belongs to the current playback. Cheap, and safe to call at any time. */
  function detachPlayer() {
    clearHide();
    clearTimeout(hintTimer);
    clearInterval(P.tick);
    const item = P.item;
    const session = P.session;
    let pos = 0;
    try { pos = position(); } catch (e) { /* ignore */ }
    if (item && pos > 0) progressMemory.set(String(item.ratingKey), { ms: P.dur > 0 && pos >= P.dur * 0.95 ? 0 : pos * 1000, t: Date.now() });
    P.item = null;
    P.streamSeq += 1;
    try { video.pause(); } catch (e) { /* ignore */ }
    try { teardownEngine(); } catch (e) { Log.add('engine stop error'); }
    ctrl.hidden = true;
    perr.hidden = true;
    setLoading(false);
    if (item) {
      Log.add('stopped at ' + fmtTime(pos));
      Plex.timeline(item, 'stopped', pos * 1000, P.dur * 1000, session);
      Plex.stop(session);
    }
    // Letting go of the media can be slow (or even throw) on some players, so do it once the new screen is showing.
    let done = false;
    const go = () => { if (!done) { done = true; releaseMedia(); } };
    if (window.requestAnimationFrame) requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 400);
  }

  function releaseMedia() {
    if (P.item) return;      // a new playback has already started and replaces this one
    const t = Date.now();
    try { video.removeAttribute('src'); video.load(); } catch (e) { Log.add('release error ' + (e && e.message)); }
    Log.add('media released in ' + (Date.now() - t) + 'ms');
  }

  function playerFailure(e) {
    P.streamSeq += 1;
    perrMsg.textContent = e && e.kind === 'network' ? 'Can\u2019t reach the Plex server.' : (e && e.message) || 'Playback failed.';
    perr.hidden = false;
    setLoading(false);
    ctrl.hidden = false;
    topbar.hidden = false;
    surface.hidden = true;
    bExit.focus();
  }

  const MEDIA_ERR = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
  video.addEventListener('error', () => {
    if (!P.item || !video.getAttribute('src') || P.mode === 'hls-js') return; // hls.js reports its own errors
    const code = video.error ? video.error.code : 0;
    failMode(MEDIA_ERR[code] || 'error ' + code);
  });

  video.addEventListener('loadeddata', () => {
    if (P.mode === 'mp4' && !P.baseSet) { P.base = video.buffered.length ? video.buffered.start(0) : 0; P.baseSet = true; }
  });
  // "playing" can fire before there is a picture (the browser is still filling its buffer),
  // so the spinner stays until the clock has really moved.
  /** If HLS begins somewhere other than the start of a fresh play, jump back to 0:00. */
  function fixStart(why) {
    const at = video.currentTime;
    P.startFix = Math.round(at);
    Log.add('start corrected (was ' + Math.round(at) + 's)');
    P.forceStart = false;
    P.guardUntil = 0;
    try { video.currentTime = 0; } catch (e) { /* ignore */ }
    P.advFrom = 0;
    P.needAdvance = true;
    return why;
  }

  video.addEventListener('playing', () => {
    if (P.forceStart && P.mode !== 'mp4') {
      if (video.currentTime > 1.5) fixStart('start');
      else { P.forceStart = false; P.guardUntil = Date.now() + 15000; P.guardT0 = Date.now(); }   // watch the first 15 s for a late jump
    }
    P.needAdvance = true;
    P.advFrom = video.currentTime;
    setPlayLabel(false);
    perr.hidden = true;
    armHide();
  });
  video.addEventListener('timeupdate', () => {
    // A player that jumps ahead shortly after starting (live-edge behaviour): the clock can't be ahead of real time + a few seconds.
    if (P.guardUntil && P.mode !== 'mp4') {
      if (Date.now() > P.guardUntil) P.guardUntil = 0;
      else if (video.currentTime > (Date.now() - P.guardT0) / 1000 + 4) fixStart('jump');
    }
    if (P.needAdvance && !video.paused && Math.abs(video.currentTime - P.advFrom) > 0.25) {
      P.needAdvance = false;
      P.started = true;
      P.smoothSince = Date.now();
      clearTimeout(P.watchdog);
      P.pending = null;
      setLoading(false);
    }
    updateProgress();
  });
  video.addEventListener('waiting', () => {
    if (!P.item || !perr.hidden) return;
    if (P.started) setLoading(true, 'Buffering\u2026'); else loadingEl.hidden = false;
    if (!P.started || video.seeking || P.rebuf || video.paused) return;
    onStall();
  });
  video.addEventListener('pause', () => { if (P.rebuf) return; setPlayLabel(true); clearHide(); });
  video.addEventListener('play', () => { if (!P.rebuf) setPlayLabel(false); });
  video.addEventListener('ended', () => { setPlayLabel(true); showControls(); if (P.item) Plex.timeline(P.item, 'stopped', P.dur * 1000, P.dur * 1000, P.session); });

  // Select on the video opens the controls; any key activity while they're open keeps them up.
  surface.addEventListener('click', showControls);
  playerEl.addEventListener('click', () => { if (ctrl.hidden && perr.hidden) showControls(); });
  playerEl.addEventListener('keydown', armHide);
  playerEl.addEventListener('focusin', armHide);
  // Belt and braces: however the glasses deliver "select" (or an arrow press) while nothing has focus, still open the controls.
  document.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('mode-player') || !ctrl.hidden || !perr.hidden || e.defaultPrevented) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key.indexOf('Arrow') === 0) { e.preventDefault(); showControls(); }
  });

  bRew.addEventListener('click', () => seekBy(-STEP));
  bFwd.addEventListener('click', () => seekBy(STEP));
  bPlay.addEventListener('click', togglePlay);
  bExit.addEventListener('click', () => goBack('exit'));   // back to the movie's splash / the episode list

  // ---------- boot ----------
  async function boot() {
    try { history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
    // If the glasses have lost this app's saved data (an update can do that), get it back from the GitHub backup first.
    if (Backup.enabled && !Backup.hasLocal()) {
      screenEl.replaceChildren(h('div', { class: 'status', role: 'status' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Restoring your backup\u2026')));
      const result = await Backup.restoreIfEmpty(10000);
      Log.add('backup restore: ' + result);
      if (result === 'restored') toast('Restored your sign-in and settings from GitHub');
    }
    creds = Plex.init();
    const saved = history.state;
    let start = ROOT;
    if (saved && saved.screen) {
      start = saved.screen === 'player' ? (saved.up || ROOT) : saved;   // restarted while playing: return to the movie's page
      if (start !== saved) { try { history.replaceState(start, ''); } catch (e) { /* ignore */ } }
    } else {
      history.replaceState(ROOT, '');
    }
    Log.add('start app v' + VERSION + ' at ' + start.screen + (Backup.enabled ? ' (backup on)' : ''));
    render(start);
    Backup.afterBoot();
  }
  boot();
})();
