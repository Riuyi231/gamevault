(() => {
  'use strict';

  window.__errors = 0;
  window.addEventListener('error', (e) => {
    window.__errors++;
    console.error('GLOBAL-ERROR:', e.message, e.filename, e.lineno);
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__errors++;
    console.error('UNHANDLED-REJECTION:', e.reason && e.reason.message ? e.reason.message : e.reason);
  });

  const api = window.gamevault;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ═══════════════ CUSTOM CURSOR ═══════════════ */
  const Cursor = (() => {
    const dot = $('#cursor-dot');
    const ring = $('#cursor-ring');
    if (!dot || !ring) return null;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (coarse || reduced) return null;

    let mx = innerWidth / 2, my = innerHeight / 2;
    let rx = mx, ry = my;
    let raf = null;

    function tick() {
      rx += (mx - rx) * 0.16;
      ry += (my - ry) * 0.16;
      dot.style.left = mx + 'px';
      dot.style.top = my + 'px';
      ring.style.left = rx + 'px';
      ring.style.top = ry + 'px';
      raf = requestAnimationFrame(tick);
    }

    document.addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    });
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('button, .game-card, .filter-btn, a, input, select, .ctx-item');
      ring.classList.toggle('hovering', !!t);
    });
    document.addEventListener('mouseout', () => ring.classList.remove('hovering'));
    window.addEventListener('blur', () => { if (raf) { cancelAnimationFrame(raf); raf = null; } });
    window.addEventListener('focus', () => { mx = innerWidth / 2; my = innerHeight / 2; rx = mx; ry = my; });
    return { tick };
  })();

  /* ═══════════════ STATE ═══════════════ */
  const state = {
    allGames: [],
    visibleGames: [],
    filter: 'all',
    search: '',
    sort: 'name',
    columns: 5,
    selectedId: null,
    selectedIndex: -1,
    contextGame: null,
    coverGame: null,
    splashDone: false,
    splashFinishTimer: null,
    detailCache: new Map(),
    arcade: false,
    arcadeIndex: -1,
    consolesOpen: false,
    locale: window.GV_I18N ? window.GV_I18N.DEFAULT_LOCALE : 'es',
    customFolders: [],
    emulators: []
  };

  const GAMEPAD = {
    connected: false,
    pollTimer: null,
    heldSince: {},
    lastNav: {},
    prevPressed: {},
    initialDelay: 300,
    repeatRate: 80,
    deadzone: 0.25,
    index: -1
  };

  /* ═══════════════ SOUND FX (synthetic Web Audio) ═══════════════ */
  const Sound = (() => {
    let ctx = null;
    let muted = false;
    const master = { gain: 0.55 };

    function ensureCtx() {
      if (!ctx) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          ctx = new AC();
        } catch {
          return null;
        }
      }
      if (ctx.state === 'suspended') {
        try {
          ctx.resume();
        } catch {}
      }
      return ctx;
    }

    function tone(freq, dur, type, vol, when = 0, glideTo = null) {
      const c = ensureCtx();
      if (!c || muted) return;
      try {
        const t0 = c.currentTime + when;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * master.gain), t0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch {
        // ignore
      }
    }

    function setMuted(v) {
      muted = !!v;
    }
    function isMuted() {
      return muted;
    }
    function unlock() {
      ensureCtx();
    }
    // Navigation hover/short — soft tick
    function move() {
      tone(660, 0.05, 'sine', 0.22);
      tone(990, 0.05, 'sine', 0.1, 0.0, 1320);
    }
    // Select / confirm
    function select() {
      tone(523, 0.07, 'triangle', 0.3);
      tone(784, 0.09, 'triangle', 0.22, 0.04);
      tone(1046, 0.12, 'sine', 0.16, 0.08);
    }
    // Launch — ascending flourish
    function launch() {
      tone(392, 0.1, 'triangle', 0.3);
      tone(523, 0.1, 'triangle', 0.3, 0.06);
      tone(659, 0.14, 'triangle', 0.28, 0.12);
      tone(784, 0.22, 'sine', 0.2, 0.18);
    }
    // Back / deselect
    function back() {
      tone(420, 0.08, 'sine', 0.2, 0, 300);
    }
    // Error
    function error() {
      tone(200, 0.14, 'sawtooth', 0.14, 0, 130);
      tone(180, 0.16, 'sawtooth', 0.1, 0.06, 120);
    }
    return { move, select, launch, back, error, setMuted, isMuted, unlock };
  })();

  const FILTER_ORDER = ['all', 'steam', 'epic', 'gog', 'xbox', 'retro', 'other'];
  const PLATFORM_LABELS = { steam: 'Steam', epic: 'Epic', gog: 'GOG', xbox: 'Xbox', retro: 'Retro', other: 'Otro' };

  /* ═══════════════ I18N ═══════════════ */
  const I18N = window.GV_I18N || { LOCALES: {}, DICT: { es: {}, en: {} }, t: (l, k) => k, DEFAULT_LOCALE: 'es' };
  function T(key, vars) {
    return I18N.t(state.locale, key, vars);
  }
  function applyI18n() {
    $$('[data-i18n]').forEach((el) => { el.textContent = T(el.getAttribute('data-i18n')); });
    $$('[data-i18n-inner]').forEach((el) => { el.innerHTML = T(el.getAttribute('data-i18n-inner')); });
    $$('[data-i18n-title]').forEach((el) => { el.title = T(el.getAttribute('data-i18n-title')); });
    $$('[data-i18n-placeholder]').forEach((el) => { el.placeholder = T(el.getAttribute('data-i18n-placeholder')); });
    $$('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', T(el.getAttribute('data-i18n-aria-label'))); });
    document.documentElement.lang = state.locale;
  }

  function platformKeyOf(game) {
    return (game && game.source) === 'retro' ? 'retro' : (game.platform || game.source || 'other');
  }
  function platformLabelOf(game) {
    if (game && game.source === 'retro' && game.platform) return game.platform;
    return T('platform.' + platformKeyOf(game));
  }

  /* ═══════════════ SPLASH ═══════════════ */
  const splash = $('#splash');
  const splashBar = $('#splash-bar-fill');
  const splashStatus = $('#splash-status');
  const splashPercent = $('#splash-percent');

  function updateSplash(val, message) {
    const p = Math.max(0, Math.min(100, Math.round(val)));
    if (splashBar) splashBar.style.width = p + '%';
    if (splashPercent) splashPercent.textContent = p + '%';
    if (message && splashStatus) splashStatus.textContent = message;
  }

  function finishSplash() {
    if (state.splashDone) return;
    state.splashDone = true;
    if (state.splashFinishTimer) clearTimeout(state.splashFinishTimer);
    updateSplash(100, T('splash.ready'));
    setTimeout(() => {
      splash.classList.add('faded');
      const app = $('#app');
      app.classList.remove('hidden');
      app.classList.add('visible');
      setTimeout(() => {
        splash.style.display = 'none';
        applyColumns();
        openHome();
        Sound.unlock();
      }, 700);
    }, 300);
  }

  const splashFallback = setInterval(() => {
    updateSplash((parseInt(splashPercent.textContent, 10) || 0) + 3, splashStatus.textContent);
    if (state.splashDone) clearInterval(splashFallback);
  }, 260);

  state.splashFinishTimer = setTimeout(finishSplash, 15000);

  /* ═══════════════ TITLEBAR ═══════════════ */
  $('#btn-minimize').addEventListener('click', () => api.minimize());
  $('#btn-maximize').addEventListener('click', () => api.maximize());
  $('#btn-close').addEventListener('click', () => api.close());

  /* ═══════════════ FILTERS ═══════════════ */
  function setFilter(filter) {
    state.filter = filter;
    $$('.filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
    const chipLabel = filter === 'all' ? '' : (PLATFORM_LABELS[filter] ? T('platform.' + filter) : filter);
    $('#filter-chip').classList.toggle('hidden', !chipLabel);
    $('#filter-chip-label').textContent = chipLabel;
    applyVisible();
  }

  $('#filter-chip-clear').addEventListener('click', () => setFilter('all'));

  $$('.filter-btn').forEach((btn) => {
    if (btn.id === 'consoles-btn') return;
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });

  function cycleFilter(dir) {
    const idx = FILTER_ORDER.indexOf(state.filter);
    const next = (idx + dir + FILTER_ORDER.length) % FILTER_ORDER.length;
    setFilter(FILTER_ORDER[next]);
  }

  /* ═══════════════ SEARCH ═══════════════ */
  $('#search-input').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    applyVisible();
  });

  /* ═══════════════ SORT ═══════════════ */
  $('#sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyVisible();
  });

  /* ═══════════════ COLUMNS ═══════════════ */
  function applyColumns() {
    const grid = $('#games-grid');
    const gap = 18;
    const width = (grid && grid.clientWidth) || 900;
    const per = (width - gap * (state.columns - 1)) / state.columns;
    const cardMin = Math.max(104, Math.min(320, Math.round(per)));
    document.documentElement.style.setProperty('--card-min', cardMin + 'px');
    $('#col-value').textContent = state.columns;
    $('#range-col-value').textContent = state.columns;
    $('#set-columns').value = state.columns;
  }

  function setColumns(cols) {
    cols = Math.max(3, Math.min(10, Math.round(cols)));
    if (cols === state.columns) {
      applyColumns();
      return;
    }
    state.columns = cols;
    applyColumns();
    saveSettings({ columns: cols });
  }

  $('#col-minus').addEventListener('click', () => setColumns(state.columns - 1));
  $('#col-plus').addEventListener('click', () => setColumns(state.columns + 1));
  window.addEventListener('resize', () => {
    if (state.splashDone) applyColumns();
  });

  /* ═══════════════ REFRESH ═══════════════ */
  $('#refresh-btn').addEventListener('click', async () => {
    const btn = $('#refresh-btn');
    btn.classList.add('spinning');
    try {
      toast(T('scan.refreshing'));
      await api.rescan();
      await loadGames();
      toast(T('scan.libraryUpdated'), 'success');
    } catch (err) {
      console.error('Rescan failed:', err);
      toast(T('scan.scanFailed'), 'error');
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 400);
    }
  });

  $('#empty-add-folder').addEventListener('click', addFolder);

  /* ═══════════════ GAMES CORE ═══════════════ */
  async function loadGames() {
    try {
      const games = await api.getGames();
      state.allGames = games || [];
      updateCounts();
      applyVisible();
      if (typeof loadEmulators === 'function') loadEmulators();
    } catch (err) {
      console.error('Failed to load games:', err);
    }
  }

  function mergeGame(game) {
    const existing = state.allGames.find((g) => g.id === game.id);
    if (existing) {
      Object.assign(existing, game);
    } else {
      state.allGames.push(game);
    }
    updateCounts();
    applyVisible();
  }

  function removeGameFromState(id) {
    state.allGames = state.allGames.filter((g) => g.id !== id);
    if (state.selectedId === id) {
      state.selectedId = null;
      state.selectedIndex = -1;
      hideDetail();
    }
    state.detailCache.delete(id);
    updateCounts();
    applyVisible();
  }

  async function deleteGameFromDisk(game) {
    if (!game) return;
    if (!game.installDir) {
      toast(T('delete.noLocation'), 'error');
      return;
    }
    const name = game.name || T('delete.thisGame');
    const sizeText = game.sizeOnDisk ? ` (${(game.sizeOnDisk / 1073741824).toFixed(1)} GB)` : '';
    const ok = confirm(T('delete.confirm', { name, size: sizeText, path: game.installDir }));
    if (!ok) return;

    try {
      const result = await api.deleteGameFromDisk(game.id);
      if (result && result.success) {
        removeGameFromState(game.id);
        toast(T('delete.done', { name: game.name }));
      } else {
        toast(T('delete.failed', { error: (result && result.error) || 'error' }), 'error');
      }
    } catch (err) {
      console.error('Delete error:', err);
      toast(T('delete.error'), 'error');
    }
  }

  function updateCounts() {
    const counts = { all: state.allGames.length, steam: 0, epic: 0, gog: 0, xbox: 0, retro: 0, other: 0 };
    for (const g of state.allGames) {
      const p = g.platform || g.source;
      if (g.source === 'retro') counts.retro++;
      else if (p === 'steam') counts.steam++;
      else if (p === 'epic') counts.epic++;
      else if (p === 'gog') counts.gog++;
      else if (p === 'xbox') counts.xbox++;
      else counts.other++;
    }

    $('#count-all').textContent = counts.all;
    $('#count-steam').textContent = counts.steam;
    $('#count-epic').textContent = counts.epic;
    $('#count-gog').textContent = counts.gog;
    const countXbox = $('#count-xbox');
    if (countXbox) countXbox.textContent = counts.xbox;
    const countRetro = $('#count-retro');
    if (countRetro) countRetro.textContent = counts.retro;
    $('#count-other').textContent = counts.other;

    $('#game-count').textContent = T('counts.games', { n: counts.all });
    $('#stats-games').textContent = T('counts.games', { n: counts.all });

    const platformsPresent = FILTER_ORDER.slice(1).filter((p) => counts[p] > 0).length;
    $('#stats-platforms').textContent = T('counts.platforms', { n: platformsPresent });
  }

  function applyVisible() {
    let games = [...state.allGames];

    if (state.filter !== 'all') {
      if (state.filter === 'retro') {
        games = games.filter((g) => g.source === 'retro');
      } else {
        games = games.filter((g) => (g.platform || g.source) === state.filter);
      }
    }

    if (state.search) {
      games = games.filter((g) => g.name.toLowerCase().includes(state.search));
    }

    switch (state.sort) {
      case 'platform': {
        const order = { steam: 0, epic: 1, gog: 2, xbox: 3, retro: 4, other: 5 };
        games.sort((a, b) => {
          const pa = order[a.platform || a.source] ?? 9;
          const pb = order[b.platform || b.source] ?? 9;
          if (pa !== pb) return pa - pb;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        break;
      }
      case 'recent':
        games.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
        break;
      case 'mostplayed':
        games.sort((a, b) => (b.playtimeMs || 0) - (a.playtimeMs || 0));
        break;
      case 'added':
        games.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        break;
      default:
        games.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        break;
    }

    state.visibleGames = games;
    renderGrid();
  }

  /* ═══════════════ RENDER ═══════════════ */
  function renderGrid() {
    const grid = $('#games-grid');
    const empty = $('#empty-state');

    if (state.splashDone) applyColumns();

    if (state.visibleGames.length === 0) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      state.selectedIndex = -1;
      state.selectedId = null;
      hideDetail();
      renderHero(null);
      return;
    }

    empty.classList.add('hidden');
    grid.innerHTML = '';

    const colsForDelay = Math.max(1, state.columns || 1);
    let originIdx = 0;
    if (state.selectedId) {
      const si = state.visibleGames.findIndex((g) => g.id === state.selectedId);
      if (si >= 0) originIdx = si;
    }
    const ox = originIdx % colsForDelay;
    const oy = Math.floor(originIdx / colsForDelay);

    state.visibleGames.forEach((game, index) => {
      const card = createGameCard(game);
      const cx = index % colsForDelay;
      const cy = Math.floor(index / colsForDelay);
      const dist = Math.hypot(cx - ox, cy - oy);
      card.style.setProperty('--anim-delay', `${Math.min(dist * 0.045, 0.5)}s`);
      grid.appendChild(card);
    });

    if (state.selectedId && state.visibleGames.some((g) => g.id === state.selectedId)) {
      const selected = grid.querySelector(`.game-card[data-id="${state.selectedId}"]`);
      if (selected) selected.classList.add('selected');
      const selGame = state.visibleGames.find((g) => g.id === state.selectedId);
      renderHero(selGame);
      heroApplyDesc(selGame);
    } else {
      renderHero(state.visibleGames[0] || null);
      if (state.visibleGames.length > 0) heroApplyDesc(state.visibleGames[0]);
    }
  }

  function createGameCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.dataset.id = game.id;
    card.tabIndex = -1;

    const platformKey = platformKeyOf(game);
    const platformLabel = platformLabelOf(game);
    const recentTag = isRecent(game) ? '<span class="game-card-new">' + esc(T('badge.new')) + '</span>' : '';

    card.innerHTML = `
      <div class="game-card-cover">
        <div class="shimmer"></div>
        <img alt="${esc(game.name)}" draggable="false">
        <span class="platform-badge ${platformKey}">${platformLabel}</span>
        <div class="launch-overlay">
          <div class="play-badge">
            <svg viewBox="0 0 24 24"><polygon points="6,3 20,12 6,21"/></svg>
          </div>
        </div>
      </div>
      <div class="game-card-info">
        <div class="game-card-name">${esc(game.name)}${recentTag}</div>
        <div class="game-card-source">
          <span class="source-dot ${platformKey}"></span>
          ${esc(platformLabel)}
        </div>
      </div>
    `;

    const img = card.querySelector('img');
    const shimmer = card.querySelector('.shimmer');

    const applyImage = (url) => {
      img.onload = () => {
        shimmer.classList.add('done');
        img.classList.add('img-in');
      };
      img.onerror = () => {
        if (url !== 'default-cover.svg') {
          applyImage('default-cover.svg');
        } else {
          shimmer.classList.add('done');
          img.classList.add('img-in');
        }
      };
      img.src = url;
    };

    const coverSrc = getCoverSrc(game);
    applyImage(coverSrc || 'default-cover.svg');

    card.addEventListener('mousemove', (e) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty('--tilt-x', `${(-py * 8).toFixed(2)}deg`);
      card.style.setProperty('--tilt-y', `${(px * 8).toFixed(2)}deg`);
      card.style.setProperty('--tilt-scale', '1.06');
    });
    card.addEventListener('mouseleave', (e) => {
      card.style.setProperty('--tilt-x', '0deg');
      card.style.setProperty('--tilt-y', '0deg');
      card.style.setProperty('--tilt-scale', '1');
    });
    card.addEventListener('click', () => {
      openGamePage(game.id);
      Sound.select();
    });
    card.addEventListener('dblclick', () => launchGame(game.id));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectGame(game.id);
      state.contextGame = game;
      showContextMenu(e.clientX, e.clientY);
    });
    card.addEventListener('mouseenter', (e) => showTooltip(e, game));
    card.addEventListener('mouseleave', hideTooltip);

    return card;
  }

  function getCoverSrc(game) {
    if (game.localCoverDataUrl) return game.localCoverDataUrl;
    if (game.hasLocalCover && game.localCoverPath) {
      return 'file:///' + encodeURI(game.localCoverPath.replace(/\\/g, '/'));
    }
    if (game.coverUrl) return game.coverUrl;
    return 'default-cover.svg';
  }

  // Panoramic landscape background (hero/home/arcade). Falls back to the cover.
  function getBannerSrc(game) {
    if (game.bannerUrl) return game.bannerUrl;
    const cached = state.detailCache.get(game.id);
    if (cached && cached.banner) return cached.banner;
    if (game.appId && /^\d{1,8}$/.test(String(game.appId))) {
      return `https://cdn.akamai.steamstatic.com/steam/apps/${game.appId}/header.jpg`;
    }
    return getCoverSrc(game);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isRecent(game) {
    if (!game.addedAt) return false;
    const added = new Date(game.addedAt).getTime();
    if (isNaN(added)) return false;
    const week = 7 * 24 * 3600 * 1000;
    return (Date.now() - added) < week;
  }

  /* ═══════════════ DETAIL PANEL ═══════════════ */
  let hideDetailTimer = null;

  function showDetail() {
    const page = $('#game-page');
    clearTimeout(hideDetailTimer);
    page.classList.remove('closing');
    page.classList.remove('hidden');
    page.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => page.classList.add('open'));
  }

  function hideDetail() {
    const page = $('#game-page');
    page.classList.remove('open');
    page.classList.add('closing');
    page.setAttribute('aria-hidden', 'true');
    clearTimeout(hideDetailTimer);
    hideDetailTimer = setTimeout(() => page.classList.add('hidden'), 420);
  }

  function gamePageOpen() {
    return $('#game-page').classList.contains('open');
  }

  function selectGame(id) {
    state.selectedId = id;
    state.selectedIndex = state.visibleGames.findIndex((g) => g.id === id);
    $$('.game-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));

    const card = $(`.game-card[data-id="${id}"]`);
    if (card) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    const game = state.allGames.find((g) => g.id === id) || state.visibleGames.find((g) => g.id === id);
    if (game) {
      renderHero(game);
      heroApplyDesc(game);
    }
  }

  function openGamePage(id) {
    const game = state.allGames.find((g) => g.id === id) || state.visibleGames.find((g) => g.id === id);
    if (!game) return;
    selectGame(id);
    if (!gamePageOpen()) {
      const card = $(`.game-card[data-id="${id}"]`);
      if (card) playPortal(card);
      renderDetailPanel(game);
    }
    Sound.unlock();
  }

  function playPortal(card) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!card || !document.body.contains(card)) return;
    const cover = card.querySelector('.game-card-cover');
    if (!cover) return;
    card.classList.add('portaling');
    const r = cover.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = vw / 2 - (r.left + r.width / 2);
    const cy = vh / 2 - (r.top + r.height / 2);
    const anim = cover.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${cx * 0.7}px, ${cy * 0.7}px) scale(3)`, opacity: 0.15 },
        { transform: `translate(${cx}px, ${cy}px) scale(4.2)`, opacity: 0 }
      ],
      { duration: 520, easing: 'cubic-bezier(0.3, 1, 0.4, 1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      anim.cancel();
      cover.style.opacity = '1';
      card.classList.remove('portaling');
    };
  }

  function deselectGame() {
    state.selectedId = null;
    state.selectedIndex = -1;
    $$('.game-card').forEach((c) => c.classList.remove('selected'));
    hideDetail();
    Sound.back();
  }

  function renderDetailPanel(game) {
    if (!game) {
      hideDetail();
      return;
    }
    showDetail();

    const bg = $('#gp-bg');
    const bannerSrc = getBannerSrc(game);
    bg.style.backgroundImage = bannerSrc && bannerSrc !== 'default-cover.svg' ? `url("${bannerSrc}")` : '';

    const img = $('#gp-cover');
    const shimmer = $('.detail-shimmer');
    const coverSrc = getCoverSrc(game);

    img.classList.remove('loaded');
    shimmer.classList.remove('done');
    const loadCover = (url) => {
      img.onload = () => {
        shimmer.classList.add('done');
        img.classList.add('loaded');
      };
      img.onerror = () => {
        if (url !== 'default-cover.svg') {
          img.src = 'default-cover.svg';
          shimmer.classList.add('done');
          img.classList.add('loaded');
        } else {
          shimmer.classList.add('done');
          img.classList.add('loaded');
        }
      };
      if (img.src !== url) img.src = url;
      else { shimmer.classList.add('done'); img.classList.add('loaded'); }
    };
    loadCover(coverSrc);

    $('#gp-title').textContent = game.name;

    const platformKey = platformKeyOf(game);
    const platEl = $('#gp-platform');
    platEl.textContent = platformLabelOf(game);
    platEl.className = 'detail-platform ' + platformKey;
    $('#gp-source').textContent = game.source === 'retro'
      ? T('detail.source.retro', { platform: game.platform || T('emu.emulator') })
      : game.source === 'custom'
        ? T('detail.source.manual')
        : (game.source || game.platform || platformKey);

    const recentEl = $('#gp-recent');
    recentEl.hidden = !isRecent(game);

    const playtimeEl = $('#gp-playtime');
    playtimeEl.hidden = !(game.playtimeMs > 0);
    playtimeEl.textContent = game.playtimeMs > 0 ? formatPlaytime(game.playtimeMs) : '';

    renderDetailMeta(game, null);
    renderShots(null);

    const desc = $('#gp-desc');
    desc.className = 'gp-desc loading';
    desc.innerHTML = `<div class="gp-desc-inner">${esc(T('detail.loading'))}</div>`;

    const id = game.id;
    const cached = state.detailCache.get(id);
    if (cached) {
      applyDetailInfo(id, cached);
    } else {
      Promise.resolve()
        .then(() => api.getGameInfo(game))
        .then((res) => {
          const info = res && (res.shortDescription !== undefined) ? res : null;
          if (info) state.detailCache.set(id, info);
          if (state.selectedId === id) applyDetailInfo(id, info);
        })
        .catch(() => {
          if (state.selectedId === id) applyDetailInfo(id, null);
        });
    }
  }

  function applyDetailInfo(id, info) {
    if (state.selectedId !== id) return;

    const desc = $('#gp-desc');
    const game = state.allGames.find((g) => g.id === id);
    if (game && info && info.banner && !game.bannerUrl) {
      game.bannerUrl = info.banner;
      $('#gp-bg').style.backgroundImage = `url("${info.banner}")`;
    }
    if (game && info && info.coverUrl && !game.coverUrl && !game.hasLocalCover) {
      game.coverUrl = info.coverUrl;
      if (state.selectedId === id) applyVisible();
    }
    if (info && (info.detailedDescription || info.about || info.shortDescription)) {
      const descText = info.detailedDescription || info.about || info.shortDescription || '';
      desc.className = 'gp-desc';
      desc.innerHTML = `<div class="gp-desc-inner">${esc(descText)}</div>`;
    } else if (info && info.discoveredName && info.discoveredName !== game.name) {
      desc.className = 'gp-desc';
      desc.innerHTML = `<div class="gp-desc-inner">${T('detail.desc.discovered', { name: esc(info.discoveredName) })}</div>`;
    } else {
      const lines = [];
      if (game.source === 'retro') {
        lines.push(T('detail.desc.romLine', { name: esc(game.name), platform: esc(game.platform || T('emu.emulator')) }));
      } else {
        lines.push(T('detail.desc.installed', { name: esc(game.name) }));
      }
      const platformKey = game.platform || game.source || 'other';
      lines.push(T('detail.desc.platform', { label: esc(platformLabelOf(game)) }));
      if (game.romPath) {
        lines.push(T('detail.desc.rom', { path: esc(game.romPath) }));
      }
      if (game.sizeOnDisk) {
        lines.push(T('detail.desc.size', { size: (game.sizeOnDisk / 1073741824).toFixed(1) }));
      }
      if (game.installDir) {
        lines.push(T('detail.desc.location', { path: esc(game.installDir) }));
      }
      if (game.lastPlayed) {
        const d = new Date(game.lastPlayed);
        lines.push(T('detail.desc.lastPlayed', { date: esc(d.toLocaleDateString(localeTag())) }));
      }
      if (game.playtimeMs > 0) {
        lines.push(T('detail.desc.playtime', { time: esc(formatPlaytime(game.playtimeMs)) }));
      }
      lines.push(T('detail.desc.noInfo'));
      desc.className = 'gp-desc';
      desc.innerHTML = `<div class="gp-desc-inner">${lines.join('<br>')}</div>`;
    }

    renderShots(info);
    renderDetailMeta(game, info);
  }

  function renderShots(info) {
    const section = $('#gp-shots-section');
    const wrap = $('#gp-shots');
    const shots = (info && Array.isArray(info.screenshots)) ? info.screenshots.filter(Boolean) : [];
    if (!shots.length) {
      section.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }
    section.classList.remove('hidden');
    wrap.innerHTML = '';
    shots.forEach((src) => {
      const el = document.createElement('div');
      el.className = 'gp-shot';
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      img.onerror = () => el.classList.add('gp-shot-missing');
      img.onclick = () => openShotView(src);
      el.appendChild(img);
      wrap.appendChild(el);
    });
  }

  function openShotView(src) {
    const view = $('#shot-view');
    const img = $('#shot-img');
    img.src = src;
    view.classList.remove('hidden');
  }

  function closeShotView() {
    const view = $('#shot-view');
    if (!view.classList.contains('hidden')) {
      view.classList.add('hidden');
      $('#shot-img').src = '';
    }
  }

  function renderDetailMeta(game, info) {
    const meta = $('#gp-meta');
    const stats = [];

    if (info && info.releaseDate) stats.push(stat(T('meta.release'), esc(info.releaseDate)));
    const metascore = info && (info.metascore || info.rating);
    if (metascore != null) stats.push(stat(T('meta.score'), esc(metascore)));
    if (game && game.sizeOnDisk) stats.push(stat(T('meta.size'), `${(game.sizeOnDisk / 1073741824).toFixed(1)} GB`));
    if (game && game.playtimeMs > 0) stats.push(stat(T('meta.played'), formatPlaytime(game.playtimeMs)));
    if (info && info.developers && info.developers.length) stats.push(stat(T('meta.devs'), esc(info.developers.slice(0, 3).join(', '))));
    if (info && info.publishers && info.publishers.length) stats.push(stat(T('meta.pubs'), esc(info.publishers.slice(0, 2).join(', '))));

    let genresHtml = '';
    if (info && info.genres && info.genres.length) {
      genresHtml = `<div class="gp-genres">${info.genres.slice(0, 8).map((g) => `<span class="meta-chip">${esc(g)}</span>`).join('')}</div>`;
    }

    meta.innerHTML = stats.length ? `<div class="gp-stats">${stats.join('')}</div>${genresHtml}` : (genresHtml || '');
  }

  function stat(k, v) {
    return `<div class="gp-stat"><div class="gp-stat-v">${v}</div><div class="gp-stat-k">${k}</div></div>`;
  }

  function formatPlaytime(ms) {
    const totalMin = Math.round((ms || 0) / 60000);
    if (totalMin < 1) return T('playtime.lessThanMin');
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return T('playtime.min', { m });
    if (m === 0) return T('playtime.hour', { h });
    return T('playtime.hours', { h, m });
  }

  /* ═══════════════ LAUNCH ═══════════════ */
  function showLaunchOverlay(game) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const el = $('#launch-overlay');
    const cover = $('#launch-cover');
    const title = $('#launch-title');
    const src = getCoverSrc(game);

    title.textContent = game.name;
    cover.onerror = () => { cover.src = 'default-cover.svg'; };
    cover.src = src;

    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
  }
  function hideLaunchOverlay() {
    const el = $('#launch-overlay');
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
  }

  async function launchGame(id) {
    const game = state.allGames.find((g) => g.id === id);
    if (!game) return;
    Sound.launch();
    const playBtn = $('#gp-play');
    playBtn.classList.add('loading');
    showLaunchOverlay(game);
    try {
      const result = await api.launchGame(id);
      if (result && result.success) {
        toast(T('launch.launching', { name: game.name }));
      } else {
        const detail = result && result.error;
        toast(detail ? `${T('launch.failed', { name: game.name })} ${detail}` : T('launch.failed', { name: game.name }), 'error');
        console.warn('Launch failed:', result && result.error);
      }
    } catch (err) {
      console.error('Launch error:', err);
      toast(T('launch.error'), 'error');
    } finally {
      setTimeout(() => playBtn.classList.remove('loading'), 420);
      setTimeout(hideLaunchOverlay, 700);
    }
  }

  /* ═══════════════ HERO / DESTACADO ═══════════════ */
  function renderHero(game) {
    const hero = $('#hero');
    if (!game) {
      hero.classList.add('hidden');
      return;
    }
    hero.classList.remove('hidden');
    hero.classList.remove('hero-refresh');
    void hero.offsetWidth;
    hero.classList.add('hero-refresh');

    const bg = $('#hero-bg');
    const img = $('#hero-cover');
    const shimmer = $('.hero-shimmer');

    const coverSrc = getCoverSrc(game);
    const bannerSrc = getBannerSrc(game);
    img.classList.remove('loaded');
    shimmer.classList.remove('done');
    const loadCover = (url) => {
      img.onload = () => {
        shimmer.classList.add('done');
        img.classList.add('loaded');
        bg.style.backgroundImage = `url("${bannerSrc}")`;
      };
      img.onerror = () => {
        shimmer.classList.add('done');
        img.classList.add('loaded');
        bg.style.backgroundImage = '';
      };
      if (img.src !== url) img.src = url;
      else { shimmer.classList.add('done'); img.classList.add('loaded'); bg.style.backgroundImage = `url("${bannerSrc}")`; }
    };
    loadCover(coverSrc);
    if (bannerSrc === 'default-cover.svg') bg.style.backgroundImage = '';

    $('#hero-title').textContent = game.name;
    $('#hero-platform').textContent = platformLabelOf(game);
    $('#hero-platform').className = 'detail-platform ' + platformKeyOf(game);
    $('#hero-source').textContent = game.source || game.platform || (game.platform || 'other');
  }

  function heroApplyDesc(game) {
    const desc = $('#hero-desc');
    const cached = state.detailCache.get(game.id);
    if (cached && cached.shortDescription) {
      desc.textContent = cached.shortDescription;
    } else {
      desc.textContent = '';
      const id = game.id;
      Promise.resolve()
        .then(() => api.getGameInfo(game))
        .then((res) => {
          const info = res && (res.shortDescription !== undefined) ? res : null;
          if (info) state.detailCache.set(id, info);
          if (state.selectedId === id && info) {
            desc.textContent = info.shortDescription || '';
            if (info.banner) {
              const g = state.allGames.find((x) => x.id === id);
              if (g) g.bannerUrl = info.banner;
              $('#hero-bg').style.backgroundImage = `url("${info.banner}")`;
            }
          }
        })
        .catch(() => {});
    }
  }

  /* ═══════════════ HOME (CONSOLA NEW-GEN) ═══════════════ */
  let homeOpen = false;
  let homeExitCallback = null;

  function recentGames(n = 5) {
    return state.allGames
      .filter((g) => g.lastPlayed)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, n);
  }

  function homeFeatured() {
    const recents = recentGames();
    if (recents.length > 0) return recents[0];
    if (state.visibleGames.length > 0) return state.visibleGames[0];
    return null;
  }

  function renderHome() {
    const game = homeFeatured();
    if (!game) {
      $('#home-title').textContent = T('home.emptyTitle');
      $('#home-desc').textContent = T('home.emptyDesc');
      $('#home-play').textContent = T('home.openLibrary');
      $('#home-bg').style.backgroundImage = '';
      $('#home-cover-img').src = 'default-cover.svg';
      renderHomeRecents();
      return;
    }
    const bg = $('#home-bg');
    const img = $('#home-cover-img');
    const shimmer = $('.home-shimmer');
    const coverSrc = getCoverSrc(game);
    const bannerSrc = getBannerSrc(game);

    img.classList.remove('loaded');
    shimmer.classList.remove('done');
    const loadCover = (url) => {
      img.onload = () => {
        shimmer.classList.add('done');
        img.classList.add('loaded');
        bg.style.backgroundImage = `url("${bannerSrc}")`;
      };
      img.onerror = () => {
        if (url !== 'default-cover.svg') loadCover('default-cover.svg');
        else { shimmer.classList.add('done'); img.classList.add('loaded'); bg.style.backgroundImage = ''; }
      };
      if (img.src !== url) img.src = url;
      else { shimmer.classList.add('done'); img.classList.add('loaded'); bg.style.backgroundImage = `url("${bannerSrc}")`; }
    };
    loadCover(coverSrc);
    if (bannerSrc === 'default-cover.svg') bg.style.backgroundImage = '';

    $('#home-title').textContent = game.name;
    $('#home-play').innerHTML =
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg> ${esc(T('home.continue'))}`;
    $('#home-desc').textContent = '';
    const cached = state.detailCache.get(game.id);
    if (cached && cached.shortDescription) {
      $('#home-desc').textContent = cached.shortDescription;
    } else {
      const id = game.id;
      Promise.resolve()
        .then(() => api.getGameInfo(game))
        .then((res) => {
          const info = res && (res.shortDescription !== undefined) ? res : null;
          if (info) state.detailCache.set(id, info);
          if (homeOpen) $('#home-desc').textContent = (info && info.shortDescription) || '';
        })
        .catch(() => {});
    }
    renderHomeRecents();
  }

  function renderHomeRecents() {
    const wrap = $('#home-recent');
    const recents = recentGames();
    wrap.innerHTML = '';
    if (recents.length === 0) {
      wrap.innerHTML = `<div class="home-recent-item" style="cursor:default"><span style="font-size:12px;color:var(--muted)">${esc(T('home.noRecent'))}</span></div>`;
      return;
    }
    recents.forEach((g, i) => {
      const item = document.createElement('div');
      item.className = 'home-recent-item';
      item.style.setProperty('--anim-delay', `${i * 0.05}s`);
      const img = document.createElement('img');
      img.src = getCoverSrc(g);
      img.onerror = () => { img.src = 'default-cover.svg'; };
      const info = document.createElement('div');
      const metaParts = [platformLabelOf(g)];
      if (g.playtimeMs > 0) metaParts.push(formatPlaytime(g.playtimeMs));
      info.innerHTML = `<div class="home-recent-name">${esc(g.name)}</div>` +
        `<div class="home-recent-meta">${metaParts.map(esc).join(' · ')}</div>`;
      item.appendChild(img);
      item.appendChild(info);
      item.addEventListener('click', () => { exitHome(g); });
      wrap.appendChild(item);
    });
  }

  function openHome() {
    if (state.visibleGames.length === 0 && state.allGames.length === 0) {
      // No public library content yet; skip home to avoid empty console feel
      return;
    }
    homeOpen = true;
    renderHome();
    const el = $('#home');
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeHome() {
    homeOpen = false;
    const el = $('#home');
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
  }

  function exitHome(game) {
    closeHome();
    if (game) {
      selectGame(game.id);
      if (state.selectedId) { renderHero(game); heroApplyDesc(game); }
    }
    Sound.select();
  }

  $('#home-play').addEventListener('click', () => {
    const g = homeFeatured();
    if (g) exitHome(g);
    else openLibraryNow();
  });
  $('#home-library').addEventListener('click', () => { closeHome(); Sound.select(); });
  $('#home-arcade').addEventListener('click', () => { closeHome(); openArcade(); Sound.select(); });

  function openLibraryNow() { closeHome(); }

  /* ═══════════════ ARCADE MODE ═══════════════ */
  function arcadeGame() {
    if (state.visibleGames.length === 0) return null;
    if (state.arcadeIndex < 0 || state.arcadeIndex >= state.visibleGames.length) {
      const si = state.selectedIndex >= 0 ? state.selectedIndex : 0;
      state.arcadeIndex = si;
    }
    return state.visibleGames[state.arcadeIndex];
  }

  function renderArcade(game) {
    if (!game) return;
    const bg = $('#arcade-bg');
    const cover = $('#arcade-cover');
    const shimmer = $('.arcade-shimmer');
    const coverSrc = getCoverSrc(game);
    const bannerSrc = getBannerSrc(game);

    cover.classList.remove('loaded');
    shimmer.classList.remove('done');
    const loadCover = (url) => {
      cover.onload = () => {
        shimmer.classList.add('done');
        cover.classList.add('loaded');
        bg.style.backgroundImage = `url("${bannerSrc}")`;
      };
      cover.onerror = () => {
        if (url !== 'default-cover.svg') loadCover('default-cover.svg');
        else {
          shimmer.classList.add('done');
          cover.classList.add('loaded');
          bg.style.backgroundImage = '';
        }
      };
      if (cover.src !== url) cover.src = url;
      else { shimmer.classList.add('done'); cover.classList.add('loaded'); bg.style.backgroundImage = `url("${bannerSrc}")`; }
    };
    loadCover(coverSrc);
    if (bannerSrc === 'default-cover.svg') bg.style.backgroundImage = '';

    $('#arcade-title').textContent = game.name;
    $('#arcade-platform').textContent = platformLabelOf(game);
    $('#arcade-platform').className = 'detail-platform ' + platformKeyOf(game);
    $('#arcade-counter').textContent = `${state.arcadeIndex + 1} / ${state.visibleGames.length}`;
  }

  function openArcade() {
    if (state.visibleGames.length === 0) return;
    state.arcade = true;
    renderArcade(arcadeGame());
    const el = $('#arcade');
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
  }

  function closeArcade() {
    state.arcade = false;
    const el = $('#arcade');
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
  }

  function arcadeNav(dir) {
    if (!state.arcade) return;
    const n = state.visibleGames.length;
    if (n === 0) return;
    state.arcadeIndex = (state.arcadeIndex + dir + n) % n;
    selectGame(state.visibleGames[state.arcadeIndex].id);
    renderArcade(arcadeGame());
    Sound.move();
  }

  $('#arcade-play').addEventListener('click', () => {
    const g = arcadeGame();
    if (g) {
      launchGame(g.id);
      setTimeout(closeArcade, 650);
    }
  });
  $('#arcade-exit').addEventListener('click', closeArcade);

  /* ═══════════════ CONSOLES DASHBOARD ═══════════════ */
  function consoleGroups() {
    const map = new Map();
    for (const g of state.allGames || []) {
      let key, label;
      if (g.source === 'retro') {
        key = 'c:' + (g.platform || 'Retro');
        label = g.platform || 'Retro';
      } else {
        key = 'p:' + platformKeyOf(g);
        label = T('platform.' + platformKeyOf(g)) || key;
      }
      const e = map.get(key) || { key, filter: key.slice(2), label, count: 0, playtimeMs: 0, lastPlayed: 0 };
      if (!map.has(key)) map.set(key, e);
      e.count += 1;
      e.playtimeMs += (g.playtimeMs || 0);
      if ((g.lastPlayed || 0) > e.lastPlayed) e.lastPlayed = g.lastPlayed;
    }
    for (const emu of state.emulators || []) {
      const key = 'c:' + (emu.console || 'Retro');
      if (!map.has(key)) {
        map.set(key, { key, filter: emu.console || 'Retro', label: emu.console || 'Retro', count: 0, playtimeMs: 0, lastPlayed: 0 });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
  }

  function colorForTag(tag) {
    let h = 0;
    for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
    return h;
  }

  function monogramOf(label) {
    const word = String(label || '?').split(/[\s/]+/).filter(Boolean);
    const letters = word.map((w) => w[0].toUpperCase());
    if (letters.length <= 1) {
      const raw = (label || '?').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      return raw.slice(0, 3) || '?';
    }
    return letters.slice(0, 3).join('');
  }

  // Icono estilizado por plataforma/consola en vez del monograma genérico.
  function platformIconOf(keyOrLabel) {
    const v = String(keyOrLabel || '').trim();
    const low = v.toLowerCase();

    const stroke = 'stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"';
    const solid = 'fill="currentColor"';

    const brandIcons = {
      steam: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M12 3v9"/><path d="M12 12a4 4 0 0 1 4-4"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor" stroke="none"/><path d="M8 8l.5 3 2.5-1.4" fill="currentColor" stroke="none"/></svg>`,
      epic: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 2l6 4-6 4-6-4z" fill="currentColor" stroke="none"/><path d="M12 13l6-1-1.8 8-4.2-4-4.2 4L6 12z" fill="currentColor" stroke="none"/></svg>`,
      gog: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M8.2 12h7.6"/><path d="M5.5 9.2h13M5.5 14.8h13"/></svg>`,
      xbox: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M4 7.5c3 4.2 3.6 4.2 8 9 4.4-4.8 5-4.8 8-9"/><path d="M4 16.5c3-4.2 3.6-4.2 8-9 4.4 4.8 5 4.8 8 9"/></svg>`,
      retro: `<svg viewBox="0 0 24 24" ${stroke}><rect x="2" y="5" width="20" height="14" rx="3.5"/><rect x="5" y="8" width="10" height="8" rx="1"/><circle cx="18" cy="10" r="0.5" fill="currentColor" stroke="none"/><path d="M17.5 13.5v1.5M16.75 12v-1M19.25 12v-1" stroke-width="1.4"/></svg>`,
      other: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor" stroke="none"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`
    };
    if (brandIcons[low] && /^(steam|epic|gog|xbox|retro|other)$/.test(low)) return brandIcons[low];

    const consoleIcons = [
      { re: /nintendo 64|---|---|n64|\bn64\b/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="11" r="2.4" fill="currentColor" stroke="none"/><path d="M7.5 14.2v1.2M10.5 14.2v1.2"/><circle cx="14.5" cy="13.5" r="1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="11" r="1" fill="currentColor" stroke="none"/></svg>` },
      { re: /nes|famicom/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="6" width="18" height="12" rx="2"/><rect x="6.5" y="9" width="7" height="8" rx="0.8"/><rect x="14.5" y="10" width="3" height="1.6" rx="0.8"/><path d="M6.5 11.5h2M8.5 12v-1.4M8.5 15.2v-1.4"/></svg>` },
      { re: /snes|super nintendo/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="6" width="18" height="12" rx="3"/><rect x="8" y="9" width="8" height="7" rx="1"/><circle cx="11" cy="11.5" r="0.7" fill="currentColor" stroke="none"/><circle cx="13" cy="11.5" r="0.7" fill="currentColor" stroke="none"/><rect x="10.6" y="13.5" width="2.8" height="1.2" rx="0.6"/><path d="M16.4 9.4h-2.4"/></svg>` },
      { re: /game ?boy|gba|\bgbc\b/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="9" y="2" width="6" height="20" rx="2"/><path d="M9 6h6"/><rect x="7" y="6" width="10" height="12" rx="1.5"/><circle cx="11" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M10.5 12.8v2M9.5 13.8h2"/><circle cx="14" cy="12" r="1"/></svg>` },
      { re: /gamecube|dolphin|\bgc\b|nintendo gc/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="7.5" y="2.5" width="9" height="9" rx="1.5"/><rect x="3" y="13" width="7.5" height="8" rx="1.2"/><rect x="13.5" y="13" width="7.5" height="8" rx="1.2"/><rect x="9" y="13" width="6" height="3" rx="0.6"/><circle cx="6.5" cy="16" r="1" fill="currentColor" stroke="none"/><circle cx="17.5" cy="16" r="1" fill="currentColor" stroke="none"/></svg>` },
      { re: /wii/, svg: `<svg viewBox="0 0 24 24" ${stroke}><path d="M3.5 7h4l1.5 9 2-6.5L12 9l1 0.5 2 6.5 1.5-9h4"/><circle cx="6" cy="7" r="0.8" fill="currentColor" stroke="none"/></svg>` },
      { re: /nds|nintendo ds|3ds/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="4" width="18" height="9" rx="1.5"/><rect x="6" y="15" width="12" height="6" rx="1.2"/><path d="M5 6.5h4M5 9h2.5"/><line x1="18" y1="18" x2="18" y2="18"/></svg>` },
      { re: /playstation|\bps|\bpsp/, svg: `<svg viewBox="0 0 24 24" ${stroke}><path d="M4 15.5c2.2 1.4 4.5 1.6 6.8.6 1.8-.8 3.6-.6 5.4.5"/><path d="M4.5 18.6c2.3 1.2 4.7 1.3 7 .3 1.8-.8 3.7-.6 5.5.4"/><path d="M3.8 21.4c2.4 1.1 4.8 1.1 7.2 0 1.8-.8 3.7-.5 5.6.4"/></svg>` },
      { re: /sega|mega ?drive|genesis/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="4" width="18" height="10" rx="2"/><path d="M6 18h2M12 18h2M18 18h2" stroke-width="2"/><circle cx="16" cy="9" r="0.7" fill="currentColor" stroke="none"/><circle cx="8" cy="9" r="0.7" fill="currentColor" stroke="none"/><path d="M6 8.6h4M14 8.6h4" stroke-width="1.2"/></svg>` },
      { re: /saturn/, svg: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="9" ry="4"/><path d="M4 9c2.5 4 6 6 8 6s5.5-2 8-6"/></svg>` },
      { re: /dreamcast|dc/, svg: `<svg viewBox="0 0 24 24" ${stroke}><path d="M4 12a8 8 0 0 1 16 0"/><path d="M20 12a8 8 0 0 1-16 0"/><path d="M12 4v16"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="0.4" fill="currentColor" stroke="none"/></svg>` },
      { re: /atari/, svg: `<svg viewBox="0 0 24 24" ${stroke}><path d="M5 3h14l-3 18-5-3-5 3z" fill="currentColor" stroke="none" opacity="0.35"/><path d="M5 3h14l-6 9z"/></svg>` },
      { re: /arcade/, svg: `<svg viewBox="0 0 24 24" ${stroke}><rect x="4" y="12" width="16" height="8" rx="2"/><path d="M7 5l2.5-2 2 4M13 7l4-2M11 3h4"/><circle cx="8.5" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="16" r="1.2" fill="currentColor" stroke="none"/><path d="M5 12V8h14v4"/></svg>` }
    ];
    for (const c of consoleIcons) {
      if (c.re.test(low)) return c.svg;
    }

    return null;
  }

  function renderConsoles() {
    const groups = consoleGroups();
    const withGames = groups.filter((g) => g.count > 0);
    $('#consoles-count').textContent = withGames.length;

    const grid = $('#consoles-grid');
    if (groups.length === 0) {
      grid.innerHTML = `<div class="consoles-empty">${esc(T('consoles.empty'))}</div>`;
      return;
    }
    grid.innerHTML = groups.map((g) => {
      const hue = colorForTag(g.filter);
      const icon = platformIconOf(g.filter) || platformIconOf(g.label);
      const iconHtml = icon
        ? `<span class="console-icon" style="--tile-h:${hue}">${icon}</span>`
        : `<span class="console-monogram" style="--tile-h:${hue}">${esc(monogramOf(g.label))}</span>`;
      return `<button class="console-tile" data-filter="${esc(g.filter)}" role="button">
        ${iconHtml}
        <span class="console-name">${esc(g.label)}</span>
        <span class="console-count">${esc(T('consoles.games', { n: g.count }))}</span>
        <span class="console-playtime">${g.playtimeMs > 0 ? formatPlaytime(g.playtimeMs) : esc(T('consoles.unplayed'))}</span>
      </button>`;
    }).join('');

    grid.querySelectorAll('.console-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        setFilter(tile.dataset.filter);
        closeConsolesView();
        Sound.select();
        deselectGame();
      });
    });
  }

  function openConsolesView() {
    if (state.allGames.length === 0 && (state.emulators || []).length === 0) return;
    if ($('#emulators-view').classList.contains('active')) closeEmulatorsView();
    state.consolesOpen = true;
    renderConsoles();
    const el = $('#consoles-view');
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
    $('#consoles-btn').classList.add('active');
    $('#consoles-btn').setAttribute('aria-pressed', 'true');
  }

  function closeConsolesView() {
    state.consolesOpen = false;
    const el = $('#consoles-view');
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    $('#consoles-btn').classList.remove('active');
    $('#consoles-btn').setAttribute('aria-pressed', 'false');
  }

  /* ═══════════════ EMULATORS VIEW ═══════════════ */
  function emulatorCard(emu) {
    const icon = platformIconOf(emu.console || 'Retro');
    const iconHtml = icon
      ? `<span class="console-icon emu-card-icon">${icon}</span>`
      : `<span class="console-monogram">${esc(monogramOf(emu.name))}</span>`;
    const bundled = emu.bundled ? `<span class="emu-bundled">${esc(T('emu.bundled'))}</span>` : '';
    const status = emulatorStatusText(emu);
    const exeOk = emu.exePath ? `<span class="emu-card-path">${esc(emu.exePath)}</span>` : '';
    const roms = emu.romsPath ? `<span class="emu-card-path">${esc(emu.romsPath)}</span>` : '';
    return `<div class="emu-card" data-id="${esc(emu.id)}">
      ${iconHtml}
      <div class="emu-card-body">
        <div class="emu-card-head">
          <span class="emu-card-name">${bundled}${esc(emu.name)}</span>
          <span class="emu-card-console">${esc(emu.console || T('emu.emulator'))}</span>
        </div>
        <div class="emu-card-paths">${exeOk}${roms}</div>
        <div class="emu-item-status"><span class="emu-status-text ${status.empty ? 'emu-status-empty' : ''}">${status.text}</span></div>
      </div>
      <div class="emu-card-actions">
        ${emu.romsPath ? `<button class="emu-open" data-path="${esc(emu.romsPath)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${esc(T('emu.openRoms'))}</button>` : ''}
        <button class="emu-remove" data-id="${esc(emu.id)}" title="${esc(T('emu.removeTitle'))}">✕</button>
      </div>
    </div>`;
  }

  function renderEmulatorsView() {
    const grid = $('#emulators-grid');
    if (!grid) return;
    $('#emulators-count').textContent = (state.emulators || []).length;
    const emus = state.emulators || [];
    if (emus.length === 0) {
      grid.innerHTML = `<div class="consoles-empty">
        <p>${esc(T('emu.none'))}</p>
        <button class="btn-primary" id="emulators-empty-add" data-i18n="emu.addButton">${esc(T('emu.addButton'))}</button>
      </div>`;
      const btn = $('#emulators-empty-add');
      if (btn) btn.addEventListener('click', () => { closeEmulatorsView(); openDrawer(); });
      return;
    }
    grid.innerHTML = emus.map(emulatorCard).join('');

    grid.querySelectorAll('.emu-open').forEach((btn) => {
      btn.addEventListener('click', async () => { await api.openFolder(btn.dataset.path); });
    });
    grid.querySelectorAll('.emu-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api.removeEmulator(btn.dataset.id);
          await loadEmulators();
          toast(T('emu.removed'));
        } catch (err) {
          console.error('Remove emulator failed:', err);
          toast(T('emu.removeFailed'), 'error');
        }
      });
    });
  }

  function openEmulatorsView() {
    if ((state.emulators || []).length === 0 && state.allGames.length === 0) {
      openDrawer();
      return;
    }
    if (state.consolesOpen) closeConsolesView();
    renderEmulatorsView();
    const el = $('#emulators-view');
    el.classList.add('active');
    el.setAttribute('aria-hidden', 'false');
    $('#emulators-btn').classList.add('active');
    $('#emulators-btn').setAttribute('aria-pressed', 'true');
  }

  function closeEmulatorsView() {
    const el = $('#emulators-view');
    el.classList.remove('active');
    el.setAttribute('aria-hidden', 'true');
    $('#emulators-btn').classList.remove('active');
    $('#emulators-btn').setAttribute('aria-pressed', 'false');
  }

  $('#emulators-btn').addEventListener('click', () => {
    if ($('#emulators-view').classList.contains('active')) closeEmulatorsView();
    else openEmulatorsView();
    Sound.select();
  });
  $('#emulators-back').addEventListener('click', () => { closeEmulatorsView(); Sound.select(); });
  $('#emulators-add').addEventListener('click', () => { closeEmulatorsView(); openDrawer(); });

  $('#consoles-btn').addEventListener('click', () => {
    if (state.consolesOpen) closeConsolesView();
    else openConsolesView();
    Sound.select();
  });
  $('#consoles-back').addEventListener('click', () => { closeConsolesView(); Sound.select(); });

  /* ═══════════════ GAME PAGE WIRING ═══════════════ */
  $('#gp-play').addEventListener('click', () => {
    if (state.selectedId) launchGame(state.selectedId);
  });

  $('#hero-play').addEventListener('click', () => {
    if (state.selectedId) launchGame(state.selectedId);
  });

  $('#gp-back').addEventListener('click', () => {
    if (!state.selectedId) return;
    deselectGame();
  });

  $('#gp-close').addEventListener('click', () => {
    if (!state.selectedId) return;
    deselectGame();
  });

  $('#gp-folder').addEventListener('click', () => {
    if (!state.selectedId) return;
    const game = state.allGames.find((g) => g.id === state.selectedId);
    if (!game) return;
    if (game.installDir) {
      api.openFolder(game.installDir).catch(() => {});
    } else if (game.exePath) {
      api.openFolder(game.exePath.replace(/\\[^\\]*$/, '')).catch(() => {});
    } else if (game.romPath) {
      api.openFolder(game.romPath.replace(/\\[^\\]*$/, '')).catch(() => {});
    }
  });

  $('#gp-cover-link').addEventListener('click', () => {
    if (!state.selectedId) return;
    const game = state.allGames.find((g) => g.id === state.selectedId);
    if (game) openCoverModal(game);
  });

  const captureBtn = $('#gp-capture');
  const originalCaptureLabel = captureBtn ? captureBtn.querySelector('span') : null;
  captureBtn.addEventListener('click', async () => {
    if (!state.selectedId) return;
    const game = state.allGames.find((g) => g.id === state.selectedId);
    if (!game) return;
    if (game.launchUri && !game.exePath && !game.romPath) {
      toast(T('capture.notExternal'), 'error');
      return;
    }
    Sound.launch();
    const label = originalCaptureLabel;
    if (label) label.textContent = T('capture.counting');
    captureBtn.disabled = true;
    try {
      const result = await api.captureGameplay(game.id);
      if (result && result.ok) {
        game.hasLocalCover = true;
        game.localCoverPath = result.localCoverPath;
        applyVisible();
        if (state.selectedId === game.id) renderDetailPanel(game);
        toast(T('capture.saved'), 'success');
      } else {
        toast(result && result.error ? result.error : T('capture.failed'), 'error');
      }
    } catch (err) {
      console.error('Capture gameplay failed:', err);
      toast(T('capture.error'), 'error');
    } finally {
      captureBtn.disabled = false;
      if (label) label.textContent = T('capture.label');
    }
  });

  $('#shot-close').addEventListener('click', closeShotView);

  /* ═══════════════ KEYBOARD NAV ═══════════════ */
  const unlockAudioOnce = () => Sound.unlock();
  document.addEventListener('pointerdown', unlockAudioOnce, { passive: true });
  document.addEventListener('keydown', unlockAudioOnce);
  document.addEventListener('keyup', unlockAudioOnce);
  document.addEventListener('keydown', (e) => {
    const searchFocused = document.activeElement === $('#search-input');
    const modalOpen = !$('#cover-modal').classList.contains('hidden');
    const drawerOpen = !$('#settings-drawer').classList.contains('hidden');
    const menuOpen = !$('#context-menu').classList.contains('hidden');
    const shotOpen = $('#shot-view') && !$('#shot-view').classList.contains('hidden');

    // Esc siempre cierra primero el visor de capturas
    if (e.key === 'Escape' && shotOpen) {
      closeShotView();
      return;
    }

    // Modo arcade: navegación simplificada
    if (state.arcade) {
      if (e.key === 'Escape' || e.key === 'F11' || e.key === 'Tab' || e.key === 'Backspace') {
        e.preventDefault();
        closeArcade();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        arcadeNav(-1);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        arcadeNav(1);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const g = arcadeGame();
        if (g) { launchGame(g.id); setTimeout(closeArcade, 650); }
        return;
      }
    }

    // Home / consola: Escape salta a la biblioteca, Enter continúa
    if (homeOpen) {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        closeHome();
        Sound.select();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('#home-play').click();
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const btns = ['#home-play', '#home-library', '#home-arcade'];
        let idx = btns.findIndex((s) => document.activeElement && document.activeElement.closest(s) === document.activeElement);
        if (idx === -1) idx = 0;
        const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
        const next = (idx + dir + btns.length) % btns.length;
        $(btns[next]).focus();
        Sound.move();
        return;
      }
    }

    if (e.key === 'F11' || (e.ctrlKey && (e.key === 'g' || e.key === 'G'))) {
      e.preventDefault();
      openArcade();
      return;
    }

    if (e.key === 'Escape') {
      if (state.consolesOpen) return closeConsolesView();
      if ($('#emulators-view').classList.contains('active')) return closeEmulatorsView();
      if (menuOpen) return hideContextMenu();
      if (modalOpen) return closeCoverModal();
      if (drawerOpen) return closeDrawer();
      if (searchFocused) {
        $('#search-input').blur();
        state.search = '';
        $('#search-input').value = '';
        applyVisible();
        return;
      }
      return deselectGame();
    }

    if (e.key === 'F2' || (e.ctrlKey && (e.key === 'f' || e.key === 'F'))) {
      e.preventDefault();
      $('#search-input').focus();
      return;
    }
    if (e.key === '/' && !searchFocused) {
      e.preventDefault();
      $('#search-input').focus();
      return;
    }

    if (modalOpen || drawerOpen || searchFocused) return;

    const cards = state.visibleGames;
    if (cards.length === 0) return;

    const cols = state.columns;
    let idx = state.selectedIndex;

    const move = (newIdx) => {
      newIdx = Math.max(0, Math.min(cards.length - 1, newIdx));
      if (newIdx >= 0 && newIdx < cards.length && newIdx !== idx) {
        selectGame(cards[newIdx].id);
        Sound.move();
      } else if (idx === -1 && cards.length > 0) {
        selectGame(cards[0].id);
        Sound.move();
      }
    };

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        idx === -1 ? move(0) : move(idx + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        idx === -1 ? move(0) : move(idx - 1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        idx === -1 ? move(0) : move(idx + cols);
        break;
      case 'ArrowUp':
        e.preventDefault();
        idx === -1 ? move(0) : move(idx - cols);
        break;
      case 'Enter':
        if (state.selectedId) {
          e.preventDefault();
          launchGame(state.selectedId);
        }
        break;
    }
  });

  /* ═══════════════ GAMEPAD ═══════════════ */
  function initGamepad() {
    window.addEventListener('gamepadconnected', (e) => {
      GAMEPAD.connected = true;
      GAMEPAD.index = e.gamepad.index;
      renderGamepadUI();
      if (!GAMEPAD.pollTimer) GAMEPAD.pollTimer = setInterval(pollGamepad, 30);
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      GAMEPAD.connected = false;
      GAMEPAD.index = -1;
      if (GAMEPAD.pollTimer) {
        clearInterval(GAMEPAD.pollTimer);
        GAMEPAD.pollTimer = null;
      }
      GAMEPAD.heldSince = {};
      GAMEPAD.lastNav = {};
      renderGamepadUI();
    });

    setTimeout(() => {
      const pads = navigator.getGamepads && navigator.getGamepads();
      for (const p of pads || []) {
        if (p && p.connected) {
          GAMEPAD.connected = true;
          GAMEPAD.index = p.index;
          renderGamepadUI();
          if (!GAMEPAD.pollTimer) GAMEPAD.pollTimer = setInterval(pollGamepad, 30);
          break;
        }
      }
    }, 500);
  }

  function renderGamepadUI() {
    if (GAMEPAD.connected) {
      $('#gamepad-dot').classList.add('on');
      const pads = navigator.getGamepads && navigator.getGamepads();
      const pad = pads && pads[GAMEPAD.index] ? pads[GAMEPAD.index] : null;
      const id = pad ? pad.id : T('gamepad.connected');
      $('#gamepad-text').textContent = shortGamepadName(id);
    } else {
      $('#gamepad-dot').classList.remove('on');
      $('#gamepad-text').textContent = T('gamepad.none');
    }
  }

  function shortGamepadName(id) {
    const clean = id.replace(/\(.*?\)/g, '').trim();
    if (!clean) return T('gamepad.connected');
    return clean.length > 24 ? clean.substring(0, 24) + '…' : clean;
  }

  function pollGamepad() {
    const pads = navigator.getGamepads();
    if (!pads) return;
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) { pad = p; break; }
    }
    if (!pad) return;

    const cards = state.visibleGames;
    if (cards.length === 0) return;

    const modalOpen = !$('#cover-modal').classList.contains('hidden');
    const drawerOpen = !$('#settings-drawer').classList.contains('hidden');

    const btn = (i) => (pad.buttons[i] && pad.buttons[i].pressed) || false;
    const ax = (i) => pad.axes[i] || 0;

    const now = Date.now();

    // ── Home / consola: navegación con mando ──
    if (homeOpen) {
      const btns = ['#home-play', '#home-library', '#home-arcade'];
      let idx = btns.findIndex((s) => document.activeElement && document.activeElement.closest(s) === document.activeElement);
      if (idx === -1) idx = 0;
      const hdx = ax(0);
      const hmx = btn(15) ? 1 : btn(14) ? -1 : (Math.abs(hdx) > GAMEPAD.deadzone ? (hdx > 0 ? 1 : -1) : 0);
      if (hmx !== 0) {
        const key = 'hm' + hmx;
        if (!GAMEPAD.heldSince[key]) {
          GAMEPAD.heldSince[key] = now;
          GAMEPAD.lastNav[key] = now;
          const next = (idx + hmx + btns.length) % btns.length;
          $(btns[next]).focus();
          Sound.move();
        } else {
          const held = now - GAMEPAD.heldSince[key];
          const interval = held > 2000 ? 45 : held > 900 ? 60 : GAMEPAD.repeatRate;
          if (now - GAMEPAD.lastNav[key] >= interval) {
            GAMEPAD.lastNav[key] = now;
            const next = (idx + hmx + btns.length) % btns.length;
            $(btns[next]).focus();
            Sound.move();
          }
        }
      } else {
        GAMEPAD.heldSince = {};
        GAMEPAD.lastNav = {};
      }
      handleButton(pad, 0, () => $('#home-play').click());
      handleButton(pad, 1, () => closeHome());
      handleButton(pad, 8, () => closeHome());
      return;
    }

    // ── Modo arcade: navegación simplificada con mando ──
    if (state.arcade) {
      const n = cards.length;
      if (n === 0) return;
      const arcDx = ax(0);
      const turnedX = btn(15) ? 1 : btn(14) ? -1 : 0;
      const movedX = turnedX !== 0 ? turnedX : (Math.abs(arcDx) > GAMEPAD.deadzone ? (arcDx > 0 ? 1 : -1) : 0);
      if (movedX !== 0) {
        const key = 'arc' + movedX;
        if (!GAMEPAD.heldSince[key]) {
          GAMEPAD.heldSince[key] = now;
          GAMEPAD.lastNav[key] = now;
          arcadeNav(movedX);
        } else {
          const held = now - GAMEPAD.heldSince[key];
          const interval = held > 2000 ? 45 : held > 900 ? 60 : GAMEPAD.repeatRate;
          if (now - GAMEPAD.lastNav[key] >= interval) {
            GAMEPAD.lastNav[key] = now;
            arcadeNav(movedX);
          }
        }
      } else {
        GAMEPAD.heldSince = {};
        GAMEPAD.lastNav = {};
      }
      handleButton(pad, 0, () => {
        const g = arcadeGame();
        if (g) { launchGame(g.id); setTimeout(closeArcade, 650); }
      });
      handleButton(pad, 1, closeArcade);
      handleButton(pad, 8, closeArcade);
      return;
    }

    const cols = state.columns;
    const dx = ax(0);
    const dy = ax(1);

    let navX = 0;
    let navY = 0;
    if (Math.abs(dx) > GAMEPAD.deadzone) navX = dx > 0 ? 1 : -1;
    if (Math.abs(dy) > GAMEPAD.deadzone) navY = dy > 0 ? 1 : -1;
    if (btn(15)) navX = 1;
    if (btn(14)) navX = -1;
    if (btn(13)) navY = 1;
    if (btn(12)) navY = -1;

    if (navX !== 0 || navY !== 0) {
      const axisKey = navX + ':' + navY;
      if (state.selectedId === null || state.selectedIndex === -1) {
        selectGame(cards[0].id);
        GAMEPAD.heldSince[axisKey] = now;
        GAMEPAD.lastNav[axisKey] = now;
      } else if (!GAMEPAD.heldSince[axisKey]) {
        GAMEPAD.heldSince[axisKey] = now;
        GAMEPAD.lastNav[axisKey] = now;
        stepGamepadNav(navX, navY, cols, cards.length);
      } else {
        const held = now - GAMEPAD.heldSince[axisKey];
        const interval = held > 2000 ? 45 : held > 900 ? 60 : GAMEPAD.repeatRate;
        if (now - GAMEPAD.lastNav[axisKey] >= interval) {
          GAMEPAD.lastNav[axisKey] = now;
          stepGamepadNav(navX, navY, cols, cards.length);
        }
      }
    } else {
      GAMEPAD.heldSince = {};
      GAMEPAD.lastNav = {};
    }

    handleButton(pad, 0, () => {
      if (modalOpen) {
        $('#cover-search-input').focus();
      } else if (state.selectedId) {
        launchGame(state.selectedId);
      } else if (cards.length > 0) {
        selectGame(cards[0].id);
      }
    });

    handleButton(pad, 1, () => {
      if (modalOpen) closeCoverModal();
      else if (drawerOpen) closeDrawer();
      else if (!$('#context-menu').classList.contains('hidden')) hideContextMenu();
      else deselectGame();
    });

    handleButton(pad, 8, () => {
      if (modalOpen) closeCoverModal();
      else if (drawerOpen) closeDrawer();
      else deselectGame();
    });

    handleButton(pad, 2, () => {
      if (!modalOpen && !drawerOpen) $('#search-input').focus();
    });

    handleButton(pad, 4, () => {
      if (!modalOpen && !drawerOpen) cycleFilter(-1);
    });

    handleButton(pad, 5, () => {
      if (!modalOpen && !drawerOpen) cycleFilter(1);
    });

    handleButton(pad, 9, () => {
      if (!modalOpen && !drawerOpen) $('#search-input').focus();
    });

    handleButton(pad, 16, () => {
      if (api.toggleFullscreen) api.toggleFullscreen();
    });
  }

  function stepGamepadNav(navX, navY, cols, len) {
    let idx = state.selectedIndex;
    if (idx === -1) idx = 0;
    let next = idx;
    if (navX !== 0) next = idx + navX;
    if (navY !== 0) next = idx + navY * cols;
    if (next < 0) next = 0;
    if (next >= len) next = len - 1;
    if (next !== idx && next >= 0 && next < len) {
      selectGame(state.visibleGames[next].id);
      Sound.move();
    }
  }

  function handleButton(pad, buttonIndex, handler) {
    const pressed = pad.buttons[buttonIndex] && pad.buttons[buttonIndex].pressed;
    const was = GAMEPAD.prevPressed[buttonIndex];
    if (pressed && !was) handler();
    GAMEPAD.prevPressed[buttonIndex] = !!pressed;
  }

  /* ═══════════════ CONTEXT MENU ═══════════════ */
  function showContextMenu(x, y) {
    const menu = $('#context-menu');
    menu.classList.remove('hidden');
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const mx = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const my = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = mx + 'px';
    menu.style.top = my + 'px';
  }

  function hideContextMenu() {
    $('#context-menu').classList.add('hidden');
    state.contextGame = null;
  }

  document.addEventListener('click', (e) => {
    const menu = $('#context-menu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
      hideContextMenu();
    }
  });

  $$('.ctx-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const action = item.dataset.action;
      const game = state.contextGame || state.allGames.find((g) => g.id === state.selectedId);
      hideContextMenu();
      if (!game) return;

      switch (action) {
        case 'play':
          await launchGame(game.id);
          break;
        case 'set-cover':
          openFilePicker(game);
          break;
        case 'search-artwork':
          openCoverModal(game);
          break;
        case 'open-folder':
          if (game.installDir) {
            const ok = await api.openFolder(game.installDir);
            if (!ok) toast(T('ctx.openFolderFail'), 'error');
          } else if (game.exePath) {
            api.openFolder(game.exePath.replace(/\\[^\\]*$/, ''));
          }
          break;
        case 'remove':
          await api.removeGame(game.id);
          removeGameFromState(game.id);
          toast(T('ctx.removed', { name: game.name }));
          break;
        case 'delete-disk':
          await deleteGameFromDisk(game);
          break;
      }
    });
  });

  /* ═══════════════ TOOLTIP ═══════════════ */
  function showTooltip(e, game) {
    const tip = $('#tooltip');
    $('#tooltip-title').textContent = game.name;
    const details = [];
    const platform = game.platform || game.source;
    if (platform) details.push(`${platformLabelOf(game)}`);
    if (game.installDir) details.push(T('tooltip.location', { path: game.installDir }));
    if (game.sizeOnDisk) details.push(T('tooltip.size', { size: (game.sizeOnDisk / 1073741824).toFixed(1) }));
    if (game.playtimeMs > 0) details.push(T('tooltip.played', { time: formatPlaytime(game.playtimeMs) }));
    if (!game.exePath && !game.launchUri && !game.romPath && !game.aumid) details.push(T('tooltip.noExe'));
    if (game.lastPlayed) {
      const d = new Date(game.lastPlayed);
      details.push(T('tooltip.lastPlayed', { date: d.toLocaleDateString(localeTag()) }));
    }
    $('#tooltip-details').innerHTML = details.join('<br>') || '—';

    tip.classList.remove('hidden');
    tip.style.left = '0';
    tip.style.top = '0';
    const rect = tip.getBoundingClientRect();
    let x = e.clientX + 14;
    let y = e.clientY + 14;
    if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';

    clearTimeout(tip._timeout);
    tip._timeout = setTimeout(() => tip.classList.add('hidden'), 2600);
  }

  function hideTooltip() {
    const tip = $('#tooltip');
    if (tip._timeout) clearTimeout(tip._timeout);
    tip.classList.add('hidden');
  }

  /* ═══════════════ FOLDERS ═══════════════ */
  async function loadFolders() {
    try {
      const folders = await api.getCustomFolders();
      state.customFolders = folders || [];
      renderFoldersList(state.customFolders, $('#folders-list'));
      renderFoldersList(state.customFolders, $('#settings-folders'));
    } catch (err) {
      console.error('Failed to load folders:', err);
    }
  }

  function renderFoldersList(folders, container) {
    if (!container) return;
    container.innerHTML = '';
    if (!folders || folders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder-item';
      empty.innerHTML = `<span class="folder-path">${esc(T('folders.none'))}</span>`;
      empty.style.color = 'var(--muted)';
      empty.style.opacity = '0.7';
      container.appendChild(empty);
      return;
    }

    folders.forEach((folder) => {
      const item = document.createElement('div');
      item.className = 'folder-item';
      const short = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
      item.innerHTML = `
        <span class="folder-path" title="${esc(folder)}">${esc(short)}</span>
        <button class="folder-remove" data-path="${esc(folder)}" title="${esc(T('folders.removeTitle'))}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
      item.querySelector('.folder-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.removeCustomFolder(folder);
        loadFolders();
        toast(T('folders.removed'));
      });
      container.appendChild(item);
    });
  }

  async function addFolder() {
    try {
      const folder = await api.selectFolder();
      if (folder) {
        await api.addCustomFolder(folder);
        loadFolders();
        toast(T('folders.added', { folder }));
      }
    } catch (err) {
      console.error('Failed to add folder:', err);
      toast(T('folders.addFailed'), 'error');
    }
  }

  $('#add-folder-btn').addEventListener('click', addFolder);
  $('#settings-add-folder').addEventListener('click', addFolder);

  /* ═══════════════ EMULADORES (retro) ═══════════════ */
  const EMU_PRESETS = [
    { id: 'snes9x', name: 'Snes9x', console: 'SNES', exe: 'snes9x.exe', args: '' },
    { id: 'fceux', name: 'FCEUX', console: 'NES', exe: 'fceux.exe', args: '' },
    { id: 'mGBA', name: 'mGBA', console: 'GBA', exe: 'mGBA.exe', args: '' },
    { id: 'project64', name: 'Project64', console: 'N64', exe: 'Project64.exe', args: '' },
    { id: 'simple64', name: 'simple64', console: 'N64', exe: 'simple64.exe', args: '' },
    { id: 'dolphin', name: 'Dolphin', console: 'GameCube', exe: 'Dolphin.exe', args: '' },
    { id: 'dolphin-wii', name: 'Dolphin', console: 'Wii', exe: 'Dolphin.exe', args: '' },
    { id: 'pcsx2', name: 'PCSX2', console: 'PS2', exe: 'pcsx2.exe', args: '' },
    { id: 'duckstation', name: 'DuckStation', console: 'PS1', exe: 'duckstation-qt.exe', args: '' },
    { id: 'ppsspp', name: 'PPSSPP', console: 'PSP', exe: 'PPSSPPWindows64.exe', args: '' },
    { id: 'desmume', name: 'DeSmuME', console: 'NDS', exe: 'DeSmuME.exe', args: '' },
    { id: 'citra', name: 'Citra', console: '3DS', exe: 'citra-qt.exe', args: '' },
    { id: 'redream', name: 'Redream', console: 'Dreamcast', exe: 'redream.exe', args: '' },
    { id: 'fusion', name: 'Kega Fusion', console: 'Mega Drive', exe: 'fusion.exe', args: '' },
    { id: 'a5200', name: 'A5200', console: 'Atari 2600', exe: 'a5200.exe', args: '' }
  ];

  const emuPresetEl = $('#emu-preset');
  if (emuPresetEl) {
    EMU_PRESETS.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} — ${p.console}`;
      emuPresetEl.appendChild(opt);
    });
  }

  function pathLeaf(p) {
    return String(p || '').split(/[\\/]/).pop();
  }

  function retroGamesFor(emu) {
    if (!emu || !state.allGames) return 0;
    return state.allGames.filter(
      (g) => g.source === 'retro' && (g.platform || '') === (emu.console || '')
    ).length;
  }

  function emulatorStatusText(emu) {
    const retroCount = retroGamesFor(emu);
    if (retroCount === 0) return { text: T('emu.noRoms'), empty: true };
    if (retroCount === 1) return { text: T('emu.oneGame'), empty: false };
    return { text: T('emu.nGames', { n: retroCount }), empty: false };
  }

  function renderEmulatorsList(emulators) {
    const wrap = $('#settings-emulators');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!emulators || emulators.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'emu-empty';
      empty.textContent = T('emu.none');
      wrap.appendChild(empty);
      return;
    }

    emulators.forEach((emu) => {
      const item = document.createElement('div');
      item.className = 'emu-item';
      const bundledBadge = emu.bundled ? `<span class="emu-bundled">${esc(T('emu.bundled'))}</span> ` : '';
      const retroCount = retroGamesFor(emu);
      const status = emulatorStatusText(emu);
      const openBtn = emu.romsPath
        ? `<button class="emu-open" data-path="${esc(emu.romsPath)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> ${esc(T('emu.openRoms'))}</button>`
        : '';
      item.innerHTML = `
        <div class="emu-item-info">
          <div class="emu-item-name">${bundledBadge}${esc(emu.name)}</div>
          <div class="emu-item-console">${esc(emu.console || 'Retro')}</div>
          <div class="emu-item-paths">${esc(emu.exePath)}${emu.romsPath ? '<br>' + esc(emu.romsPath) : ''}</div>
          <div class="emu-item-status"><span class="emu-status-text ${status.empty ? 'emu-status-empty' : ''}">${status.text}</span> ${openBtn}</div>
        </div>
        <button class="emu-remove" data-id="${esc(emu.id)}" title="${esc(T('emu.removeTitle'))}">✕</button>
      `;
      const openRoms = item.querySelector('.emu-open');
      if (openRoms) {
        openRoms.addEventListener('click', async () => {
          await api.openFolder(openRoms.dataset.path);
        });
      }
      item.querySelector('.emu-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api.removeEmulator(emu.id);
          await loadEmulators();
          toast(T('emu.removed'));
        } catch (err) {
          console.error('Remove emulator failed:', err);
          toast(T('emu.removeFailed'), 'error');
        }
      });
      wrap.appendChild(item);
    });
  }

  async function loadEmulators() {
    try {
      const emus = await api.getEmulators();
      state.emulators = emus || [];
      renderEmulatorsList(state.emulators);
      renderEmulatorsView();
    } catch (err) {
      console.error('Failed to load emulators:', err);
    }
  }

  function clearEmulatorForm() {
    $('#emu-preset').value = '';
    $('#emu-name').value = '';
    $('#emu-console').value = '';
    $('#emu-exe').value = '';
    $('#emu-roms').value = '';
    $('#emu-args').value = '';
  }

  function fillEmulatorPreset(id) {
    const p = EMU_PRESETS.find((x) => x.id === id);
    if (!p) return;
    $('#emu-name').value = p.name;
    $('#emu-console').value = p.console;
    $('#emu-args').value = p.args || '';
  }

  emuPresetEl.addEventListener('change', (e) => fillEmulatorPreset(e.target.value));

  $('#emu-pick-exe').addEventListener('click', async () => {
    try {
      const p = await api.selectExecutable();
      if (!p) return;
      $('#emu-exe').value = p;
      const nameInput = $('#emu-name');
      if (!nameInput.value.trim()) {
        nameInput.value = pathLeaf(p).replace(/\.exe$/i, '');
      }
    } catch (err) {
      console.error('Pick exe failed:', err);
    }
  });

  $('#emu-pick-roms').addEventListener('click', async () => {
    try {
      const p = await api.selectFolder();
      if (p) $('#emu-roms').value = p;
    } catch (err) {
      console.error('Pick roms failed:', err);
    }
  });

  $('#emu-add').addEventListener('click', async () => {
    const name = $('#emu-name').value.trim();
    const consoleValue = $('#emu-console').value.trim();
    const exePath = $('#emu-exe').value.trim();
    const romsPath = $('#emu-roms').value.trim();
    const args = $('#emu-args').value.trim();

    if (!name) { toast(T('emu.addNameError'), 'error'); return; }
    if (!exePath) { toast(T('emu.addExeError'), 'error'); return; }
    if (!romsPath) { toast(T('emu.addRomsError'), 'error'); return; }

    try {
      await api.addEmulator({ name, console: consoleValue || 'Retro', exePath, romsPath, args });
      clearEmulatorForm();
      await loadEmulators();
      toast(T('emu.added'));
    } catch (err) {
      console.error('Add emulator failed:', err);
      toast(T('emu.addFailed'), 'error');
    }
  });

  /* ── Juego manual ── */
  $('#manual-pick-exe').addEventListener('click', async () => {
    try {
      const p = await api.selectExecutable();
      if (!p) return;
      $('#manual-exe').value = p;
      const nameInput = $('#manual-name');
      if (!nameInput.value.trim()) {
        nameInput.value = pathLeaf(p).replace(/\.exe$/i, '');
      }
    } catch (err) {
      console.error('Pick game exe failed:', err);
    }
  });

  $('#manual-add').addEventListener('click', async () => {
    const name = $('#manual-name').value.trim();
    const exePath = $('#manual-exe').value.trim();
    if (!name) { toast(T('manual.nameError'), 'error'); return; }
    if (!exePath) { toast(T('manual.exeError'), 'error'); return; }
    try {
      const game = await api.addGame({ name, exePath, source: 'custom', platform: 'custom', isManual: true });
      $('#manual-name').value = '';
      $('#manual-exe').value = '';
      toast(T('manual.added', { name: game.name }), 'success');
      await loadGames();
    } catch (err) {
      console.error('Add game failed:', err);
      toast(T('manual.addFailed'), 'error');
    }
  });

  /* ═══════════════ SETTINGS DRAWER ═══════════════ */
  const drawer = $('#settings-drawer');

  function openDrawer() {
    drawer.classList.remove('hidden');
  }

  function closeDrawer() {
    drawer.classList.add('hidden');
  }

  $('#settings-gear').addEventListener('click', openDrawer);
  $$('[data-close-drawer]').forEach((el) => el.addEventListener('click', closeDrawer));

  $('#set-auto-scan').addEventListener('change', (e) => {
    saveSettings({ autoScan: e.target.checked });
  });

  $('#set-rawg-key').addEventListener('change', (e) => {
    saveSettings({ rawgKey: e.target.value.trim() });
  });
  $('#set-sgdb-key').addEventListener('change', (e) => {
    saveSettings({ sgdbKey: e.target.value.trim() });
  });

  $('#setting-sound').addEventListener('change', (e) => {
    Sound.setMuted(!e.target.checked);
    saveSettings({ sound: e.target.checked });
    if (e.target.checked) {
      Sound.select();
    }
  });

  /* ── Idioma ── */
  function renderLocaleOptions() {
    const sel = $('#set-locale');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(I18N.LOCALES).forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = (I18N.DICT[code] && I18N.DICT[code]['locale.self']) || code;
      sel.appendChild(opt);
    });
    sel.value = state.locale;
  }

  const localeSelect = $('#set-locale');
  if (localeSelect) {
    localeSelect.addEventListener('change', (e) => {
      state.locale = e.target.value;
      saveSettings({ locale: state.locale });
      applyLocale();
    });
  }

  function localeTag() {
    return state.locale === 'en' ? 'en-US' : 'es-ES';
  }

  function applyLocale() {
    applyI18n();
    renderLocaleOptions();
    updateCounts();
    applyVisible();
    if (state.consolesOpen) renderConsoles();
    if (homeOpen) renderHome();
    renderGamepadUI();
    renderFoldersList(state.customFolders, $('#folders-list'));
    renderFoldersList(state.customFolders, $('#settings-folders'));
    renderEmulatorsList(state.emulators || []);
    if (gamePageOpen() && state.selectedId) {
      const game = state.allGames.find((g) => g.id === state.selectedId);
      if (game) renderDetailPanel(game);
    }
    if (state.coverGame && $('#cover-modal') && !$('#cover-modal').classList.contains('hidden')) {
      $('#cover-modal-title').textContent = T('cover.titlePrefix', { name: state.coverGame.name });
    }
  }

  /* requisitos del sistema (VC++ Redistributable) */
  function showEnvWarning(show) {
    const group = $('#env-warn-group');
    if (group) group.classList.toggle('hidden', !show);
  }

  (async () => {
    try {
      const env = await api.checkEnv();
      showEnvWarning(!!(env && env.vcredistMissing));
    } catch {
      showEnvWarning(false);
    }
  })();

  const vcDownload = $('#env-download-vc');
  if (vcDownload) {
    vcDownload.addEventListener('click', () => {
      api.openExternal('https://aka.ms/vs/17/release/vc_redist.x64.exe');
    });
  }
  const vcSkip = $('#env-skip-vc');
  if (vcSkip) {
    vcSkip.addEventListener('click', () => showEnvWarning(false));
  }

  /* exportar / importar configuración */
  $('#export-config-btn').addEventListener('click', async () => {
    try {
      const r = await api.exportConfig();
      if (r && r.ok) toast(T('config.exported'), 'success');
      else if (r && !r.canceled) toast(T('config.exportFailed'), 'error');
    } catch (err) {
      console.error('Export config failed:', err);
      toast(T('config.exportFailed'), 'error');
    }
  });

  $('#import-config-btn').addEventListener('click', async () => {
    try {
      const r = await api.importConfig();
      if (r && r.ok) {
        toast(T('config.imported'), 'success');
        await loadSettings();
        await loadFolders();
        loadEmulators();
        api.rescan();
      } else if (r && r.error === 'invalid-json') {
        toast(T('config.invalidJson'), 'error');
      } else if (r && r.error === 'not-gamevault') {
        toast(T('config.notGamevault'), 'error');
      } else if (r && !r.canceled) {
        toast(T('config.importFailed'), 'error');
      }
    } catch (err) {
      console.error('Import config failed:', err);
      toast(T('config.importFailed'), 'error');
    }
  });

  $('#set-columns').addEventListener('input', (e) => {
    setColumns(parseInt(e.target.value, 10));
  });

  $$('.accent-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      const accent = dot.dataset.accent;
      $$('.accent-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
      applyAccent(accent);
      saveSettings({ accent });
    });
  });

  function applyAccent(accent) {
    const accents = {
      purple: ['#7c5cff', '#00d2ff'],
      cyan: ['#00d2ff', '#66e0ff'],
      blue: ['#3b82f6', '#60a5fa'],
      green: ['#22c55e', '#4ade80']
    };
    const [c1, c2] = accents[accent] || accents.purple;
    const root = document.documentElement;
    root.style.setProperty('--accent', c1);
    root.style.setProperty('--accent2', c2);
    root.style.setProperty('--accent-soft', 'rgba(124, 92, 255, 0.16)');
    root.style.setProperty('--accent-glow', `0 4px 22px ${c1}73`);
    root.style.setProperty('--accent-grad', `linear-gradient(135deg, ${c1}, ${c2})`);
  }

  function saveSettings(s) {
    if (typeof api.setSettings === 'function') {
      api.setSettings(s).catch(() => {});
    }
  }

  /* ═══════════════ UPDATES (GITHUB) ═══════════════ */
  function setUpdateStatus(text, kind) {
    const box = $('#update-result');
    if (!box) return;
    box.classList.remove('hidden', 'ok', 'err', 'busy');
    box.textContent = text || '';
    if (kind) box.classList.add(kind);
  }

  async function checkForUpdates() {
    const btn = $('#btn-check-updates');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '...';
    setUpdateStatus(T('updates.checking'), 'busy');
    try {
      const res = await api.checkUpdates();
      if (!res) {
        setUpdateStatus(T('updates.checkFailed'), 'err');
      } else if (res.error) {
        setUpdateStatus(res.error, 'err');
      } else if (!res.hasUpdate) {
        setUpdateStatus(
          T('updates.upToDate', { version: res.currentVersion || 'actual' }),
          'ok'
        );
      } else {
        const note = (res.notes || '').split('\n').slice(0, 6).join('\n  ');
        const kind = note ? T('updates.notesSuffix') : '';
        setUpdateStatus(
          T('updates.newAvailable', { version: res.latestVersion, suffix: kind }),
          'ok'
        );
        const resultBox = $('#update-result');
        if (resultBox) {
          resultBox.innerHTML = '';
          if (note) {
            const pre = document.createElement('div');
            pre.className = 'update-notes';
            pre.textContent = note;
            resultBox.appendChild(pre);
          }
          const row = document.createElement('div');
          row.className = 'update-actions';
          if (res.assetUrl) {
            const dl = document.createElement('button');
            dl.className = 'btn-primary';
            dl.textContent = T('updates.downloadInstaller');
            dl.onclick = () => api.openUpdateUrl(res.assetUrl);
            row.appendChild(dl);
          }
          if (res.htmlUrl) {
            const go = document.createElement('button');
            go.className = 'btn-secondary';
            go.textContent = T('updates.viewRelease');
            go.onclick = () => api.openUpdateUrl(res.htmlUrl);
            row.appendChild(go);
          }
          resultBox.appendChild(row);
        }
      }
    } catch (err) {
      console.error('Update check failed:', err);
      setUpdateStatus(T('updates.checkError'), 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = T('settings.checkNow');
    }
  }

  $('#btn-check-updates').addEventListener('click', checkForUpdates);

  /* ═══════════════ AUTO-UPDATE BANNER ═══════════════ */
  function initAutoUpdateBanner() {
    const banner = $('#update-banner');
    const text = $('#update-banner-text');
    const icon = $('#update-banner-icon');
    const restartBtn = $('#update-banner-btn');
    const dismiss = $('#update-banner-dismiss');
    if (!banner || !text || !icon || !restartBtn || !dismiss) return;

    const show = (state) => {
      banner.classList.remove('hidden');
      banner.className = 'show';
      if (state) banner.classList.add(state);
      banner.setAttribute('aria-hidden', 'false');
    };
    const hide = () => {
      banner.classList.remove('show');
      banner.classList.add('hidden');
      banner.setAttribute('aria-hidden', 'true');
    };

    dismiss.addEventListener('click', hide);

    restartBtn.addEventListener('click', () => {
      restartBtn.disabled = true;
      restartBtn.textContent = T('banner.updating');
      api.installUpdate().catch(() => {
        restartBtn.disabled = false;
        restartBtn.textContent = T('banner.restart');
      });
    });

    api.onUpdateStatus((st) => {
      if (!st) return;
      if (st.type === 'not-available') return;
      if (st.type === 'error') {
        text.textContent = st.error || T('banner.error');
        icon.textContent = '!';
        restartBtn.classList.add('hidden');
        show('err');
        return;
      }
      if (st.type === 'available') {
        icon.textContent = '↓';
        text.textContent = T('banner.newVersion', { version: st.version || '' });
        restartBtn.classList.add('hidden');
        show('');
        return;
      }
      if (st.type === 'downloading') {
        icon.textContent = `${st.percent || 0}%`;
        text.textContent = T('banner.downloading', { percent: st.percent || 0 });
        show('');
        return;
      }
      if (st.type === 'downloaded') {
        icon.textContent = '✓';
        text.textContent = T('banner.ready', { version: st.version || '' });
        restartBtn.classList.remove('hidden');
        show('done');
      }
    });
  }

  initAutoUpdateBanner();

  async function loadSettings() {
    try {
      const settings = await api.getSettings();
      if (!settings) return;
      state.locale = settings.locale || state.locale;
      renderLocaleOptions();
      setColumns(settings.columns || 5);
      $('#set-auto-scan').checked = settings.autoScan !== false;
      const soundOn = settings.sound !== false;
      const soundInput = $('#setting-sound');
      if (soundInput) soundInput.checked = soundOn;
      Sound.setMuted(!soundOn);
      if (settings.accent) {
        $$('.accent-dot').forEach((d) => d.classList.toggle('active', d.dataset.accent === settings.accent));
        applyAccent(settings.accent);
      }
      const rawgInput = $('#set-rawg-key');
      if (rawgInput) rawgInput.value = settings.rawgKey || '';
      const sgdbInput = $('#set-sgdb-key');
      if (sgdbInput) sgdbInput.value = settings.sgdbKey || '';
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  /* ═══════════════ COVER MODAL ═══════════════ */
  const coverModal = $('#cover-modal');

  function openCoverModal(game) {
    state.coverGame = game;
    $('#cover-modal-title').textContent = T('cover.titlePrefix', { name: game.name });
    $('#cover-search-input').value = game.name;
    $('#cover-results').innerHTML = `<div class="cover-hint">${esc(T('cover.searchHint'))}</div>`;
    coverModal.classList.remove('hidden');
    setTimeout(() => {
      $('#cover-search-input').focus();
      $('#cover-search-input').select();
    }, 100);
    doCoverSearch(game.name);
  }

  function closeCoverModal() {
    coverModal.classList.add('hidden');
    state.coverGame = null;
  }

  $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeCoverModal));

  async function doCoverSearch(query) {
    const resultsEl = $('#cover-results');
    if (!query || !query.trim()) {
      resultsEl.innerHTML = `<div class="cover-hint">${esc(T('cover.searchHint'))}</div>`;
      return;
    }

    resultsEl.innerHTML = `<div class="cover-loading"><div class="spinner"></div>` + esc(T('cover.searching')) + `</div>`;

    try {
      const items = await api.searchArtwork(query.trim());
      let cfg = null;
      if (typeof api.getArtworkConfig === 'function') {
        try { cfg = await api.getArtworkConfig(); } catch { cfg = null; }
      }
      resultsEl.innerHTML = '';
      if (cfg && !cfg.hasRawgKey) {
        const note = document.createElement('div');
        note.className = 'cover-rawg-note';
        note.innerHTML =
          `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
          T('cover.rawgNote');
        resultsEl.appendChild(note);
      }
      if (!items || items.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'cover-hint';
        hint.textContent = T('cover.noResults');
        resultsEl.appendChild(hint);
        return;
      }

      items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = `cover-item${item.isWide ? ' wide' : ''}`;
        div.style.setProperty('--anim-delay', `${Math.min(i * 0.04, 0.4)}s`);
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = item.url || item.thumb || '';
        img.alt = T('cover.title');
        img.onerror = () => div.remove();
        if (item.isWide) {
          const badge = document.createElement('span');
          badge.className = 'cover-item-wide-badge';
          badge.textContent = T('cover.wide');
          div.appendChild(badge);
        }
        img.onclick = async () => {
          const game = state.coverGame;
          const url = item.url || item.thumb || '';
          if (game && url) {
            try {
              const result = await api.setCover(game.id, url);
              if (result && result.ok) {
                game.hasLocalCover = true;
                game.localCoverPath = result.localCoverPath;
                delete game.localCoverDataUrl;
                applyVisible();
                if (state.selectedId === game.id && gamePageOpen()) renderDetailPanel(game);
                toast(T('cover.updated'), 'success');
              } else {
                toast(T('cover.saveFailed'), 'error');
              }
              closeCoverModal();
            } catch (err) {
              console.error('Cover set failed:', err);
              toast(T('cover.saveError'), 'error');
            }
          }
        };
        div.appendChild(img);
        if (item.label) {
          const tag = document.createElement('span');
          tag.className = 'cover-item-tag';
          tag.textContent = item.label;
          div.appendChild(tag);
        }
        resultsEl.appendChild(div);
      });
    } catch (err) {
      console.error('Cover search failed:', err);
      resultsEl.innerHTML = `<div class="cover-hint">${esc(T('cover.searchFailed'))}</div>`;
    }
  }

  $('#cover-search-btn').addEventListener('click', () => doCoverSearch($('#cover-search-input').value));
  $('#cover-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doCoverSearch(e.target.value);
    }
  });

  function openFilePicker(game) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const result = await api.setCover(game.id, reader.result);
          if (result && result.ok) {
            game.hasLocalCover = true;
            game.localCoverPath = result.localCoverPath;
            delete game.localCoverDataUrl;
            applyVisible();
            if (state.selectedId === game.id && gamePageOpen()) renderDetailPanel(game);
            toast(T('cover.updated'), 'success');
          } else {
            toast(T('cover.saveFailed'), 'error');
          }
        } catch (err) {
          console.error('Upload cover failed:', err);
          toast(T('cover.saveError'), 'error');
        }
      };
      reader.readAsDataURL(file);
    });
    input.click();
  }

  $('#cover-upload-btn').addEventListener('click', () => {
    if (state.coverGame) openFilePicker(state.coverGame);
  });

  /* ═══════════════ TOAST ═══════════════ */
  function toast(message, type = '') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  /* ═══════════════ IPC EVENTS ═══════════════ */
  api.onScanProgress(({ percent, message }) => {
    if (!state.splashDone) updateSplash(percent, message);
  });

  api.onScanComplete(async () => {
    await loadGames();
    if (!state.splashDone) finishSplash();
  });

  api.onGameAdded((game) => {
    mergeGame(game);
    if (typeof loadEmulators === 'function') loadEmulators();
  });

  api.onGameRemoved((id) => {
    removeGameFromState(id);
    if (typeof loadEmulators === 'function') loadEmulators();
  });

  /* ═══════════════ INIT ═══════════════ */
  async function init() {
    initGamepad();
    await loadSettings();
    applyLocale();
    await loadFolders();
    loadEmulators();
    loadGames();
  }

  init();
})();
