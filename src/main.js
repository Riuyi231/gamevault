const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const chokidar = require('chokidar');
const { autoUpdater } = require('electron-updater');
const GameDetector = require('./services/game-detect');
const GameStore = require('./services/game-store');
const ArtworkService = require('./services/artwork');
const GameInfoService = require('./services/game-info');
const UpdaterService = require('./services/updater');
const { EmulatorCatalog } = require('./services/emulator-catalog');
const I18N = require('./i18n/dict');

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// En desarrollo el +Electron+ escribe en %APPDATA%\Electron por defecto; lo
// fijamos a GameVault para que dev y la app instalada compartan sus datos.
if (!app.isPackaged) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'GameVault'));
  } catch {
    // ignore
  }
}

const SCAN_INTERVAL = 90 * 1000;

let mainWindow = null;
let gameStore = null;
let gameDetector = null;
let artworkService = null;
let gameInfoService = null;
let updaterService = null;
let emulatorCatalog = null;
let watcher = null;
let currentScan = null;
let periodicTimer = null;
let rescansSinceScan = 0;
let tray = null;
let quitting = false;
let updateDownloadedFor = null;

const log = (...args) => console.log('[GameVault]', ...args);
const logError = (...args) => console.error('[GameVault]', ...args);

/* ─────────────────────────── I18N ─────────────────────────── */
function currentLocale() {
  try {
    const s = gameStore && gameStore.getSettings ? gameStore.getSettings() : null;
    return (s && s.locale) || I18N.DEFAULT_LOCALE;
  } catch {
    return I18N.DEFAULT_LOCALE;
  }
}
function t(key, vars) {
  return I18N.t(currentLocale(), key, vars);
}

/* ─────────────────────────── PLAYTIME ─────────────────────────── */

// Track running sessions to accumulate playtime. For native/emulator launches we
// have a PID we can poll; for launcher-URI launches (Steam/Epic) we flush the
// session on the next launch of the same game or when the app quits.
const playSessions = new Map(); // id -> { startedAt, pids, uri }

function endPlaySession(id, now = Date.now()) {
  const s = playSessions.get(id);
  if (!s) return;
  playSessions.delete(id);
  const elapsed = Math.max(0, now - s.startedAt);
  if (elapsed >= 1000 && gameStore) gameStore.addPlaytime(id, elapsed);
}

function startPlaySession(game, pid, uri = false) {
  const id = game && game.id;
  if (!id) return;
  endPlaySession(id); // flush any previous session for the same game
  playSessions.set(id, { startedAt: Date.now(), pids: pid ? new Set([pid]) : new Set(), uri });
}

function tickPlaySessions() {
  const now = Date.now();
  for (const id of Array.from(playSessions.keys())) {
    const s = playSessions.get(id);
    if (!s || s.uri) continue; // URI sessions are flushed on quit / next launch
    if (s.pids.size === 0) { endPlaySession(id, now); continue; }
    let alive = false;
    for (const pid of s.pids) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        // process no longer exists
      }
    }
    if (!alive) endPlaySession(id, now);
  }
}

/* ─────────────────────────── LAUNCHING ─────────────────────────── */

// Spawns a process capturing failure both synchronously and via the 'error'
// event. WINDOWS NOTE: spawn can fail asynchronously (EACCES/ENOENT with a weird
// path); without an 'error' listener the ChildProcess throws and Electron opens
// the "A JavaScript error occurred in the main process" dialog.
function launchChild(exe, args, opts) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(exe, args, opts);
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const settleFail = (err) => {
      if (settled) return;
      settled = true;
      logError('Launch failed:', err);
      resolve({ ok: false, error: err.message });
    };
    child.once('error', settleFail);
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.removeListener('error', settleFail);
      child.on('error', (err) => logError('Child process error:', err));
      resolve({ ok: true, pid: child.pid, child });
    });
    child.unref();
  });
}

