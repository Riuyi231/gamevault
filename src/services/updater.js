const https = require('https');
const { app } = require('electron');

function httpGetJson(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'GameVault-Updater/1.0',
          Accept: 'application/vnd.github+json'
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

function parseVersion(v) {
  const m = String(v || '').replace(/^v/, '').replace(/\+.*/, '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function compareVersions(a, b) {
  if (!a || !b) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] > b[k]) return 1;
    if (a[k] < b[k]) return -1;
  }
  return 0;
}

class UpdaterService {
  constructor(repo) {
    this.setRepo(repo);
  }

  setRepo(repo) {
    this.repo = String(repo || '').replace(/^\s+|\s+$/g, '').replace(/\/+$/, '');
  }

  async checkForUpdates() {
    if (!this.repo || !this.repo.includes('/')) {
      return { error: 'No hay repositorio configurado para actualizaciones.' };
    }
    try {
      const { status, body } = await httpGetJson(
        `https://api.github.com/repos/${encodeURIComponent(this.repo)}/releases/latest`
      );
      if (status !== 200) {
        return { error: `No se pudo contactar con GitHub (${status}). Verifica que exista una release en ${this.repo}.` };
      }
      const release = JSON.parse(body);
      const latestVersion = parseVersion(release.tag_name);
      const currentVersion = parseVersion(app.getVersion());
      if (!latestVersion) {
        return { error: 'La última release no tiene una etiqueta de versión válida.' };
      }
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
      const setupAsset =
        (release.assets || []).find((a) => /\.(exe|msi)$/i.test(a.name)) ||
        (release.assets || []).find((a) => a.name !== 'latest.yml') || null;

      return {
        hasUpdate,
        latestVersion: release.tag_name,
        currentVersion: app.getVersion(),
        name: release.name || release.tag_name,
        notes: release.body || '',
        htmlUrl: release.html_url || '',
        assetUrl: setupAsset ? setupAsset.browser_download_url : '',
        assetName: setupAsset ? setupAsset.name : '',
        publishedAt: release.published_at || ''
      };
    } catch (err) {
      return { error: 'Error al comprobar actualizaciones: ' + (err && err.message ? err.message : 'desconocido') };
    }
  }
}

module.exports = UpdaterService;
