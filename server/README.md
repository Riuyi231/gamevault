# GameVault Proxy

Servidor central que guarda tus claves de **IGDB/Twitch** en secreto y sirve tus datos a todas las instalaciones de GameVault. Ninguna clave llega al instalador ni al usuario: la app solo le pide datos a este servidor.

## Qué expone

- `POST /igdb` — búsqueda IGDB (info real, capturas, artworks y tráilers). Cuerpo: Apicalypse. El servidor obtiene/renueva el token OAuth automáticamente y respeta el límite de ~4 petic/s de IGDB.
- `GET /tgdb/search?name=` y `GET /tgdb/images?id=` — TheGamesDB (si defines `TGDB_API_KEY`).
- `GET /sgdb/autocomplete?name=` y `GET /sgdb/grids?id=&dimensions=&types=` — SteamGridDB (si defines `SGDB_API_KEY`).
- `GET /health` — estado del servidor y de cada fuente.

Si el servidor no tiene configurada una fuente, responde `503 {error:'not_configured'}` y GameVault **cae automáticamente** a sus fuentes keyless (Steam/PCGamingWiki/Wikipedia). Nunca se rompe nada si el servidor está caído.

## Configuración (variables de entorno)

Tus claves se configuran como **secretos** (no se compilan en binario). En Cloudflare Workers se hace con `npx wrangler secret put`; en un servidor Node con `.env`.

| Variable | Necesaria | Descripción |
|---|---|---|
| `IGDB_CLIENT_ID` | Sí | Client ID de tu app Twitch (dev.twitch.tv) |
| `IGDB_CLIENT_SECRET` | Sí | Client Secret (solo se muestra una vez) |
| `TGDB_API_KEY` | No | thegamesdb.net (tu perfil) |
| `SGDB_API_KEY` | No | steamgriddb.com (tu perfil) |
| `PORT` | No (Node) | 8080 por defecto |
| `IGDB_MAX_PER_SEC` | No | 4 por defecto (límite real de IGDB) |
| `IP_MAX_PER_MIN` | No | 120 por defecto |
| `ALLOWED_ORIGINS` | No | Lista de origenes permitidos (vacío = todos) |

## Desplegar en Cloudflare Workers (recomendado, gratis y siempre encendido)

> Free: 100 000 peticiones/día, sin tarjeta de crédito, sin tu PC encendido. `worker.js` es el archivo que se despliega (versión `fetch` del proxy; `index.js` solo se usa en un servidor propio).

1. Crea tu cuenta gratis en https://dash.cloudflare.com/sign-up (verifica el email; no pide tarjeta).
2. Abre una terminal en esta carpeta (`server/`):
   ```bash
   npx wrangler login
   ```
   Deja que se abra el navegador y autoriza a `wrangler` con tu cuenta.
3. Pon tus claves como secretos (te las preguntará una a una):
   ```bash
   npx wrangler secret put IGDB_CLIENT_ID
   npx wrangler secret put IGDB_CLIENT_SECRET
   npx wrangler secret put TGDB_API_KEY     # opcional
   npx wrangler secret put SGDB_API_KEY     # opcional
   ```
4. Despliega:
   ```bash
   npx wrangler deploy
   ```
5. Verifica que responde:
   ```bash
   curl https://gamevault-proxy.TU-SUBDOMINIO.workers.dev/health
   # -> {"ok":true,"igdb":true,"tgdb":false,"sgdb":false,...}
   ```

Ese subdominio `*.workers.dev` es tu URL para GameVault. Para recargar secretos después solo repite el paso 3 y `npx wrangler deploy` (o `npx wrangler deploy --dry-run` para probar).

## Ejecutar en un servidor propio (alternativa)

Con Node 18+:

```bash
cp .env.example .env   # edita y pon tus claves
node index.js
```

Con Docker:

```bash
docker build -t gamevault-proxy .
docker run -d -p 8080:8080 --env-file .env gamevault-proxy
```

Si no tienes servidor, puedes correrlo en casa abriendo el puerto o con el túnel `cloudflared`.

## Conectar GameVault

En **Ajustes → Claves de API → Servidor IGDB (opcional)** pega la URL base del proxy (ej. `https://gamevault-proxy.TU-SUBDOMINIO.workers.dev`). Si está vacío, GameVault usa tus claves locales de IGDB o las fuentes keyless. No hace falta poner client ID ni secret en cada PC.