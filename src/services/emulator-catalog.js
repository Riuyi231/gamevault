const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Catálogo de emuladores que se incluyen en el propio instalador
// (resources/emulators). RetroArch cubre las consolas retro/portátiles con
// cores; PCSX2 y Dolphin son standalone para PS2 y GameCube/Wii.
const CATALOG = [
  { key: 'nes', console: 'NES', name: 'NES (RetroArch core)', kind: 'retroarch', core: 'fceumm_libretro.dll', romsDir: 'NES' },
  { key: 'snes', console: 'SNES', name: 'SNES (RetroArch core)', kind: 'retroarch', core: 'snes9x_libretro.dll', romsDir: 'SNES' },
  { key: 'gbc', console: 'Game Boy / Color', name: 'GB / GBC (RetroArch core)', kind: 'retroarch', core: 'gambatte_libretro.dll', romsDir: 'Game Boy' },
  { key: 'gba', console: 'GBA', name: 'GBA (RetroArch core)', kind: 'retroarch', core: 'mgba_libretro.dll', romsDir: 'GBA' },
  { key: 'n64', console: 'Nintendo 64', name: 'N64 (RetroArch core)', kind: 'retroarch', core: 'mupen64plus_next_libretro.dll', romsDir: 'N64' },
  { key: 'genesis', console: 'Genesis / Mega Drive', name: 'Genesis (RetroArch core)', kind: 'retroarch', core: 'genesis_plus_gx_libretro.dll', romsDir: 'Genesis' },
  { key: 'saturn', console: 'Saturn', name: 'Saturn (RetroArch core)', kind: 'retroarch', core: 'mednafen_saturn_libretro.dll', romsDir: 'Saturn' },
  { key: 'dreamcast', console: 'Dreamcast', name: 'Dreamcast (RetroArch core)', kind: 'retroarch', core: 'flycast_libretro.dll', romsDir: 'Dreamcast' },
  { key: 'ps1', console: 'PlayStation', name: 'PSX (RetroArch core)', kind: 'retroarch', core: 'swanstation_libretro.dll', romsDir: 'PlayStation' },
  { key: 'psp', console: 'PlayStation Portable', name: 'PSP (RetroArch core)', kind: 'retroarch', core: 'ppsspp_libretro.dll', romsDir: 'PSP' },
  { key: 'nds', console: 'Nintendo DS', name: 'NDS (RetroArch core)', kind: 'retroarch', core: 'melonDS_libretro.dll', romsDir: 'NDS' },
  { key: 'ps2', console: 'PlayStation 2', name: 'PS2 (PCSX2)', kind: 'pcsx2', exeRel: 'pcsx2/pcsx2-qt.exe', romsDir: 'PS2', args: '' },
  { key: 'gcwii', console: 'GameCube / Wii', name: 'GameCube / Wii (Dolphin)', kind: 'dolphin', exeRel: 'dolphin/Dolphin.exe', romsDir: 'GameCube / Wii', args: '-b -e' }
];

// Args base: RetroArch carga el core correspondiente.
function defaultArgs(entry, coresDir) {
  if (entry.kind === 'retroarch') {
    const coreRel = path.join('cores', entry.core);
    return ['-L', coreRel].join(' ');
  }
  return entry.args || '';
}

class EmulatorCatalog {
  constructor() {
    this._root = null;
    this._userRomsRoot = null;
  }

  // En dev los emuladores viven en <proyecto>/resources/emulators;
  // empaquetado, electron-builder los copia a <app>/resources/emulators.
  get root() {
    if (this._root) return this._root;
    const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    this._root = path.join(base, 'emulators');
    return this._root;
  }

  get userRomsRoot() {
    if (this._userRomsRoot) return this._userRomsRoot;
    this._userRomsRoot = path.join(app.getPath('userData'), 'roms');
    return this._userRomsRoot;
  }

  resolveExe(entry) {
    const exeRel = this.exeRel(entry);
    if (!exeRel) return null;
    const abs = path.join(this.root, exeRel);
    return fs.existsSync(abs) ? abs : null;
  }

  exeRel(entry) {
    if (entry.kind === 'retroarch') return 'retroarch/retroarch.exe';
    return entry.exeRel || '';
  }

  isAvailable(entry) {
    const exe = this.resolveExe(entry);
    if (!exe) return false;
    if (entry.kind === 'retroarch') {
      const core = path.join(path.dirname(exe), 'cores', entry.core);
      return fs.existsSync(core);
    }
    return true;
  }

  romsDirFor(entry) {
    return path.join(this.userRomsRoot, entry.romsDir);
  }

  // Registra en el store los emuladores incluidos cuyo binario esté presente.
  // No reemplaza emuladores configurados por el usuario para la misma consola.
  apply(gameStore) {
    if (!gameStore) return { registered: [], skipped: [] };
    const existing = gameStore.getEmulators();
    const existingConsoles = new Set(
      existing.map((e) => String(e.console || '').trim().toLowerCase())
    );
    const registered = [];
    const skipped = [];

    for (const entry of CATALOG) {
      const id = `bundled-${entry.key}`;
      if (existing.some((e) => e.id === id)) {
        skipped.push(entry.console);
        continue;
      }
      const consoleKey = String(entry.console || '').trim().toLowerCase();
      if (existingConsoles.has(consoleKey)) {
        skipped.push(entry.console);
        continue;
      }
      if (!this.isAvailable(entry)) {
        skipped.push(entry.console);
        continue;
      }

      const romsPath = this.romsDirFor(entry);
      try {
        fs.mkdirSync(romsPath, { recursive: true });
      } catch {
        // permisos u otro error: se salta la consola
        skipped.push(entry.console);
        continue;
      }

      const config = {
        id,
        name: entry.name,
        console: entry.console,
        exePath: this.resolveExe(entry),
        romsPath,
        args: defaultArgs(entry),
        bundled: true
      };
      gameStore.addEmulator(config);
      existingConsoles.add(consoleKey);
      registered.push(entry.console);
    }

    return { registered, skipped };
  }
}

module.exports = { EmulatorCatalog, CATALOG };