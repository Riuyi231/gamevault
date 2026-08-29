const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DEFAULT_OVERRIDES = {
  'left 4 dead 2': { appid: 550, name: 'Left 4 Dead 2' },
  'project zomboid': { appid: 108600, name: 'Project Zomboid' },
  'hollow knight': { appid: 367520, name: 'Hollow Knight' },
  'mortal kombat 11': { appid: 976310, name: 'Mortal Kombat 11' },
  'persona 5 royal': { appid: 1687950, name: 'Persona 5 Royal' },
  'p5r': { appid: 1687950, name: 'Persona 5 Royal' },
  'digimon story time stranger': { appid: 1984270, name: 'Digimon Story Time Stranger' },
  'romancing saga 2': { appid: 2455640, name: 'Romancing SaGa 2: Revenge of the Seven' },
  'resident evil 0': { appid: 339340, name: 'Resident Evil 0' },
  'detroit become human': { appid: 1222140, name: 'Detroit: Become Human' },
  'god of war': { appid: 1593500, name: 'God of War' },
  'marvel rivals': { appid: 2767030, name: 'Marvel Rivals' },
  'slay the princess': { appid: 1986730, name: 'Slay the Princess' },
  'dragon ball sparking zero': { appid: 2891650, name: 'DRAGON BALL Sparking! ZERO' },
  'bloodstained ritual of the night': { appid: 692850, name: 'Bloodstained: Ritual of the Night' },
  'bloodstained': { appid: 692850, name: 'Bloodstained: Ritual of the Night' },
  'dying light': { appid: 239140, name: 'Dying Light' },
  'expedition 33': { appid: 2377540, name: 'Clair Obscur: Expedition 33' },
  'heavy rain': { appid: 960910, name: 'Heavy Rain' },
  'wallpaper engine': null,
  'wallpaper_engine': null
};

const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#161b22"/>
      <stop offset="100%" stop-color="#0d1117"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7c5cff"/>
      <stop offset="100%" stop-color="#00d2ff"/>
    </linearGradient>
  </defs>
  <rect width="600" height="900" fill="url(#bg)"/>
  <rect x="3" y="3" width="594" height="894" fill="none" stroke="url(#accent)" stroke-width="2" opacity="0.18" rx="14"/>
  <circle cx="300" cy="350" r="150" fill="none" stroke="url(#accent)" stroke-width="1" opacity="0.07"/>
  <g transform="translate(300,340)" opacity="0.55">
    <rect x="-72" y="-28" width="144" height="56" rx="28" fill="none" stroke="url(#accent)" stroke-width="3"/>
    <circle cx="-34" cy="0" r="10" fill="#7c5cff"/>
    <circle cx="34" cy="0" r="10" fill="#00d2ff"/>
    <rect x="-14" y="-58" width="28" height="12" rx="6" fill="url(#accent)"/>
    <rect x="-14" y="46" width="28" height="12" rx="6" fill="url(#accent)"/>
    <rect x="-60" y="-14" width="12" height="28" rx="6" fill="url(#accent)"/>
    <rect x="48" y="-14" width="12" height="28" rx="6" fill="url(#accent)"/>
  </g>
  <text x="300" y="565" text-anchor="middle" fill="#7c5cff" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="800" letter-spacing="6">GAMEVAULT</text>
  <text x="300" y="600" text-anchor="middle" fill="#484f58" font-family="Segoe UI, Arial, sans-serif" font-size="15" letter-spacing="2">SIN PORTADA</text>