// Reconciles a stored exePath with reality: trims whitespace and retries with
// the clean basename inside installDir (stored paths can carry a stray leading
// space, p.ej. "D:\Genshin Impact game\ GenshinImpact.exe").
function resolveExe(exePath, installDir) {
  let p = String(exePath || '').trim();
  if (p && fs.existsSync(p)) return p;
  if (p && installDir) {
    const base = path.basename(p).trim();
    if (base && base !== path.basename(p)) {
      const dir = String(installDir).replace(/[\\/]$/, '');
      const candidate = path.join(dir, base);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return p;
}

// WINDOWS: algunos juegos piden elevación (manifiesto requireAdministrator,
// anti-cheat...) y el spawn directo de Node falla con EACCES/EPERM aunque el
// .exe exista; ShellExecute (shell.openPath) gestiona el prompt de UAC y los
// abre. Usado como reintento cuando spawn no pudo arrancar el proceso.
async function launchViaShell(exePath) {
  try {
    const res = await shell.openPath(exePath);
    if (typeof res === 'string' && res) return { ok: false, error: res };
    return { ok: true, viaShell: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function needsShellFallback(launchErr) {
  return process.platform === 'win32' && /EACCES|EPERM/.test(String(launchErr || ''));
}

// Starts a game's process (native exe, emulator+ROM or launcher URI) and starts
// a playtime session. Returns { success, viaLauncher, pid } or { success:false, error }.
async function openGameProcess(game) {
  const id = game.id;

  // Emulador + ROM (juegos retro)
  if (game.romPath) {
    const emuPath = game.exePath || '';
    if (emuPath && fs.existsSync(emuPath)) {
      const args = [];
      if (game.emulatorArgs) args.push(...splitArgs(game.emulatorArgs));
      args.push(game.romPath);
      const launched = await launchChild(emuPath, args, {
        cwd: path.dirname(emuPath),
        detached: true,
        stdio: 'ignore'
      });
      if (!launched.ok) {
        if (needsShellFallback(launched.error)) {
          const via = await launchViaShell(emuPath);
          if (via.ok) {
            gameStore.updateGame(id, { lastPlayed: Date.now(), exePath: emuPath });
            startPlaySession(game, null, true);
            log('Launched (retro, via ShellExecute):', game.name, emuPath, '->', game.romPath);
            return { success: true, viaLauncher: true };
          }
          return { success: false, error: via.error || launched.error };
        }
        return { success: false, error: launched.error };
      }
      gameStore.updateGame(id, { lastPlayed: Date.now(), exePath: emuPath });
      startPlaySession(game, launched.pid);
      log('Launched (retro):', game.name, emuPath, '->', game.romPath);
      return { success: true, pid: launched.pid };
    }
    return { success: false, error: t('main.emuNotFound') };
  }

  // Xbox / Game Pass (MSIX) apps launch via their AUMID through Explorer.
  if (game.aumid) {
    const launched = await launchChild(
      'explorer.exe',
      ['shell:AppsFolder\\' + game.aumid],
      { windowsHide: true }
    );
    if (!launched.ok) return { success: false, error: launched.error };
    gameStore.updateGame(id, { lastPlayed: Date.now() });
    startPlaySession(game, null, true);
    log('Launched Xbox app:', game.name, game.aumid);
    return { success: true };
  }

  let exePath = game.exePath
    ? resolveExe(game.exePath, game.installDir || path.dirname(game.exePath))
    : '';
  if (!exePath && game.installDir) {
    exePath = gameDetector._findMainExe(game.installDir);
    if (exePath) gameStore.updateGame(id, { exePath });
  } else if (exePath && exePath !== game.exePath) {
    gameStore.updateGame(id, { exePath });
  }

  // Juegos de Epic cuyo ejecutable es el bootstrap/launcher (p.ej. Fortnite):
  // abrir el .exe del launcher directamente no inicia el juego; usa la URI.
  if (game.source === 'epic' && game.launchUri && exePath) {
    const leaf = String(exePath).toLowerCase();
    if (/bootstrap|_launcher|launcher\.exe/.test(leaf)) exePath = null;
  }

  if (exePath && fs.existsSync(exePath)) {
    const launched = await launchChild(exePath, [], {
      cwd: game.installDir || path.dirname(exePath),
      detached: true,
      stdio: 'ignore'
    });
    if (!launched.ok) {
      if (needsShellFallback(launched.error)) {
        const via = await launchViaShell(exePath);
        if (via.ok) {
          gameStore.updateGame(id, { lastPlayed: Date.now() });
          startPlaySession(game, null, true);
          log('Launched via ShellExecute:', game.name, exePath);
          return { success: true, viaLauncher: true };
        }
        return { success: false, error: via.error || launched.error };
      }
      return { success: false, error: launched.error };
    }
    gameStore.updateGame(id, { lastPlayed: Date.now() });
    startPlaySession(game, launched.pid);
    log('Launched:', game.name, exePath);
    return { success: true, pid: launched.pid };
  }

  if (game.launchUri) {
    try {
      shell.openExternal(game.launchUri);
      gameStore.updateGame(id, { lastPlayed: Date.now() });
      startPlaySession(game, null, true);
      log('Launched via launcher URI:', game.name, game.launchUri);
      return { success: true, viaLauncher: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return {
    success: false,
    error: exePath
      ? `${t('main.exeNotFound')}: ${exePath}`
      : t('main.exeNotFound')
  };
}

// Captures the primary screen and stores it as a PNG for a game's real-gameplay cover.
async function captureScreenToFile(gameId) {
  const capturesDir = path.join(app.getPath('userData'), 'captures');
  fs.mkdirSync(capturesDir, { recursive: true });
  const filePath = path.join(capturesDir, `${gameId}-${Date.now()}.png`);
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1600, height: 900 }
    });
    if (!sources || sources.length === 0) return { ok: false, error: t('main.noScreen') };
    const primary = sources.find((s) => s.display_id === '0') || sources[0];
    const image = primary.thumbnail;
    if (!image || image.isEmpty()) return { ok: false, error: t('main.noImage') };
    fs.writeFileSync(filePath, image.toPNG());
    return { ok: true, localCoverPath: filePath };
  } catch (err) {
    logError('Screen capture failed:', err);
    return { ok: false, error: t('main.captureFail') };
  }
}

function splitArgs(input) {
  const result = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || ''))) !== null) {
    result.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return result;
}

// Comprueba si el Microsoft Visual C++ 2015-2022 Redistributable (x64) está
// instalado. PCSX2 y Dolphin (emuladores incluidos) lo requieren.
function isVcRedistInstalled() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
    'HKCU\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
  ];
  for (const key of keys) {
    try {
      const r = spawnSync('reg', ['query', key, '/v', 'Installed'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000
      });
      if (r.status === 0 && r.stdout && /Installed\s+REG_DWORD\s+0x1/i.test(r.stdout)) {
        return true;
      }
    } catch {
      // siguiente clave
    }
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'GameVault',
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    frame: false,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Cerrar la ventana con la X minimiza a bandeja (menos en salida real).
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-fail-load', (event, code) => {
    if (code === -3) return;
    logError('Failed to load renderer, code', code);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logError('Renderer process gone:', details.reason, details.exitCode);
    // Si el renderer se cae por un crash de GPU o un fallo de rendering,
    // recargamos en vez de dejar la ventana congelada esperando a que el
    // usuario cambie de ventana.
    recoverFromRenderingFailure();
  });

  mainWindow.webContents.on('gpu-process-crashed', (event) => {
    logError('GPU process crashed');
    recoverFromRenderingFailure();
  });

  mainWindow.webContents.on('console-message', (event, details) => {
    const level = details && details.level !== undefined ? details.level : 0;
    const message = details && details.message ? details.message : '';
    if (level >= 2) {
      logError(`[renderer:${level}] ${message}`);
    }
  });
}

