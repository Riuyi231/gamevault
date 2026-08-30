'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CloudflareWorker GameVaultProxy/1.0';
const INF_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_URL = 'https://api.igdb.com/v4/games';

let tokenGlobal = null;
let tokenExpGlobal = 0;
let igdbTickets = 4;
let igdbLast = Date.now();
const ipHits = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Client-ID, Authorization, x-api-key',
    'Access-Control-Max-Age': '86400'
  };
}

function allowedOrigin(reqOrigin, env) {
  const list = (env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || !reqOrigin) return reqOrigin || '*';
  return list.indexOf(reqOrigin) !== -1 ? reqOrigin : null;
}

function jsonResponse(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) }
  });
}

function passResponse(status, body, contentType, origin) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType || 'application/json; charset=utf-8', ...corsHeaders(origin) }
  });
}

function getTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function lockIgdb(maxPerSec) {
  while (true) {
    const now = Date.now();
    const refill = Math.floor((now - igdbLast) / 1000);
    if (refill > 0) {
      igdbTickets = Math.min(maxPerSec, igdbTickets + refill);
      igdbLast = now;
    }
    if (igdbTickets > 0) { igdbTickets -= 1; return; }
    await sleep(200);
  }
}

async function getIgdbToken(env) {
  if (tokenGlobal && Date.now() < tokenExpGlobal) return tokenGlobal;
  try {
    const hit = await caches.default.match('https://gamevault-token-cache.local');
    if (hit) {
      tokenGlobal = await hit.text();
      tokenExpGlobal = Date.now() + 3600 * 1000;
      return tokenGlobal;
    }
  } catch (e) { /* caches not available */ }
  const payload =
    'client_id=' + encodeURIComponent(env.IGDB_CLIENT_ID) +
    '&client_secret=' + encodeURIComponent(env.IGDB_CLIENT_SECRET) +
    '&grant_type=client_credentials';
  let res;
  try {
    const { signal, clear } = getTimeout(10000);
    res = await fetch(INF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: payload,
      signal
    });
    clear();
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch (e) { return null; }
  if (!j.access_token) return null;
  tokenGlobal = j.access_token;
  tokenExpGlobal = Date.now() + Math.max(60, ((j.expires_in || 5184000) - 300)) * 1000;
  try {
    await caches.default.put('https://gamevault-token-cache.local', new Response(j.access_token, {
      headers: { 'Cache-Control': 's-maxage=' + Math.floor((j.expires_in || 5184000) - 300) }
    }));
  } catch (e) { /* cache best-effort */ }
  return tokenGlobal;
}

async function handleIgdb(env, payload) {
  if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) {
    return { status: 503, body: JSON.stringify({ error: 'not_configured', message: 'IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are not set (npx wrangler secret put ...)' }), type: 'application/json' };
  }
  await lockIgdb(Number(env.IGDB_MAX_PER_SEC || 4));
  const t = await getIgdbToken(env);
  if (!t) return { status: 502, body: JSON.stringify({ error: 'token_failed', message: 'Could not obtain an IGDB token' }), type: 'application/json' };
  let res;
  try {
    const { signal, clear } = getTimeout(20000);
    res = await fetch(IGDB_URL, {
      method: 'POST',
      headers: {
        'Client-ID': env.IGDB_CLIENT_ID,
        Authorization: 'Bearer ' + t,
        Accept: 'application/json',
        'Content-Type': 'text/plain',
        'User-Agent': UA
      },
      body: payload,
      signal
    });
    clear();
  } catch (e) {
    return { status: 504, body: '', type: 'application/json' };
  }
  const text = await res.text();
  return { status: res.status, body: text, type: res.headers.get('content-type') || 'application/json' };
}

