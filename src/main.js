const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
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

  setTimeout(() => runScan(), 150);
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