// La ventana puede quedarse "frita" si el proceso GPU crashea o el renderer se
// cae a mitad de un repintado pesado (p. ej. al abrir una captura grande). Se
// recarga el contenido con un enfriamiento para no reiniciar en bucle.
let lastRenderingRecovery = 0;
function recoverFromRenderingFailure() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  if (now - lastRenderingRecovery < 10000) return;
  lastRenderingRecovery = now;
  log('Recuperando congelacion de rendering: recargando la ventana...');
  try {
    mainWindow.webContents.reload();
  } catch {
    // ignore
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, payload);
    } catch {
      // ignore
    }
  }
}

const pendingEmuCovers = new Set();

// Busca el logo/portada real de cada emulador (Wikipedia, sin clave) y lo
// persiste en el store; luego avisa al renderer para que refresque las vistas.
async function enrichEmulatorCovers() {
  if (!artworkService) return;
  try {
    for (const emu of gameStore.getEmulators()) {
      if (emu.coverUrl || pendingEmuCovers.has(emu.id)) continue;
      pendingEmuCovers.add(emu.id);
      const logo = await artworkService.searchEmulatorLogo(emu.name || emu.console || '');
      if (logo) {
        gameStore.updateEmulator(emu.id, { coverUrl: logo });
        sendToRenderer('emulators-updated');
      }
    }
  } catch {
    // ignore
  }
}

function attachLocalCovers(game) {
  const clean = { ...game };
  const local = artworkService.getCoverLocal(clean.id);
  if (local) {
    clean.hasLocalCover = true;
    clean.localCoverPath = local;
  }
  return clean;
}

function syncServiceKeys(settings) {
  const s = settings || {};
  if (gameInfoService && gameInfoService.setRawgKey) gameInfoService.setRawgKey(s.rawgKey);
  if (artworkService && artworkService.setRawgKey) artworkService.setRawgKey(s.rawgKey);
  if (artworkService && artworkService.setSgdbKey) artworkService.setSgdbKey(s.sgdbKey);
  if (gameInfoService && gameInfoService.setIgdbKeys) gameInfoService.setIgdbKeys(s.igdbClientId, s.igdbClientSecret);
  if (artworkService && artworkService.setIgdbKeys) artworkService.setIgdbKeys(s.igdbClientId, s.igdbClientSecret);
  if (gameInfoService && gameInfoService.setTgdbKey) gameInfoService.setTgdbKey(s.tgdbKey);
  if (artworkService && artworkService.setTgdbKey) artworkService.setTgdbKey(s.tgdbKey);
  if (gameDetector && gameDetector.setLocale) gameDetector.setLocale(s.locale || I18N.DEFAULT_LOCALE);
  if (gameInfoService && gameInfoService.setLocale) gameInfoService.setLocale(s.locale || I18N.DEFAULT_LOCALE);
  if (updaterService && updaterService.setLocale) updaterService.setLocale(s.locale || I18N.DEFAULT_LOCALE);
}

