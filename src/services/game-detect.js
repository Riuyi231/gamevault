const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const SKIP_APPIDS = new Set([
  '228980', // Steamworks Common Redistributables
  '251530', // Steamworks (app test)
  '480', // Spacewar (Steam internal)
  '250820', // Steamworks Redistributables
  '431960', // Wallpaper Engine (tool)
  '8930', // Sonic Generations free? tool? keep skip-safe
  '2399830', // Steam Controller Configs
  '1127900' // Steam Music? not relevant
]);

const SKIP_NAME_PATTERNS = [
  /redistrib/i,
  /redist/,
  /steam linux runtime/i,
  /source sdk base/i,
  /steamworks shared/i,
  /steam controller config/i,
  /steam controller/i,
  /wallpaper engine/i,
  /wallpaper_engine/i,
  /spacewar/i,
  /vcredist/i,
  /directx/i,
  /steamworks/i,
  /crashpad/i
];

const SKIP_DIRS = [
  'redist',
  'redists',
  'vcredist',
  'support',
  '_commonredist',
  'commonredist',
  '__redist',
  'directx',
  'installer',
  'installers',
  '__installer',
  'drivers',
  'dxsetup',
  'tools',
  'toolkit',
  'utilities',
  'utility',
  'unins000',
  '$recycle.bin',
  'system volume information',
  'crashdump',
  'logos'
];

const SKIP_EXE_PATTERNS = [
  /unins/i,
  /uninstall/i,
  /setup/i,
  /installer/i,
  /krinstall/i,
  /updater/i,
  /crashreport/i,
  /crashhandler/i,
  /crashpad/i,
  /report_crash/i,
  /unitycrashhandler/i,
  /dotnet/i,
  /vcredist/i,
  /vc_redist/i,
  /dxsetup/i,
  /redist/i,
  /launcherhelper/i,
  /bootstrap/i,
  /steam(_|api|works)/i,
  /merge_dbs/i,
  /tonemap/i,
  /psoconsolidator/i,
  /cleanup/i,
  /diagnostic/i,
  /websocket/i,
  /launcher/i
];

const CLEAN_NAME_OVERRIDES = {
  'p5r': 'P5R',
  'mk11': 'Mortal Kombat 11',
  'god of war': 'God of War',
  'project zomboid': 'Project Zomboid',
  'marvel rivals': 'Marvel Rivals',
  'heavy rain': 'Heavy Rain',
  'left 4 dead 2': 'Left 4 Dead 2',
  'resident evil 0': 'Resident Evil 0',
  'resident evil 1': 'Resident Evil 1',
  'l4d2': 'Left 4 Dead 2',
  'slay the princess': 'Slay the Princess',
  'hollow knight': 'Hollow Knight',
  'mortal kombat 11': 'Mortal Kombat 11',
  'genshin impact game': 'Genshin Impact',
  'genshin impact': 'Genshin Impact',
  'fallguys': 'Fall Guys',
  'fall guys': 'Fall Guys',
  'star rail games': 'Honkai: Star Rail',
  'star rail': 'Honkai: Star Rail',
  'zenlesszonezero game': 'Zenless Zone Zero',
  'zenless zone zero': 'Zenless Zone Zero',
  'wuthering waves game': 'Wuthering Waves',
  'wuthering waves': 'Wuthering Waves',
  'sky dimo': 'Skydimo',
  'unleashed recomp': 'Sonic Unleashed (Unleashed Recomp)'
};

const KNOWN_GOG_DIRS = ['GOG Games', 'GOGGames', 'GOG games, GOG'];
const STEAM_COVER_BASE = 'https://cdn.akamai.steamstatic.com/steam/apps/';

const ROM_EXTENSIONS = new Set([
  // Nintendo
  '.nes', '.fds', '.sfc', '.smc', '.gb', '.gbc', '.gba', '.nds', '.3ds',
  '.n64', '.z64', '.v64', '.nsp', '.xci', '.wbfs', '.rvz', '.iso', '.gcm',
  // Sega
  '.md', '.gen', '.smd', '.gg', '.sms', '.32x', '.cue', '.bin', '.chd',
  // Sony
  '.pbp', '.pkg', '.cso', '.ciso', '.chd',
  // Atari / others
  '.a78', '.lnx', '.2600', '.jag', '.xm', '.tzx', '.tap',
  // Misc / arcade
  '.zip', '.7z', '.rvm'
]);

