# GameVault Proxy

Servidor central que guarda tus claves de **IGDB/Twitch** en secreto y sirve tus datos a todas las instalaciones de GameVault. Ninguna clave llega al instalador ni al usuario: la app solo le pide datos a este servidor.

## Qué expone

- `POST /igdb` — búsqueda IGDB (info real, capturas, artworks y tráilers). Cuerpo: Apicalypse. El servidor obtiene/renueva el token OAuth automáticamente y respeta el límite de ~4 petic/s de IGDB.
- `GET /tgdb/search?name=` y `GET /tgdb/images?id=` — TheGamesDB (si defines `TGDB_API_KEY`).
- `GET /sgdb/autocomplete?name=` y `GET /sgdb/grids?id=&dimensions=&types=` — SteamGridDB (si defines `SGDB_API_KEY`).
- `GET /health` — estado del servidor y de cada fuente.

Si el servidor no tiene configurada una fuente, responde `503 {error:'not_configured'}` y GameVault **cae automáticamente** a sus fuentes keyless (Steam/PCGamingWiki/Wikipedia). Nunca se rompe nada si el servidor está caído.

## Configuración (variables de entorno)

Copia `.env.example` a `.env` y rellena:

| Variable | Necesaria | Descripción |
|---|---|---|
| `IGDB_CLIENT_ID` | Sí | Client ID de tu app Twitch (dev.twitch.tv) |
| `IGDB_CLIENT_SECRET` | Sí | Client Secret (solo se muestra una vez) |
| `TGDB_API_KEY` | No | thegamesdb.net (tu perfil) |
| `SGDB_API_KEY` | No | steamgriddb.com (tu perfil) |
| `PORT` | No | 8080 por defecto |
| `IGDB_MAX_PER_SEC` | No | 4 por defecto (límite real de IGDB) |
| `IP_MAX_PER_MIN` | No | 120 por defecto |
| `ALLOWED_ORIGINS` | No | Lista de origenes permitidos (vacío = todos) |

## Ejecutar

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

## Desplegar gratis

1. **Render** (fácil, dormilón): crea un servicio Web → Branch: `master` → Root Directory: `server` → Runtime: Docker. Añade las variables de entorno. URL tipo `https://gamevault-proxy.onrender.com`.
2. **Fly.io** (siempre despierto, saldo mensual gratuito): instala `flyctl`, entra en `server/` y `fly launch` — deja que detecte el Dockerfile y vuelca las variables con `fly secrets set`.
3. **Railway** simil: Nuevo proyecto → Deploy from Dockerfile → variables en el panel.
4. **En casa**: corre el proxy en un PC/servidor casero abriendo el puerto (o con el túnel `cloudflared`).

## Conectar GameVault

En **Ajustes → Claves de API → Servidor IGDB (opcional)** pega la URL base del proxy (ej. `https://gamevault-proxy.onrender.com`). Si está vacío, GameVault usa tus claves locales de IGDB o las fuentes keyless. No hace falta poner client ID ni secret en cada PC.