/* ─────────────────────────── SCANNING ─────────────────────────── */

function doScan() {
  const customFolders = gameStore.getCustomFolders();
  const emulators = gameStore.getEmulators();
  return gameDetector.getAllGames(customFolders, [], (percent, message) => {
    sendToRenderer('scan-progress', { percent, message });
  }, emulators).then((detected) => {
    const withCovers = detected.map(attachLocalCovers);
    const { newGames, total } = gameStore.syncFromScan(withCovers);

    for (const game of newGames) {
      sendToRenderer('game-added', attachLocalCovers(game));
    }

    gameStore.setLastScan(Date.now());
    const platforms = gameStore.getPlatformCounts();
    sendToRenderer('scan-complete', { total, newCount: newGames.length, platforms });
    rebuildWatcher(detected);
    log('Scan complete:', total, 'games,', newGames.length, 'new');
    return { total, newCount: newGames.length, platforms };
  }).catch((err) => {
    logError('Scan failed:', err.message || err);
    sendToRenderer('scan-complete', {
      total: gameStore.getGames().length,
      newCount: 0,
      error: String(err.message || err),
      platforms: gameStore.getPlatformCounts()
    });
    return { total: gameStore.getGames().length, newCount: 0, error: true };
  });
}

function runScan() {
  if (currentScan) return currentScan;
  currentScan = doScan().finally(() => {
    currentScan = null;
  });
  return currentScan;
}

/* ─────────────────────────── WATCHER ─────────────────────────── */

let watcherDebounce = null;

function scheduleRescan() {
  if (watcherDebounce) clearTimeout(watcherDebounce);
  rescansSinceScan++;
  watcherDebounce = setTimeout(() => {
    watcherDebounce = null;
    runScan();
  }, 1200);
}

async function rebuildWatcher(detectedGames) {
  if (watcher) {
    try {
      await watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }

  const games = detectedGames && detectedGames.length > 0 ? detectedGames : gameStore.getGames();
  const paths = new Set(gameStore.getCustomFolders().filter((p) => fs.existsSync(p)));

  for (const game of games) {
    if (!game.installDir || !fs.existsSync(game.installDir)) continue;
    const lower = game.installDir.toLowerCase();
    const idx = lower.indexOf('steamapps\\common');
    if (idx !== -1) {
      const commonDir = game.installDir.slice(0, idx + 'steamapps\\common'.length);
      if (fs.existsSync(commonDir)) paths.add(commonDir);
    } else {
      paths.add(game.installDir);
    }
  }

  if (paths.size === 0) return;

  try {
    watcher = chokidar.watch(Array.from(paths), {
      ignoreInitial: true,
      depth: 2,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 2000 }
    });
    watcher.on('add', scheduleRescan);
    watcher.on('unlink', scheduleRescan);
    watcher.on('addDir', scheduleRescan);
    watcher.on('unlinkDir', scheduleRescan);
    log('Watching', paths.size, 'paths for game changes');
  } catch (err) {
    logError('Watcher error:', err.message || err);
  }
}

function startPeriodicRescan() {
  if (periodicTimer) clearInterval(periodicTimer);
  const settings = gameStore.getSettings();
  if (settings.autoScan === false) return;
  periodicTimer = setInterval(() => {
    runScan();
  }, SCAN_INTERVAL);
}

/* ─────────────────────────── INFO (caché + prefetch) ─────────────────────────── */

const INFO_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 días
// Coincide con game-info.js: las fichas cacheadas sin esta versión se re-descargan
// una vez (p. ej. las que se crearon antes de existir trailers/plataformas).
const INFO_SCHEMA_VERSION = 2;

// Comparte la petición de info por juego (evita duplicar fetch si el prefetch ya
// está descargándolo) y la persiste para que la siguiente apertura sea instantánea.
const infoPromises = new Map();
function getOrFetchInfo(id, game) {
  if (infoPromises.has(id)) return infoPromises.get(id);
  const p = gameInfoService
    .fetchForGame({ id, name: game.name, appId: game.appId })
    .then((info) => {
      if (info && (info.detailedDescription || info.shortDescription)) {
        gameStore.setInfoCache(id, info);
      }
      return info;
    })
    .finally(() => infoPromises.delete(id));
  infoPromises.set(id, p);
  return p;
}