function cleanRomName(base) {
  const s = String(base || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s*\[[^\]]*\]\s*$/g, '')
    .replace(/\s*\([^)]*\)/gi, '')
    .replace(/\s+-\s+[^\s-]+$/g, '')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || 'ROM';
}

function md5(input) {
  return crypto.createHash('md5').update(String(input)).digest('hex').slice(0, 12);
}

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ +/g, ' ');
}

function normalizeDirName(dir) {
  if (!dir) return '';
  return path
    .basename(dir)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function getAcfField(content, key) {
  const m = content.match(new RegExp('"' + key + '"\\s*"([^"]*)"'));
  return m ? m[1] : '';
}

class GameDetector {
  constructor() {
    this.libraryFoldersVdf = [
      'libraryfolders.vdf',
      'libraryfolder.vdf'
    ];
    this.epicManifestDirs = [
      'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests',
      'C:\\ProgramData\\Epic\\EpicLauncher\\Data\\Manifests',
      'C:\\ProgramData\\Epic\\Launcher\\Data\\Manifests',
      'C:\\ProgramData\\EpicGames\\EpicGamesLauncher\\Data\\Manifests'
    ];
    this.gogRegistryPaths = [
      'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games',
      'HKLM\\SOFTWARE\\GOG.com\\Games'
    ];
  }

  /* ═══════════════ HELPERS ═══════════════ */

  _drives() {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      try {
        if (fs.existsSync(`${letter}:\\`)) drives.push(`${letter}:\\`);
      } catch {
        // ignore
      }
    }
    return drives;
  }

  generateId(source, key) {
    return md5(`${source}-${key}`);
  }

  cleanGameName(raw) {
    if (!raw) return '';
    let s = String(raw).trim();

    const key = normalizeName(s);
    if (CLEAN_NAME_OVERRIDES[key]) return CLEAN_NAME_OVERRIDES[key];

    s = s.replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();

    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    s = s.replace(/([A-Za-z])(\d)/g, '$1 $2');
    s = s.replace(/(\d)([A-Za-z])/g, '$1 $2');

    s = s.replace(/\s+v\d+(\.\d+)*(-[a-z0-9]+)?\s*$/i, '');
    s = s.replace(/\s+\d+\.\d+$/i, '');

    const lowerKeeper = new Set([
      'of', 'the', 'and', 'a', 'an', 'for', 'de', 'del', 'la', 'el',
      'los', 'las', 'y', 'e', 'en', 'con', 'at', 'to', 'vs'
    ]);

    const words = s.split(/\s+/).filter(Boolean);
    const out = words.map((w) => {
      if (lowerKeeper.has(w.toLowerCase())) return w.toLowerCase();
      if (/^[A-ZÀ-Ý0-9]{1,4}$/.test(w) && /[A-ZÀ-Ý]{2,}/.test(w.replace(/[0-9]/g, 'x'))) {
        return w;
      }
      if (/^[A-ZÀ-Ý]+$/.test(w)) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }
      if (w.length > 2 && w.toUpperCase() === w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });

    let cleaned = out.join(' ');
    cleaned = cleaned.replace(/\s+([:!,?;])/g, '$1').replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/([A-Za-z])\s+([A-Za-z])/g, (m, a, b) => {
      return a + ' ' + b; // keep single spaces between real words (camelCase split produces "God Of War")
    });

    // Fix titles that came from camelCase splits (e.g. "God Of War" -> "God of War")
    cleaned = cleaned
      .split(/\s+/)
      .map((w) => (lowerKeeper.has(w.toLowerCase()) ? w.toLowerCase() : w))
      .join(' ');

    return cleaned.replace(/\s+/g, ' ').trim();
  }

  _walkForExes(dir, depth, maxDepth, results, seen) {
    if (depth > maxDepth) return;
    if (!isDir(dir)) return;

    const lower = dir.toLowerCase();
    if (lower.includes('$recycle.bin') || lower.includes('\\system volume information\\')) return;

    const baseName = path.basename(dir).toLowerCase();
    if (depth > 0 && SKIP_DIRS.includes(baseName)) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== '.exe') continue;

        const exeBase = path.basename(entry.name, '.exe').toLowerCase();
        if (SKIP_EXE_PATTERNS.some((r) => r.test(exeBase))) continue;
        if (exeBase.length < 2) continue;

        const name = this.cleanGameName(path.basename(entry.name, '.exe'));
        const id = `custom-${md5(`custom-${fullPath}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        if (SKIP_NAME_PATTERNS.some((r) => r.test(normalizeName(name)))) continue;

        results.push({
          id,
          name,
          exePath: fullPath,
          platform: 'other',
          source: 'custom',
          coverUrl: '',
          installDir: dir,
          sizeOnDisk: 0,
          appId: '',
          launchUri: '',
          addedAt: Date.now()
        });
      } else if (entry.isDirectory() && depth < maxDepth) {
        this._walkForExes(fullPath, depth + 1, maxDepth, results, seen);
      }
    }
  }

  _collectExes(dir, depth, acc) {
    if (depth > 4 || !isDir(dir)) return;
    if (depth > 0 && SKIP_DIRS.includes(path.basename(dir).toLowerCase())) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
        acc.push(full);
      } else if (entry.isDirectory()) {
        this._collectExes(full, depth + 1, acc);
      }
    }
  }

  _findMainExe(dir) {
    try {
      if (!isDir(dir)) return '';
      const dirName = path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '');

      const candidates = [];
      this._collectExes(dir, 0, candidates);

      const clean = candidates.filter((fullPath) => {
        const n = path.basename(fullPath).toLowerCase().replace('.exe', '');
        if (SKIP_EXE_PATTERNS.some((r) => r.test(n))) return false;
        // Ignore tiny helper/remanent exes (<1MB) unless they closely match the folder name
        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          return false;
        }
        const bare = n.replace(/[^a-z0-9]/g, '');
        const matchesDir = dirName && dirName.length >= 3 && (dirName.includes(bare) || bare.includes(dirName));
        return size >= 1024 * 1024 || matchesDir;
      });

      if (clean.length === 0) return '';

      const relDepth = (fullPath) => path.relative(dir, fullPath).split(path.sep).length;
      const topLevel = clean.filter((p) => relDepth(p) <= 1);
      const nearTop = clean.filter((p) => relDepth(p) === 2);
      const deeper = clean.filter((p) => relDepth(p) > 2);

      const score = (fullPath) => {
        const base = path.basename(fullPath, '.exe').toLowerCase().replace(/[^a-z0-9]/g, '');
        let s = 0;
        if (dirName && base.length >= 3 && dirName.includes(base)) s += 200;
        if (dirName && base.length >= 3 && base.includes(dirName)) s += 160;
        if (dirName && dirName.startsWith(base)) s += 120;
        const pureDir = dirName.replace(/\d+/g, '');
        if (pureDir.length >= 3 && base.startsWith(pureDir)) s += 90;
        if (base.includes('game')) s += 10;
        if (base.includes('win64') || base.includes('win32') || base.includes('dx11')) s += 4;
        if (base.includes('shipping')) s += 2;
        if (/\d{4,}/.test(base)) s -= 5;
        return s;
      };

      const best = (list) => list.reduce((acc, item) => (score(item) > score(acc) ? item : acc), list[0]);

      if (topLevel.length > 0) return best(topLevel);
      if (nearTop.length > 0) return best(nearTop);
      return best(deeper);
    } catch {
      return '';
    }
  }

  /* ═══════════════ STEAM LIBRARY DISCOVERY ═══════════════ */

  async findSteamLibraryPaths() {
    const found = new Set();
    const roots = new Set();

    const candidates = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
    for (const drive of this._drives()) {
      candidates.push(
        path.join(drive, 'Steam'),
        path.join(drive, 'SteamLibrary'),
        path.join(drive, 'Program Files (x86)\\Steam'),
        path.join(drive, 'Program Files\\Steam')
      );
    }

    for (const c of candidates) {
      if (isDir(c)) roots.add(c);
    }

    for (const root of roots) {
      const vdfNames = ['libraryfolders.vdf', 'libraryfolder.vdf'];
      for (const vdfName of vdfNames) {
        const vdf = path.join(root, 'steamapps', vdfName);
        if (!fs.existsSync(vdf)) continue;
        try {
          const content = fs.readFileSync(vdf, 'utf-8');
          const re = /"path"\s*"([^"]+)"/g;
          let match;
          while ((match = re.exec(content)) !== null) {
            let p = match[1];
            p = p.replace(/\\\\/g, '\\').replace(/\\\//g, '\\').replace(/\\t/g, '');
            if (p && isDir(p)) found.add(p.replace(/[\\/]+$/, ''));
          }
        } catch {
          // ignore
        }
      }

      if (isDir(path.join(root, 'steamapps'))) {
        found.add(root.replace(/[\\/]+$/, ''));
      }
    }

    // Drive-root libraries (steamapps directly on a drive)
    for (const drive of this._drives()) {
      try {
        const entries = fs.readdirSync(drive);
        for (const entry of entries) {
          if (entry.toLowerCase() === 'steamapps') {
            const p = path.join(drive, entry);
            if (isDir(p)) found.add(drive.replace(/[\\/]+$/, ''));
          }
        }
      } catch {
        // ignore
      }
    }

    return Array.from(found);
  }

  /* ═══════════════ STEAM SCANNERS ═══════════════ */

  async scanSteam(onProgress) {
    const games = [];
    const libs = await this.findSteamLibraryPaths();

    for (let li = 0; li < libs.length; li++) {
      const lib = libs[li];
      if (onProgress) {
        onProgress(Math.round(8 + (li / Math.max(1, libs.length)) * 24), 'Detectando juegos de Steam...');
      }

      const steamApps = path.join(lib, 'steamapps');
      if (!isDir(steamApps)) continue;

      let files;
      try {
        files = fs.readdirSync(steamApps);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!/^appmanifest_\d+\.acf$/i.test(file)) continue;
        try {
          const content = fs.readFileSync(path.join(steamApps, file), 'utf-8');
          const appid = getAcfField(content, 'appid');
          const name = getAcfField(content, 'name');
          const installdir = getAcfField(content, 'installdir');
          const size = parseInt(getAcfField(content, 'sizeonbytes') || '0', 10) || 0;
        const stateFlags = parseInt(getAcfField(content, 'StateFlags') || '4', 10);

          if (!appid || !name) continue;
          if (SKIP_APPIDS.has(appid)) continue;

          const normName = normalizeName(name);
          const normDir = normalizeName(installdir || '');
          if (SKIP_NAME_PATTERNS.some((r) => r.test(normName))) continue;
          if (normDir && SKIP_NAME_PATTERNS.some((r) => r.test(normDir))) continue;

          // 4 = fully installed, 6 = fully installed/update queued, 0 = missing state
          if (stateFlags !== 4 && stateFlags !== 6 && stateFlags !== 0) continue;

          const gameDir = path.join(steamApps, 'common', installdir || '');
          let exePath = '';
          if (isDir(gameDir)) exePath = this._findMainExe(gameDir);

          games.push({
            id: `steam-${appid}`,
            name,
            exePath,
            platform: 'steam',
            source: 'steam',
            coverUrl: `${STEAM_COVER_BASE}${appid}/library_600x900.jpg`,
            installDir: isDir(gameDir) ? gameDir : '',
            sizeOnDisk: size,
            appId: appid,
            launchUri: `steam://rungameid/${appid}`,
            addedAt: Date.now()
          });
        } catch {
          // ignore unreadable manifests
        }
      }
    }

    return games;
  }

  async scanSteamCommonFolders(coveredKeys, onProgress) {
    const games = [];
    const libs = await this.findSteamLibraryPaths();
    const seen = new Set();

    for (let li = 0; li < libs.length; li++) {
      const lib = libs[li];
      if (onProgress) {
        onProgress(Math.round(34 + (li / Math.max(1, libs.length)) * 18), 'Analizando carpetas de Steam...');
      }

      const commonDir = path.join(lib, 'steamapps', 'common');
      if (!isDir(commonDir)) continue;

      let entries;
      try {
        entries = fs.readdirSync(commonDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folderPath = path.join(commonDir, entry.name);
        const folderBase = normalizeDirName(folderPath);
        const folderNorm = normalizeName(entry.name);

        if (!folderBase || folderBase.length < 2) continue;
        if (coveredKeys.has(folderBase) || coveredKeys.has(folderNorm)) continue;
        if (seen.has(folderBase)) continue;

        const exePath = this._findMainExe(folderPath);
        if (!exePath) continue;

        const normName = normalizeName(entry.name);
        if (SKIP_NAME_PATTERNS.some((r) => r.test(normName))) continue;

        seen.add(folderBase);
        games.push({
          id: `steamcommon-${this.generateId('steamcommon', folderPath)}`,
          name: this.cleanGameName(entry.name),
          exePath,
          platform: 'steam',
          source: 'steam',
          coverUrl: '',
          installDir: folderPath,
          sizeOnDisk: 0,
          appId: '',
          launchUri: '',
          addedAt: Date.now()
        });
      }
    }

    return games;
  }

  /* ═══════════════ EPIC ═══════════════ */

  _epicExePath(manifest, installLocation) {
    if (!installLocation || !isDir(installLocation)) return '';
    const candidates = [];
    const values = [manifest.ExecutableName, manifest.LaunchExecutable, manifest.LaunchCommand];
    for (const val of values) {
      if (!val) continue;
      const first = String(val).replace(/"/g, '').split(/\s+/)[0];
      if (!first) continue;
      const normalized = first.replace(/\//g, '\\');
      if (path.isAbsolute(normalized)) {
        candidates.push(normalized);
      } else {
        candidates.push(path.join(installLocation, normalized));
        candidates.push(path.join(installLocation, path.basename(normalized)));
      }
    }
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return this._findMainExe(installLocation);
  }

  async scanEpic(onProgress) {
    const games = [];
    const seen = new Set();

    const manifestDirs = [];
    for (const dir of this.epicManifestDirs) {
      if (isDir(dir)) manifestDirs.push(dir);
    }
    const roaming = path.join(process.env.APPDATA || '', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    if (isDir(roaming)) manifestDirs.push(roaming);

    let shown = false;
    for (const manifestDir of manifestDirs) {
      let files;
      try {
        files = fs.readdirSync(manifestDir).filter((f) => f.endsWith('.item'));
      } catch {
        continue;
      }

      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf-8'));
          const name = data.DisplayName || data.AppName || '';
          const appName = data.AppName || '';
          const installLocation = data.InstallLocation || '';
          const normName = normalizeName(name);
          const normApp = normalizeName(appName);

          if (!name) continue;
          if (/epic games launcher|epicgameslauncher|unreal?engine|launcher/i.test(normApp + ' ' + normName)) continue;

          const exePath = this._epicExePath(data, installLocation);
          const id = `epic-${appName || this.generateId('epic', name)}`;
          if (seen.has(id)) continue;
          seen.add(id);

          if (!shown && onProgress) {
            onProgress(54, 'Detectando juegos de Epic Games...');
            shown = true;
          }

          games.push({
            id,
            name,
            exePath,
            platform: 'epic',
            source: 'epic',
            coverUrl: '',
            installDir: installLocation || '',
            sizeOnDisk: parseInt(data.InstallSize || '0', 10) || 0,
            appId: appName || '',
            launchUri: appName ? `com.epicgames.launcher://apps/${encodeURIComponent(appName)}?action=launch&silent=true` : '',
            addedAt: Date.now()
          });
        } catch {
          // ignore malformed manifests
        }
      }
    }

    // Fallback: scan Epic install roots that may have been installed outside the launcher db
    const epicRoots = ['C:\\Epic Games'];
    for (const drive of this._drives()) {
      epicRoots.push(path.join(drive, 'Epic Games'));
    }
    const folderSeen = new Set();
    for (const root of epicRoots) {
      if (!isDir(root)) continue;
      let entries;
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const norm = normalizeName(entry.name);
        if (norm.includes('launcher') || norm.length < 2) continue;
        if (folderSeen.has(norm)) continue;
        const fullPath = path.join(root, entry.name);
        const exePath = this._findMainExe(fullPath);
        if (!exePath) continue;
        folderSeen.add(norm);
        const id = `epicfolder-${this.generateId('epic', fullPath)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        games.push({
          id,
          name: this.cleanGameName(entry.name),
          exePath,
          platform: 'epic',
          source: 'epic',
          coverUrl: '',
          installDir: fullPath,
          sizeOnDisk: 0,
          appId: '',
          launchUri: '',
          addedAt: Date.now()
        });
      }
    }

    return games;
  }

  /* ═══════════════ GOG ═══════════════ */

  async scanGOG(onProgress) {
    const games = [];
    const seen = new Set();

    for (const regPath of this.gogRegistryPaths) {
      let output = '';
      try {
        output = execSync(`reg query "${regPath}" /s`, {
          encoding: 'utf-8',
          timeout: 8000,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true
        });
      } catch {
        continue;
      }

      const lines = output.split(/\r?\n/);
      let current = null;
      const blocks = [];

      for (const line of lines) {
        const keyM = line.match(/^\s*HKEY_(?:LOCAL_MACHINE|CURRENT_USER)\\.*?GOG\.com\\Games\\(\d+)/);
        if (keyM) {
          if (current && (current.name || current.path)) blocks.push(current);
          current = { id: keyM[1], name: '', path: '', exe: '' };
          continue;
        }
        if (/^\s*HKEY_/.test(line)) {
          if (current && (current.name || current.path)) blocks.push(current);
          current = null;
          continue;
        }
        if (!current) continue;

        let m = line.match(/^\s*GameName\s+REG_\w+\s+(.+)$/i);
        if (m) current.name = m[1].trim();
        m = line.match(/^\s*Path\s+REG_\w+\s+(.+)$/i);
        if (m) current.path = m[1].trim();
        m = line.match(/^\s*exe\s+REG_\w+\s+(.+)$/i);
        if (m) current.exe = m[1].trim();
      }
      if (current && (current.name || current.path)) blocks.push(current);

      for (const block of blocks) {
        try {
          const normName = normalizeName(block.name);
          if (!normName) continue;
          if (SKIP_NAME_PATTERNS.some((r) => r.test(normName))) continue;

          let exePath = '';
          if (block.exe) {
            const raw = block.exe.replace(/\\{2}/g, '\\').trim();
            const exeMatch = raw.match(/([A-Za-z]:\\[^"]+\.exe)/i);
            if (exeMatch) {
              const candidate = exeMatch[1];
              if (fs.existsSync(candidate)) exePath = candidate;
            }
          }
          if (!exePath && block.path && isDir(block.path)) {
            exePath = this._findMainExe(block.path);
          }

          const id = `gog-${block.id}`;
          if (seen.has(id)) continue;
          seen.add(id);

          games.push({
            id,
            name: block.name,
            exePath,
            platform: 'gog',
            source: 'gog',
            coverUrl: '',
            installDir: block.path || '',
            sizeOnDisk: 0,
            appId: block.id,
            launchUri: '',
            addedAt: Date.now()
          });
        } catch {
          // ignore
        }
      }
    }

    if (onProgress) onProgress(70, 'Detectando juegos de GOG...');

    // Fallback folder scan
    const gogRoots = [];
    for (const drive of this._drives()) {
      gogRoots.push(path.join(drive, 'GOG Games'), path.join(drive, 'GOGGames'));
    }
    gogRoots.push('C:\\Program Files (x86)\\GOG Galaxy\\Games');

    for (const root of gogRoots) {
      if (!isDir(root)) continue;
      let entries;
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(root, entry.name);
        const norm = normalizeName(entry.name);
        if (norm.length < 2 || SKIP_NAME_PATTERNS.some((r) => r.test(norm))) continue;
        const exePath = this._findMainExe(fullPath);
        if (!exePath) continue;
        const id = `gogfolder-${this.generateId('gog', fullPath)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        games.push({
          id,
          name: this.cleanGameName(entry.name),
          exePath,
          platform: 'gog',
          source: 'gog',
          coverUrl: '',
          installDir: fullPath,
          sizeOnDisk: 0,
          appId: '',
          launchUri: '',
          addedAt: Date.now()
        });
      }
    }

    return games;
  }

  /* ═══════════════ CUSTOM FOLDERS ═══════════════ */

  async scanCustomFolders(folders, extraScanPaths = []) {
    const games = [];

    for (const folder of folders || []) {
      if (!folder || !isDir(folder)) continue;
      this._walkForExes(folder.replace(/[\\/]+$/, ''), 0, 3, games, new Set());
    }

    for (const extra of extraScanPaths || []) {
      if (!extra || !isDir(extra)) continue;
      this._walkForExes(extra.replace(/[\\/]+$/, ''), 0, 2, games, new Set());
    }

    return games;
  }

  /* ═══════════════ EMULATORS (retro ROMs) ═══════════════ */

  scanEmulatorRoms(emulators) {
    const games = [];
    if (!Array.isArray(emulators)) return games;
    const seen = new Set();

    for (const emu of emulators) {
      if (!emu || !emu.exePath || !isDir(emu.romsPath)) continue;
      const args = String(emu.args || '').trim();
      const consoles = String(emu.console || 'Retro').trim() || 'Retro';

      let entries;
      try {
        entries = fs.readdirSync(emu.romsPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const base = path.basename(entry.name, ext);
        if (!ROM_EXTENSIONS.has(ext)) continue;
        if (String(base || '').trim().length < 1) continue;

        const romPath = path.join(emu.romsPath, entry.name);
        const id = `retro-${this.generateId('retro', `${emu.id}|${romPath}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        games.push({
          id,
          name: cleanRomName(base),
          exePath: emu.exePath,
          romPath,
          platform: consoles,
          source: 'retro',
          coverUrl: '',
          installDir: emu.romsPath,
          sizeOnDisk: 0,
          appId: '',
          launchUri: '',
          emulatorId: emu.id,
          emulatorArgs: args,
          addedAt: Date.now()
        });
      }
    }

    return games;
  }

  /* ═══════════════ DRIVE ROOTS (games loose on D:/F:) ═══════════════ */

  _isSystemRootDir(name) {
    const lower = name.toLowerCase();
    return (
      lower.startsWith('$') ||
      lower === 'windows' ||
      lower === 'program files' ||
      lower === 'program files (x86)' ||
      lower === 'programdata' ||
      lower === 'users' ||
      lower === 'perflogs' ||
      lower === 'recovery' ||
      lower === 'boot' ||
      lower === 'system volume information' ||
      lower === '$recycle.bin' ||
      lower === 'intel' ||
      lower === 'msocache' ||
      lower === 'node_modules' ||
      lower === '.git'
    );
  }

  _isLauncherRootDir(name) {
    const lower = name.toLowerCase();
    return (
      lower.includes('steamlibrary') ||
      lower.includes('steam\\') ||
      lower === 'steam' ||
      lower.includes('gog galaxy') ||
      lower === 'epic games' ||
      lower.includes('battle.net') ||
      lower === 'blizzard' ||
      lower === 'ubisoft' ||
      lower.includes('origin') ||
      lower === 'riot games' ||
      lower.includes('xboxgames')
    );
  }

  async scanDriveRoots(onProgress) {
    const games = [];
    const seen = new Set();

    const drives = this._drives().filter((d) => {
      const letter = d.replace(/[^A-Za-z]/g, '').toUpperCase();
      // Skip system drive (C:) and empty/Optical drives
      if (letter === 'C') return false;
      if (d === 'E:\\' || d === 'G:\\') {
        try {
          if (!fs.existsSync(path.join(d, 'Games')) && fs.readdirSync(d).length === 0) return false;
        } catch {
          return false;
        }
      }
      return true;
    });

    for (const drive of drives) {
      if (onProgress) onProgress(62, `Analizando unidades de disco (${drive.replace(/[\\/]+$/, '')})...`);
      let entries;
      try {
        entries = fs.readdirSync(drive, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (this._isSystemRootDir(entry.name)) continue;
        if (this._isLauncherRootDir(entry.name)) continue;
        if (SKIP_DIRS.includes(entry.name.toLowerCase())) continue;

        const folderPath = path.join(drive, entry.name);
        const normName = normalizeName(entry.name);
        if (normName.length < 2) continue;

        // Only treat as game if a plausible main .exe exists in the top folders
        const exePath = this._findMainExe(folderPath);
        if (!exePath) continue;

        // Skip if empty/launcher-ish small exes only
        const folderName = normalizeName(path.basename(exePath, '.exe'));
        if (SKIP_NAME_PATTERNS.some((r) => r.test(folderName))) continue;

        const genericFolders = ['emuladores', 'emulators', 'games', 'juegos', 'juegos pc', 'pc games', 'installed games'];
        const rawName = this.cleanGameName(entry.name);
        const name = genericFolders.includes(normalizeName(rawName))
          ? this.cleanGameName(path.basename(exePath, '.exe'))
          : rawName;
        const id = `drive-${this.generateId('drive', exePath)}`;
        if (seen.has(id)) continue;
        seen.add(id);

        games.push({
          id,
          name,
          exePath,
          platform: 'other',
          source: 'drive',
          coverUrl: '',
          installDir: folderPath,
          sizeOnDisk: 0,
          appId: '',
          launchUri: '',
          addedAt: Date.now()
        });
      }
    }

    return games;
  }

  /* ═══════════════ MERGE ═══════════════ */

  async getAllGames(customFolders = [], extraScanPaths = [], onProgress, emulators = []) {
    const report = (pct, msg) => {
      if (typeof onProgress === 'function') onProgress(Math.max(1, Math.min(100, pct)), msg);
    };

    report(3, 'Detectando bibliotecas de Steam...');
    const steamManifest = await this.scanSteam((p, m) => report(p, m));

    report(33, 'Analizando carpetas de Steam sin manifiesto...');
    const covered = new Set();
    for (const g of steamManifest) {
      if (g.installDir) covered.add(normalizeDirName(g.installDir));
      covered.add(normalizeName(g.name));
      covered.add(normalizeDirName(g.installDir || ''));
    }
    const steamCommon = await this.scanSteamCommonFolders(covered, (p, m) => report(p, m));

    report(53, 'Detectando juegos de Epic Games...');
    const epicGames = await this.scanEpic(onProgress);

    report(68, 'Detectando juegos de GOG...');
    const gogGames = await this.scanGOG(onProgress);

    report(80, 'Analizando carpetas personalizadas...');
    const customGames = await this.scanCustomFolders(customFolders, extraScanPaths);

    report(86, 'Buscando juegos en unidades de disco...');
    const driveGames = await this.scanDriveRoots((p, m) => report(p, m));

    report(89, 'Analizando ROMs de emuladores...');
    const retroGames = this.scanEmulatorRoms(emulators);

    report(93, 'Fusionando bibliotecas de juegos...');
    const allGames = [...steamManifest, ...steamCommon, ...epicGames, ...gogGames, ...customGames, ...driveGames, ...retroGames];

    const groups = new Map();
    for (const game of allGames) {
      const key = normalizeName(game.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(game);
    }

    const priority = { steam: 0, epic: 1, gog: 3, other: 5, custom: 6 };
    const merged = [];

    for (const list of groups.values()) {
      const sorted = list.sort((a, b) => {
        const pa = priority[a.source] ?? 9;
        const pb = priority[b.source] ?? 9;
        if (pa !== pb) return pa - pb;
        return Number(!!b.exePath) - Number(!!a.exePath);
      });

      let base = sorted[0];
      for (const g of sorted.slice(1)) {
        base = {
          ...base,
          name: base.name && base.name.trim() ? base.name : g.name,
          exePath: base.exePath || g.exePath,
          coverUrl: base.coverUrl || g.coverUrl,
          installDir: base.installDir || g.installDir,
          sizeOnDisk: base.sizeOnDisk || g.sizeOnDisk,
          appId: base.appId || g.appId,
          launchUri: base.launchUri || g.launchUri
        };
      }
      merged.push(base);
    }

    report(100, 'Biblioteca lista');
    return merged.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
}

module.exports = GameDetector;