const https = require('https');
const http = require('http');
const I18N = require('../i18n/dict');

function warn(...args) {
  if (process.env.GAMEVAULT_DEBUG) console.warn('[GameInfo]', ...args);
}

function httpGetJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 GameVault/1.0',
          Accept: 'application/json'
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '' });
    });
  });
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

class GameInfoService {
  constructor() {
    this.cache = new Map();
    this.steamIdCache = new Map();
    this.rawgKey = '';
    this.setLocale();
  }

  setLocale(locale) {
    this.locale = I18N.LOCALES[locale] ? locale : I18N.DEFAULT_LOCALE;
  }

  _rawgLang() {
    return this.locale === 'en' ? 'en' : 'es';
  }

  _steamParams() {
    return this.locale === 'en' ? 'cc=us&l=english' : 'cc=es&l=espanol';
  }

  setRawgKey(key) {
    this.rawgKey = String(key || '').trim();
  }

  /* ── RAWG (multi-platform, localized descriptions) ── */
  async _rawgSearch(name) {
    if (!name || !this.rawgKey) return null;
    try {
      const q = encodeURIComponent(name);
      const { status, body } = await httpGetJson(
        `https://api.rawg.io/api/games?key=${encodeURIComponent(this.rawgKey)}&search=${q}&lang=${this._rawgLang()}&page_size=8&search_precise=true`,
        9000
      );
      if (status !== 200) return null;
      const data = JSON.parse(body);

      const scoreMatch = (a, b) => {
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const na = norm(a);
        const nb = norm(b);
        if (!na || !nb) return 0;
        if (na === nb) return 200;
        if (na.length >= 3 && na.includes(nb)) return 100;
        if (na.length >= 3 && nb.includes(na)) return 100;
        if (na.startsWith(nb) || nb.startsWith(na)) return 60;
        return 0;
      };

      const results = (data.results || []).filter(
        (r) => r.slug && r.name && scoreMatch(name, r.name) >= 60
      );
      results.sort((x, y) => scoreMatch(name, y.name) - scoreMatch(name, x.name));
      return results[0] || null;
    } catch {
      return null;
    }
  }