function isCacheFresh(id, game) {
  const c = gameStore.getInfoCache(id);
  if (!c) return false;
  if (Date.now() - c.savedAt >= INFO_CACHE_TTL) return false;
  if (c.name && game.name && c.name !== game.name) return false;
  if (c.info && c.info.version !== INFO_SCHEMA_VERSION) return false;
  return true;
}

// Precalienta las fichas en segundo plano (3 en paralelo como mucho; el throttle
// interno de las fuentes ya espacia las peticiones para no tocar rate-limits).
const prewarmThinTries = new Map();
function isThinWikiCache(c) {
  return !!(c && c.info && c.info.source === 'wikipedia' && !(c.info.developers && c.info.developers.length) && !(c.info.publishers && c.info.publishers.length));
}
function prewarmGameInfo() {
  const games = gameStore.getGames();
  let i = 0;
  const worker = async () => {
    while (i < games.length) {
      const g = games[i++];
      if (!g) continue;
      const c = gameStore.getInfoCache(g.id);
      const versionOk = !!(c && c.info && c.info.version === INFO_SCHEMA_VERSION);
      const ttlOk = c && Date.now() - c.savedAt < INFO_CACHE_TTL;
      if (c && ttlOk && versionOk) {
        // Caché fresca y con el esquema actual: solo se re-descarga si quedó
        // "delgada" (rate-limit de Wikidata) y hace tiempo de la última tentativa.
        if (!isThinWikiCache(c)) continue;
        const last = prewarmThinTries.get(g.id) || 0;
        if (Date.now() - last < 8 * 60 * 1000) continue;
        prewarmThinTries.set(g.id, Date.now());
      }
      try {
        await getOrFetchInfo(g.id, g);
      } catch {
        // ignore
      }
    }
  };
  for (let w = 0; w < 2; w++) worker();
}

/* ─────────────────────────── IPC ─────────────────────────── */