</svg>`;

function normalize(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

class ArtworkService {
  constructor(dataDir) {
    this.coversDir = path.join(dataDir, 'covers');
    try {
      if (!fs.existsSync(this.coversDir)) {
        fs.mkdirSync(this.coversDir, { recursive: true });
      }
    } catch {
      // ignore
    }
    this.defaultSvgPath = path.join(this.coversDir, 'default-cover.svg');
    this.rawgKey = '';
    this.sgdbKey = '';
    this._ensureDefaultCover();
  }

  getCoversDir() {
    return this.coversDir;
  }

  setRawgKey(key) {
    this.rawgKey = String(key || '').trim();
  }

  setSgdbKey(key) {
    this.sgdbKey = String(key || '').trim();
  }

  _ensureDefaultCover() {
    if (fs.existsSync(this.defaultSvgPath)) return;
    try {
      fs.writeFileSync(this.defaultSvgPath, DEFAULT_SVG, 'utf-8');
    } catch {
      // ignore
    }
  }

  // Cola global: espacia las peticiones para no saturar Wikipedia/Steam/RAWG y
  // reintenta los 429 (rate-limit) con backoff. Evita que las portadas/capturas
  // de unos juegos salgan y las de otros no por throttling.
  static _net() {
    if (!this.__net) this.__net = { last: 0, gap: 130 };
    return this.__net;
  }

  async _httpGetJson(url, timeoutMs = 10000, extraHeaders = {}, _attempt = 1) {
    const net = ArtworkService._net();
    const wait = Math.max(0, net.last + net.gap - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    net.last = Date.now();
    return new Promise((resolve, reject) => {
      const httpMod = url.startsWith('https') ? https : http;
      const req = httpMod.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GameVault/1.0',
            'Accept': 'application/json',
            ...extraHeaders
          },
          timeout: timeoutMs
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode === 429 && _attempt < 3) {
              setTimeout(() => {
                this._httpGetJson(url, timeoutMs, extraHeaders, _attempt + 1)
                  .then(resolve)
                  .catch(reject);
              }, 800 * _attempt);
              return;
            }
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  }

  _httpGetBuffer(url, redirectCount = 0, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      const httpMod = url.startsWith('https') ? https : http;
      const req = httpMod.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GameVault/1.0'
          },
          timeout: timeoutMs
        },
        (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) &&
            res.headers.location
          ) {
            res.resume();
            const nextUrl = new URL(res.headers.location, url).toString();
            return this._httpGetBuffer(nextUrl, redirectCount + 1)
              .then(resolve)
              .catch(reject);
          }
          if (res.statusCode >= 400) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      );
      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  }

  _steamStaticCover(appId) {
    return {
      url: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
      width: 600,
      height: 900,
      source: 'steam',
      thumb: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900_thumb.jpg`
    };
  }

  async searchGame(gameName) {
    const results = [];
    if (!gameName) return results;
    const normalized = normalize(gameName);

    const overrideIds = new Set();
    for (const key of Object.keys(DEFAULT_OVERRIDES)) {
      if (normalized === key || normalized.includes(key)) {
        const override = DEFAULT_OVERRIDES[key];
        if (override && override.appid) overrideIds.add(override.appid);
      }
    }

    // 1) RAWG (multi-platform) — find matches by name, pull covers from RAWG + SteamGridDB
    try {
      const rawgMatches = await this._searchRawg(gameName);
      for (const m of rawgMatches) {
        if (!results.some((r) => r.url === m.url)) results.push(m);
      }
    } catch {
      // ignore
    }

    // 2) SteamGridDB covers (works for Epic/GOG/custom, not only Steam)
    if (results.length === 0) {
      try {
        results.push(...(await this._searchSteamGridDB(gameName)));
      } catch {
        // ignore
      }
    }

    // 3) Steam store as fallback
    try {
      const steamResults = await this._searchSteamStore(gameName);
      for (const r of steamResults) {
        if (!results.some((x) => x.url === r.url)) results.push(r);
      }
    } catch {
      // ignore
    }

    // 4) Wikipedia (sin clave): imagen real de cualquier juego, incluso si no
    //    está en Steam ni requiere clave de RAWG/SGDB.
    if (results.length === 0) {
      try {
        results.push(...(await this._searchWikipedia(gameName)));
      } catch {
        // ignore
      }
    }

    if (results.length === 0) {
      for (const appid of overrideIds) {
        const cover = this._steamStaticCover(appid);
        if (!results.some((r) => r.url === cover.url)) results.push(cover);
      }
    }

    return results.slice(0, 12);
  }

  // Logo/portada real del emulador o consola vía Wikipedia (sin clave).
  // `name` es el nombre del emulador (p.ej. "N64 (RetroArch core)"); se mapea a
  // un artículo exacto conocido para evitar resultados erróneos (p.ej. "Dolphin"
  // → el animal, "Saturn" → el planeta) y la no-determinancia de la búsqueda.
  async searchEmulatorLogo(name) {
    if (!name) return '';
    const low = String(name).toLowerCase();
    const consoleTitles = {
      'nintendo 64': 'Nintendo_64', 'n64': 'Nintendo_64',
      'super nintendo': 'Super_Nintendo_Entertainment_System', 'snes': 'Super_Nintendo_Entertainment_System',
      'nes': 'NES',
      'genesis': 'Sega_Genesis', 'mega drive': 'Sega_Genesis',
      'saturn': 'Sega_Saturn',
      'dreamcast': 'Dreamcast',
      'playstation portable': 'PlayStation_Portable', 'psp': 'PlayStation_Portable',
      'playstation 2': 'PlayStation_2', 'ps2': 'PlayStation_2',
      'playstation': 'PlayStation_(console)', 'psx': 'PlayStation_(console)', 'ps1': 'PlayStation_(console)',
      'game boy advance': 'Game_Boy_Advance', 'gba': 'Game_Boy_Advance', 'advance': 'Game_Boy_Advance',
      'game boy color': 'Game_Boy_Color', 'gbc': 'Game_Boy_Color', 'game boy': 'Game_Boy_Color', 'gameboy': 'Game_Boy_Color',
      'nintendo ds': 'Nintendo_DS', 'nds': 'Nintendo_DS',
      'gamecube': 'Nintendo_GameCube', 'wii': 'Nintendo_GameCube'
    };
    const softwareTitles = {
      'retroarch': 'RetroArch', 'pcsx2': 'PCSX2', 'dolphin': 'Dolphin_(emulator)', 'duckstation': 'DuckStation'
    };
    const pick = (map) =>
      Object.keys(map)
        .sort((a, b) => b.length - a.length)
        .find((k) => low === k || low.includes(k));
    try {
      // Los cores de RetroArch representan su consola (N64, Genesis...), así que
      // la consola gana frente al logo del propio RetroArch. Si el artículo
      // canónico no responde (p.ej. rate-limit) NO se cae a una búsqueda difusa:
      // mejor quedarse sin portada esta vez que persistir una imagen errónea.
      const cKey = pick(consoleTitles);
      if (cKey) return await this._wikiLogoUrl(consoleTitles[cKey]);
      const eKey = pick(softwareTitles);
      if (eKey) return await this._wikiLogoUrl(softwareTitles[eKey]);
      const results = await this._searchWikipedia(name);
      const hit = results.find((r) => r && r.url);
      return hit ? hit.url : '';
    } catch {
      return '';
    }
  }

  // Imagen principal (logo/caja) de un artículo exacto de Wikipedia, sin clave.
  async _wikiLogoUrl(title) {
    if (!title) return '';
    if (!this._logoCache) this._logoCache = {};
    if (this._logoCache[title] !== undefined) return this._logoCache[title];
    for (const lang of ['es', 'en']) {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { status, body } = await this._httpGetJson(url, 8000);
          if (status === 429) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }
          if (status !== 200) break;
          const d = JSON.parse(body);
          if (!d || !d.pageid) break;
          const img = (d.originalimage && d.originalimage.source) || (d.thumbnail && d.thumbnail.source) || '';
          if (img) {
            this._logoCache[title] = img;
            return img;
          }
        } catch {
          break;
        }
      }
    }
    return '';
  }

  async _searchRawg(name) {
    const results = [];
    if (!this.rawgKey || !name) return results;
    try {
      const q = encodeURIComponent(name);
      const { status, body } = await this._httpGetJson(
        `https://api.rawg.io/api/games?key=${encodeURIComponent(this.rawgKey)}&search=${q}&page_size=8&search_precise=true`,
        8000
      );
      if (status !== 200) return results;
      const data = JSON.parse(body);

      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normName = norm(name);
      const matches = (data.results || []).filter((r) => r.slug && r.name);

      for (const r of matches) {
        const label = r.name || '';
        // Prefer a vertical cover via SteamGridDB game lookup when possible
        if (this.sgdbKey && r.slug) {
          try {
            const sgdb = await this._sgdbBySlug(r.slug);
            if (sgdb && sgdb.url && !results.some((x) => x.url === sgdb.url)) {
              results.push({ ...sgdb, label, source: 'steamgriddb' });
              continue;
            }
          } catch {
            // ignore
          }
        }
        const bg = r.background_image || r.background_image_additional || '';
        if (bg && !results.some((x) => x.url === bg)) {
          const strong = normName && normName.includes(norm(label)) || norm(label).includes(normName);
          results.push({
            url: bg,
            thumb: bg,
            width: r.width || 1280,
            height: r.height || 720,
            source: 'rawg',
            label,
            isWide: true,
            relevance: strong ? 110 : 60
          });
        }
      }
      results.sort((x, y) => (y.relevance || 0) - (x.relevance || 0));
    } catch {
      // ignore
    }
    return results;
  }

  async _sgdbBySlug(slug) {
    if (!this.sgdbKey || !slug) return null;
    try {
      const idUrl = `https://www.steamgriddb.com/api/v2/steam/game/${encodeURIComponent(slug)}`;
      const idRes = await this._httpGetJson(idUrl, 7000);
      if (idRes.status !== 200) return null;
      const idParsed = JSON.parse(idRes.body);
      const gameId = idParsed.data && (idParsed.data.id || idParsed.data.game);
      if (!gameId) return null;
      const gridsUrl = `https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900&types=static`;
      const gridRes = await this._httpGetJson(gridsUrl, 7000);
      if (gridRes.status !== 200) return null;
      const gridParsed = JSON.parse(gridRes.body);
      const grids = gridParsed.data || [];
      const grid = Array.isArray(grids) ? grids[0] : null;
      if (!grid || !grid.url) return null;
      return { url: grid.url, width: 600, height: 900, thumb: grid.thumb || grid.url };
    } catch {
      return null;
    }
  }

  async _searchSteamStore(name) {
    const results = [];
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
      name
    )}&l=spanish&cc=es&v=1`;
    let data = null;
    try {
      const { status, body } = await this._httpGetJson(url, 8000);
      if (status === 200) data = JSON.parse(body);
    } catch {
      return results;
    }

    const items = (data && data.items) || [];
    const normName = normalize(name || '');
    const tagged = [];
    for (const item of items) {
      if (!item || item.type !== 'app' || !item.id || parseInt(item.id, 10) <= 0) continue;
      const steamTitle = item.name || '';
      // Score how well this Steam title matches the typed name
      const normItem = normalize(steamTitle);
      let score = 0;
      const a = normName;
      const b = normItem;
      if (a && b) {
        if (a === b) score = 200;
        else if (a.length >= 3 && a.includes(b)) score = 120;
        else if (a.length >= 3 && b.includes(a)) score = 110;
        else if (a.startsWith(b) || b.startsWith(a)) score = 70;
      }
      // Keep strong matches always; weak matches only if nothing better exists
      tagged.push({ item, steamTitle, normItem, score });
    }

    tagged.sort((x, y) => y.score - x.score);
    const strong = tagged.filter((t) => t.score >= 70);
    const pool = strong.length >= 2 ? strong : tagged.filter((t) => t.score > 0).slice(0, 10);

    for (const { item, steamTitle, score } of pool) {
      // Vertical 600x900 cover (recommended) + horizontal capsule (fallback)
      const cover = this._steamStaticCover(item.id);
      cover.label = steamTitle;
      cover.relevance = score;
      cover.width = 600;
      cover.height = 900;
      if (!results.some((r) => r.url === cover.url)) results.push(cover);

      const caps = item.tiny_image || item.header_image || item.logo || '';
      if (caps && score >= 110 && !results.some((r) => r.url === caps)) {
        results.push({
          url: caps,
          thumb: caps,
          width: 231,
          height: 87,
          source: 'steam-capsule',
          label: steamTitle,
          isCapsule: true,
          relevance: score
        });
      }
    }
    return results;
  }

  // Última alternativa sin clave: imagen real desde Wikipedia (cualquier juego,
  // sea de la tienda que sea, aunque no esté en Steam).
  async _searchWikipedia(name) {
    const results = [];
    if (!name) return results;
    const tryLang = async (lang) => {
      const fetchSummary = async (title) => {
        const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
        const { status, body } = await this._httpGetJson(url, 8000);
        if (status !== 200) return null;
        try {
          const d = JSON.parse(body);
          if (!d || !d.pageid) return null;
          return {
            title: d.title || title,
            original: d.originalimage && d.originalimage.source,
            thumb: d.thumbnail && d.thumbnail.source
          };
        } catch {
          return null;
        }
      };
      const candidates = lang === 'es'
        ? [name, `${name} (videojuego)`, `${name} (videojuegos)`]
        : [name, `${name} (video game)`, `${name} (game)`];
      for (const title of candidates) {
        const item = await fetchSummary(title);
        if (item && (item.original || item.thumb)) {
          return {
            image: item.original || item.thumb,
            thumbImage: item.thumb || item.original,
            label: item.title
          };
        }
      }
      return null;
    };

    try {
      const best = await tryLang('es');
      const bestEn = best ? null : await tryLang('en');
      const chosen = best || bestEn;
      if (!chosen || !chosen.image) return results;
      const push = (url, thumb, label) => {
        if (!url || results.some((r) => r.url === url)) return;
        results.push({ url, thumb: thumb || url, width: 1280, height: 720, source: 'wikipedia', label, isWide: true });
      };
      push(chosen.image, chosen.thumbImage, chosen.label);
      push(chosen.thumbImage, chosen.image, chosen.label);
    } catch {
      // ignore
    }
    return results;
  }

  async _searchSteamGridDB(name) {
    const results = [];
    try {
      const encoded = encodeURIComponent(name);
      const autoUrl = `https://www.steamgriddb.com/api/v2/search/autocomplete/${encoded}`;
      const { status, body } = await this._httpGetJson(autoUrl, 8000);
      if (status !== 200) return results;

      const parsed = JSON.parse(body);
      const items = parsed.data || [];
      const searchResults = Array.isArray(items) ? items : [items];
      const gameIds = searchResults.slice(0, 5).map((i) => i.id).filter(Boolean);

      for (const gameId of gameIds) {
        try {
          const headers = this.sgdbKey ? { 'x-api-key': this.sgdbKey } : undefined;
          const imagesUrl = `https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900&types=static`;
          const imgRes = await this._httpGetJson(imagesUrl, 8000, headers);
          if (imgRes.status !== 200) continue;
          const imgParsed = JSON.parse(imgRes.body);
          const grids = imgParsed.data || [];
          const grid = Array.isArray(grids) ? grids[0] : grids;
          if (grid && grid.url) {
            const slug = searchResults.find((i) => i.id === gameId);
            results.push({
              url: grid.url,
              width: grid.width || 600,
              height: grid.height || 900,
              source: 'steamgriddb',
              thumb: grid.thumb || grid.url,
              label: slug ? slug.name || '' : ''
            });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore — SteamGridDB may require an API key; gracefully return []
    }
    return results;
  }

  getCoverLocal(gameId) {
    if (!gameId) return null;
    for (const ext of ['jpg', 'png', 'webp', 'svg']) {
      const p = path.join(this.coversDir, `${gameId}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async saveCover(gameId, imageInput) {
    if (!gameId || !imageInput) return null;
    this._ensureDefaultCover();

    if (Buffer.isBuffer(imageInput)) {
      const finalPath = path.join(this.coversDir, `${gameId}.jpg`);
      fs.writeFileSync(finalPath, imageInput);
      return finalPath;
    }

    if (typeof imageInput !== 'string') return null;

    if (imageInput.startsWith('data:')) {
      const match = imageInput.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (match) {
        const mime = match[1].toLowerCase();
        let ext = 'jpg';
        if (mime === 'png') ext = 'png';
        else if (mime === 'webp') ext = 'webp';
        else if (mime === 'jpeg' || mime === 'jpg') ext = 'jpg';
        else if (mime.indexOf('svg') !== -1) ext = 'svg';
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length === 0) return null;
        const finalPath = path.join(this.coversDir, `${gameId}.${ext}`);
        fs.writeFileSync(finalPath, buffer);
        return finalPath;
      }
    }

    if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
      try {
        const buffer = await this._httpGetBuffer(imageInput);
        if (!buffer || buffer.length === 0) return null;
        const baseName = imageInput.split('?')[0].toLowerCase();
        let ext = 'jpg';
        if (baseName.endsWith('.png')) ext = 'png';
        else if (baseName.endsWith('.webp')) ext = 'webp';
        else if (baseName.endsWith('.svg')) ext = 'svg';
        const finalPath = path.join(this.coversDir, `${gameId}.${ext}`);
        fs.writeFileSync(finalPath, buffer);
        return finalPath;
      } catch {
        return null;
      }
    }

    return null;
  }

  removeCover(gameId) {
    for (const ext of ['jpg', 'png', 'webp', 'svg']) {
      const p = path.join(this.coversDir, `${gameId}.${ext}`);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  }

  getDefaultCoverPath() {
    this._ensureDefaultCover();
    return this.defaultSvgPath;
  }

  coverToDataUrl(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      let mime = 'image/jpeg';
      if (ext === '.png') mime = 'image/png';
      else if (ext === '.svg') mime = 'image/svg+xml';
      else if (ext === '.webp') mime = 'image/webp';
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  }
}

module.exports = ArtworkService;