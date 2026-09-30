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

  const VERSION = '3';
  const cfg = window.PLEX_CONFIG || {};
  const pb = Object.assign({
    strategy: 'auto', container: 'mp4', videoResolution: '640x360', maxVideoBitrate: 1200,
    forceTranscode: true, seekStepSeconds: 15, controlsHideMs: 6000, startTimeoutSeconds: 45, hlsJsUrl: '',
    rebufferSeconds: 10, rebufferMaxSeconds: 25, autoLowerQuality: true,
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
  const brand = $('#brand');
  const pstat = $('#pstat');

  bRew.textContent = '\u2212' + STEP + 's';
  bFwd.textContent = '+' + STEP + 's';

  // ---------- state ----------
  const ROOT = { screen: 'libraries', d: 0 };
  let current = null;
  let renderSeq = 0;
  let creds = { ok: false };
  const focusMemory = new Map();
  const lastLetter = new Map();
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
    if (!a || !scopeEl().contains(a)) return;

    // Library screen with the A-Z strip: strip sits between Back and the list.
    const strip = screenEl.hidden ? null : $('#letters', screenEl);
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

    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    if (!isEdge(a, e.key)) return;
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
      detail = 'Open the app once from your launch link, which ends in #token=YOUR_TOKEN (README, step 3).';
    } else if (e && e.kind === 'auth') {
      title = 'Plex rejected the token';
      msg = 'The saved token is no longer valid.';
      detail = 'Open the app from a fresh launch link with a new #token=\u2026 (README, step 3).';
    } else if (e && e.kind === 'network') {
      title = 'Can\u2019t reach your Plex server';
      msg = 'Server: ' + host;
      detail = 'The glasses (via your phone) must be able to reach that address, and the server must allow browser requests (CORS). A 192.168.x.x address only works on your home network.';
    } else if (e && e.kind === 'timeout') {
      title = 'Your Plex server isn\u2019t answering';
      msg = 'Server: ' + host;
      detail = 'It took too long to reply. Check the server is awake and the connection is good, then try again.';
    } else if (e && e.kind === 'libs') {
      title = 'No movie or TV libraries';
      msg = 'This server has no movie or TV show libraries this app can play.';
      detail = 'Libraries on the server: ' + ((e.available || []).join(', ') || 'none') + '.';
    }
    screenEl.replaceChildren(h('div', { class: 'panel', role: 'alert' },
      h('h2', {}, title), h('p', {}, msg), detail ? h('p', { class: 'small' }, detail) : null,
      h('button', { class: 'btn btn-primary', type: 'button', 'data-autofocus': '', onclick: () => render(current) }, 'Try again')));
    focusInitial();
  }

  // ---------- render ----------
  async function render(state) {
    const prev = current;
    current = state;
    const seq = ++renderSeq;

    if (prev && prev.screen === 'player' && !(state.screen === 'player' && state.id === prev.id)) teardownPlayer();

    const isPlayer = state.screen === 'player';
    document.body.classList.toggle('mode-player', isPlayer);
    screenEl.hidden = isPlayer;
    playerEl.hidden = !isPlayer;
    topbar.hidden = isPlayer;
    brand.toggleAttribute('hidden', state.screen !== 'libraries');   // (SVG elements have no .hidden property, so use the attribute)

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
      onSelect: () => navigate({ screen: 'library', lib: l.id, title: l.title }),
    })));
    if (skipped.length) {
      screenEl.append(h('p', { class: 'note' }, 'Not shown (this app plays movies and TV only): ' + skipped.map((l) => l.title).join(', ')));
    }
    screenEl.append(h('p', { class: 'note note-ver' }, 'Plex Glasses v' + VERSION));
    focusInitial();
  }

  function getLibraries() {
    if (!cache.libs) cache.libs = Plex.libraries().catch((e) => { cache.libs = null; throw e; });
    return cache.libs;
  }

  // ---------- screen: a library's items, alphabetical ----------
  function openRow(r) {
    if (r.ty === 'movie') navigate({ screen: 'movie', id: r.k, title: r.t });
    else if (r.ty === 'show') navigate({ screen: 'show', id: r.k, title: r.t });
    else if (r.ty === 'season') navigate({ screen: 'season', id: r.k, title: r.t });
    else navigate({ screen: 'player', id: r.k, kind: r.ty });
  }

  function rowOpts(r) {
    return {
      key: 'it:' + r.k,
      label: r.t,
      sub: r.ty === 'show' && r.c ? r.c + (r.c === 1 ? ' season' : ' seasons') : (r.y || ''),
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

  function renderLetters(state, idx) {
    const remembered = lastLetter.get(state.lib);
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
      b.addEventListener('click', () => pickLetter(state, idx, strip, rowsHost, L));
      strip.append(b);
    });
    screenEl.replaceChildren(h('div', { class: 'lib' }, strip, rowsHost));
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

  function pickLetter(state, idx, strip, rowsHost, L) {
    lastLetter.set(state.lib, L);
    state.letter = L;
    history.replaceState(state, '');           // Back from a title returns to this letter
    Array.prototype.forEach.call(strip.children, (c) => {
      if (c.dataset.key === 'ch:' + L) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
    });
    fillRows(rowsHost, idx.sorted(L), PAGE);
    screenEl.scrollTop = 0;
    const first = $('.item', rowsHost);
    if (first) first.focus();
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
    host.replaceChildren(ul);
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
      class: 'btn btn-primary btn-play', type: 'button', 'data-autofocus': '', 'data-key': 'play',
      onclick: () => navigate({ screen: 'player', id: m.ratingKey, kind: 'movie' }),
    }, h('span', { class: 'play-badge' }, icon('play')), h('span', { class: 'play-text' }, 'Play'));

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
    item: null, session: '', mode: '', ladder: [], idx: 0, errors: [], qs: [], q: 0,
    offset: 0, base: 0, baseSet: false, dur: 0, streamSeq: 0, pending: null, started: false,
    needAdvance: false, advFrom: 0, stalls: 0, stallTimes: [], rebuf: false, rebufTimer: 0,
    hideTimer: 0, tick: 0, watchdog: 0, hls: null, decisionText: '',
  };
  const MODE_NAME = { 'hls-native': 'HLS', 'hls-js': 'HLS (hls.js)', mp4: 'MP4' };
  // If playback keeps stalling, the app steps down through these (only ones below your configured quality are used).
  const QUALITY = [{ r: '854x480', b: 2000 }, { r: '640x360', b: 1200 }, { r: '480x270', b: 700 }, { r: '426x240', b: 400 }];
  // A 1x1 transparent picture: stops the browser drawing its own grey "play" placeholder over the black screen.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const pbFor = (protocol) => {
    const q = P.qs[P.q] || { r: pb.videoResolution, b: pb.maxVideoBitrate };
    return Object.assign({}, pb, { protocol, videoResolution: q.r, maxVideoBitrate: q.b });
  };
  function buildQualities() {
    const first = { r: pb.videoResolution, b: pb.maxVideoBitrate };
    return [first].concat(pb.autoLowerQuality ? QUALITY.filter((q) => q.b < first.b) : []);
  }

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
      if (nativeHls) ladder.push('hls-native');
      if (mse) ladder.push('hls-js');
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
    const urls = pb.hlsJsUrl ? [pb.hlsJsUrl] : ['js/vendor/hls.min.js', 'https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js'];
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
    const q = P.qs[P.q];
    pstat.textContent = [
      MODE_NAME[P.mode],
      q ? q.r.replace('x', '\u00D7') + ' @ ' + q.b / 1000 + ' Mbps' : '',
      'buffer ' + Math.round(bufferedAhead()) + 's',
      'stalls ' + P.stalls,
    ].filter(Boolean).join(' \u00B7 ');
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
    surface.hidden = true;
    armHide();
  }

  function hideControls() {
    if (!perr.hidden) return;
    clearHide();
    ctrl.hidden = true;
    topbar.hidden = true;
    surface.hidden = false;
    surface.focus({ preventScroll: true });
  }

  function resetPlayerUi() {
    ctrl.hidden = true;
    perr.hidden = true;
    topbar.hidden = true;
    surface.hidden = false;
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
    P.qs = buildQualities();
    P.q = 0;
    P.stalls = 0;
    P.stallTimes = [];
    P.rebuf = false;
    clearTimeout(P.rebufTimer);
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

    begin(0);
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
      if (pos > 1) video.addEventListener('loadedmetadata', () => { try { video.currentTime = pos; } catch (e) { /* ignore */ } }, { once: true });
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
        startPosition: pos > 1 ? pos : -1,
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
    P.stallTimes = P.stallTimes.filter((t) => now - t < 90000).concat(now);
    if (P.stallTimes.length >= 3 && P.q + 1 < P.qs.length) { stepDown(); return; }
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
    P.q += 1;
    P.stallTimes = [];
    const old = P.session;
    P.session = uuid();                 // fresh transcode session at the lower quality
    Plex.stop(old);
    begin(pos, 'Lowering quality to keep it smooth\u2026');
  }

  function heartbeat() {
    if (!P.item) return;
    Plex.ping(P.session);
    Plex.timeline(P.item, video.paused && !P.rebuf ? 'paused' : 'playing', position() * 1000, P.dur * 1000, P.session);
  }

  function teardownPlayer() {
    clearHide();
    clearInterval(P.tick);
    teardownEngine();
    const item = P.item;
    const session = P.session;
    const pos = position();
    P.item = null;
    P.streamSeq += 1;
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
  video.addEventListener('playing', () => {
    P.needAdvance = true;
    P.advFrom = video.currentTime;
    setPlayLabel(false);
    perr.hidden = true;
    armHide();
  });
  video.addEventListener('timeupdate', () => {
    if (P.needAdvance && !video.paused && Math.abs(video.currentTime - P.advFrom) > 0.25) {
      P.needAdvance = false;
      P.started = true;
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