function setupIPC() {
  ipcMain.handle('get-games', async () => {
    const games = gameStore.getGames();
    if (games.length === 0 && gameStore.getLastScan() === 0) {
      try {
        await runScan();
      } catch {
        // ignore
      }
    }
    return gameStore.getGames().map(attachLocalCovers);
  });

  ipcMain.handle('launch-game', async (event, id) => {
    const game = gameStore.getGame(id);
    if (!game) return { success: false, error: t('main.gameNotFound') };
    return openGameProcess(game);
  });

  ipcMain.handle('capture-gameplay', async (event, id) => {
    const game = gameStore.getGame(id);
    if (!game) return { ok: false, error: t('main.gameNotFound') };

    const launched = await openGameProcess(game);
    if (!launched || !launched.success) {
      return { ok: false, error: launched && launched.error ? launched.error : t('main.launchFailed') };
    }
    if (launched.viaLauncher) {
      return { ok: false, error: t('main.captureExternal') };
    }

    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    } catch { /* ignore */ }

    await new Promise((resolve) => setTimeout(resolve, 8000));

    const shot = await captureScreenToFile(id);
    if (!shot.ok) return shot;

    gameStore.updateGame(id, { hasLocalCover: true, localCoverPath: shot.localCoverPath });
    log('Captured gameplay for:', game.name, '->', shot.localCoverPath);
    return { ok: true, localCoverPath: shot.localCoverPath };
  });

  ipcMain.handle('rescan', async () => {
    return runScan();
  });

  ipcMain.handle('add-game', async (event, data) => {
    const game = {
      id: data.id || `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: data.name || t('main.defaultName'),
      exePath: data.exePath || '',
      source: data.source || 'custom',
      installDir: data.installDir || (data.exePath ? path.dirname(data.exePath) : ''),
      platform: data.platform || 'other',
      appId: data.appId || '',
      coverUrl: data.coverUrl || '',
      sizeOnDisk: data.sizeOnDisk || 0,
      launchUri: data.launchUri || '',
      lastPlayed: 0,
      addedAt: Date.now(),
      playtimeMs: 0,
      isManual: false,
      hasLocalCover: false,
      localCoverPath: '',
      ...data
    };
    gameStore.addGame(game);
    sendToRenderer('game-added', attachLocalCovers(game));
    return attachLocalCovers(game);
  });

  ipcMain.handle('remove-game', async (event, id) => {
    gameStore.removeGame(id);
    artworkService.removeCover(id);
    sendToRenderer('game-removed', id);
    return true;
  });

  // Delete a game's installed files from disk (moves to Recycle Bin for safety)
  ipcMain.handle('delete-game-from-disk', async (event, id) => {
    const game = gameStore.getGame(id);
    if (!game) return { success: false, error: t('main.gameNotFound') };

    // Never delete the whole launcher/library roots (safety guard)
    const installDir = (game.installDir || '').trim();
    const protectedRoots = /^[A-Za-z]:[\\/](steam|steamlibrary|steamapps|program files|program files \(x86\)|epic games|gog|windows|users)/i;
    if (!installDir || !fs.existsSync(installDir) || protectedRoots.test(installDir.replace(/[\\/]+$/, ''))) {
      return { success: false, error: t('main.invalidDeleteLocation') };
    }

    try {
      await shell.trashItem(installDir);
    } catch (err) {
      logError('trashItem failed:', err.message || err);
      // Fallback: try direct delete
      try {
        fs.rmSync(installDir, { recursive: true, force: true });
      } catch (err2) {
        return { success: false, error: err2.message || t('main.deleteFailed') };
      }
    }

    // Remove from store + send update
    gameStore.removeGame(id);
    artworkService.removeCover(id);
    sendToRenderer('game-removed', id);
    log('Deleted from disk:', game.name, installDir);
    return { success: true };
  });

  ipcMain.handle('search-artwork', async (event, name) => {
    return artworkService.searchGame(name);
  });

  ipcMain.handle('get-artwork-config', async () => {
    return {
      hasRawgKey: !!(artworkService && artworkService.rawgKey),
      hasSgdb: !!(artworkService && artworkService.sgdbKey),
      hasIgdb: !!(artworkService && artworkService.igdbId && artworkService.igdbSecret),
      hasTgdb: !!(artworkService && artworkService.tgdbKey)
    };
  });

  ipcMain.handle('check-updates', async () => {
    if (!updaterService) return { error: t('main.updaterUnavailable') };
    return updaterService.checkForUpdates();
  });

  ipcMain.handle('open-update-url', async (event, url) => {
    if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('download-update', async () => {
    if (!app.isPackaged) return { error: t('main.packagedOnly') };
    try {
      autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { error: err && err.message ? err.message : t('main.downloadStartFailed') };
    }
  });

  ipcMain.handle('install-update', async () => {
    if (!app.isPackaged) return { error: t('main.packagedOnly') };
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      return { error: err && err.message ? err.message : t('main.installFailed') };
    }
  });

  ipcMain.handle('set-cover', async (event, id, dataUrlOrUrl) => {
    const saved = await artworkService.saveCover(id, dataUrlOrUrl);
    if (saved) {
      gameStore.updateGame(id, { hasLocalCover: true, localCoverPath: saved });
      return { ok: true, localCoverPath: saved };
    }
    return { ok: false };
  });

  ipcMain.handle('open-external', async (event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('check-env', async () => {
    return { vcredistMissing: !isVcRedistInstalled() };
  });

  ipcMain.handle('export-config', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: t('main.exportTitle'),
      defaultPath: `gamevault-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const payload = {
      app: 'gamevault',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      settings: gameStore.getSettings(),
      customFolders: gameStore.getCustomFolders(),
      emulators: gameStore
        .getEmulators()
        .filter((e) => !String(e.id || '').startsWith('bundled-'))
        .map((e) => ({ ...e }))
    };
    try {
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return { ok: true, filePath };
    } catch (err) {
      logError('Export config failed:', err);
      return { ok: false, error: 'write' };
    }
  });

  ipcMain.handle('import-config', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: t('main.importTitle'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };

    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
    } catch {
      return { ok: false, error: 'invalid-json' };
    }
    if (!payload || payload.app !== 'gamevault') return { ok: false, error: 'not-gamevault' };

    if (payload.settings && typeof payload.settings === 'object') {
      gameStore.updateSettings(payload.settings);
      syncServiceKeys(payload.settings);
    }
    if (Array.isArray(payload.customFolders)) {
      gameStore.setCustomFolders(payload.customFolders);
      rebuildWatcher();
    }
    if (Array.isArray(payload.emulators)) {
      gameStore.setEmulators(
        payload.emulators.filter((e) => e && e.id && !String(e.id).startsWith('bundled-'))
      );
    }
    startPeriodicRescan();
    return { ok: true };
  });

  ipcMain.handle('get-settings', async () => {
    return gameStore.getSettings();
  });

  ipcMain.handle('set-settings', async (event, settings) => {
    const updated = gameStore.updateSettings(settings || {});
    syncServiceKeys(updated);
    startPeriodicRescan();
    return updated;
  });

  ipcMain.handle('get-custom-folders', async () => {
    return gameStore.getCustomFolders();
  });

  ipcMain.handle('add-custom-folder', async (event, folder) => {
    const added = gameStore.addCustomFolder(folder);
    if (added) {
      rebuildWatcher();
      setTimeout(runScan, 250);
    }
    return added;
  });

  ipcMain.handle('remove-custom-folder', async (event, folder) => {
    const removed = gameStore.removeCustomFolder(folder);
    if (removed) {
      rebuildWatcher();
    }
    return removed;
  });

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: t('main.selectFolderTitle')
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('select-executable', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: t('main.selectExeTitle'),
      filters: [{ name: t('main.executablesFilter'), extensions: ['exe'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /* ── Emuladores (retro) ── */

  ipcMain.handle('get-emulators', async () => {
    enrichEmulatorCovers();
    return gameStore.getEmulators();
  });

  ipcMain.handle('add-emulator', async (event, emulator) => {
    const config = gameStore.addEmulator(emulator || {});
    rebuildWatcher();
    setTimeout(runScan, 250);
    setTimeout(enrichEmulatorCovers, 300);
    return config;
  });

  ipcMain.handle('remove-emulator', async (event, id) => {
    const removed = gameStore.removeEmulator(id);
    if (removed) {
      rebuildWatcher();
      setTimeout(runScan, 250);
    }
    return removed;
  });

  ipcMain.handle('open-folder', async (event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) return false;
    shell.openPath(folderPath);
    return true;
  });

  ipcMain.handle('get-game-info', async (event, game) => {
    if (!game || !game.id) return null;
    try {
      if (isCacheFresh(game.id, game)) {
        const c = gameStore.getInfoCache(game.id);
        // Auto-curación: si la ficha de fuente Wikipedia está "delgada" (sin
        // desarrollador/plataformas porque el enriquecimiento de Wikidata se
        // topó con un rate-limit), se re-descarga en segundo plano y la
        // siguiente apertura ya muestra los datos completos.
        if (isThinWikiCache(c) && Date.now() - c.savedAt > 5 * 60 * 1000) {
          getOrFetchInfo(game.id, game).catch(() => {});
        }
        return c.info;
      }
      const info = await getOrFetchInfo(game.id, game);
      // Persiste portada y banner panorámico obtenidos de internet (RAWG,
      // Steam o Wikipedia) para que sobrevivan al siguiente análisis.
      if (info && game.id) {
        const base = gameStore.getGame(game.id);
        if (!base || !base.hasLocalCover || base.hasLocalCover === undefined) {
          const updates = {};
          if (info.coverUrl) updates.coverUrl = info.coverUrl;
          if (info.banner) updates.bannerUrl = info.banner;
          if (Object.keys(updates).length > 0) gameStore.updateGame(game.id, updates);
        }
      }
      return info;
    } catch (err) {
      logError('get-game-info error:', err.message || err);
      return null;
    }
  });

  ipcMain.handle('get-platforms', async () => {
    const counts = gameStore.getPlatformCounts();
    const labels = { steam: t('filters.steam'), epic: t('filters.epic'), gog: t('filters.gog'), xbox: t('filters.xbox'), other: t('filters.other') };
    return Object.keys(counts).map((id) => ({ id, label: labels[id] || id, count: counts[id] }));
  });

  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });

  ipcMain.on('window-fullscreen', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  // Modo consola: pantalla completa real de la ventana (y restauración).
  // Se usa event.sender para funcionar también desde ventanas de test.
  ipcMain.handle('get-window-fullscreen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!(win && win.isFullScreen());
  });

  ipcMain.handle('set-arcade-fullscreen', async (event, on) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.setFullScreen(!!on);
      return true;
    } catch {
      return false;
    }
  });
}

