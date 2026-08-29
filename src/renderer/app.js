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
    arcadeIndex: -1
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

  const FILTER_ORDER = ['all', 'steam', 'epic', 'gog', 'retro', 'other'];
  const PLATFORM_LABELS = { steam: 'Steam', epic: 'Epic', gog: 'GOG', retro: 'Retro', other: 'Otro' };

  function platformKeyOf(game) {
    return (game && game.source) === 'retro' ? 'retro' : (game.platform || game.source || 'other');
  }
  function platformLabelOf(game) {
    if (game && game.source === 'retro' && game.platform) return game.platform;
    return PLATFORM_LABELS[platformKeyOf(game)] || 'Otro';
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
    updateSplash(100, 'Listo');
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
    applyVisible();
  }

  $$('.filter-btn').forEach((btn) => {
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
      toast('Analizando juegos...');
      await api.rescan();
      await loadGames();
      toast('Biblioteca actualizada', 'success');
    } catch (err) {
      console.error('Rescan failed:', err);
      toast('No se pudo analizar la biblioteca', 'error');
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
      toast('Este juego no tiene una ubicación local para eliminar', 'error');
      return;
    }
    const name = game.name || 'este juego';
    const sizeText = game.sizeOnDisk ? ` (${(game.sizeOnDisk / 1073741824).toFixed(1)} GB)` : '';
    const ok = confirm(
      `¿Eliminar "${name}"${sizeText} de tu PC?\n\nSe moverá a la Papelera de reciclaje.` +
        `\nUbicación: ${game.installDir}\n\nEsta acción no se puede deshacer fácilmente.`
    );
    if (!ok) return;

    try {
      const result = await api.deleteGameFromDisk(game.id);
      if (result && result.success) {
        removeGameFromState(game.id);
        toast(`${game.name} eliminado de la PC`);
      } else {
        toast(`No se pudo eliminar: ${(result && result.error) || 'error'}`, 'error');
      }
    } catch (err) {
      console.error('Delete error:', err);
      toast('Error al eliminar el juego', 'error');
    }
  }

  function updateCounts() {
    const counts = { all: state.allGames.length, steam: 0, epic: 0, gog: 0, retro: 0, other: 0 };
    for (const g of state.allGames) {
      const p = g.platform || g.source;
      if (g.source === 'retro') counts.retro++;
      else if (p === 'steam') counts.steam++;
      else if (p === 'epic') counts.epic++;
      else if (p === 'gog') counts.gog++;
      else counts.other++;
    }

    $('#count-all').textContent = counts.all;
    $('#count-steam').textContent = counts.steam;
    $('#count-epic').textContent = counts.epic;
    $('#count-gog').textContent = counts.gog;
    const countRetro = $('#count-retro');
    if (countRetro) countRetro.textContent = counts.retro;
    $('#count-other').textContent = counts.other;

    $('#game-count').textContent = `${counts.all} juego${counts.all !== 1 ? 's' : ''}`;
    $('#stats-games').textContent = `${counts.all} juego${counts.all !== 1 ? 's' : ''}`;

    const platformsPresent = FILTER_ORDER.slice(1).filter((p) => counts[p] > 0).length;
    $('#stats-platforms').textContent = `${platformsPresent} plataforma${platformsPresent !== 1 ? 's' : ''}`;
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
        const order = { steam: 0, epic: 1, gog: 2, retro: 3, other: 4 };
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
    const recentTag = isRecent(game) ? '<span class="game-card-new">Nuevo</span>' : '';

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
      selectGame(game.id);
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
  function showDetail() {
    const panel = $('#detail-panel');
    panel.classList.remove('closing');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
  }

  function hideDetail() {
    const panel = $('#detail-panel');
    panel.classList.remove('open');
    panel.classList.add('closing');
    panel.setAttribute('aria-hidden', 'true');
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
      const wasOpen = $('#detail-panel').classList.contains('open');
      if (!wasOpen) playPortal(card);
      renderDetailPanel(game);
      renderHero(game);
      heroApplyDesc(game);
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

    const img = $('#detail-cover');
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

    $('#detail-title').textContent = game.name;

    const platformKey = platformKeyOf(game);
    const platformLabel = platformLabelOf(game);
    const platEl = $('#detail-platform');
    platEl.textContent = platformLabel;
    platEl.className = 'detail-platform ' + platformKey;
    $('#detail-source').textContent = game.source === 'retro' ? 'Retro · ' + (game.platform || 'Emulador') : (game.source || game.platform || platformKey);

    const recentEl = $('#detail-recent');
    recentEl.hidden = !isRecent(game);

    renderDetailMeta(game, null);

    const desc = $('#detail-desc');
    desc.className = 'detail-desc loading';
    desc.innerHTML = '<div class="desc-inner">Cargando información...</div>';

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

    const desc = $('#detail-desc');
    const game = state.allGames.find((g) => g.id === id);
    if (game && info && info.banner && !game.bannerUrl) {
      game.bannerUrl = info.banner;
    }
    if (info && (info.detailedDescription || info.about || info.shortDescription)) {
      const descText = info.detailedDescription || info.about || info.shortDescription || '';
      desc.className = 'detail-desc';
      desc.innerHTML = `<div class="desc-inner">${esc(descText)}</div>`;
    } else if (info && info.discoveredName && info.discoveredName !== game.name) {
      desc.className = 'detail-desc';
      desc.innerHTML = `<div class="desc-inner">Estás viendo la ficha de "<b>${esc(info.discoveredName)}</b>". Si no es el juego que buscas, usa el menú contextual para buscar una carátula o editar la información.</div>`;
    } else {
      const lines = [];
      if (game.source === 'retro') {
        lines.push(`<b>${esc(game.name)}</b> es una ROM para <b>${esc(game.platform || 'emulador')}</b>.`);
      } else {
        lines.push(`<b>${esc(game.name)}</b> está instalado en tu PC.`);
      }
      const platformKey = game.platform || game.source || 'other';
      lines.push(`Plataforma: <b>${esc(platformLabelOf(game))}</b>.`);
      if (game.romPath) {
        lines.push(`ROM: <span class="desc-path">${esc(game.romPath)}</span>.`);
      }
      if (game.sizeOnDisk) {
        lines.push(`Ocupa <b>${(game.sizeOnDisk / 1073741824).toFixed(1)} GB</b> en disco.`);
      }
      if (game.installDir) {
        lines.push(`Ubicación: <span class="desc-path">${esc(game.installDir)}</span>.`);
      }
      if (game.lastPlayed) {
        const d = new Date(game.lastPlayed);
        lines.push(`Último lanzamiento: <b>${d.toLocaleDateString('es-ES')}</b>.`);
      }
      if (game.playtimeMs > 0) {
        lines.push(`Tiempo jugado: <b>${formatPlaytime(game.playtimeMs)}</b>.`);
      }
      lines.push(
        'La información detallada de este título no está disponible en la biblioteca de Steam. Puedes buscar una carátula en línea desde el menú contextual.'
      );
      desc.className = 'detail-desc';
      desc.innerHTML = `<div class="desc-inner">${lines.join('<br>')}</div>`;
    }

    renderDetailMeta(game, info);
  }

  function renderDetailMeta(game, info) {
    const meta = $('#detail-meta');
    const rows = [];

    const devs = info && info.developers;
    if (devs && devs.length) {
      rows.push(metaRow('Desarrolladores', esc(devs.join(', '))));
    }
    const pubs = info && info.publishers;
    if (pubs && pubs.length) {
      rows.push(metaRow('Editores', esc(pubs.join(', '))));
    }
    if (info && info.releaseDate) {
      rows.push(metaRow('Lanzamiento', esc(info.releaseDate)));
    }
    const genres = info && info.genres;
    if (genres && genres.length) {
      const chips = genres.slice(0, 6).map((g) => `<span class="meta-chip">${esc(g)}</span>`).join('');
      rows.push(`<div class="meta-row"><span class="meta-key">Géneros</span><span class="meta-val">${chips}</span></div>`);
    }
    if (game && game.sizeOnDisk) {
      rows.push(metaRow('Tamaño', `${(game.sizeOnDisk / 1073741824).toFixed(1)} GB`));
    }
    if (game && game.playtimeMs > 0) {
      rows.push(metaRow('Tiempo jugado', formatPlaytime(game.playtimeMs)));
    }
    if (info && info.metascore) {
      rows.push(`<div class="meta-row"><span class="meta-key">Metacritic</span><span class="meta-val"><span class="meta-score">${esc(info.metascore)}</span></span></div>`);
    }
    if (info) {
      if (info.isFree) {
        rows.push(`<div class="meta-row"><span class="meta-key">Precio</span><span class="meta-val"><span class="meta-price free">Gratis</span></span></div>`);
      } else if (info.price && info.price.final > 0) {
        rows.push(metaRow('Precio', `${info.price.final} ${esc(info.price.currency || '')}`));
      }
    }

    meta.innerHTML = rows.join('');
  }

  function metaRow(key, val) {
    return `<div class="meta-row"><span class="meta-key">${key}</span><span class="meta-val">${val}</span></div>`;
  }

  function formatPlaytime(ms) {
    const totalMin = Math.round((ms || 0) / 60000);
    if (totalMin < 1) return 'Menos de 1 min';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h} h`;
    return `${h} h ${m} min`;
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
    const playBtn = $('#detail-play');
    playBtn.classList.add('loading');
    showLaunchOverlay(game);
    try {
      const result = await api.launchGame(id);
      if (result && result.success) {
        toast(`Lanzando ${game.name}...`);
      } else {
        toast(`No se pudo lanzar ${game.name}`, 'error');
        console.warn('Launch failed:', result && result.error);
      }
    } catch (err) {
      console.error('Launch error:', err);
      toast('Error al lanzar el juego', 'error');
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
      $('#home-title').textContent = 'Tu biblioteca está vacía';
      $('#home-desc').textContent = 'Añade carpetas de juegos para empezar.';
      $('#home-play').textContent = 'Abrir biblioteca';
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
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg> Continuar`;
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
      wrap.innerHTML = '<div class="home-recent-item" style="cursor:default"><span style="font-size:12px;color:var(--muted)">Aún no has jugado nada</span></div>';
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

  /* ═══════════════ DETAIL PANEL WIRING ═══════════════ */
  $('#detail-play').addEventListener('click', () => {
    if (state.selectedId) launchGame(state.selectedId);
  });

  $('#hero-play').addEventListener('click', () => {
    if (state.selectedId) launchGame(state.selectedId);
  });

  $('#detail-close').addEventListener('click', () => {
    if (!state.selectedId) return;
    deselectGame();
  });

  $$('[data-dlink]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.selectedId) return;
      const game = state.allGames.find((g) => g.id === state.selectedId);
      if (!game) return;
      if (btn.dataset.dlink === 'folder') {
        if (game.installDir) {
          api.openFolder(game.installDir).catch(() => {});
        } else if (game.exePath) {
          api.openFolder(game.exePath.replace(/\\[^\\]*$/, '')).catch(() => {});
        }
      } else if (btn.dataset.dlink === 'cover') {
        openCoverModal(game);
      }
    });
  });

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
      const id = pad ? pad.id : 'Mando conectado';
      $('#gamepad-text').textContent = shortGamepadName(id);
    } else {
      $('#gamepad-dot').classList.remove('on');
      $('#gamepad-text').textContent = 'Sin mando';
    }
  }

  function shortGamepadName(id) {
    const clean = id.replace(/\(.*?\)/g, '').trim();
    if (!clean) return 'Mando conectado';
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
            if (!ok) toast('No se pudo abrir la ubicación', 'error');
          } else if (game.exePath) {
            api.openFolder(game.exePath.replace(/\\[^\\]*$/, ''));
          }
          break;
        case 'remove':
          await api.removeGame(game.id);
          removeGameFromState(game.id);
          toast(`${game.name} eliminado de la biblioteca`);
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
    if (game.installDir) details.push(`Ubicación: ${game.installDir}`);
    if (game.sizeOnDisk) details.push(`Tamaño: ${(game.sizeOnDisk / 1073741824).toFixed(1)} GB`);
    if (game.playtimeMs > 0) details.push(`Jugado: ${formatPlaytime(game.playtimeMs)}`);
    if (!game.exePath && !game.launchUri && !game.romPath) details.push('Ejecutable no encontrado');
    if (game.lastPlayed) {
      const d = new Date(game.lastPlayed);
      details.push(`Último lanzamiento: ${d.toLocaleDateString('es-ES')}`);
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
      renderFoldersList(folders, $('#folders-list'));
      renderFoldersList(folders, $('#settings-folders'));
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
      empty.innerHTML = `<span class="folder-path">Sin carpetas</span>`;
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
        <button class="folder-remove" data-path="${esc(folder)}" title="Quitar carpeta">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
      item.querySelector('.folder-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.removeCustomFolder(folder);
        loadFolders();
        toast('Carpeta eliminada');
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
        toast(`Carpeta añadida: ${folder}`);
      }
    } catch (err) {
      console.error('Failed to add folder:', err);
      toast('No se pudo añadir la carpeta', 'error');
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

  function renderEmulatorsList(emulators) {
    const wrap = $('#settings-emulators');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!emulators || emulators.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'emu-empty';
      empty.textContent = 'Sin emuladores configurados';
      wrap.appendChild(empty);
      return;
    }

    emulators.forEach((emu) => {
      const item = document.createElement('div');
      item.className = 'emu-item';
      item.innerHTML = `
        <div class="emu-item-info">
          <div class="emu-item-name">${esc(emu.name)}</div>
          <div class="emu-item-console">${esc(emu.console || 'Retro')}</div>
          <div class="emu-item-paths">${esc(emu.exePath)}${emu.romsPath ? '<br>' + esc(emu.romsPath) : ''}</div>
        </div>
        <button class="emu-remove" data-id="${esc(emu.id)}" title="Quitar emulador">✕</button>
      `;
      item.querySelector('.emu-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api.removeEmulator(emu.id);
          await loadEmulators();
          toast('Emulador eliminado');
        } catch (err) {
          console.error('Remove emulator failed:', err);
          toast('No se pudo eliminar el emulador', 'error');
        }
      });
      wrap.appendChild(item);
    });
  }

  async function loadEmulators() {
    try {
      const emus = await api.getEmulators();
      renderEmulatorsList(emus || []);
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

    if (!name) { toast('Escribe un nombre para el emulador', 'error'); return; }
    if (!exePath) { toast('Selecciona el ejecutable del emulador', 'error'); return; }
    if (!romsPath) { toast('Selecciona la carpeta de ROMs', 'error'); return; }

    try {
      await api.addEmulator({ name, console: consoleValue || 'Retro', exePath, romsPath, args });
      clearEmulatorForm();
      await loadEmulators();
      toast('Emulador añadido. Analizando ROMs...');
    } catch (err) {
      console.error('Add emulator failed:', err);
      toast('No se pudo añadir el emulador', 'error');
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
    if (!name) { toast('Escribe el nombre del juego', 'error'); return; }
    if (!exePath) { toast('Selecciona el ejecutable del juego', 'error'); return; }
    try {
      const game = await api.addGame({ name, exePath, source: 'custom', platform: 'custom', isManual: true });
      $('#manual-name').value = '';
      $('#manual-exe').value = '';
      toast(`Juego añadido: ${game.name}`, 'success');
      await loadGames();
    } catch (err) {
      console.error('Add game failed:', err);
      toast('No se pudo añadir el juego', 'error');
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
    setUpdateStatus('Comprobando la última versión en GitHub…', 'busy');
    try {
      const res = await api.checkUpdates();
      if (!res) {
        setUpdateStatus('No se pudo comprobar. Reintenta más tarde.', 'err');
      } else if (res.error) {
        setUpdateStatus(res.error, 'err');
      } else if (!res.hasUpdate) {
        setUpdateStatus(
          `Ya tienes la última versión (${res.currentVersion || 'actual'}).`,
          'ok'
        );
      } else {
        const note = (res.notes || '').split('\n').slice(0, 6).join('\n  ');
        const kind = note ? ' (notas de la versión abajo)' : '';
        setUpdateStatus(
          `¡Nueva versión ${res.latestVersion} disponible!${kind}`,
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
            dl.textContent = 'Descargar instalador';
            dl.onclick = () => api.openUpdateUrl(res.assetUrl);
            row.appendChild(dl);
          }
          if (res.htmlUrl) {
            const go = document.createElement('button');
            go.className = 'btn-secondary';
            go.textContent = 'Ver release';
            go.onclick = () => api.openUpdateUrl(res.htmlUrl);
            row.appendChild(go);
          }
          resultBox.appendChild(row);
        }
      }
    } catch (err) {
      console.error('Update check failed:', err);
      setUpdateStatus('Error al comprobar actualizaciones.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Buscar';
    }
  }

  $('#btn-check-updates').addEventListener('click', checkForUpdates);

  async function loadSettings() {
    try {
      const settings = await api.getSettings();
      if (!settings) return;
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
    $('#cover-modal-title').textContent = `Portada · ${game.name}`;
    $('#cover-search-input').value = game.name;
    $('#cover-results').innerHTML = `<div class="cover-hint">Escribe un nombre y pulsa Buscar</div>`;
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
      resultsEl.innerHTML = `<div class="cover-hint">Escribe un nombre y pulsa Buscar</div>`;
      return;
    }

    resultsEl.innerHTML = `<div class="cover-loading"><div class="spinner"></div>Buscando portadas...</div>`;

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
          `<span><b>Sin clave RAWG.</b> Añade tu clave en <b>Ajustes → Claves de API</b> para ver descripciones y arte de todas las plataformas (Epic/GOG/custom). Por ahora se muestran resultados de Steam/SteamGridDB.</span>`;
        resultsEl.appendChild(note);
      }
      if (!items || items.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'cover-hint';
        hint.textContent = 'No se encontraron resultados. Intenta con otro nombre.';
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
        img.alt = 'Portada';
        img.onerror = () => div.remove();
        if (item.isWide) {
          const badge = document.createElement('span');
          badge.className = 'cover-item-wide-badge';
          badge.textContent = 'Panorámica';
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
                if (state.selectedId === game.id) renderDetailPanel(game);
                toast('Portada actualizada', 'success');
              } else {
                toast('No se pudo guardar la portada', 'error');
              }
              closeCoverModal();
            } catch (err) {
              console.error('Cover set failed:', err);
              toast('Error al guardar la portada', 'error');
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
      resultsEl.innerHTML = `<div class="cover-hint">La búsqueda falló. Intenta de nuevo.</div>`;
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
            if (state.selectedId === game.id) renderDetailPanel(game);
            toast('Portada actualizada', 'success');
          } else {
            toast('No se pudo guardar la portada', 'error');
          }
        } catch (err) {
          console.error('Upload cover failed:', err);
          toast('Error al guardar la portada', 'error');
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
  });

  api.onGameRemoved((id) => {
    removeGameFromState(id);
  });

  /* ═══════════════ INIT ═══════════════ */
  async function init() {
    initGamepad();
    await loadSettings();
    await loadFolders();
    loadEmulators();
    loadGames();
  }

  init();
})();
