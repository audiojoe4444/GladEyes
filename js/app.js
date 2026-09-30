/*
 * Plex Glasses: screens, navigation and playback. Vanilla JS, no build step.
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

  const cfg = window.PLEX_CONFIG || {};
  const pb = Object.assign({
    protocol: 'http', container: 'mp4', videoResolution: '854x480', maxVideoBitrate: 2000,
    forceTranscode: true, seekStepSeconds: 15, controlsHideMs: 6000,
  }, cfg.playback || {});
  const STEP = pb.seekStepSeconds;
  const MAX_INDEX = 4; // host keeps at most 5 history entries (indexes 0..4)

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
    play: '<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
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

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sortKey = (it) => String(it.titleSort || it.title || '').trim();

  // ---------- elements ----------
  const screenEl = $('#screen');
  const topbar = $('#topbar');
  const backBtn = $('#back');
  const titleEl = $('#title');
  const playerEl = $('#player');
  const video = $('#video');
  const surface = $('#surface');
  const loadingEl = $('#loading');
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

  bRew.textContent = '\u2212' + STEP + 's';
  bFwd.textContent = '+' + STEP + 's';

  // ---------- state ----------
  const ROOT = { screen: 'libraries', d: 0 };
  let current = null;
  let renderSeq = 0;
  let creds = { ok: false };
  const focusMemory = new Map();
  const cache = { libs: null, items: new Map(), meta: new Map(), kids: new Map() };

  function cached(map, key, load) {
    if (!map.has(key)) map.set(key, load().catch((e) => { map.delete(key); throw e; }));
    return map.get(key);
  }
  const stateKey = (s) => [s.screen, s.lib || '', s.id || ''].join('|');

  // ---------- navigation (real browser history) ----------
  function navigate(next) {
    if (current.d >= MAX_INDEX) {
      // Would exceed the host's 5-entry limit: replace instead of pushing.
      next.d = current.d;
      history.replaceState(next, '');
    } else {
      next.d = current.d + 1;
      history.pushState(next, '');
    }
    render(next);
  }

  window.addEventListener('popstate', (e) => {
    const s = e.state;
    render(s && s.screen && s.screen !== 'player' ? s : ROOT);
  });

  backBtn.addEventListener('click', () => history.back());

  // ---------- focus ----------
  function rememberFocus() {
    const a = document.activeElement;
    if (current && a && a.dataset && a.dataset.key && screenEl.contains(a)) {
      focusMemory.set(stateKey(current), a.dataset.key);
    }
  }

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
    if (a === backBtn) {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusPrimary(); }
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    if (!a || !scopeEl().contains(a) || !isEdge(a, e.key)) return;
    e.preventDefault();
    backBtn.focus();
  });

  // ---------- generic screen bits ----------
  function setTitle(text, showInBar) {
    titleEl.textContent = showInBar === false ? '' : text;
    document.title = text || 'Plex';
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
    if (e && e.kind === 'setup') {
      title = 'One-time setup needed';
      msg = 'This app needs your Plex token.';
      detail = 'Open the app once from your launch link, which ends in #token=YOUR_TOKEN (README, step 4).';
    } else if (e && e.kind === 'auth') {
      title = 'Plex rejected the token';
      msg = 'The saved token is no longer valid.';
      detail = 'Open the app from a fresh launch link with a new #token=\u2026 (README, step 4).';
    } else if (e && e.kind === 'network') {
      title = 'Can\u2019t reach your Plex server';
      msg = 'Server: ' + host;
      detail = 'The glasses (via your phone) must be able to reach that address, and the server must allow browser requests (CORS). A 192.168.x.x address only works on your home network.';
    } else if (e && e.kind === 'libs') {
      title = 'Libraries not found';
      msg = 'None of ' + (cfg.libraries || []).join(', ') + ' exist on this server.';
      detail = 'Libraries on the server: ' + ((e.available || []).join(', ') || 'none') + '. Edit "libraries" in config.js.';
    }
    screenEl.replaceChildren(h('div', { class: 'panel', role: 'alert' },
      h('h2', {}, title), h('p', {}, msg), detail ? h('p', { class: 'small' }, detail) : null,
      h('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': '', onclick: () => render(current) }, 'Try again')));
    focusInitial();
  }

  // ---------- render ----------
  async function render(state) {
    rememberFocus();
    const prev = current;
    current = state;
    const seq = ++renderSeq;

    if (prev && prev.screen === 'player' && !(state.screen === 'player' && state.id === prev.id)) teardownPlayer();

    const isPlayer = state.screen === 'player';
    document.body.classList.toggle('mode-player', isPlayer);
    screenEl.hidden = isPlayer;
    playerEl.hidden = !isPlayer;
    topbar.hidden = isPlayer;

    try {
      switch (state.screen) {
        case 'library': await showLibrary(state, seq); break;
        case 'movie': await showMovie(state, seq); break;
        case 'show': await showShow(state, seq); break;
        case 'season': await showSeason(state, seq); break;
        case 'player': await showPlayer(state, seq); break;
        default: await showLibraries(seq);
      }
    } catch (e) {
      if (seq !== renderSeq) return;
      if (isPlayer) { playerFailure(e); } else { showFailure(e); }
    }
  }

  // ---------- screen: Libraries ----------
  async function showLibraries(seq) {
    setTitle('Libraries');
    if (!creds.ok) throw failure('setup');
    showLoading();
    if (!cache.libs) cache.libs = Plex.libraries().catch((e) => { cache.libs = null; throw e; });
    const libs = await cache.libs;
    if (seq !== renderSeq) return;

    const byName = new Map(libs.map((l) => [l.title.trim().toLowerCase(), l]));
    const shown = [];
    const missing = [];
    (cfg.libraries || []).forEach((name) => {
      const l = byName.get(String(name).trim().toLowerCase());
      if (l) shown.push(l); else missing.push(name);
    });
    if (!shown.length) throw failure('libs', 'libs', { available: libs.map((l) => l.title) });

    showList(shown.map((l) => ({
      key: 'lib:' + l.id,
      label: l.title,
      onSelect: () => navigate({ screen: 'library', lib: l.id, title: l.title }),
    })));
    if (missing.length) screenEl.append(h('p', { class: 'note' }, 'Not found on server: ' + missing.join(', ')));
    focusInitial();
  }

  // ---------- screen: a library's items, alphabetical ----------
  function openItem(it) {
    if (it.type === 'movie') navigate({ screen: 'movie', id: it.ratingKey, title: it.title });
    else if (it.type === 'show') navigate({ screen: 'show', id: it.ratingKey, title: it.title });
    else if (it.type === 'season') navigate({ screen: 'season', id: it.ratingKey, title: it.title });
    else navigate({ screen: 'player', id: it.ratingKey, kind: it.type });
  }

  async function showLibrary(state, seq) {
    setTitle(state.title);
    showLoading('Loading ' + state.title + '\u2026');
    const items = await cached(cache.items, state.lib, () => Plex.libraryItems(state.lib, (n, total) => {
      const t = $('#loadtext');
      if (t && seq === renderSeq) t.textContent = 'Loading ' + state.title + '\u2026 ' + n + (isFinite(total) ? ' / ' + total : '');
    }));
    if (seq !== renderSeq) return;
    const sorted = items.slice().sort((a, b) => collator.compare(sortKey(a), sortKey(b)));
    showList(sorted.map((it) => ({
      key: 'it:' + it.ratingKey,
      label: it.title,
      sub: it.type === 'show'
        ? (it.childCount ? it.childCount + (it.childCount === 1 ? ' season' : ' seasons') : it.year)
        : it.year,
      onSelect: () => openItem(it),
    })), 'This library is empty.');
    focusInitial();
  }

  // ---------- screen: movie splash ----------
  async function showMovie(state, seq) {
    setTitle(state.title || 'Movie');
    showLoading();
    const m = await cached(cache.meta, state.id, () => Plex.metadata(state.id));
    if (seq !== renderSeq) return;
    if (!m) throw failure('http', 'That title is no longer on the server.');
    setTitle(m.title, false); // the splash shows the title itself

    const meta = [m.year, m.duration ? fmtDur(m.duration) : '', m.contentRating].filter(Boolean).join(' \u00B7 ');
    const poster = h('img', { class: 'poster', src: Plex.image(m.thumb, 300, 450), alt: '', decoding: 'async' });
    poster.addEventListener('error', () => poster.classList.add('poster-missing'));

    const play = h('button', {
      class: 'btn btn-primary', type: 'button', 'data-autofocus': '', 'data-key': 'play',
      onclick: () => navigate({ screen: 'player', id: m.ratingKey, kind: 'movie' }),
    }, icon('play'), 'Play');

    screenEl.replaceChildren(h('article', { class: 'splash' },
      h('div', { class: 'splash-top' }, poster,
        h('div', { class: 'splash-info' }, h('h2', { class: 'splash-title' }, m.title), meta ? h('p', { class: 'meta' }, meta) : null, play)),
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

  // ---------- screen: episodes of a season ----------
  async function showSeason(state, seq) {
    setTitle(state.show ? state.show + ' \u2014 ' + state.title : state.title);
    showLoading();
    const kids = await cached(cache.kids, state.id, () => Plex.children(state.id));
    if (seq !== renderSeq) return;
    const eps = kids.filter((k) => k.type === 'episode').sort((a, b) => (a.index || 0) - (b.index || 0));
    showList(eps.map((ep) => ({
      key: 'ep:' + ep.ratingKey,
      label: (ep.index != null ? ep.index + '. ' : '') + ep.title,
      sub: ep.duration ? fmtDur(ep.duration) : '',
      onSelect: () => navigate({ screen: 'player', id: ep.ratingKey, kind: 'episode' }),
    })), 'No episodes found.');
    focusInitial();
  }

  // =====================================================================
  //  Player
  // =====================================================================
  const P = { item: null, session: '', offset: 0, base: 0, baseSet: false, dur: 0, streamSeq: 0, pending: null, hideTimer: 0, tick: 0, decisionText: '' };

  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  function fullTitle(it) {
    if (it.type === 'episode') {
      const s = it.parentIndex != null ? 'S' + it.parentIndex : '';
      const e = it.index != null ? 'E' + it.index : '';
      return [it.grandparentTitle, s + e, it.title].filter(Boolean).join(' \u00B7 ');
    }
    return it.title;
  }

  function setLoading(on) { loadingEl.hidden = !on; }
  function setPlayLabel(paused) { bPlay.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Play' : 'Pause'); }

  const position = () => P.offset + Math.max(0, video.currentTime - P.base);

  function updateProgress() {
    if (ctrl.hidden) return;
    const pos = P.pending != null ? P.pending : position();
    if (P.dur > 0) fill.style.width = Math.min(100, (pos / P.dur) * 100) + '%';
    ptime.textContent = fmtTime(pos) + (P.dur > 0 ? ' / ' + fmtTime(P.dur) : '');
  }

  function clearHide() { clearTimeout(P.hideTimer); P.hideTimer = 0; }
  function armHide() {
    clearHide();
    if (!ctrl.hidden && perr.hidden && !video.paused && !video.ended) P.hideTimer = setTimeout(hideControls, pb.controlsHideMs);
  }

  function showControls() {
    ctrl.hidden = false;
    topbar.hidden = false;
    updateProgress();
    if (!ctrl.contains(document.activeElement) && document.activeElement !== backBtn) bPlay.focus();
    armHide();
  }

  function hideControls() {
    if (!perr.hidden) return;
    clearHide();
    ctrl.hidden = true;
    topbar.hidden = true;
    surface.focus({ preventScroll: true });
  }

  function resetPlayerUi() {
    ctrl.hidden = true;
    perr.hidden = true;
    topbar.hidden = true;
    fill.style.width = '0%';
    ptime.textContent = '';
    setPlayLabel(true);
    setLoading(true);
  }

  async function showPlayer(state, seq) {
    resetPlayerUi();
    surface.focus({ preventScroll: true });
    const item = await cached(cache.meta, state.id, () => Plex.metadata(state.id));
    if (seq !== renderSeq) return;
    if (!item) throw failure('http', 'That title is no longer on the server.');

    P.item = item;
    P.session = uuid();
    P.offset = 0; P.base = 0; P.baseSet = false;
    P.dur = (item.duration || 0) / 1000;
    P.pending = null;
    P.streamSeq = 0;
    ptitle.textContent = fullTitle(item);
    clearInterval(P.tick);
    P.tick = setInterval(heartbeat, 10000);
    startStream(0, true);
  }

  /** (Re)start the server-side transcode at `offset` seconds and point the <video> at it. */
  async function startStream(offset, withDecision) {
    const my = ++P.streamSeq;
    P.offset = Math.max(0, Math.floor(offset));
    P.base = 0;
    P.baseSet = false;
    setLoading(true);
    const args = { offset: P.offset, session: P.session, pb };
    if (withDecision) {
      const d = await Plex.decision(P.item, args);
      if (my !== P.streamSeq || !P.item) return;
      P.decisionText = d && d.text ? d.text : '';
    }
    video.src = Plex.streamUrl(P.item, args);
    video.load();
    try {
      await video.play();
    } catch (e) {
      if (e && e.name === 'NotAllowedError') { setLoading(false); showControls(); }
    }
  }

  function inBuffered(t) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) + 0.1 && t <= b.end(i) - 1) return true;
    return false;
  }

  /** Seek to an absolute position. Inside what's already buffered: instant. Otherwise ask the server to restart at that offset. */
  function seekTo(pos) {
    const max = P.dur > 0 ? Math.max(0, P.dur - 2) : Infinity;
    pos = Math.min(Math.max(0, pos), max);
    const rel = pos - P.offset + P.base;
    if (P.pending == null && inBuffered(rel)) { video.currentTime = rel; return; }
    P.pending = pos; // so rapid +15s presses accumulate instead of all starting from the old spot
    startStream(pos, false);
    updateProgress();
  }
  const seekBy = (delta) => seekTo((P.pending != null ? P.pending : position()) + delta);

  function togglePlay() {
    if (video.ended) { seekTo(0); video.play().catch(() => {}); return; }
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  function heartbeat() {
    if (!P.item) return;
    Plex.ping(P.session);
    Plex.timeline(P.item, video.paused ? 'paused' : 'playing', position() * 1000, P.dur * 1000, P.session);
  }

  function teardownPlayer() {
    clearHide();
    clearInterval(P.tick);
    const item = P.item;
    const session = P.session;
    const pos = position();
    P.item = null;
    try { video.pause(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');
    video.load();
    if (item) {
      Plex.timeline(item, 'stopped', pos * 1000, P.dur * 1000, session);
      Plex.stop(session);
    }
    ctrl.hidden = true;
    perr.hidden = true;
    setLoading(false);
  }

  function playerFailure(e) {
    let msg = e && e.kind === 'network' ? 'Can\u2019t reach the Plex server.' : (e && e.message) || 'Playback failed.';
    perrMsg.textContent = msg;
    perr.hidden = false;
    setLoading(false);
    ctrl.hidden = false;
    topbar.hidden = false;
    bExit.focus();
  }

  const MEDIA_ERR = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
  video.addEventListener('error', () => {
    if (!P.item || !video.getAttribute('src')) return;
    const code = video.error ? video.error.code : 0;
    const probe = video.canPlayType('video/mp4; codecs="avc1.640029, mp4a.40.2"') || 'no';
    perrMsg.textContent = 'Playback failed (' + (MEDIA_ERR[code] || 'unknown') + '). ' +
      (P.decisionText ? 'Server: ' + P.decisionText + '. ' : '') +
      'This browser reports H.264/AAC MP4 support: ' + probe + '. See README, "If video won\u2019t play".';
    perr.hidden = false;
    setLoading(false);
    ctrl.hidden = false;
    topbar.hidden = false;
    clearHide();
    bExit.focus();
  });

  video.addEventListener('loadeddata', () => {
    if (!P.baseSet) { P.base = video.buffered.length ? video.buffered.start(0) : 0; P.baseSet = true; }
  });
  video.addEventListener('playing', () => { setLoading(false); P.pending = null; setPlayLabel(false); perr.hidden = true; armHide(); });
  video.addEventListener('waiting', () => setLoading(true));
  video.addEventListener('pause', () => { setPlayLabel(true); clearHide(); });
  video.addEventListener('play', () => setPlayLabel(false));
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('ended', () => { setPlayLabel(true); showControls(); if (P.item) Plex.timeline(P.item, 'stopped', P.dur * 1000, P.dur * 1000, P.session); });

  // Select on the video opens the controls; any key activity while they're open keeps them up.
  surface.addEventListener('click', showControls);
  playerEl.addEventListener('keydown', armHide);
  playerEl.addEventListener('focusin', armHide);

  bRew.addEventListener('click', () => seekBy(-STEP));
  bFwd.addEventListener('click', () => seekBy(STEP));
  bPlay.addEventListener('click', togglePlay);
  bExit.addEventListener('click', () => history.back()); // back to the movie's splash / the episode list

  // ---------- boot ----------
  try { history.scrollRestoration = 'manual'; } catch (e) { /* ignore */ }
  creds = Plex.init();
  const saved = history.state;
  let start = ROOT;
  if (saved && saved.screen && saved.screen !== 'player') start = saved;
  else history.replaceState(ROOT, '');
  render(start);
})();