/* ─────────────────────────── AUTO-UPDATE ─────────────────────────── */

const sendUpdateStatus = (state) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', state);
  }
};

function setupAutoUpdater() {
  if (!app.isPackaged) {
    log('AutoUpdate: saltado (aplicación no empaquetada).');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  try {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: process.env.GAMEVAULT_UPDATE_REPO
        ? process.env.GAMEVAULT_UPDATE_REPO.split('/')[0]
        : 'Riuyi231',
      repo: process.env.GAMEVAULT_UPDATE_REPO
        ? process.env.GAMEVAULT_UPDATE_REPO.split('/')[1]
        : 'gamevault'
    });
  } catch (err) {
    logError('AutoUpdate: feed no configurado, usando app-update.yml.', err && err.message);
  }

  autoUpdater.on('update-available', (info) => {
    log('AutoUpdate: nueva versión', info && info.version);
    sendUpdateStatus({ type: 'available', version: info && info.version });
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ type: 'not-available' });
  });

  autoUpdater.on('download-progress', (p) => {
    const percent = p && typeof p.percent === 'number' ? Math.round(p.percent) : 0;
    sendUpdateStatus({ type: 'downloading', percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = info && info.version;
    log('AutoUpdate: descarga completada', version);
    updateDownloadedFor = version;
    sendUpdateStatus({ type: 'downloaded', version });
    rebuildTrayMenu();
    try {
      new Notification({
        title: t('main.notifUpdatedTitle'),
        body: t('main.notifUpdatedBody', { version: version || '' })
      }).show();
    } catch (err) {
      logError('Notification failed:', err);
    }
  });

  autoUpdater.on('error', (err) => {
    logError('AutoUpdate: error', err && (err.message || err));
    sendUpdateStatus({
      type: 'error',
      error: err && err.message ? err.message : String(err)
    });
  });

  const checkOnce = () => {
    autoUpdater.checkForUpdates().catch((err) => {
      logError('AutoUpdate: comprobación fallida', err && (err.message || err));
    });
  };
  setTimeout(checkOnce, 15000);
  setInterval(checkOnce, 3600 * 1000);
}

/* ─────────────────────────── TRAY ─────────────────────────── */

function trayIconPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'app.asar', 'icon.ico'), path.join(process.resourcesPath, 'icon.ico')]
    : [path.join(__dirname, '..', 'icon.ico'), path.join(__dirname, '..', 'assets', 'icon.ico')];
  return candidates.find((p) => fs.existsSync(p)) || path.join(__dirname, '..', 'icon.ico');
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