async function proxyGet(url, headers) {
  let res;
  try {
    const { signal, clear } = getTimeout(20000);
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal });
    clear();
  } catch (e) {
    return { status: 504, body: '', type: 'application/json' };
  }
  const text = await res.text();
  return { status: res.status, body: text, type: res.headers.get('content-type') || 'application/json' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const normalized = url.pathname.replace(/\/+$/, '') || '/';
    const origin = allowedOrigin(request.headers.get('Origin'), env);
    const ip = (request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || '?');
    const min = Math.floor(Date.now() / 60000);
    const key = ip + ':' + min;
    const hits = (ipHits.get(key) || 0) + 1;
    ipHits.set(key, hits);
    if (ipHits.size > 5000) {
      for (const k of ipHits.keys()) { if (!k.endsWith(':' + min)) ipHits.delete(k); }
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const ipMax = Number(env.IP_MAX_PER_MIN || 120);
    if (hits > ipMax) {
      return jsonResponse(429, { error: 'too_many_requests', message: 'This IP exceeded the per-minute limit on the proxy' }, origin);
    }

    if (request.method === 'GET' && normalized === '/health') {
      return jsonResponse(200, {
        ok: true,
        igdb: !!(env.IGDB_CLIENT_ID && env.IGDB_CLIENT_SECRET),
        tgdb: !!env.TGDB_API_KEY,
        sgdb: !!env.SGDB_API_KEY,
        tokenCached: !!(tokenGlobal && Date.now() < tokenExpGlobal),
        igdbMaxPerSec: Number(env.IGDB_MAX_PER_SEC || 4)
      }, origin);
    }

    if (request.method === 'POST' && normalized === '/igdb') {
      let payload = '';
      try { payload = (await request.text()).slice(0, 100000); } catch (e) { payload = ''; }
      const out = await handleIgdb(env, payload);
      return passResponse(out.status, out.body, out.type, origin);
    }

    if (request.method === 'GET' && normalized === '/tgdb/search') {
      if (!env.TGDB_API_KEY) {
        return jsonResponse(503, { error: 'not_configured', message: 'TGDB_API_KEY is not set on the server' }, origin);
      }
      const name = (url.searchParams.get('name') || '').slice(0, 100);
      if (!name) return jsonResponse(400, { error: 'bad_request', message: 'missing name' }, origin);
      const out = await proxyGet(
        'https://thegamesdb.net/v1/Games/ByGameName?apikey=' + encodeURIComponent(env.TGDB_API_KEY) + '&q=' + encodeURIComponent(name));
      return passResponse(out.status, out.body, out.type, origin);
    }

    if (request.method === 'GET' && normalized === '/tgdb/images') {
      if (!env.TGDB_API_KEY) {
        return jsonResponse(503, { error: 'not_configured', message: 'TGDB_API_KEY is not set on the server' }, origin);
      }
      const id = (url.searchParams.get('id') || '').slice(0, 20);
      if (!id) return jsonResponse(400, { error: 'bad_request', message: 'missing id' }, origin);
      const out = await proxyGet(
        'https://thegamesdb.net/v1/Games/Images?apikey=' + encodeURIComponent(env.TGDB_API_KEY) + '&games_id=' + encodeURIComponent(id));
      return passResponse(out.status, out.body, out.type, origin);
    }

    if (request.method === 'GET' && normalized === '/sgdb/autocomplete') {
      if (!env.SGDB_API_KEY) {
        return jsonResponse(503, { error: 'not_configured', message: 'SGDB_API_KEY is not set on the server' }, origin);
      }
      const name = (url.searchParams.get('name') || '').slice(0, 100);
      if (!name) return jsonResponse(400, { error: 'bad_request', message: 'missing name' }, origin);
      const out = await proxyGet(
        'https://www.steamgriddb.com/api/v2/search/autocomplete/' + encodeURIComponent(name), { 'x-api-key': env.SGDB_API_KEY });
      return passResponse(out.status, out.body, out.type, origin);
    }

    if (request.method === 'GET' && normalized === '/sgdb/grids') {
      if (!env.SGDB_API_KEY) {
        return jsonResponse(503, { error: 'not_configured', message: 'SGDB_API_KEY is not set on the server' }, origin);
      }
      const id = (url.searchParams.get('id') || '').slice(0, 20);
      const dimensions = (url.searchParams.get('dimensions') || '460x215,600x900').slice(0, 60);
      const types = (url.searchParams.get('types') || 'static').slice(0, 60);
      if (!id) return jsonResponse(400, { error: 'bad_request', message: 'missing id' }, origin);
      const out = await proxyGet(
        'https://www.steamgriddb.com/api/v2/grids/game/' + encodeURIComponent(id) + '?dimensions=' + encodeURIComponent(dimensions) + '&types=' + encodeURIComponent(types),
        { 'x-api-key': env.SGDB_API_KEY });
      return passResponse(out.status, out.body, out.type, origin);
    }

    return jsonResponse(404, { error: 'not_found', message: 'Unknown endpoint: ' + url.pathname }, origin);
  }
};