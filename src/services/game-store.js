const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  autoScan: true,
  columns: 5,
  accent: 'purple',
  theme: 'dark',
  rawgKey: '',
  sgdbKey: ''
};

class GameStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dataFile = path.join(dataDir, 'gamevault-data.json');
    this._load();
  }

  _defaults() {
    return {
      games: [],
      customFolders: [],
      emulators: [],
      lastScan: 0,
      settings: { ...DEFAULT_SETTINGS }
    };
  }

  _load() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch {
      // ignore
    }

    if (!fs.existsSync(this.dataFile)) {
      this._data = this._defaults();
      this._save();
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
      this._data = {
        ...this._defaults(),
        ...raw,
        games: Array.isArray(raw.games) ? raw.games : [],
        customFolders: Array.isArray(raw.customFolders) ? raw.customFolders : [],
        emulators: Array.isArray(raw.emulators) ? raw.emulators : [],
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }
      };
    } catch {
      this._data = this._defaults();
      this._save();
    }
  }

  _save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.dataFile, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  /* ─── GAMES ─── */

  getGames() {
    return Array.isArray(this._data.games) ? this._data.games : [];
  }

  getGame(id) {
    return this.getGames().find((g) => g.id === id) || null;
  }

  addGame(game) {
    const games = this.getGames();
    if (games.find((g) => g.id === game.id)) return false;
    this._data.games = [...games, game];
    this._save();
    return true;
  }

  removeGame(id) {
    const before = this.getGames().length;
    this._data.games = this.getGames().filter((g) => g.id !== id);
    const removed = this.getGames().length !== before;
    if (removed) this._save();
    return removed;
  }

  updateGame(id, updates) {
    const idx = this.getGames().findIndex((g) => g.id === id);
    if (idx === -1) return false;
    this._data.games[idx] = { ...this._data.games[idx], ...updates };
    this._save();
    return true;
  }

  addPlaytime(id, ms) {
    const idx = this.getGames().findIndex((g) => g.id === id);
    if (idx === -1) return false;
    const g = this._data.games[idx];
    this._data.games[idx] = { ...g, playtimeMs: (g.playtimeMs || 0) + Math.max(0, Math.round(ms)) };
    this._save();
    return true;
  }

  syncFromScan(detectedGames) {
    const detectedMap = new Map(detectedGames.map((g) => [g.id, g]));
    const current = this.getGames();

    const newGames = [];
    const kept = [];

    for (const detected of detectedGames) {
      const existing = current.find((c) => c.id === detected.id);
      if (existing) {
        kept.push({
          ...detected,
          addedAt: existing.addedAt || detected.addedAt || Date.now(),
          lastPlayed: existing.lastPlayed || 0,
          playtimeMs: existing.playtimeMs || 0,
          isManual: existing.isManual || false,
          hasLocalCover: existing.hasLocalCover || false,
          localCoverPath: existing.localCoverPath || ''
        });
      } else {
        newGames.push({
          ...detected,
          addedAt: detected.addedAt || Date.now(),
          lastPlayed: 0,
          playtimeMs: 0,
          isManual: false,
          hasLocalCover: false,
          localCoverPath: ''
        });
      }
    }

    // Preserve manually added games that the scan no longer detects
    const manualKeep = current.filter((g) => g.isManual && !detectedMap.has(g.id));

    this._data.games = [...kept, ...newGames, ...manualKeep];
    this._data.lastScan = Date.now();
    this._save();

    return { newGames, total: this._data.games.length };
  }

  /* ─── CUSTOM FOLDERS ─── */

  getCustomFolders() {
    return Array.isArray(this._data.customFolders) ? this._data.customFolders : [];
  }

  addCustomFolder(p) {
    const folders = this.getCustomFolders();
    if (!folders.includes(p)) {
      this._data.customFolders = [...folders, p];
      this._save();
      return true;
    }
    return false;
  }

  removeCustomFolder(p) {
    const before = this.getCustomFolders().length;
    this._data.customFolders = this.getCustomFolders().filter((f) => f !== p);
    const removed = this.getCustomFolders().length !== before;
    if (removed) this._save();
    return removed;
  }

  /* ─── EMULATORS ─── */

  getEmulators() {
    return Array.isArray(this._data.emulators) ? this._data.emulators : [];
  }

  addEmulator(emulator) {
    const emus = this.getEmulators();
    const config = {
      id: emulator.id || `emu-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: emulator.name || 'Emulador',
      console: emulator.console || 'Retro',
      exePath: emulator.exePath || '',
      romsPath: emulator.romsPath || '',
      args: emulator.args || ''
    };
    if (!emus.some((e) => e.id === config.id)) {
      this._data.emulators = [...emus, config];
      this._save();
    } else {
      this._data.emulators = this._data.emulators.map((e) => (e.id === config.id ? config : e));
      this._save();
    }
    return config;
  }

  removeEmulator(id) {
    const emus = this.getEmulators();
    const next = emus.filter((e) => e.id !== id);
    if (next.length !== emus.length) {
      this._data.emulators = next;
      this._save();
      return true;
    }
    return false;
  }

  /* ─── SETTINGS ─── */

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...(this._data.settings || {}) };
  }

  updateSettings(settings) {
    this._data.settings = { ...this.getSettings(), ...settings };
    this._save();
    return this.getSettings();
  }

  /* ─── SCAN METADATA ─── */

  getLastScan() {
    return this._data.lastScan || 0;
  }

  setLastScan(t) {
    this._data.lastScan = t;
    this._save();
  }

  getPlatformCounts() {
    const counts = { steam: 0, epic: 0, gog: 0, retro: 0, other: 0 };
    for (const game of this.getGames()) {
      const p = game.platform || game.source;
      if (game.source === 'retro') counts.retro++;
      else if (p === 'steam') counts.steam++;
      else if (p === 'epic') counts.epic++;
      else if (p === 'gog') counts.gog++;
      else counts.other++;
    }
    return counts;
  }
}

module.exports = GameStore;