async function checkUpdatesNow() {
  if (!updaterService) return;
  try {
    const info = await updaterService.checkForUpdates();
    if (!info || !info.hasUpdate) {
      sendUpdateStatus({ type: 'not-available' });
      try {
        new Notification({ title: t('main.notifUpToDateTitle'), body: t('main.notifUpToDateBody') }).show();
      } catch { /* ignore */ }
      return;
    }
    sendUpdateStatus({ type: 'available', version: info.latestVersion });
    if (app.isPackaged) {
      autoUpdater.downloadUpdate().catch((err) => {
        logError('AutoUpdate: descarga fallida', err && (err.message || err));
      });
    } else {
      try {
        new Notification({
          title: t('main.notifNewTitle'),
          body: t('main.notifNewBody', { version: info.latestVersion })
        }).show();
      } catch { /* ignore */ }
    }
  } catch (err) {
    logError('Check updates failed:', err);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  const hasUpdate = !!updateDownloadedFor;
  const menu = Menu.buildFromTemplate([
    {
      label: t('main.trayToggle'),
      click: toggleMainWindow
    },
    { type: 'separator' },
    {
      label: t('main.trayCheckUpdates'),
      click: () => checkUpdatesNow()
    },
    {
      label: updateDownloadedFor
        ? t('main.trayRestartInstallV', { version: updateDownloadedFor })
        : t('main.trayRestartInstall'),
      enabled: hasUpdate,
      click: () => {
        if (app.isPackaged) {
          quitting = true;
          autoUpdater.quitAndInstall(false, true);
        }
      }
    },
    { type: 'separator' },
    {
      label: t('main.trayQuit'),
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function setupTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIconPath());
    tray.setToolTip('GameVault');
    tray.on('click', toggleMainWindow);
    tray.on('double-click', toggleMainWindow);
    rebuildTrayMenu();
  } catch (err) {
    logError('Tray init failed:', err);
  }
}

/* ─────────────────────────── LIFECYCLE ─────────────────────────── */

app.whenReady().then(async () => {
  log('Starting...');

  const userData = app.getPath('userData');
  const dataDir = app.isPackaged ? userData : path.join(app.getAppPath(), 'data');
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    // ignore
  }

  gameStore = new GameStore(userData);
  gameDetector = new GameDetector();
  artworkService = new ArtworkService(dataDir);
  gameInfoService = new GameInfoService();
  updaterService = new UpdaterService(process.env.GAMEVAULT_UPDATE_REPO || 'Riuyi231/gamevault');
  emulatorCatalog = new EmulatorCatalog();
  syncServiceKeys(gameStore.getSettings());

  // Registra los emuladores incluidos en el instalador (si están presentes)
  const bundledResult = emulatorCatalog.apply(gameStore);
  if (bundledResult && bundledResult.registered.length) {
    log('Emuladores incluidos registrados:', bundledResult.registered.join(', '));
  }

  createWindow();
  setupIPC();
  setupTray();
  startPeriodicRescan();
  setupAutoUpdater();

  setInterval(tickPlaySessions, 5000);

  setTimeout(() => enrichEmulatorCovers(), 1200);
  setTimeout(() => runScan(), 150);
  // Precarga la información de los juegos en segundo plano (caché persistente)
  // para que las fichas se abran al instante, sin esperas de red visibles.
  setTimeout(prewarmGameInfo, 4000);
});

app.on('before-quit', () => {
  quitting = true;
  const now = Date.now();
  for (const id of Array.from(playSessions.keys())) endPlaySession(id, now);
});

app.on('window-all-closed', () => {
  if (!quitting) return; // minimizar a bandeja en lugar de salir
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  if (periodicTimer) clearInterval(periodicTimer);
  if (watcherDebounce) clearTimeout(watcherDebounce);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});