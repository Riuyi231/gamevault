'use strict';
const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT || 8080);
const IGDB_ID = process.env.IGDB_CLIENT_ID || '';
const IGDB_SECRET = process.env.IGDB_CLIENT_SECRET || '';
const TGDB_KEY = process.env.TGDB_API_KEY || '';
const SGDB_KEY = process.env.SGDB_API_KEY || '';
const IGDB_MAX_PER_SEC = Math.max(1, Number(process.env.IGDB_MAX_PER_SEC || 4));
const IP_MAX_PER_MIN = Math.max(10, Number(process.env.IP_MAX_PER_MIN || 120));
const ALLOWED = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GameVaultProxy/1.0';

let token = null;
let tokenExp = 0;
let igdbTickets = IGDB_MAX_PER_SEC;
let igdbLast = Date.now();
const ipHits = new Map();

function now() { return Date.now(); }

function json(status, obj) {
  const body = JSON.stringify(obj);
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
    body
  };
}

function request(method, url, headers, body, timeoutMs) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.request(url, {
      method,
      headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers),
      timeout: timeoutMs || 15000
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    r.on('error', () => resolve({ status: 502, body: '', headers: {} }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 504, body: '', headers: {} }); });
    if (body) r.write(body);
    r.end();
  });
}

function getIgdbToken() {
  if (token && now() < tokenExp) return Promise.resolve(token);
  return new Promise(resolve => {
    const payload = 'client_id=' + encodeURIComponent(IGDB_ID) +
      '&client_secret=' + encodeURIComponent(IGDB_SECRET) +
      '&grant_type=client_credentials';
    const req = https.request('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.access_token && j.expires_in) {
            token = j.access_token;
            tokenExp = now() + (j.expires_in - 60) * 1000;
            resolve(token);
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function igdbLock() {
  while (true) {
    const nowMs = now();
    const refill = Math.floor((nowMs - igdbLast) / 1000);
    if (refill > 0) {
      igdbTickets = Math.min(IGDB_MAX_PER_SEC, igdbTickets + refill);
      igdbLast = nowMs;
    }
    if (igdbTickets > 0) { igdbTickets -= 1; return; }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function handleIgdb(payload) {
  if (!IGDB_ID || !IGDB_SECRET) {
    return json(503, { error: 'not_configured', message: 'IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are not set on the server' });
  }
  await igdbLock();
  const t = await getIgdbToken();
  if (!t) return json(502, { error: 'token_failed', message: 'Could not obtain an IGDB token' });
  const out = await request('POST', 'https://api.igdb.com/v4/games', {
    'Client-ID': IGDB_ID,
    Authorization: 'Bearer ' + t,
    'Content-Type': 'text/plain'
  }, payload, 20000);
  return { status: out.status, headers: { 'Content-Type': out.headers['content-type'] || 'application/json' }, body: out.body };
}

function proxyGet(url, headers) {
  return request('GET', url, headers, null, 20000).then(out => ({
    status: out.status,
    headers: { 'Content-Type': out.headers['content-type'] || 'application/json' },
    body: out.body
  }));
}

function allowedOrigin(reqOrigin) {
  if (!ALLOWED) return reqOrigin || '*';
  if (!reqOrigin) return null;
  return ALLOWED.indexOf(reqOrigin) !== -1 ? reqOrigin : null;
}

function crossOrigin(origin, extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Client-ID, Authorization, x-api-key'
  }, extra);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://' + req.headers.host || 'localhost');
  const origin = allowedOrigin(req.headers.origin);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
  const min = Math.floor(now() / 60000);
  const key = ip + ':' + min;
  const hits = (ipHits.get(key) || 0) + 1;
  ipHits.set(key, hits);
  if (ipHits.size > 2000) {
    for (const k of ipHits.keys()) { if (!k.endsWith(':' + min)) ipHits.delete(k); }
  }

  const finish = out => {
    if (out.headers['Access-Control-Allow-Origin'] === undefined && origin) {
      Object.assign(out.headers, crossOrigin(origin));
    }
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  };

  if (req.method === 'OPTIONS') {
    finish({ status: 204, headers: crossOrigin(origin || '*'), body: '' });
    return;
  }

  if (hits > IP_MAX_PER_MIN) {
    finish(json(429, { error: 'too_many_requests', message: 'This IP exceeded the per-minute limit on the proxy' }));
    return;
  }

  if (req.method === 'GET' && u.pathname === '/health') {
    finish(json(200, {
      ok: true,
      igdb: !!(IGDB_ID && IGDB_SECRET),
      tgdb: !!TGDB_KEY,
      sgdb: !!SGDB_KEY,
      tokenCached: !!token,
      igdbMaxPerSec: IGDB_MAX_PER_SEC
    }));
    return;
  }

  const normalized = u.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'POST' && normalized === '/igdb') {
    let body = '';
    req.on('data', c => { if (body.length < 100000) body += c; });
    req.on('end', () => {
      handleIgdb(body.slice(0, 100000)).then(finish);
    });
    return;
  }

  if (req.method === 'GET' && normalized === '/tgdb/search') {
    if (!TGDB_KEY) {
      finish(json(503, { error: 'not_configured', message: 'TGDB_API_KEY is not set on the server' }));
      return;
    }
    const name = (u.searchParams.get('name') || '').slice(0, 100);
    if (!name) { finish(json(400, { error: 'bad_request', message: 'missing name' })); return; }
    proxyGet('https://thegamesdb.net/v1/Games/ByGameName?apikey=' + encodeURIComponent(TGDB_KEY) + '&q=' + encodeURIComponent(name))
      .then(finish);
    return;
  }

  if (req.method === 'GET' && normalized === '/tgdb/images') {
    if (!TGDB_KEY) {
      finish(json(503, { error: 'not_configured', message: 'TGDB_API_KEY is not set on the server' }));
      return;
    }
    const id = (u.searchParams.get('id') || '').slice(0, 20);
    if (!id) { finish(json(400, { error: 'bad_request', message: 'missing id' })); return; }
    proxyGet('https://thegamesdb.net/v1/Games/Images?apikey=' + encodeURIComponent(TGDB_KEY) + '&games_id=' + encodeURIComponent(id))
      .then(finish);
    return;
  }

  if (req.method === 'GET' && normalized === '/sgdb/autocomplete') {
    if (!SGDB_KEY) {
      finish(json(503, { error: 'not_configured', message: 'SGDB_API_KEY is not set on the server' }));
      return;
    }
    const name = (u.searchParams.get('name') || '').slice(0, 100);
    if (!name) { finish(json(400, { error: 'bad_request', message: 'missing name' })); return; }
    proxyGet('https://www.steamgriddb.com/api/v2/search/autocomplete/' + encodeURIComponent(name), { 'x-api-key': SGDB_KEY })
      .then(finish);
    return;
  }

  if (req.method === 'GET' && normalized === '/sgdb/grids') {
    if (!SGDB_KEY) {
      finish(json(503, { error: 'not_configured', message: 'SGDB_API_KEY is not set on the server' }));
      return;
    }
    const id = (u.searchParams.get('id') || '').slice(0, 20);
    const dimensions = (u.searchParams.get('dimensions') || '460x215,600x900').slice(0, 60);
    const types = (u.searchParams.get('types') || 'static').slice(0, 60);
    if (!id) { finish(json(400, { error: 'bad_request', message: 'missing id' })); return; }
    proxyGet('https://www.steamgriddb.com/api/v2/grids/game/' + encodeURIComponent(id) + '?dimensions=' + encodeURIComponent(dimensions) + '&types=' + encodeURIComponent(types), { 'x-api-key': SGDB_KEY })
      .then(finish);
    return;
  }

  finish(json(404, { error: 'not_found', message: 'Unknown endpoint: ' + u.pathname }));
});

server.listen(PORT, () => {
  console.log('[gamevault-proxy] listening on port ' + PORT + (IGDB_ID ? ' (igdb ready)' : ' (igdb NOT configured: set IGDB_CLIENT_ID/IGDB_CLIENT_SECRET)'));
});