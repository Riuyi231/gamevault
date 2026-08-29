const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
const { autoUpdater } = require('electron-updater');
const GameDetector = require('./services/game-detect');
const GameStore = require('./services/game-store');
const ArtworkService = require('./services/artwork');
const GameInfoService = require('./services/game-info');
const UpdaterService = require('./services/updater');

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const SCAN_INTERVAL = 90 * 1000;

let mainWindow = null;
let gameStore = null;
let gameDetector = null;
let artworkService = null;
let gameInfoService = null;
let updaterService = null;
let watcher = null;
let currentScan = null;
let periodicTimer = null;
let rescansSinceScan = 0;

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

function splitArgs(input) {
  const result = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || ''))) !== null) {
    result.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return result;
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

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) {
      logError(`[renderer:${level}] ${message} (${sourceId}:${line})`);
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
          return { success: true };
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
        return { success: true };
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
    log('AutoUpdate: descarga completada', info && info.version);
    sendUpdateStatus({ type: 'downloaded', version: info && info.version });
  });

  autoUpdater.on('error', (err) => {
    logError('AutoUpdate: error', err && (err.message || err));
    sendUpdateStatus({
      type: 'error',
      error: err && err.message ? err.message : String(err)
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logError('AutoUpdate: comprobación fallida', err && (err.message || err));
    });
  }, 15000);
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
  syncServiceKeys(gameStore.getSettings());

  createWindow();
  setupIPC();
  startPeriodicRescan();
  setupAutoUpdater();

  setInterval(tickPlaySessions, 5000);

  setTimeout(() => runScan(), 150);
});

app.on('before-quit', () => {
  const now = Date.now();
  for (const id of Array.from(playSessions.keys())) endPlaySession(id, now);
});

app.on('window-all-closed', () => {
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