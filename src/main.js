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

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

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

// Starts a game's process (native exe, emulator+ROM or launcher URI) and starts
// a playtime session. Returns { success, viaLauncher, pid } or { success:false, error }.
function openGameProcess(game) {
  const id = game.id;

  let exePath = game.exePath;
  if (!exePath && game.installDir) {
    exePath = gameDetector._findMainExe(game.installDir);
    if (exePath) gameStore.updateGame(id, { exePath });
  }

  // Emulador + ROM (juegos retro)
  if (game.romPath) {
    const emuPath = game.exePath || '';
    if (emuPath && fs.existsSync(emuPath)) {
      try {
        const args = [];
        if (game.emulatorArgs) args.push(...splitArgs(game.emulatorArgs));
        args.push(game.romPath);
        const cwd = path.dirname(emuPath);
        const child = spawn(emuPath, args, { cwd, detached: true, stdio: 'ignore' });
        child.unref();
        gameStore.updateGame(id, { lastPlayed: Date.now(), exePath: emuPath });
        startPlaySession(game, child.pid);
        log('Launched (retro):', game.name, emuPath, '->', game.romPath);
        return { success: true, pid: child.pid };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    return { success: false, error: 'Emulador no encontrado' };
  }

  if (exePath && fs.existsSync(exePath)) {
    try {
      const cwd = game.installDir || path.dirname(exePath);
      const child = spawn(exePath, [], { cwd, detached: true, stdio: 'ignore' });
      child.unref();
      gameStore.updateGame(id, { lastPlayed: Date.now() });
      startPlaySession(game, child.pid);
      log('Launched:', game.name, exePath);
      return { success: true, pid: child.pid };
    } catch (err) {
      return { success: false, error: err.message };
    }
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

  return { success: false, error: 'Ejecutable no encontrado' };
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
    if (!sources || sources.length === 0) return { ok: false, error: 'No hay pantalla para capturar' };
    const primary = sources.find((s) => s.display_id === '0') || sources[0];
    const image = primary.thumbnail;
    if (!image || image.isEmpty()) return { ok: false, error: 'No se pudo obtener la imagen' };
    fs.writeFileSync(filePath, image.toPNG());
    return { ok: true, localCoverPath: filePath };
  } catch (err) {
    logError('Screen capture failed:', err);
    return { ok: false, error: 'Falló la captura de pantalla' };
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
  });

  mainWindow.webContents.on('console-message', (event, details) => {
    const level = details && details.level !== undefined ? details.level : 0;
    const message = details && details.message ? details.message : '';
    if (level >= 2) {
      logError(`[renderer:${level}] ${message}`);
    }
  });
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
    if (!game) return { success: false, error: 'Juego no encontrado' };
    return openGameProcess(game);
  });

  ipcMain.handle('capture-gameplay', async (event, id) => {
    const game = gameStore.getGame(id);
    if (!game) return { ok: false, error: 'Juego no encontrado' };

    const launched = openGameProcess(game);
    if (!launched || !launched.success) {
      return { ok: false, error: launched && launched.error ? launched.error : 'No se pudo lanzar el juego' };
    }
    if (launched.viaLauncher) {
      return { ok: false, error: 'No se puede capturar un juego de launcher externo' };
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
      name: data.name || 'Juego',
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
    if (!game) return { success: false, error: 'Juego no encontrado' };

    // Never delete the whole launcher/library roots (safety guard)
    const installDir = (game.installDir || '').trim();
    const protectedRoots = /^[A-Za-z]:[\\/](steam|steamlibrary|steamapps|program files|program files \(x86\)|epic games|gog|windows|users)/i;
    if (!installDir || !fs.existsSync(installDir) || protectedRoots.test(installDir.replace(/[\\/]+$/, ''))) {
      return { success: false, error: 'Ubicación no válida para eliminar' };
    }

    try {
      await shell.trashItem(installDir);
    } catch (err) {
      logError('trashItem failed:', err.message || err);
      // Fallback: try direct delete
      try {
        fs.rmSync(installDir, { recursive: true, force: true });
      } catch (err2) {
        return { success: false, error: err2.message || 'No se pudo eliminar' };
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
      hasRawgKey: !!(artworkService && artworkService.rawgKey)
    };
  });

  ipcMain.handle('check-updates', async () => {
    if (!updaterService) return { error: 'Actualizador no disponible.' };
    return updaterService.checkForUpdates();
  });

  ipcMain.handle('open-update-url', async (event, url) => {
    if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('download-update', async () => {
    if (!app.isPackaged) return { error: 'Solo disponible en la versión instalada.' };
    try {
      autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { error: err && err.message ? err.message : 'No se pudo iniciar la descarga.' };
    }
  });

  ipcMain.handle('install-update', async () => {
    if (!app.isPackaged) return { error: 'Solo disponible en la versión instalada.' };
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      return { error: err && err.message ? err.message : 'No se pudo instalar.' };
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
      title: 'Exportar configuración de GameVault',
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
      title: 'Importar configuración de GameVault',
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
      title: 'Seleccionar carpeta de juegos'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('select-executable', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Seleccionar ejecutable del emulador',
      filters: [{ name: 'Ejecutables', extensions: ['exe'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /* ── Emuladores (retro) ── */

  ipcMain.handle('get-emulators', async () => {
    return gameStore.getEmulators();
  });

  ipcMain.handle('add-emulator', async (event, emulator) => {
    const config = gameStore.addEmulator(emulator || {});
    rebuildWatcher();
    setTimeout(runScan, 250);
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
    if (!game) return null;
    try {
      const info = await gameInfoService.fetchForGame(game);
      // Persist a panoramic banner for the hero background when available
      if (info && info.banner && game.id) {
        gameStore.updateGame(game.id, { bannerUrl: info.banner });
      }
      return info;
    } catch (err) {
      logError('get-game-info error:', err.message || err);
      return null;
    }
  });

  ipcMain.handle('get-platforms', async () => {
    const counts = gameStore.getPlatformCounts();
    const labels = { steam: 'Steam', epic: 'Epic', gog: 'GOG', other: 'Otros' };
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
        title: 'GameVault actualizado',
        body: `La versión ${version || 'nueva'} está lista. Reinicia la app para instalarla.`
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
        new Notification({ title: 'GameVault al día', body: 'No hay actualizaciones disponibles.' }).show();
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
          title: 'Nueva versión de GameVault',
          body: `${info.latestVersion} disponible. Descárgala en la página de lanzamientos.`
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
      label: 'Abrir / Cerrar GameVault',
      click: toggleMainWindow
    },
    { type: 'separator' },
    {
      label: 'Buscar actualizaciones',
      click: () => checkUpdatesNow()
    },
    {
      label: updateDownloadedFor
        ? `Reiniciar e instalar ${updateDownloadedFor}`
        : 'Reiniciar e instalar actualización',
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
      label: 'Salir',
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

  setTimeout(() => runScan(), 150);
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