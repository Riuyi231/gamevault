const https = require('https');
const http = require('http');
const I18N = require('../i18n/dict');

function warn(...args) {
  if (process.env.GAMEVAULT_DEBUG) console.warn('[GameInfo]', ...args);
}

// Pequeña cola global: separa las peticiones HTTP al menos `gap` ms entre sí y
// reenvía los 429 (rate-limit de Wikipedia/Steam). Evita que un recargado de la
// biblioteca en ráfaga haga que el fallback del idioma falle en unos juegos sí y
// en otros no (mezcla de descripciones ES/EN por throttling).
const NET = { last: 0, gap: 110, minRetry: 800 };
function httpGetJson(url, timeoutMs = 10000, _attempt = 1) {
  return new Promise((resolve) => {
    const wait = Math.max(0, NET.last + NET.gap - Date.now());
    const go = () => {
      NET.last = Date.now();
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
          res.on('end', () => {
            if (res.statusCode === 429 && _attempt < 3) {
              setTimeout(() => {
                httpGetJson(url, timeoutMs, _attempt + 1).then(resolve);
              }, NET.minRetry * _attempt);
              return;
            }
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, body: '' });
      });
    };
    setTimeout(go, wait);
  });
}

// Wikidata limita mucho más que Wikipedia/Steam: cola propia con mayor
// separación y más reintentos para no obtener 429 en ráfaga.
const WD_NET = { last: 0, gap: 900, minRetry: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Versión del esquema de "info". Si sube, las fichas cacheadas con una versión
// anterior se re-descargan (p. ej. al añadir trailers/plataformas/personas).
const INFO_SCHEMA_VERSION = 2;
const stampInfo = (i) => {
  if (i && typeof i === 'object' && !i.version) i.version = INFO_SCHEMA_VERSION;
  return i;
};
function wikidataGet(url, timeoutMs = 10000, _attempt = 1) {
  return new Promise((resolve) => {
    const wait = Math.max(0, WD_NET.last + WD_NET.gap - Date.now());
    const go = () => {
      WD_NET.last = Date.now();
      const req = https.get(
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
          res.on('end', () => {
            if (res.statusCode === 429 && _attempt < 4) {
              setTimeout(() => {
                wikidataGet(url, timeoutMs, _attempt + 1).then(resolve);
              }, WD_NET.minRetry * _attempt);
              return;
            }
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, body: '' });
      });
    };
    setTimeout(go, wait);
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
    // Steam usa nombres de idioma en inglés: 'spanish', no 'espanol'.
    return this.locale === 'en' ? 'cc=us&l=english' : 'cc=es&l=spanish';
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

  /* ── Wikipedia (keyless, cualquier plataforma, descripción localizada) ── */
  // ¿El texto es realmente (casi) todo en español? Compara marcadores ES contra
  // marcadores EN en lugar de exigir un mínimo de aciertos en español, que
  // descartaba descripciones cortas válidas ("es una obra maestra").
  _looksSpanish(text) {
    const low = ` ${String(text || '').toLowerCase()} `;
    const esMarkers = [
      ' el ', ' la ', ' los ', ' las ', ' un ', ' una ', ' es un ', ' es una ', ' son ', ' del ', ' en ', ' con ',
      ' que ', ' por ', ' para ', ' está ', ' sobre ', ' desarrollado por ', ' jugadores', ' puedes ', ' tu '
    ];
    const enMarkers = [
      ' the ', ' and ', ' of ', ' to ', ' you ', ' your ', ' with ', ' for ', ' from ', ' is a ', ' are ', ' game ',
      ' about ', ' have ', ' has ', ' gameplay ', ' experience ', ' control ', ' battle ', ' world '
    ];
    let es = 0;
    let en = 0;
    for (const m of esMarkers) if (low.includes(m)) es++;
    for (const m of enMarkers) if (low.includes(m)) en++;
    return es > en;
  }

  // En locale es: si los datos de Steam no vienen en español (juegos sin
  // traducción en la tienda), usa la descripción de Wikipedia en español.
  async _wikiLocalized(info, name) {
    if (!info || this._rawgLang() !== 'es') return info;
    const text = info.detailedDescription || info.shortDescription || '';
    if (!text || this._looksSpanish(text)) return info;
    const wiki = await this._wikiSummary(name);
    if (!wiki || !wiki.detailedDescription || !this._looksLikeGame(wiki)) return info;
    return {
      ...info,
      shortDescription: wiki.shortDescription || info.shortDescription,
      detailedDescription: wiki.detailedDescription,
      about: wiki.about || info.about,
      wikipediaFallback: true
    };
  }

  // ¿La página de Wikipedia parece realmente de un videojuego?
  _looksLikeGame(wiki) {
    if (!wiki) return false;
    if (wiki.coverUrl || wiki.banner) return true;
    const title = String(wiki.wikiTitle || wiki.name || '').toLowerCase();
    if (/(videojuego|video game|videogame|series|franquicia)/.test(title)) return true;
    const text = String(wiki.detailedDescription || '').toLowerCase();
    if (text.includes('videojuego') || text.includes('video game')) return true;
    if (text.includes('es un juego') && text.includes('desarrollado')) return true;
    const gameKinds = ['rpg', 'estrategia', ' rol', 'plataformas', 'aventura', 'aventuras', 'disparos',
      'acción', 'lucha', 'survival', 'mundo abierto', 'sandbox', 'simulador', 'carreras', 'puzzle',
      'plataforma', 'shooter', 'mazo', 'tablero', 'beat', 'arcade'];
    if (text.includes('es un ') && gameKinds.some((k) => text.includes(k))) return true;
    if (text.includes('juego') && text.includes('desarrollado por')) return true;
    return false;
  }

  async _wikiSummary(name) {
    if (!name) return null;
    const cacheKey = `wiki:${this._rawgLang()}:${String(name).toLowerCase().trim()}`;
    if (this.cache.has(cacheKey)) {
      const hit = this.cache.get(cacheKey);
      return hit && hit.source === 'wikipedia' ? hit : null;
    }
    const lang = this._rawgLang();
    const fetchSummary = async (title) => {
      const { status, body } = await httpGetJson(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        8000
      );
      if (status !== 200) return null;
      try {
        const d = JSON.parse(body);
        if (!d || !d.pageid) return null;
        const extract = String(d.extract || '').trim();
        const firstSentence = extract.split(/(?<=[.!?])\s/)[0] || extract;
        return {
          qid: d.wikibase_item || '',
          wikiTitle: d.title || title,
          name: d.title || name,
          shortDescription: firstSentence.slice(0, 320),
          detailedDescription: extract,
          about: extract,
          developers: [],
          publishers: [],
          genres: d.description ? [d.description] : [],
          categories: [],
          releaseDate: '',
          comingSoon: false,
          price: null,
          isFree: false,
          type: 'game',
          metascore: null,
          rating: null,
          screenshot: (d.originalimage && d.originalimage.source) || (d.thumbnail && d.thumbnail.source) || '',
          header: (d.thumbnail && d.thumbnail.source) || (d.originalimage && d.originalimage.source) || '',
          coverUrl: (d.thumbnail && d.thumbnail.source) || (d.originalimage && d.originalimage.source) || '',
          banner: (d.originalimage && d.originalimage.source) || (d.thumbnail && d.thumbnail.source) || '',
          screenshots: [],
          source: 'wikipedia',
          platforms: []
        };
      } catch {
        return null;
      }
    };

    // Prefiere el artículo del videojuego (p.ej. "Sifu (videojuego)") frente a
    // páginas de términos ambiguos que comparten el mismo nombre.
    const candidates =
      lang === 'es'
        ? [name, `${name} (videojuego)`]
        : [name, `${name} (video game)`, `${name} (series)`];

    const best = (list) => {
      const scored = list.filter(Boolean).map((cand, i) => ({
        cand,
        score: (i > 0 ? 40 : 0) + (cand.coverUrl ? 20 : 0) + (cand.detailedDescription.length >= 120 ? 20 : 0)
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored[0] ? scored[0].cand : null;
    };

    try {
      const fetched = [];
      for (const title of candidates) {
        const item = await fetchSummary(title);
        if (item) {
          fetched.push(item);
          if (candidates.indexOf(title) > 0) break;
        }
      }
      const direct = best(fetched);
      if (direct && this._looksLikeGame(direct)) {
        // Rechaza artículos poco relevantes (específicamente: sin imagen y con
        // extracto de diccionario) si existe una variante mejor en `fetched`.
        const done = await this._finalizeWiki(direct);
        this.cache.set(cacheKey, done);
        return done;
      }
      const { status, body } = await httpGetJson(
        `https://${lang}.wikipedia.org/api/rest_v1/search/page?q=${encodeURIComponent(name)}&limit=3`,
        8000
      );
      if (status !== 200) return null;
      const data = JSON.parse(body);
      const pages = data.pages || [];
      const alt = [];
      for (const p of pages.slice(0, 3)) {
        const item = await fetchSummary(String(p.title).replace(/_/g, ' '));
        if (item && this._looksLikeGame(item) && item.detailedDescription.length >= 60 && !item.detailedDescription.startsWith('No debe confundirse')) {
          alt.push(item);
          if (alt.length >= 1 && (item.coverUrl || item.detailedDescription.length >= 150)) break;
        }
      }
      const chosen = best(alt);
      if (chosen) {
        const done = await this._finalizeWiki(chosen);
        this.cache.set(cacheKey, done);
        return done;
      }
    } catch {
      return null;
    }
    return null;
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
        if (normName && normName.length >= 3 && n.includes(normName)) {
          s += 100;
          // Un título mucho más largo que la consulta suele ser un falso
          // positivo de subcadena (p.ej. "Undying" -> "Quern - Undying Thoughts").
          if (n.length > normName.length + 8) s -= 70;
        }
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

  // Enriquecimiento del resultado de Wikipedia sin clave: imágenes del artículo
  // como capturas + año de lanzamiento inferido del primer párrafo.
  async _finalizeWiki(item) {
    if (!item) return item;
    if (!item.screenshots || item.screenshots.length === 0) {
      try {
        const imgs = await this._wikiMediaImages(item.wikiTitle || item.name, this._rawgLang());
        if (imgs && imgs.length) item.screenshots = imgs;
      } catch {
        /* keep empty */
      }
    }
    if (!item.releaseDate) {
      const head =
        String(item.about || item.detailedDescription || '').slice(0, 200) +
        ' ' +
        String((item.genres && item.genres[0]) || '');
      const year = head.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
      if (year) item.releaseDate = year[0];
    }
    return item;
  }

  // Lista de imágenes del artículo de Wikipedia (API de MediaWiki, sin clave).
  // Filtra logos/portadas y devuelve thumbnails anchos (1280px) a modo de capturas.
  async _wikiMediaImages(title, lang) {
    if (!title || !lang) return [];
    const cacheKey = `wikimedia:${lang}:${String(title).toLowerCase().trim()}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const none = () => {
      this.cache.set(cacheKey, []);
      return [];
    };

    const download = async (tryLang) => {
      const { status, body } = await httpGetJson(
        `https://${tryLang}.wikipedia.org/w/api.php?action=query&prop=images&format=json&imlimit=50&origin=*` +
          `&titles=${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
        8000
      );
      if (status !== 200) return [];
      const data = JSON.parse(body);
      const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
      if (!pages[0] || pages[0].missing || !pages[0].images) return [];

      const junk = /logo|icon|cover|portada|banner|caja.?art|caratula|mapa|emblema|artwork|poster|_logo|key.?art|sello/i;
      const screenshotLike = /(screenshot|captura|jugabilidad|gameplay|game.{0,2}shot|en.?juego|gameplay_image|_shot)/i;
      const pool = pages[0].images
        .map((f) => f.title)
        .filter((name) => /\.(jpe?g|png)$/i.test(name) && !junk.test(name))
        .map((name) => ({ name, like: screenshotLike.test(name) ? 1 : 0 }))
        .sort((a, b) => b.like - a.like)
        .slice(0, 6);
      if (pool.length < 2) return [];

      const { status: s2, body: b2 } = await httpGetJson(
        `https://${tryLang}.wikipedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=1280&format=json&origin=*` +
          `&titles=${encodeURIComponent(pool.map((p) => p.name).join('|'))}`,
        8000
      );
      if (s2 !== 200) return [];
      const data2 = JSON.parse(b2);
      const urls = [];
      const pages2 = data2.query && data2.query.pages ? data2.query.pages : {};
      for (const page of Object.values(pages2)) {
        const ii = page.imageinfo && page.imageinfo[0];
        if (ii && ii.thumburl) urls.push(ii.thumburl);
      }
      return urls;
    };

    try {
      let urls = await download(lang);
      if (urls.length === 0 && lang !== 'en') urls = await download('en');
      if (urls.length === 0) return none();
      this.cache.set(cacheKey, urls);
      return urls;
    } catch {
      return none();
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
        platforms: d.platforms
          ? Object.keys(d.platforms)
              .filter((p) => d.platforms[p] === true)
              .map((p) => (p === 'linux' ? 'Linux' : p === 'mac' ? 'macOS' : 'Windows'))
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
        header: d.header_image || '',
        coverUrl: d.header_image || '',
        screenshots: Array.isArray(d.screenshots)
          ? d.screenshots.map((s) => s && (s.path_full || s.path_thumbnail)).filter(Boolean)
          : [],
        // Trailers reales de la tienda para mostrarlos en la ficha. Steam hoy los
        // entrega en streaming (hls_h264/dash_h264 son la URL maestra .m3u8/.mpd);
        // algunos títulos aún traen mp4/webm en {{480,max}}.
        movies: Array.isArray(d.movies)
          ? d.movies
              .map((m) => {
                const pick = (o) => {
                  if (!o) return '';
                  if (typeof o === 'string') return o;
                  return o.default || o['1080'] || o['720'] || o['480'] || o.max || o['360'] || '';
                };
                return {
                  name: (m && m.name) || '',
                  thumbnail: (m && m.thumbnail) || '',
                  src: pick(m.mp4) || pick(m.webm) || pick(m.hls_h264) || pick(m.dash_h264) || pick(m.dash_av1) || ''
                };
              })
              .filter((m) => m.src)
          : [],
        website: d.website || '',
        banner: (d.header_image || (d.screenshots && d.screenshots[0] ? d.screenshots[0].path_full : '')),
        source: 'steam'
      };
      this.cache.set(cacheKey, info);
      return info;
    } catch {
      return null;
    }
  }

  /* ── Wikidata (sin clave): hechos estructurados reales (desarrollador, editor,
        géneros, plataformas, fecha de lanzamiento, metascore) para juegos que no
        están en Steam, en lugar de quedarse solo con el extracto de Wikipedia ── */

  async _wikidataQid(title, lang) {
    if (!title || !lang) return null;
    try {
      const { status, body } = await httpGetJson(
        `https://${lang}.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&format=json&origin=*` +
          `&titles=${encodeURIComponent(String(title).replace(/ /g, '_'))}`,
        7000
      );
      if (status !== 200) return null;
      const data = JSON.parse(body);
      const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
      return (pages[0] && pages[0].pageprops && pages[0].pageprops.wikibase_item) || null;
    } catch {
      return null;
    }
  }

  async _wikidataClaims(qid) {
    if (!qid) return null;
    try {
      const { status, body } = await wikidataGet(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}` +
          `&props=claims&format=json&origin=*`,
        9000
      );
      if (status !== 200) return null;
      const d = JSON.parse(body);
      const e = d.entities && d.entities[qid];
      return (e && e.claims) || null;
    } catch {
      return null;
    }
  }

  async _wikidataLabels(ids) {
    if (!ids || ids.length === 0) return {};
    try {
      const { status, body } = await wikidataGet(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.map(encodeURIComponent).join('|')}` +
          `&props=labels&languages=es|en|zh|ja|ko&languagefallback=1&format=json&origin=*`,
        9000
      );
      if (status !== 200) return {};
      const d = JSON.parse(body);
      const out = {};
      for (const id of ids) {
        const e = d.entities && d.entities[id];
        const l = e && e.labels && (e.labels.es || e.labels.en || e.labels.zh || e.labels.ja || e.labels.ko);
        if (l && l.value) out[id] = l.value;
      }
      return out;
    } catch {
      return {};
    }
  }

  async _wikidataEnrich(item) {
    if (!item) return item;
    // El QID viene ya en la respuesta del summary (d.wikibase_item); si falta,
    // se consulta pageprops en es.wikipedia. Con reintentos: Wikidata y Wikipedia
    // limitan en ráfaga y una sola pasada puede quedarse a medias.
    for (let attempt = 1; attempt <= 3; attempt++) {
      let qid = null;
      try {
        qid = item.qid || (await this._wikidataQid(item.wikiTitle || item.name, this._rawgLang()));
      } catch {
        qid = null;
      }
      if (!qid) {
        if (attempt === 1) await sleep(1500);
        continue;
      }
      let claims = null;
      try {
        claims = await this._wikidataClaims(qid);
      } catch {
        claims = null;
      }
      if (!claims) {
        if (attempt === 1) await sleep(1500);
        continue;
      }

      const itemIds = (pid) =>
        ((claims[pid] || [])
          .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
          .filter((v) => v && typeof v === 'object' && v.id)
          .map((v) => v.id));

      const devs = itemIds('P178'); // desarrollador
      const pubs = itemIds('P123'); // editor
      const genres = itemIds('P136'); // género
      const platforms = itemIds('P750'); // plataforma
      const wanted = new Set([...devs, ...pubs, ...genres, ...platforms]);
      let labels = {};
      for (let li = 0; li < 3 && wanted.size > 0 && Object.keys(labels).length < wanted.size; li++) {
        if (li > 0) await sleep(1600 * li);
        try {
          labels = { ...labels, ...(await this._wikidataLabels(Array.from(wanted))) };
        } catch {
          /* ignore */
        }
      }

      const dates = ((claims['P577'] || []) // fecha de publicación
        .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
        .filter((v) => v && v.time)
        .map((v) => String(v.time).replace(/^\+/, '').slice(0, 10))
        .filter(Boolean)
        .sort());
      const metas = ((claims['P444'] || []) // metascore
        .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
        .filter((v) => v != null && typeof v === 'number'));

      if (devs.length && !item.developers.length) item.developers = devs.map((id) => labels[id] || id);
      if (pubs.length && !item.publishers.length) item.publishers = pubs.map((id) => labels[id] || id);
      if (genres.length && (!item.genres || item.genres.length <= 1)) item.genres = genres.map((id) => labels[id] || id);
      if (platforms.length && (!item.platforms || item.platforms.length === 0)) item.platforms = platforms.map((id) => labels[id] || id);
      if (dates.length && !item.releaseDate) item.releaseDate = dates[0];
      if (metas.length && item.metascore == null) item.metascore = metas[0];
      break;
    }
    return item;
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
        this.cache.set(cacheKey, stampInfo(rawgInfo));
        return stampInfo(rawgInfo);
      }
    }

    // 2) Steam by appId
    if (game.appId && /^\d{1,8}$/.test(String(game.appId))) {
      const info = await this._fetchSteamAppDetails(game.appId);
      if (info) {
        const final = await this._wikiLocalized(info, game.name);
        this.cache.set(cacheKey, stampInfo(final));
        return stampInfo(final);
      }
    }

    // 3) Steam by name (fallback): cualquier juego puede tener ficha de tienda
    //    aunque se escaneó sin appid (gotas de Epic/Ubisoft, carpetas propias,
    //    etc.). Solo se usa con coincidencia muy fuerte; si no, se cae a 4).
    const appid = await this._findSteamIdByName(game.name);
    if (appid) {
      const info = await this._fetchSteamAppDetails(appid);
      if (info && this._scoreMatch(game.name, info.name) >= 100) {
        const final = await this._wikiLocalized(info, game.name);
        this.cache.set(cacheKey, stampInfo(final));
        return stampInfo(final);
      }
    }

    // 4) Wikipedia (sin clave): datos localizados + hechos estructurados reales
    //    de Wikidata (desarrollador, editor, géneros, plataformas, fecha de
    //    lanzamiento, metascore) para juegos de cualquier plataforma (tiendas
    //    propias, consolas, etc.) aunque no estén en Steam.
    const wikiInfo = await this._wikiSummary(game.name);
    if (wikiInfo) {
      const enriched = stampInfo(await this._wikidataEnrich(wikiInfo));
      this.cache.set(cacheKey, enriched);
      return enriched;
    }

    const fallback = stampInfo({ name: game.name, shortDescription: '', detailedDescription: '', about: '' });
    this.cache.set(cacheKey, fallback);
    return fallback;
  }
}

module.exports = GameInfoService;