  async _rawgDetails(slug) {
    if (!slug || !this.rawgKey) return null;
    const cacheKey = `rawg:${slug}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    try {
      const { status, body } = await httpGetJson(
        `https://api.rawg.io/api/games/${encodeURIComponent(slug)}?key=${encodeURIComponent(this.rawgKey)}`,
        9000
      );
      if (status !== 200) return null;
      const d = JSON.parse(body);
      const info = {
        name: d.name,
        shortDescription: (d.description_raw || d.description || '').split(/\.\s/)[0] + '.' || '',
        detailedDescription: d.description_raw || d.description || '',
        about: (d.description_raw || d.description || ''),
        developers: Array.isArray(d.developers) ? d.developers.map((x) => x.name) : [],
        publishers: Array.isArray(d.publishers) ? d.publishers.map((x) => x.name) : [],
        genres: Array.isArray(d.genres) ? d.genres.map((g) => g.name).filter(Boolean) : [],
        categories: Array.isArray(d.tags)
          ? d.tags.slice(0, 12).map((t) => t.name).filter(Boolean)
          : [],
        releaseDate: d.released || '',
        comingSoon: !!d.tba,
        price: null,
        isFree: false,
        type: 'game',
        metascore: null,
        screenshot: (d.background_image || ''),
        header: (d.background_image || ''),
        coverUrl: (d.background_image || ''),
        banner: (d.background_image || ''),
        screenshots: Array.isArray(d.short_screenshots)
          ? d.short_screenshots.map((s) => s && s.image).filter(Boolean)
          : Array.isArray(d.screenshots)
            ? d.screenshots.map((s) => s && s.image).filter(Boolean)
            : [],
        metacritic: d.metacritic || null,
        rating: d.rating || null,
        source: 'rawg',
        platforms: Array.isArray(d.parent_platforms)
          ? d.parent_platforms.map((p) => p.platform && p.platform.name).filter(Boolean)
          : []
      };
      this.cache.set(cacheKey, info);
      return info;
    } catch {
      return null;
    }
  }

  /* ── Steam fallback ── */
  async _findSteamIdByName(name) {
    const key = name ? String(name).toLowerCase().trim() : '';
    if (!key) return null;
    if (this.steamIdCache.has(key)) return this.steamIdCache.get(key);
    try {
      const { status, body } = await httpGetJson(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(
          name
        )}&${this._steamParams()}&v=1`,
        8000
      );
      if (status !== 200) return null;
      const data = JSON.parse(body);
      const norm = (s) =>
        String(s || '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
      const normName = norm(name);
      let best = null;
      let bestScore = -1;
      for (const i of data.items || []) {
        if (!i || i.type !== 'app' || !i.id) continue;
        const n = norm(i.name);
        let s = 0;
        if (normName && normName.length >= 3 && normName.includes(n)) s += 100;
        if (normName && normName.length >= 3 && n.includes(normName)) s += 100;
        if (normName && normName.startsWith(n)) s += 60;
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      }
      const appid = (best && bestScore >= 60) ? best.id : null;
      this.steamIdCache.set(key, appid);
      return appid;
    } catch {
      return null;
    }
  }

  _scoreMatch(name, foundName) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = norm(name);
    const b = norm(foundName);
    if (!a || !b) return 0;
    if (a === b) return 200;
    if (a.length >= 3 && a.includes(b)) return 100;
    if (a.length >= 3 && b.includes(a)) return 100;
    if (a.startsWith(b) || b.startsWith(a)) return 60;
    return 0;
  }

  async _fetchSteamAppDetails(appid) {
    const cacheKey = `app:${appid}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    try {
      const { status, body } = await httpGetJson(
        `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&${this._steamParams()}`,
        10000
      );
      if (status !== 200) return null;
      const data = JSON.parse(body);
      const entry = data[String(appid)] || data[appid];
      if (!entry || entry.success !== true || !entry.data) return null;

      const d = entry.data;
      const info = {
        name: d.name,
        shortDescription: (d.short_description || '').trim(),
        detailedDescription: stripHtml(d.detailed_description || '') || (d.short_description || '').trim(),
        about: stripHtml((d.about_the_game || '').split('<h2>')[0]) || (d.short_description || '').trim(),
        developers: Array.isArray(d.developers) ? d.developers : [],
        publishers: Array.isArray(d.publishers) ? d.publishers : [],
        genres: Array.isArray(d.genres)
          ? d.genres.map((g) => g.description || g.id).filter(Boolean)
          : [],
        categories: Array.isArray(d.categories)
          ? d.categories.map((c) => c.description).filter(Boolean)
          : [],
        releaseDate: d.release_date ? d.release_date.date : '',
        comingSoon: d.release_date ? !!d.release_date.coming_soon : false,
        price: d.price_overview
          ? {
              final: d.price_overview.final / 100,
              initial: d.price_overview.initial / 100,
              currency: d.price_overview.currency || ''
            }
          : null,
        isFree: d.is_free === true,
        type: d.type,
        metascore: d.metacritic ? d.metacritic.score : null,
        screenshot: d.screenshots && d.screenshots[0] ? d.screenshots[0].path_full : '',
        banner: d.screenshots && d.screenshots[0] ? d.screenshots[0].path_full : (d.header_image || ''),
        header: d.header_image || '',
        coverUrl: d.header_image || '',
        screenshots: Array.isArray(d.screenshots)
          ? d.screenshots.map((s) => s && (s.path_full || s.path_thumbnail)).filter(Boolean)
          : [],
        banner: d.header_image || '',
        source: 'steam'
      };
      this.cache.set(cacheKey, info);
      return info;
    } catch {
      return null;
    }
  }

  async fetchForGame(game) {
    if (!game) return null;
    const cacheKey = game.id;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    // 1) RAWG first: multi-platform + localized (es) descriptions
    const rawgMatch = await this._rawgSearch(game.name);
    if (rawgMatch) {
      const rawgInfo = await this._rawgDetails(rawgMatch.slug);
      if (rawgInfo) {
        this.cache.set(cacheKey, rawgInfo);
        return rawgInfo;
      }
    }

    // 2) Steam by appId
    if (game.appId && /^\d{1,8}$/.test(String(game.appId))) {
      const info = await this._fetchSteamAppDetails(game.appId);
      if (info) {
        this.cache.set(cacheKey, info);
        return info;
      }
    }

    // 3) Steam by name (fallback)
    const appid = await this._findSteamIdByName(game.name);
    if (appid) {
      const info = await this._fetchSteamAppDetails(appid);
      if (info) {
        if (this._scoreMatch(game.name, info.name) >= 60) {
          this.cache.set(cacheKey, info);
          return info;
        }
        const mismatch = {
          name: game.name,
          discoveredName: info.name,
          shortDescription: '',
          detailedDescription: '',
          about: ''
        };
        this.cache.set(cacheKey, mismatch);
        return mismatch;
      }
    }

    const fallback = { name: game.name, shortDescription: '', detailedDescription: '', about: '' };
    this.cache.set(cacheKey, fallback);
    return fallback;
  }
}

module.exports = GameInfoService;
