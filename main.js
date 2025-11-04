const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const extract = require('extract-zip');
const crypto = require('crypto');
const os = require('os');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { Client } = require('minecraft-launcher-core');
const MCLCHandler = require('minecraft-launcher-core/components/handler');
const { Rcon } = require('rcon-client');
const nbt = require('prismarine-nbt');

const DEFAULT_STATUS_API = 'https://api.mcstatus.io/v2/status/java';
const MIN_REFRESH_INTERVAL_MS = 10000;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const configRaw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(configRaw);

let mainWindow = null;

const SUPPRESSED_EXCEPTION_CODES = new Set(['ECONNRESET']);

const shouldSuppressMainProcessException = (error) => {
  if (!error) return false;
  if (error.code && SUPPRESSED_EXCEPTION_CODES.has(error.code)) {
    return true;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  if (!message) return false;
  const upper = message.toUpperCase();
  for (const code of SUPPRESSED_EXCEPTION_CODES) {
    if (upper.includes(code)) {
      return true;
    }
  }
  return false;
};

const uncaughtExceptionHandler = (error) => {
  if (shouldSuppressMainProcessException(error)) {
    console.warn('[main] Suppressed uncaught exception:', error);
    return;
  }
  process.removeListener('uncaughtException', uncaughtExceptionHandler);
  throw error;
};

process.on('uncaughtException', uncaughtExceptionHandler);

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeUpdateConfig = (raw = {}) => {
  const source = raw || {};
  const github = source.github || source.GITHUB || {};
  const owner =
    process.env.APP_UPDATE_OWNER ||
    github.OWNER ||
    github.owner ||
    process.env.RELEASE_OWNER ||
    null;
  const repo =
    process.env.APP_UPDATE_REPO ||
    github.REPO ||
    github.repo ||
    process.env.RELEASE_REPO ||
    null;
  const assetName =
    process.env.APP_UPDATE_ASSET ||
    process.env.APP_UPDATE_ASSET_NAME ||
    github.ASSET_NAME ||
    github.assetName ||
    null;
  const enabled = parseBoolean(
    process.env.APP_UPDATES_ENABLED,
    source.ENABLED !== undefined ? parseBoolean(source.ENABLED, true) : true
  );
  const enforce = parseBoolean(
    process.env.APP_UPDATES_ENFORCE,
    source.ENFORCE !== undefined ? parseBoolean(source.ENFORCE, true) : true
  );
  const channel = process.env.APP_UPDATES_CHANNEL || source.CHANNEL || source.channel || 'stable';
  return {
    enabled: enabled && Boolean(owner && repo),
    enforce,
    channel,
    owner,
    repo,
    assetName
  };
};

const APP_VERSION = app.getVersion();
const updateConfig = normalizeUpdateConfig(config.APP_UPDATES || {});
const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedUpdateInfo = null;
let updateCheckPromise = null;
let updateDownloadTask = null;

const sendUpdateEvent = (payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('app:update:event', payload);
  } catch (err) {
    console.warn('[updates] Failed to send update event:', err);
  }
};

const broadcastUpdateState = (state) => {
  sendUpdateEvent({ type: 'state', state });
};

const extractVersionFromString = (value) => {
  if (!value) return null;
  const match = String(value).match(/(\d+(?:\.\d+)+)/);
  return match ? match[1] : null;
};

const compareVersionStrings = (a, b) => {
  if (a === b) return 0;
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const aParts = String(a)
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean);
  const bParts = String(b)
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const left = aParts[i] || '0';
    const right = bParts[i] || '0';
    const leftNum = Number(left);
    const rightNum = Number(right);
    if (!Number.isNaN(leftNum) && !Number.isNaN(rightNum)) {
      if (leftNum > rightNum) return 1;
      if (leftNum < rightNum) return -1;
    } else {
      const cmp = left.localeCompare(right);
      if (cmp > 0) return 1;
      if (cmp < 0) return -1;
    }
  }
  return 0;
};

const fetchLatestReleaseMetadata = async () => {
  const url = `https://api.github.com/repos/${updateConfig.owner}/${updateConfig.repo}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'compass-mc-launcher'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Update metadata request failed (${response.status})`);
    error.status = response.status;
    error.responseText = text;
    throw error;
  }
  return response.json();
};

const buildUpdateInfoFromRelease = (release) => {
  if (!release) {
    throw new Error('Release payload is empty.');
  }
  const releaseVersion =
    extractVersionFromString(release.tag_name) || extractVersionFromString(release.name);
  if (!releaseVersion) {
    throw new Error('Latest release does not contain a recognizable version tag.');
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  let asset = null;
  if (updateConfig.assetName) {
    asset = assets.find((entry) => entry && entry.name === updateConfig.assetName);
  }
  if (!asset) {
    asset = assets.find((entry) => entry && /\.exe$/i.test(entry.name || ''));
  }
  if (!asset) {
    throw new Error('Release is missing a portable executable asset.');
  }
  const comparison = compareVersionStrings(releaseVersion, APP_VERSION);
  return {
    enabled: true,
    enforce: updateConfig.enforce,
    status: 'ok',
    currentVersion: APP_VERSION,
    latestVersion: releaseVersion,
    releaseTag: release.tag_name || null,
    publishedAt: release.published_at || null,
    releaseNotes: release.body || '',
    downloadUrl: asset.browser_download_url,
    assetName: asset.name,
    assetSize: typeof asset.size === 'number' ? asset.size : null,
    needsUpdate: comparison > 0,
    mandatory: comparison > 0 && updateConfig.enforce,
    fetchedAt: Date.now()
  };
};

const getLatestUpdateInfo = async (force = false) => {
  if (!updateConfig.enabled) {
    const info = {
      enabled: false,
      enforce: updateConfig.enforce,
      status: 'disabled',
      currentVersion: APP_VERSION,
      latestVersion: null,
      releaseTag: null,
      publishedAt: null,
      releaseNotes: null,
      downloadUrl: null,
      assetName: null,
      assetSize: null,
      needsUpdate: false,
      mandatory: false,
      fetchedAt: Date.now()
    };
    cachedUpdateInfo = info;
    broadcastUpdateState(info);
    return info;
  }

  if (!force && cachedUpdateInfo && Date.now() - cachedUpdateInfo.fetchedAt < UPDATE_CACHE_TTL_MS) {
    broadcastUpdateState(cachedUpdateInfo);
    return cachedUpdateInfo;
  }

  if (force) {
    cachedUpdateInfo = null;
  }

  if (updateCheckPromise) {
    return updateCheckPromise;
  }

  updateCheckPromise = (async () => {
    try {
      const release = await fetchLatestReleaseMetadata();
      const info = buildUpdateInfoFromRelease(release);
      cachedUpdateInfo = info;
      broadcastUpdateState(info);
      return info;
    } catch (err) {
      console.warn('[updates] Failed to retrieve update info:', err);
      const failure = {
        enabled: true,
        enforce: updateConfig.enforce,
        status: 'error',
        currentVersion: APP_VERSION,
        latestVersion: null,
        releaseTag: null,
        publishedAt: null,
        releaseNotes: null,
        downloadUrl: null,
        assetName: null,
        assetSize: null,
        needsUpdate: false,
        mandatory: false,
        fetchedAt: Date.now(),
        error: err.message || String(err)
      };
      cachedUpdateInfo = failure;
      broadcastUpdateState(failure);
      return failure;
    } finally {
      updateCheckPromise = null;
    }
  })();

  return updateCheckPromise;
};

const scheduleUpdateReplacement = async (downloadPath) => {
  if (!downloadPath) {
    throw new Error('Update payload path is missing.');
  }

  const scriptPath = path.join(
    os.tmpdir(),
    `mc-launcher-update-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  );

  const scriptContent = [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$SourcePath,',
    '  [Parameter(Mandatory=$true)][string]$TargetPath,',
    '  [Parameter(Mandatory=$true)][int]$ProcessId',
    ')',
    '$attempts = 0',
    'while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {',
    '  Start-Sleep -Milliseconds 200',
    '}',
    'while ($attempts -lt 120) {',
    '  try {',
    '    Copy-Item -LiteralPath $SourcePath -Destination $TargetPath -Force',
    '    Remove-Item -LiteralPath $SourcePath -Force -ErrorAction SilentlyContinue',
    '    Start-Process -FilePath $TargetPath',
    '    break',
    '  } catch {',
    '    Start-Sleep -Milliseconds 500',
    '    $attempts++',
    '  }',
    '}',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue'
  ].join('\r\n');

  await fs.promises.writeFile(scriptPath, scriptContent, 'utf8');

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-SourcePath',
    downloadPath,
    '-TargetPath',
    process.execPath,
    '-ProcessId',
    String(process.pid)
  ];

  try {
    const updater = spawn('powershell.exe', args, {
      detached: true,
      stdio: 'ignore'
    });
    updater.unref();
  } catch (err) {
    throw new Error(`Failed to launch updater script: ${err.message || err}`);
  }

  setTimeout(() => {
    app.quit();
    setTimeout(() => {
      app.exit(0);
    }, 1000);
  }, 200);
};

const downloadAndApplyUpdate = async (info) => {
  if (!info || !info.downloadUrl) {
    throw new Error('Update download link is unavailable.');
  }
  if (updateDownloadTask) {
    throw new Error('An update is already being downloaded.');
  }

  const controller = new AbortController();
  const tempPath = path.join(
    os.tmpdir(),
    `mc-launcher-update-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`
  );

  updateDownloadTask = { controller, tempPath };
  sendUpdateEvent({ type: 'status', status: 'downloading' });

  let downloadedBytes = 0;
  let totalBytes = null;
  let scheduled = false;

  try {
    const response = await fetch(info.downloadUrl, {
      headers: {
        'User-Agent': 'compass-mc-launcher'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Download failed (${response.status}): ${text ? text.slice(0, 120) : 'no response body'}`
      );
    }

    if (!response.body) {
      throw new Error('Update download stream is missing.');
    }

    totalBytes = Number(response.headers.get('content-length')) || null;

    response.body.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      const percent = totalBytes
        ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
        : null;
      sendUpdateEvent({
        type: 'progress',
        downloadedBytes,
        totalBytes,
        percent
      });
    });

    const outStream = fs.createWriteStream(tempPath);
    await pipeline(response.body, outStream);

    sendUpdateEvent({
      type: 'status',
      status: 'downloaded',
      downloadedBytes,
      totalBytes
    });

    await scheduleUpdateReplacement(tempPath);
    scheduled = true;
    sendUpdateEvent({ type: 'status', status: 'restarting' });
  } catch (err) {
    sendUpdateEvent({
      type: 'status',
      status: 'error',
      error: err.message || String(err)
    });

    try {
      if (!scheduled && (await fs.pathExists(tempPath))) {
        await fs.remove(tempPath);
      }
    } catch (cleanupErr) {
      console.warn('[updates] Failed to cleanup temporary update file:', cleanupErr);
    }

    throw err;
  } finally {
    updateDownloadTask = null;
  }
};

const cloneJson = (value) => {
  if (!value || typeof value !== 'object') return null;
  return JSON.parse(JSON.stringify(value));
};

const rawMclcOverrides = cloneJson(config.MCLC_OVERRIDES);

const trimTrailingSlashes = (value) => value.replace(/\/+$/, '');
const ensureSingleTrailingSlash = (value) => `${trimTrailingSlashes(value)}/`;

const sanitizeUrlOverrides = (urls = {}) => {
  if (!urls || typeof urls !== 'object') return null;
  const sanitized = {};
  if (typeof urls.meta === 'string') {
    sanitized.meta = trimTrailingSlashes(urls.meta.trim());
  }
  if (typeof urls.resource === 'string') {
    sanitized.resource = trimTrailingSlashes(urls.resource.trim());
  }
  if (typeof urls.mavenForge === 'string') {
    sanitized.mavenForge = ensureSingleTrailingSlash(urls.mavenForge.trim());
  }
  if (typeof urls.defaultRepoForge === 'string') {
    sanitized.defaultRepoForge = ensureSingleTrailingSlash(urls.defaultRepoForge.trim());
  }
  if (typeof urls.fallbackMaven === 'string') {
    sanitized.fallbackMaven = ensureSingleTrailingSlash(urls.fallbackMaven.trim());
  }
  if (typeof urls.resourceBase === 'string') {
    sanitized.resourceBase = trimTrailingSlashes(urls.resourceBase.trim());
  }
  return Object.keys(sanitized).length ? sanitized : null;
};

const buildMclcOverrides = () => {
  if (!rawMclcOverrides) return null;
  const overrides = cloneJson(rawMclcOverrides) || {};
  if (overrides.url) {
    const sanitizedUrl = sanitizeUrlOverrides(overrides.url);
    if (sanitizedUrl) {
      overrides.url = sanitizedUrl;
    } else {
      delete overrides.url;
    }
  }
  return Object.keys(overrides).length ? overrides : null;
};

const extractUrlPath = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search || ''}`;
  } catch (err) {
    return null;
  }
};

const replaceUrlBase = (url, base) => {
  if (typeof url !== 'string' || typeof base !== 'string') return url;
  const pathPart = extractUrlPath(url);
  if (!pathPart) return url;
  const normalizedBase = trimTrailingSlashes(base.trim());
  if (!normalizedBase) return url;
  let normalizedPath = pathPart;

  // When moving files into a mirror rooted at ".../meta", strip any duplicated repository prefix.
  if (normalizedBase.toLowerCase().endsWith('/meta')) {
    const metaMarkerIndex = pathPart.toLowerCase().indexOf('/meta/');
    if (metaMarkerIndex >= 0) {
      normalizedPath = pathPart.slice(metaMarkerIndex + '/meta'.length);
      if (!normalizedPath.startsWith('/')) {
        normalizedPath = `/${normalizedPath}`;
      }
    }
  }

  return `${normalizedBase}${normalizedPath}`;
};

const joinBaseAndPath = (base, path) => {
  if (typeof base !== 'string' || typeof path !== 'string') return null;
  const normalizedBase = trimTrailingSlashes(base.trim());
  if (!normalizedBase) return null;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

const rewriteUrlForMirror = (url, overrides) => {
  if (typeof url !== 'string' || !overrides || !overrides.url) return url;
  const target = url.trim();
  if (!target) return target;

  const { meta, resource, mavenForge, defaultRepoForge, fallbackMaven } = overrides.url;
  const metaBase = meta ? trimTrailingSlashes(meta) : null;
  const resourceBase = resource ? trimTrailingSlashes(resource) : null;
  const mavenBase = mavenForge ? trimTrailingSlashes(mavenForge) : null;
  const defaultBase = defaultRepoForge ? trimTrailingSlashes(defaultRepoForge) : null;
  const fallbackBase = fallbackMaven ? trimTrailingSlashes(fallbackMaven) : null;

  const pathPart = extractUrlPath(target);
  const isBmclapiMirror = /^(https?:\/\/)?(?:.+\.)?bmclapi2\.bangbang93\.com/i.test(target);

  if (metaBase) {
    if (/^(https?:\/\/)?(launchermeta|piston-meta|piston-data|launcher)\.mojang\.com/i.test(target)) {
      const next = joinBaseAndPath(metaBase, pathPart);
      if (next) return next;
    }
    if (isBmclapiMirror && pathPart && /^\/(mc\/game|v1\/packages|v1\/objects)\b/i.test(pathPart)) {
      const next = joinBaseAndPath(metaBase, pathPart);
      if (next) return next;
    }
  }

  if (resourceBase) {
    if (/^(https?:\/\/)?resources\.download\.minecraft\.net/i.test(target)) {
      const next = joinBaseAndPath(resourceBase, pathPart);
      if (next) return next;
    }
    if (isBmclapiMirror && pathPart && /^\/assets\//i.test(pathPart)) {
      const trimmedPath = pathPart.replace(/^\/assets/i, '/objects');
      const next = joinBaseAndPath(resourceBase, trimmedPath);
      if (next) return next;
    }
  }

  if (mavenBase) {
    if (/^(https?:\/\/)?(files|maven)\.minecraftforge\.net/i.test(target)) {
      const next = joinBaseAndPath(mavenBase, pathPart);
      if (next) return next;
    }
    if (isBmclapiMirror && pathPart && /^\/maven\//i.test(pathPart)) {
      const trimmedPath = pathPart.replace(/^\/maven/i, '');
      const next = joinBaseAndPath(mavenBase, trimmedPath);
      if (next) return next;
    }
  }

  if (defaultBase) {
    if (/^(https?:\/\/)?libraries\.minecraft\.net/i.test(target)) {
      const next = joinBaseAndPath(defaultBase, pathPart);
      if (next) return next;
    }
    if (isBmclapiMirror && pathPart && /^\/maven\//i.test(pathPart)) {
      const trimmedPath = pathPart.replace(/^\/maven/i, '');
      const next = joinBaseAndPath(defaultBase, trimmedPath);
      if (next) return next;
    }
  }

  if (fallbackBase) {
    if (/^(https?:\/\/)?search\.maven\.org/i.test(target)) {
      const next = joinBaseAndPath(fallbackBase, pathPart);
      if (next) return next;
    }
    if (isBmclapiMirror && pathPart && /^\/maven\//i.test(pathPart)) {
      const trimmedPath = pathPart.replace(/^\/maven/i, '');
      const next = joinBaseAndPath(fallbackBase, trimmedPath);
      if (next) return next;
    }
  }

  return target;
};

const normalizeForgeMirrorUrl = (url, overrides) => {
  if (typeof url !== 'string') return url;
  let adjusted = rewriteUrlForMirror(url, overrides);
  if (typeof adjusted !== 'string' || !overrides?.url?.mavenForge) return adjusted;

  const normalizedForgeBase = ensureSingleTrailingSlash(overrides.url.mavenForge);
  const fallbackForgeBase = normalizedForgeBase.replace(/\/maven\/$/i, '/forge/');
  const trimmedForgeBase = trimTrailingSlashes(normalizedForgeBase);
  const trimmedFallbackForgeBase = trimTrailingSlashes(fallbackForgeBase);

  if (normalizedForgeBase !== fallbackForgeBase) {
    if (adjusted.startsWith(fallbackForgeBase)) {
      adjusted = normalizedForgeBase + adjusted.slice(fallbackForgeBase.length);
    } else if (adjusted.startsWith(trimmedFallbackForgeBase)) {
      adjusted = trimmedForgeBase + adjusted.slice(trimmedFallbackForgeBase.length);
    }
  }

  return adjusted;
};

const rewriteForgeVersionJsonForMirror = (payload, overrides) => {
  if (!payload || typeof payload !== 'object' || !overrides || !overrides.url) return payload;
  const cloned = JSON.parse(JSON.stringify(payload));

  const rewriteLibraryUrls = (library) => {
    if (!library || typeof library !== 'object') return;
    if (library.url) {
      library.url = normalizeForgeMirrorUrl(library.url, overrides);
    }
    if (library.downloads && typeof library.downloads === 'object') {
      if (library.downloads.artifact && library.downloads.artifact.url) {
        library.downloads.artifact.url = normalizeForgeMirrorUrl(library.downloads.artifact.url, overrides);
      }
      if (library.downloads.classifiers && typeof library.downloads.classifiers === 'object') {
        for (const classifier of Object.values(library.downloads.classifiers)) {
          if (classifier && classifier.url) {
            classifier.url = normalizeForgeMirrorUrl(classifier.url, overrides);
          }
        }
      }
    }
  };

  if (Array.isArray(cloned.libraries)) {
    cloned.libraries.forEach(rewriteLibraryUrls);
  }
  if (Array.isArray(cloned.mavenFiles)) {
    cloned.mavenFiles.forEach(rewriteLibraryUrls);
  }

  return cloned;
};

if (!MCLCHandler.prototype.__mirrorDownloadPatched) {
  const originalDownloadAsync = MCLCHandler.prototype.downloadAsync;
  MCLCHandler.prototype.downloadAsync = function patchedDownloadAsync(url, directory, name, retry, type) {
    const overrides = this.options?.overrides;
    if (typeof url === 'string') {
      const adjusted = normalizeForgeMirrorUrl(url, overrides);
      if (typeof adjusted === 'string') {
        url = adjusted;
      }
    }
    return originalDownloadAsync.call(this, url, directory, name, retry, type);
  };
  MCLCHandler.prototype.__mirrorDownloadPatched = true;
}

const rewriteVersionJsonForMirror = (payload, overrides) => {
  if (!payload || typeof payload !== 'object' || !overrides || !overrides.url) return payload;
  const cloned = JSON.parse(JSON.stringify(payload));

  if (cloned.assetIndex && cloned.assetIndex.url) {
    cloned.assetIndex.url = rewriteUrlForMirror(cloned.assetIndex.url, overrides);
  }

  if (cloned.downloads) {
    if (cloned.downloads.client && cloned.downloads.client.url) {
      cloned.downloads.client.url = rewriteUrlForMirror(cloned.downloads.client.url, overrides);
    }
    if (cloned.downloads.server && cloned.downloads.server.url) {
      cloned.downloads.server.url = rewriteUrlForMirror(cloned.downloads.server.url, overrides);
    }
  }

  if (cloned.logging && cloned.logging.client && cloned.logging.client.file && cloned.logging.client.file.url) {
    cloned.logging.client.file.url = rewriteUrlForMirror(cloned.logging.client.file.url, overrides);
  }

  if (Array.isArray(cloned.libraries)) {
    for (const lib of cloned.libraries) {
      if (!lib || typeof lib !== 'object') continue;
      if (lib.url) {
        lib.url = rewriteUrlForMirror(lib.url, overrides);
      }
      if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url) {
        lib.downloads.artifact.url = rewriteUrlForMirror(lib.downloads.artifact.url, overrides);
      }
      if (lib.downloads && lib.downloads.classifiers && typeof lib.downloads.classifiers === 'object') {
        for (const classifier of Object.values(lib.downloads.classifiers)) {
          if (classifier && classifier.url) {
            classifier.url = rewriteUrlForMirror(classifier.url, overrides);
          }
        }
      }
    }
  }

  return cloned;
};

const fetchJsonFromMirror = async (url, label) => {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Failed to fetch ${label}: ${err.message || err}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch ${label}: ${res.status} ${res.statusText}`);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(`Failed to read ${label}: ${err.message || err}`);
  }

  const sanitized = typeof text === 'string'
    ? text.replace(/^\uFEFF/, '').trim()
    : '';

  if (!sanitized) {
    throw new Error(`Failed to parse ${label}: empty response body`);
  }

  try {
    return JSON.parse(sanitized);
  } catch (err) {
    throw new Error(`Failed to parse ${label}: ${err.message || err}`);
  }
};

const ensureVersionMetadataForMirror = async (gameRoot, versionNumber, overrides) => {
  if (!gameRoot || !versionNumber || !overrides || !overrides.url || !overrides.url.meta) return null;

  const versionDir = path.join(gameRoot, 'versions', versionNumber);
  const versionJsonPath = path.join(versionDir, `${versionNumber}.json`);

  if (await fs.pathExists(versionJsonPath)) {
    try {
      const existing = await fs.readJson(versionJsonPath);
      const rewritten = rewriteVersionJsonForMirror(existing, overrides);
      if (JSON.stringify(existing) !== JSON.stringify(rewritten)) {
        await fs.ensureDir(versionDir);
        await fs.writeJson(versionJsonPath, rewritten, { spaces: 2 });
      }
      return versionJsonPath;
    } catch (err) {
      console.warn(`[mclc] Failed to reuse version metadata at ${versionJsonPath}:`, err);
    }
  }

  const metaBase = trimTrailingSlashes(overrides.url.meta);
  const manifestUrl = `${metaBase}/mc/game/version_manifest.json`;
  const manifest = await fetchJsonFromMirror(manifestUrl, 'Minecraft version manifest');
  const entry = Array.isArray(manifest?.versions)
    ? manifest.versions.find((item) => item && String(item.id) === String(versionNumber))
    : null;

  if (!entry || !entry.url) {
    throw new Error(`Version "${versionNumber}" is missing in manifest from ${manifestUrl}`);
  }

  const versionUrl = replaceUrlBase(entry.url, metaBase);
  const versionJson = await fetchJsonFromMirror(versionUrl, `Minecraft version ${versionNumber} metadata`);
  const rewrittenJson = rewriteVersionJsonForMirror(versionJson, overrides);

  await fs.ensureDir(versionDir);
  await fs.writeJson(versionJsonPath, rewrittenJson, { spaces: 2 });
  return versionJsonPath;
};

const ensureForgeVersionJsonForMirror = async (gameRoot, forgeVersion, overrides) => {
  if (!gameRoot || !forgeVersion || !overrides || !overrides.url) return null;

  const baseVersion = typeof forgeVersion === 'string'
    ? (forgeVersion.split('-forge')[0] || forgeVersion)
    : '1.12.2';
  const forgeDir = path.join(gameRoot, 'forge', baseVersion);
  const forgeJsonPath = path.join(forgeDir, 'version.json');

  if (!await fs.pathExists(forgeJsonPath)) {
    return null;
  }

  try {
    const existing = await fs.readJson(forgeJsonPath);
    const rewritten = rewriteForgeVersionJsonForMirror(existing, overrides);
    if (JSON.stringify(existing) !== JSON.stringify(rewritten)) {
      await fs.writeJson(forgeJsonPath, rewritten, { spaces: 2 });
    }
    return forgeJsonPath;
  } catch (err) {
    console.warn(`[mclc] Failed to rewrite Forge version metadata at ${forgeJsonPath}:`, err);
    return null;
  }
};

const DEFAULT_RELATIVE_ROOT = config.GAME_ROOT && !path.isAbsolute(config.GAME_ROOT)
  ? config.GAME_ROOT
  : 'runtime';

const computeBaseGameRoot = () => {
  if (config.GAME_ROOT && path.isAbsolute(config.GAME_ROOT)) {
    return config.GAME_ROOT;
  }

  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR, DEFAULT_RELATIVE_ROOT);
  }

  if (app.isPackaged) {
    return path.resolve(app.getPath('userData'), DEFAULT_RELATIVE_ROOT);
  }

  return path.resolve(__dirname, DEFAULT_RELATIVE_ROOT);
};

let BASE_GAME_ROOT = computeBaseGameRoot();
let USER_SETTINGS_PATH = path.join(BASE_GAME_ROOT, 'user-settings.json');
let FORGE_DIR = path.join(BASE_GAME_ROOT, 'forge');

const DEFAULT_RAM = Number(config.DEFAULT_RAM_MB) || 2048;
const DEFAULT_MIN_RAM = Number(config.MIN_RAM_MB) || 1024;
const CLEAN_JAVA_ARGS = (config.JAVA_ARGS || []).filter(arg => !/^(-Xmx|-Xms)/i.test(String(arg)));

const toUpperKeys = (github = {}) => ({
  OWNER: github.OWNER || github.owner,
  REPO: github.REPO || github.repo,
  BRANCH: github.BRANCH || github.branch || 'main',
  SUBDIR: github.SUBDIR || github.subdir || ''
});

const shaderpacksRepoConfig = toUpperKeys(config.SHADERPACKS_GITHUB || {});
const resourcepacksRepoConfig = toUpperKeys(config.RESOURCEPACKS_GITHUB || {});

const slugify = (value, fallback) => {
  const base = String(value || fallback || 'modpack')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'modpack';
};

const rawModpacks = Array.isArray(config.MODPACKS) && config.MODPACKS.length
  ? config.MODPACKS
  : [{
      id: 'default',
      name: config.MODPACK_NAME || 'Основной модпак',
      description: config.MODPACK_DESCRIPTION || 'Forge 1.12.2 с синхронизацией модов.',
      icon: config.MODPACK_ICON || null,
      forgeVersion: config.FORGE_VERSION,
      github: config.GITHUB
    }];

const modpacks = rawModpacks.map((entry, index) => {
  const id = String(entry.id || `modpack-${index + 1}`);
  const github = toUpperKeys(entry.github || config.GITHUB || {});
  return {
    id,
    slug: slugify(entry.folder || entry.id || entry.name || id, `modpack-${index + 1}`),
    name: entry.name || `Модпак ${index + 1}`,
    description: entry.description || '',
    icon: entry.icon || null,
    tags: entry.tags || [],
    forgeVersion: entry.forgeVersion || config.FORGE_VERSION,
    github,
    gameRoot: entry.gameRoot || null
  };
});

const toPositiveInteger = (value) => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
};

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
};

const rawAuthConfig = config.AUTH;
const authConfig = (() => {
  if (!rawAuthConfig) return null;
  const baseUrl = normalizeBaseUrl(rawAuthConfig.baseUrl);
  if (!baseUrl) return null;
  const provider = rawAuthConfig.provider || 'authlib-injector';
  const allowRegistration = toBoolean(rawAuthConfig.allowRegistration, false);
  const domain = typeof rawAuthConfig.domain === 'string' ? rawAuthConfig.domain.trim() || null : null;
  const injectorRaw = rawAuthConfig.authlibInjector || {};
  const downloadUrl = typeof injectorRaw.downloadUrl === 'string' ? injectorRaw.downloadUrl.trim() || null : null;
  const version = injectorRaw.version ? String(injectorRaw.version) : null;
  const sha256 = typeof injectorRaw.sha256 === 'string' ? injectorRaw.sha256.trim() || null : null;

  return {
    provider,
    baseUrl,
    allowRegistration,
    domain,
    authlibInjector: downloadUrl ? { downloadUrl, version, sha256 } : null
  };
})();

const authEndpoints = authConfig ? {
  baseUrl: authConfig.baseUrl,
  authServer: `${authConfig.baseUrl}/auth`,
  accountServer: `${authConfig.baseUrl}/account`,
  sessionServer: `${authConfig.baseUrl}/session`,
  servicesServer: `${authConfig.baseUrl}/services`,
  injectorMeta: `${authConfig.baseUrl}/authlib-injector/meta`
} : null;

const resolveRefreshIntervalMs = (entry = {}) => {
  const directMs = toPositiveInteger(entry.refreshIntervalMs || entry.refreshMs);
  if (directMs) return Math.max(MIN_REFRESH_INTERVAL_MS, directMs);

  const seconds = toPositiveInteger(entry.refreshIntervalSeconds || entry.refreshSeconds || entry.refreshInterval);
  if (seconds) return Math.max(MIN_REFRESH_INTERVAL_MS, seconds * 1000);

  const configMs = toPositiveInteger(config.SERVER_REFRESH_MS);
  if (configMs) return Math.max(MIN_REFRESH_INTERVAL_MS, configMs);

  const configSeconds = toPositiveInteger(config.SERVER_REFRESH_SECONDS);
  if (configSeconds) return Math.max(MIN_REFRESH_INTERVAL_MS, configSeconds * 1000);

  return 60000;
};

const displayServerAddress = (server) => (server.port ? `${server.address}:${server.port}` : server.address);

const createClientToken = () => crypto.randomBytes(16).toString('hex');

const sanitizeProfile = (profile) => {
  if (!profile || typeof profile !== 'object') return null;
  const id = profile.id || profile.uuid || profile.playerId || profile.playerUUID;
  const name = profile.name || profile.playerName || profile.displayName;
  if (!id || !name) return null;
  return { id: String(id), name: String(name) };
};

const sanitizePropertiesArray = (properties) => {
  if (!Array.isArray(properties)) return [];
  return properties
    .filter(prop => prop && prop.name !== undefined && prop.name !== null)
    .map(prop => ({
      name: String(prop.name),
      value: prop.value !== undefined && prop.value !== null ? String(prop.value) : ''
    }));
};

const normalizeAuthSnapshot = (raw = {}, overrides = {}) => {
  const fallbackProvider = overrides.provider !== undefined
    ? overrides.provider
    : (authConfig ? authConfig.provider : null);
  const fallbackBaseUrl = overrides.baseUrl !== undefined
    ? overrides.baseUrl
    : (authConfig ? authConfig.baseUrl : null);
  const fallbackAllowRegistration = overrides.allowRegistration !== undefined
    ? overrides.allowRegistration
    : (authConfig ? authConfig.allowRegistration : false);

  const clientToken = typeof raw.clientToken === 'string' && raw.clientToken.trim()
    ? raw.clientToken.trim()
    : createClientToken();

  const selectedProfile = sanitizeProfile(raw.selectedProfile || raw.profile || raw.selected_profile);
  const availableProfilesRaw = raw.availableProfiles || raw.available_profiles || [];
  const availableProfiles = Array.isArray(availableProfilesRaw)
    ? availableProfilesRaw.map(sanitizeProfile).filter(Boolean)
    : [];

  const dedupedProfiles = [];
  const seenProfileIds = new Set();
  if (selectedProfile && selectedProfile.id) {
    dedupedProfiles.push(selectedProfile);
    seenProfileIds.add(selectedProfile.id);
  }
  for (const profile of availableProfiles) {
    if (profile && profile.id && !seenProfileIds.has(profile.id)) {
      dedupedProfiles.push(profile);
      seenProfileIds.add(profile.id);
    }
  }

  const normalizedBaseUrl = normalizeBaseUrl(raw.baseUrl || raw.serverBaseUrl || fallbackBaseUrl);

  return {
    provider: raw.provider || fallbackProvider,
    baseUrl: normalizedBaseUrl,
    allowRegistration: raw.allowRegistration !== undefined
      ? toBoolean(raw.allowRegistration, fallbackAllowRegistration)
      : fallbackAllowRegistration,
    clientToken,
    accessToken: typeof raw.accessToken === 'string' && raw.accessToken.trim() ? raw.accessToken.trim() : null,
    refreshToken: typeof raw.refreshToken === 'string' && raw.refreshToken.trim() ? raw.refreshToken.trim() : null,
    selectedProfile,
    availableProfiles: dedupedProfiles,
    user: raw.user ? {
      ...raw.user,
      properties: sanitizePropertiesArray(raw.user.properties)
    } : null,
    minecraftToken: typeof raw.minecraftToken === 'string' && raw.minecraftToken.trim() ? raw.minecraftToken.trim() : null,
    lastAuthAt: typeof raw.lastAuthAt === 'number' && Number.isFinite(raw.lastAuthAt) ? raw.lastAuthAt : null,
    tokenExpiresAt: typeof raw.tokenExpiresAt === 'number' && Number.isFinite(raw.tokenExpiresAt) ? raw.tokenExpiresAt : null
  };
};

const normalizeCommand = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
};

const normalizeRconConfig = (entry, fallbackAddress, fallbackPort) => {
  if (!entry || typeof entry !== 'object') return null;
  const password = entry.password || entry.pass;
  if (!password) return null;

  const host = String(entry.host || entry.hostname || fallbackAddress || '').trim();
  const port = toPositiveInteger(entry.port || entry.rconPort) || 25575;
  const timeoutMs = Math.max(1000, toPositiveInteger(entry.timeoutMs || entry.timeout) || 5000);
  const rawListCommand = entry.listCommand ?? entry.commands?.list;
  const rawTpsCommand = entry.tpsCommand ?? entry.commands?.tps;
  const listCommand = normalizeCommand(rawListCommand, 'list');
  const tpsCommand = rawTpsCommand === null || rawTpsCommand === false
    ? null
    : normalizeCommand(rawTpsCommand, 'tps');

  return {
    host: host || fallbackAddress,
    port,
    password: String(password),
    timeoutMs,
    listCommand,
    tpsCommand
  };
};

const resolveStatusApi = (entry) => {
  if (entry.statusApi === null || entry.statusApi === false) return null;
  const direct = typeof entry.statusApi === 'string' ? entry.statusApi.trim() : '';
  if (direct) return direct;
  const alt = typeof entry.api === 'string' ? entry.api.trim() : '';
  if (alt) return alt;
  return DEFAULT_STATUS_API;
};

const rawServers = Array.isArray(config.SERVERS) ? config.SERVERS : [];
const servers = rawServers
  .map((entry, index) => {
    const address = String(entry.address || entry.host || '').trim();
    if (!address) return null;

    const port = toPositiveInteger(entry.port) || null;
    const statusApi = resolveStatusApi(entry);
    const rcon = normalizeRconConfig(entry.rcon, address, port);
    const icon = typeof entry.icon === 'string' ? entry.icon.trim() || null : null;

    return {
      id: String(entry.id || `server-${index + 1}`),
      name: entry.name || entry.label || `Server ${index + 1}`,
      address,
      port,
      statusApi,
      refreshIntervalMs: resolveRefreshIntervalMs(entry),
      rcon,
      acceptTextures: toBoolean(entry.acceptTextures, true),
      hideAddress: toBoolean(entry.hideAddress, false),
      icon
    };
  })
  .filter(Boolean);

const getServerById = (id) => servers.find((server) => server.id === id) || null;

const normalizeServerForDat = (server) => {
  const ip = displayServerAddress(server);
  if (!ip) return null;
  return {
    ip,
    name: server.name,
    hideAddress: toBoolean(server.hideAddress, false),
    acceptTextures: toBoolean(server.acceptTextures, true),
    icon: typeof server.icon === 'string' && server.icon ? server.icon : null
  };
};

const buildServersDatEntry = (server) => {
  const entry = {
    name: { type: 'string', value: server.name },
    ip: { type: 'string', value: server.ip },
    hideAddress: { type: 'byte', value: server.hideAddress ? 1 : 0 },
    acceptTextures: { type: 'byte', value: server.acceptTextures ? 1 : 0 }
  };

  if (server.icon) {
    entry.icon = { type: 'string', value: server.icon };
  }

  return entry;
};

const applyConfigServersToDat = (existingEntries, configByIp) => {
  const finalEntries = [];

  for (const entry of existingEntries) {
    const ipTag = entry?.ip;
    const ip = ipTag && typeof ipTag.value === 'string' ? ipTag.value : null;
    if (!ip) {
      finalEntries.push(entry);
      continue;
    }

    const override = configByIp.get(ip);
    if (override) {
      entry.name = { type: 'string', value: override.name };
      entry.ip = { type: 'string', value: override.ip };
      entry.hideAddress = { type: 'byte', value: override.hideAddress ? 1 : 0 };
      entry.acceptTextures = { type: 'byte', value: override.acceptTextures ? 1 : 0 };
      if (override.icon) {
        entry.icon = { type: 'string', value: override.icon };
      } else {
        delete entry.icon;
      }
      configByIp.delete(ip);
    }

    finalEntries.push(entry);
  }

  for (const remaining of configByIp.values()) {
    finalEntries.push(buildServersDatEntry(remaining));
  }

  return finalEntries;
};

const syncServersDat = async (gameRoot, serverList) => {
  if (!gameRoot || !Array.isArray(serverList)) return null;

  const normalized = serverList
    .map(normalizeServerForDat)
    .filter((entry) => entry && entry.ip && entry.name);

  if (!normalized.length) return null;

  const serversDatPath = path.join(gameRoot, 'servers.dat');
  const configByIp = new Map(normalized.map((entry) => [entry.ip, entry]));

  let existingBuffer = null;
  let existingEntries = [];

  try {
    existingBuffer = await fs.readFile(serversDatPath);
    const parsed = await nbt.parse(existingBuffer);
    const rawEntries = parsed?.parsed?.value?.servers?.value?.value;
    if (Array.isArray(rawEntries)) {
      existingEntries = rawEntries.map((entry) => ({ ...entry }));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[servers.dat] Failed to read existing file at ${serversDatPath}:`, err);
    }
  }

  const finalEntries = applyConfigServersToDat(existingEntries, configByIp);
  const payload = {
    type: 'compound',
    name: '',
    value: {
      servers: {
        type: 'list',
        value: {
          type: 'compound',
          value: finalEntries
        }
      }
    }
  };

  const buffer = nbt.writeUncompressed(payload);
  if (existingBuffer && existingBuffer.equals(buffer)) {
    return serversDatPath;
  }

  try {
    await fs.ensureDir(path.dirname(serversDatPath));
    await fs.writeFile(serversDatPath, buffer);
    return serversDatPath;
  } catch (err) {
    console.warn(`[servers.dat] Failed to write file at ${serversDatPath}:`, err);
    return null;
  }
};

const usePerModpackRoots = Array.isArray(config.MODPACKS) && config.MODPACKS.length > 0;

const deriveBaseVersion = (forgeVersion) => {
  if (typeof forgeVersion !== 'string') return '1.12.2';
  const [base] = forgeVersion.split('-forge');
  return base || forgeVersion;
};

const ensurePath = async (dir) => {
  await fs.ensureDir(dir);
  return dir;
};

const normalizeSettings = (settings = {}) => {
  const sanitized = {
    nickname: String(settings.nickname || config.DEFAULT_NICKNAME || 'Player').slice(0, 32),
    ramMb: Number(settings.ramMb) || DEFAULT_RAM,
    selectedModpack: settings.selectedModpack || config.ACTIVE_MODPACK || modpacks[0].id,
    auth: normalizeAuthSnapshot(settings.auth || {}, {
      provider: authConfig ? authConfig.provider : undefined,
      baseUrl: authConfig ? authConfig.baseUrl : undefined,
      allowRegistration: authConfig ? authConfig.allowRegistration : undefined
    })
  };

  sanitized.ramMb = Math.max(DEFAULT_MIN_RAM, Math.min(65536, sanitized.ramMb));

  if (!modpacks.find(m => m.id === sanitized.selectedModpack)) {
    sanitized.selectedModpack = modpacks[0].id;
  }

  return sanitized;
};

const loadUserSettings = () => {
  try {
    const stored = fs.readJsonSync(USER_SETTINGS_PATH);
    return normalizeSettings(stored);
  } catch (err) {
    return normalizeSettings();
  }
};

let userSettings = loadUserSettings();

const ensureAuthState = () => {
  const previous = userSettings.auth || {};
  const prevBaseUrl = previous.baseUrl || null;
  let normalized = normalizeAuthSnapshot(previous, {
    provider: authConfig ? authConfig.provider : undefined,
    baseUrl: authConfig ? authConfig.baseUrl : undefined,
    allowRegistration: authConfig ? authConfig.allowRegistration : undefined
  });

  if (authConfig) {
    const baseChanged = prevBaseUrl && prevBaseUrl !== authConfig.baseUrl;
    normalized.provider = authConfig.provider || normalized.provider || 'authlib-injector';
    normalized.allowRegistration = authConfig.allowRegistration;
    normalized.baseUrl = authConfig.baseUrl;
    if (baseChanged) {
      normalized = {
        ...normalized,
        accessToken: null,
        refreshToken: null,
        selectedProfile: null,
        availableProfiles: [],
        user: null,
        minecraftToken: null,
        lastAuthAt: null,
        tokenExpiresAt: null
      };
    }
  }

  userSettings.auth = normalized;
  return userSettings.auth;
};

const formatUserPropertiesJson = (properties) => {
  if (!Array.isArray(properties) || !properties.length) return '{}';
  const aggregated = {};
  for (const entry of properties) {
    if (!entry || !entry.name) continue;
    const key = String(entry.name);
    const val = entry.value !== undefined && entry.value !== null ? String(entry.value) : '';
    if (!aggregated[key]) {
      aggregated[key] = [val];
    } else {
      aggregated[key].push(val);
    }
  }
  return JSON.stringify(aggregated);
};

const serializeAuthState = () => {
  const state = ensureAuthState();
  const primaryProfile = state.selectedProfile || state.availableProfiles[0] || null;
  const status = authConfig
    ? (state.accessToken && primaryProfile ? 'authenticated' : 'unauthenticated')
    : 'disabled';

  const minimalUser = state.user ? {
    id: state.user.id || null,
    username: state.user.username || null,
    isAdmin: typeof state.user.isAdmin === 'boolean' ? state.user.isAdmin : undefined,
    maxPlayerCount: state.user.maxPlayerCount !== undefined ? state.user.maxPlayerCount : undefined
  } : null;

  return {
    provider: state.provider,
    baseUrl: state.baseUrl,
    domain: authConfig ? authConfig.domain : null,
    allowRegistration: state.allowRegistration,
    status,
    hasSession: Boolean(state.accessToken && primaryProfile),
    selectedProfile: primaryProfile,
    availableProfiles: state.availableProfiles,
    user: minimalUser,
    lastAuthAt: state.lastAuthAt,
    tokenExpiresAt: state.tokenExpiresAt
  };
};

const applyAuthResponse = async (authResponse = {}, extras = {}) => {
  if (!authResponse) return serializeAuthState();
  const state = ensureAuthState();

  const selectedProfile = sanitizeProfile(
    authResponse.selectedProfile ||
    authResponse.selected_profile ||
    authResponse.profile
  );
  const availableProfilesRaw = authResponse.availableProfiles || authResponse.available_profiles;
  const availableProfiles = Array.isArray(availableProfilesRaw)
    ? availableProfilesRaw.map(sanitizeProfile).filter(Boolean)
    : [];

  const dedupedProfiles = [];
  const seen = new Set();
  if (selectedProfile && selectedProfile.id) {
    dedupedProfiles.push(selectedProfile);
    seen.add(selectedProfile.id);
  }
  for (const profile of availableProfiles) {
    if (profile && profile.id && !seen.has(profile.id)) {
      dedupedProfiles.push(profile);
      seen.add(profile.id);
    }
  }

  state.clientToken = authResponse.clientToken || authResponse.client_token || state.clientToken || createClientToken();
  state.accessToken = authResponse.accessToken || authResponse.access_token || state.accessToken;
  state.refreshToken = authResponse.refreshToken || authResponse.refresh_token || null;
  state.selectedProfile = selectedProfile || state.selectedProfile || null;
  const profilesList = dedupedProfiles.length ? dedupedProfiles : state.availableProfiles;
  state.availableProfiles = profilesList;
  if (!state.selectedProfile && profilesList.length) {
    state.selectedProfile = profilesList[0];
  }
  state.user = authResponse.user ? {
    ...authResponse.user,
    properties: sanitizePropertiesArray(authResponse.user.properties)
  } : state.user;
  state.minecraftToken = authResponse.minecraftToken || authResponse.minecraft_token || state.minecraftToken || null;
  state.lastAuthAt = Date.now();

  if (authResponse.expiresIn) {
    const expiresInMs = Number(authResponse.expiresIn) * 1000;
    state.tokenExpiresAt = Number.isFinite(expiresInMs) ? Date.now() + expiresInMs : null;
  } else if (authResponse.expiresAt) {
    const parsed = Date.parse(authResponse.expiresAt);
    state.tokenExpiresAt = Number.isFinite(parsed) ? parsed : null;
  } else {
    state.tokenExpiresAt = state.tokenExpiresAt || null;
  }

  if (extras.baseUrl) {
    state.baseUrl = normalizeBaseUrl(extras.baseUrl) || state.baseUrl;
  }
  if (extras.provider) {
    state.provider = extras.provider;
  }
  if (typeof extras.allowRegistration === 'boolean') {
    state.allowRegistration = extras.allowRegistration;
  }

  if (state.selectedProfile && state.selectedProfile.name) {
    userSettings.nickname = state.selectedProfile.name;
  }

  await persistUserSettings();
  return serializeAuthState();
};

const clearAuthState = async () => {
  const state = ensureAuthState();
  state.accessToken = null;
  state.refreshToken = null;
  state.selectedProfile = null;
  state.availableProfiles = [];
  state.user = null;
  state.minecraftToken = null;
  state.lastAuthAt = null;
  state.tokenExpiresAt = null;
  await persistUserSettings();
  return serializeAuthState();
};

const persistUserSettings = async () => {
  ensureAuthState();
  await fs.ensureDir(path.dirname(USER_SETTINGS_PATH));
  await fs.writeJson(USER_SETTINGS_PATH, userSettings, { spaces: 2 });
};

const getClientToken = () => {
  const state = ensureAuthState();
  if (state.clientToken) return state.clientToken;
  state.clientToken = createClientToken();
  return state.clientToken;
};

let cachedAuthlibInjectorPath = null;

const getModpackById = (id) => modpacks.find(mp => mp.id === id) || modpacks[0];

let activeModpackId = userSettings.selectedModpack;
let activeModpack = getModpackById(activeModpackId);

const resolveModpackPaths = (modpack) => {
  let gameRoot;
  if (!usePerModpackRoots) {
    gameRoot = BASE_GAME_ROOT;
  } else {
    const customPath = modpack.gameRoot;
    gameRoot = customPath
      ? (path.isAbsolute(customPath) ? customPath : path.join(BASE_GAME_ROOT, customPath))
      : path.join(BASE_GAME_ROOT, 'profiles', modpack.slug);
  }

  return {
    gameRoot,
    modsDir: path.join(gameRoot, 'mods'),
    shaderpacksDir: path.join(gameRoot, 'shaderpacks'),
    resourcepacksDir: path.join(gameRoot, 'resourcepacks')
  };
};

let activePaths = resolveModpackPaths(activeModpack);

const updateActiveModpack = async (modpackId) => {
  activeModpackId = modpackId;
  activeModpack = getModpackById(modpackId);
  activePaths = resolveModpackPaths(activeModpack);
  userSettings.selectedModpack = activeModpack.id;
  await ensurePath(activePaths.modsDir);
  await ensurePath(activePaths.shaderpacksDir);
  await ensurePath(activePaths.resourcepacksDir);
  await syncServersDat(activePaths.gameRoot, servers);
  await persistUserSettings();
};

const clampRam = (value) => Math.max(DEFAULT_MIN_RAM, Math.min(65536, Number(value) || DEFAULT_RAM));

const updateUserSettings = async (patch = {}) => {
  if (patch.nickname !== undefined) {
    userSettings.nickname = String(patch.nickname || '').slice(0, 32) || 'Player';
  }
  if (patch.ramMb !== undefined) {
    userSettings.ramMb = clampRam(patch.ramMb);
  }
  if (patch.selectedModpack !== undefined && modpacks.find(m => m.id === patch.selectedModpack)) {
    await updateActiveModpack(patch.selectedModpack);
  }
  await persistUserSettings();
  return userSettings;
};

const serializeSettings = () => {
  const { auth, ...rest } = userSettings;
  const safe = JSON.parse(JSON.stringify(rest));
  safe.auth = serializeAuthState();
  return safe;
};
const serializeModpacks = () => modpacks.map(mp => ({
  id: mp.id,
  name: mp.name,
  description: mp.description,
  icon: mp.icon,
  tags: mp.tags,
  forgeVersion: mp.forgeVersion
}));

const serializeServers = () => servers.map(server => ({
  id: server.id,
  name: server.name,
  address: server.address,
  port: server.port,
  displayAddress: displayServerAddress(server),
  refreshIntervalMs: server.refreshIntervalMs,
  hasRcon: Boolean(server.rcon),
  hasStatusApi: Boolean(server.statusApi)
}));

const mapServerStatusPayload = (payload = {}) => {
  const toFiniteNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const online = Boolean(payload.online);
  const playersOnline = toFiniteNumber(payload.players?.online);
  const playersMax = toFiniteNumber(payload.players?.max);
  const latency = toFiniteNumber(payload.latency ?? payload.ping ?? payload.response_time ?? payload.duration ?? payload.ms);
  const icon = typeof payload.icon === 'string' && payload.icon.length ? payload.icon : null;

  const motdClean = Array.isArray(payload.motd?.clean)
    ? payload.motd.clean.join('\n')
    : (typeof payload.motd?.clean === 'string' ? payload.motd.clean : null);

  const motdRaw = Array.isArray(payload.motd?.raw)
    ? payload.motd.raw.join('\n')
    : (typeof payload.motd?.raw === 'string' ? payload.motd.raw : null);

  const versionName = payload.version?.name_clean || payload.version?.name || payload.version?.name_raw || null;

  const samplePlayers = Array.isArray(payload.players?.list)
    ? payload.players.list
        .map((entry) => {
          if (!entry) return null;
          if (typeof entry === 'string') return entry;
          return entry.name_clean || entry.name || entry.name_raw || null;
        })
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const tpsRaw = payload.performance?.tps ?? payload.tps ?? payload.debug?.tps ?? null;
  const tpsCandidate = Array.isArray(tpsRaw)
    ? tpsRaw.find((entry) => Number.isFinite(Number(entry)))
    : tpsRaw;
  const tps = toFiniteNumber(tpsCandidate);

  return {
    online,
    playersOnline: playersOnline ?? (online ? 0 : null),
    playersMax: playersMax ?? null,
    latencyMs: latency,
    motd: motdClean || motdRaw || null,
    version: versionName,
    samplePlayers,
    tps,
    icon,
    fetchedAt: Date.now()
  };
};

const fetchServerStatusViaHttp = async (server) => {
  if (!server.statusApi) {
    throw new Error('HTTP status API is not configured for this server.');
  }

  const apiBase = server.statusApi.replace(/\/+$/, '');
  const encodedHost = encodeURIComponent(server.address);
  const targetUrl = server.port
    ? `${apiBase}/${encodedHost}:${server.port}`
    : `${apiBase}/${encodedHost}`;

  const res = await fetch(targetUrl);
  if (!res.ok) {
    throw new Error(`Status request failed (${res.status} ${res.statusText})`);
  }

  const payload = await res.json();
  return mapServerStatusPayload(payload);
};

const stripMinecraftColorCodes = (value = '') => value.replace(/\u00A7[0-9A-FK-OR]/gi, '');

const parsePlayerListResponse = (raw) => {
  const cleaned = stripMinecraftColorCodes(String(raw ?? '')).replace(/\r?\n/g, ' ').trim();
  if (!cleaned) {
    return { online: null, max: null, players: [] };
  }

  const noPlayersTokens = [
    'no players',
    'none',
    'not connected',
    'нет игроков',
    'игроков нет',
    'никого'
  ];
  const hasNoPlayersToken = noPlayersTokens.some(token => cleaned.toLowerCase().includes(token));

  const countsMatch =
    cleaned.match(/(\d+)\s*(?:of\s+(?:a\s+)?max(?:imum)?\s+of|of|\/)\s*(\d+)/i) ||
    cleaned.match(/Players\s*\((\d+)\s*\/\s*(\d+)\)/i) ||
    cleaned.match(/(\d+)\s*(?:из|\/)\s*(\d+)/i);

  let online = countsMatch ? Number(countsMatch[1]) : null;
  let max = countsMatch ? Number(countsMatch[2]) : null;

  const numericTokens = cleaned.match(/\d+/g)?.map(Number).filter(Number.isFinite) || [];
  if (online === null) {
    if (numericTokens.length >= 2) {
      [online, max] = numericTokens;
    } else if (numericTokens.length === 1) {
      online = numericTokens[0];
    }
  } else if (max === null && numericTokens.length >= 2) {
    max = numericTokens[1];
  }

  if (hasNoPlayersToken && (online === null || online > 0)) {
    online = 0;
  }

  const listSection = cleaned.includes(':') ? cleaned.split(':').slice(1).join(':').trim() : '';
  const players = listSection
    ? listSection
        .split(/[,;]\s*/)
        .map(name => stripMinecraftColorCodes(name).trim())
        .filter((name) => Boolean(name) && !/^\d+(?:\s*\/\s*\d+)?$/.test(name))
    : [];

  if ((online === null || online === undefined) && players.length) {
    online = players.length;
  }
  if (online === null && hasNoPlayersToken) {
    online = 0;
  }

  return {
    online: Number.isFinite(online) ? online : (hasNoPlayersToken ? 0 : null),
    max: Number.isFinite(max) ? max : null,
    players
  };
};

const parseTpsResponse = (raw) => {
  const cleaned = stripMinecraftColorCodes(String(raw ?? '').trim());
  if (!cleaned) return null;
  const normalized = cleaned.replace(/,/g, '.'); // support locales that use comma as decimal separator
  const matches = normalized.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || !matches.length) return null;
  const numbers = matches
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  const candidate = numbers.find((value) => value > 0) ?? numbers[0];
  if (!Number.isFinite(candidate)) return null;
  return Math.max(0, Math.min(candidate, 20));
};

const fetchServerStatusViaRcon = async (server) => {
  if (!server.rcon) {
    throw new Error('RCON is not configured for this server.');
  }

  const { host, port, password, timeoutMs, listCommand, tpsCommand } = server.rcon;
  let rcon;
  try {
    rcon = await Rcon.connect({ host, port, password, timeout: timeoutMs });
  } catch (err) {
    throw new Error(`RCON connection failed: ${err?.message || err}`);
  }

  try {
    const listStart = Date.now();
    const listRaw = await rcon.send(listCommand || 'list');
    const latency = Date.now() - listStart;

    let tps = null;
    if (tpsCommand) {
      try {
        const tpsRaw = await rcon.send(tpsCommand);
        tps = parseTpsResponse(tpsRaw);
      } catch (err) {
        console.warn(`[server:status] TPS command failed for ${server.id}:`, err);
      }
    }

    const listInfo = parsePlayerListResponse(listRaw);

    return {
      online: true,
      playersOnline: Number.isFinite(listInfo.online) ? listInfo.online : null,
      playersMax: Number.isFinite(listInfo.max) ? listInfo.max : null,
      samplePlayers: listInfo.players.slice(0, 12),
      tps,
      latencyMs: latency,
      motd: null,
      version: null,
      icon: null,
      fetchedAt: Date.now()
    };
  } finally {
    try {
      if (rcon) {
        await rcon.end();
      }
    } catch (err) {
      console.warn(`[server:status] Failed to close RCON connection for ${server.id}:`, err);
    }
  }
};

const fetchServerStatus = async (server) => {
  if (server.rcon) {
    return fetchServerStatusViaRcon(server);
  }
  if (server.statusApi) {
    return fetchServerStatusViaHttp(server);
  }
  throw new Error('No status provider configured for this server.');
};

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    resizable: true,
    minWidth: 1024,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

app.whenReady().then(async () => {
  await ensurePath(BASE_GAME_ROOT);
  await ensurePath(activePaths.modsDir);
  await ensurePath(activePaths.shaderpacksDir);
  await ensurePath(activePaths.resourcepacksDir);
  await ensurePath(FORGE_DIR);
  await syncServersDat(activePaths.gameRoot, servers);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

const downloadGithubRepoZip = async ({ owner, repo, branch, tempPrefix }) => {
  if (!owner || !repo) {
    throw new Error('GitHub repository information is incomplete.');
  }

  const branchCandidates = [];
  if (Array.isArray(branch)) {
    branchCandidates.push(...branch.filter(Boolean));
  } else if (branch) {
    branchCandidates.push(branch);
  }
  if (!branchCandidates.length) {
    branchCandidates.push('main');
  }
  if (!branchCandidates.includes('main')) {
    branchCandidates.push('main');
  }
  if (!branchCandidates.includes('master')) {
    branchCandidates.push('master');
  }
  const uniqueBranches = [...new Set(branchCandidates)];
  let lastError = null;

  for (const candidate of uniqueBranches) {
    const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${candidate}`;
    const tmpZip = path.join(os.tmpdir(), `${tempPrefix || `${repo}-archive`}-${candidate}-${Date.now()}.zip`);
    try {
      const res = await fetch(zipUrl);
      if (!res.ok || !res.body) {
        const statusText = res.statusText ? ` ${res.statusText}` : '';
        throw new Error(`HTTP ${res.status}${statusText}`);
      }
      const stream = fs.createWriteStream(tmpZip);
      await pipeline(res.body, stream);
      return { zipPath: tmpZip, branch: candidate };
    } catch (err) {
      lastError = err;
      if (await fs.pathExists(tmpZip)) {
        await fs.remove(tmpZip);
      }
    }
  }

  throw new Error(`GitHub ZIP fetch failed: ${lastError?.message || 'Unknown error'}`);
};

const collectFilesByExtensions = async (dir, extensions) => {
  const entries = await fs.readdir(dir);
  const matches = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const nested = await collectFilesByExtensions(fullPath, extensions);
      matches.push(...nested);
    } else {
      const lowerName = entry.toLowerCase();
      if (extensions.some((ext) => lowerName.endsWith(ext))) {
        matches.push(fullPath);
      }
    }
  }
  return matches;
};

const syncArchivesFromZip = async (zipPath, targetDir, options = {}) => {
  const tempDir = path.join(os.tmpdir(), `${options.tempPrefix || 'gh-repo'}-${Date.now()}`);
  await fs.ensureDir(tempDir);

  const extensions = Array.isArray(options.extensions) && options.extensions.length
    ? options.extensions.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`))
    : ['.zip'];

  try {
    await extract(zipPath, { dir: tempDir });
    const candidates = await fs.readdir(tempDir);
    let repoRoot = null;
    for (const candidate of candidates) {
      const fullPath = path.join(tempDir, candidate);
      if ((await fs.stat(fullPath)).isDirectory()) {
        repoRoot = fullPath;
        break;
      }
    }
    if (!repoRoot) {
      throw new Error('Unexpected GitHub archive structure.');
    }

    const files = await collectFilesByExtensions(repoRoot, extensions);
    if (!files.length) {
      const kindLabel = options.kind || 'matching';
      throw new Error(`No ${kindLabel} files found in repository archive.`);
    }

    await fs.ensureDir(targetDir);
    const copied = [];
    for (const sourcePath of files) {
      const fileName = path.basename(sourcePath);
      await fs.copy(sourcePath, path.join(targetDir, fileName), { overwrite: true });
      copied.push(fileName);
    }

    let deleted = 0;
    if (options.deleteExtra) {
      const copiedSet = new Set(copied.map((name) => name.toLowerCase()));
      const existing = await fs.readdir(targetDir);
      const toDelete = existing.filter((name) => {
        const lower = name.toLowerCase();
        if (!extensions.some((ext) => lower.endsWith(ext))) {
          return false;
        }
        return !copiedSet.has(lower);
      });
      for (const name of toDelete) {
        await fs.remove(path.join(targetDir, name));
        deleted += 1;
      }
    }

    return { copied, copiedCount: copied.length, deleted };
  } finally {
    await fs.remove(tempDir);
  }
};

const syncPackArchivesFromRepo = async (repoConfig, targetDir, options = {}) => {
  if (!repoConfig || !repoConfig.OWNER || !repoConfig.REPO) {
    throw new Error(options.missingMessage || 'GitHub repository is not configured.');
  }
  await ensurePath(targetDir);
  const { zipPath } = await downloadGithubRepoZip({
    owner: repoConfig.OWNER,
    repo: repoConfig.REPO,
    branch: repoConfig.BRANCH,
    tempPrefix: options.tempPrefix || repoConfig.REPO
  });
  try {
    return await syncArchivesFromZip(zipPath, targetDir, options);
  } finally {
    await fs.remove(zipPath);
  }
};

const downloadModsZip = async (modpack) => {
  const repo = toUpperKeys(modpack.github || {});
  if (!repo.OWNER || !repo.REPO) {
    throw new Error(`GitHub ??????? ?? ?????? ??? ??????? "${modpack.name}"`);
  }

  const { zipPath } = await downloadGithubRepoZip({
    owner: repo.OWNER,
    repo: repo.REPO,
    branch: repo.BRANCH,
    tempPrefix: `modpack-${modpack.id || repo.REPO}`
  });

  return zipPath;
};

const syncModsFromZip = async (modpack, zipPath, modsDir) => {
  const tmpDir = path.join(os.tmpdir(), `mods-${modpack.id}-${Date.now()}`);
  await fs.ensureDir(tmpDir);
  await extract(zipPath, { dir: tmpDir });

  const [rootFolder] = await fs.readdir(tmpDir);
  if (!rootFolder) throw new Error('Не удалось определить содержимое архива модпака');
  const repoRoot = path.join(tmpDir, rootFolder);
  const sub = (modpack.github.SUBDIR || '').replace(/^\/+|\/+$/g, '');
  const sourceMods = sub ? path.join(repoRoot, sub) : repoRoot;

  const exists = await fs.pathExists(sourceMods);
  if (!exists) throw new Error(`Папка с модами не найдена в ZIP: ${sourceMods}`);

  const srcFiles = (await fs.readdir(sourceMods)).filter(f => f.endsWith('.jar'));
  await fs.ensureDir(modsDir);

  for (const f of srcFiles) {
    await fs.copy(path.join(sourceMods, f), path.join(modsDir, f), { overwrite: true });
  }

  if (config.DELETE_EXTRA_MODS) {
    const dstFiles = (await fs.readdir(modsDir)).filter(f => f.endsWith('.jar'));
    const toDelete = dstFiles.filter(f => !srcFiles.includes(f));
    for (const f of toDelete) await fs.remove(path.join(modsDir, f));
  }

  await fs.remove(tmpDir);
  return { copied: srcFiles.length };
};

const ensureForgeInstaller = async (forgeVersion, overrides) => {
  const version = forgeVersion || config.FORGE_VERSION;
  if (!version) {
    throw new Error('Версия Forge не указана в конфигурации.');
  }
  const normalized = version.replace('forge-', '');
  const installerName = `forge-${normalized}-installer.jar`;
  const installerPath = path.join(FORGE_DIR, installerName);

  if (await fs.pathExists(installerPath)) return installerPath;

  await fs.ensureDir(FORGE_DIR);
  let forgeUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${normalized}/${installerName}`;
  forgeUrl = normalizeForgeMirrorUrl(forgeUrl, overrides);

  const res = await fetch(forgeUrl);
  if (!res.ok) {
    throw new Error(`Forge download failed: ${res.status} ${res.statusText}`);
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(installerPath);
    res.body.pipe(stream);
    res.body.on('error', async (err) => {
      if (await fs.pathExists(installerPath)) await fs.remove(installerPath);
      reject(err);
    });
    stream.on('finish', resolve);
    stream.on('error', async (err) => {
      if (await fs.pathExists(installerPath)) await fs.remove(installerPath);
      reject(err);
    });
  });

  return installerPath;
};

const currentAuthExtras = () => authConfig ? {
  provider: authConfig.provider,
  baseUrl: authConfig.baseUrl,
  allowRegistration: authConfig.allowRegistration
} : {};

const ensureAuthlibInjector = async () => {
  if (!authConfig || !authConfig.authlibInjector) return null;
  if (cachedAuthlibInjectorPath && await fs.pathExists(cachedAuthlibInjectorPath)) {
    return cachedAuthlibInjectorPath;
  }

  const { downloadUrl, version, sha256 } = authConfig.authlibInjector;
  if (!downloadUrl) return null;

  const jarDir = path.join(BASE_GAME_ROOT, 'authlib-injector');
  let jarName = 'authlib-injector.jar';
  try {
    const parsed = new URL(downloadUrl);
    const base = path.basename(parsed.pathname);
    if (base) {
      jarName = base;
    } else if (version) {
      jarName = `authlib-injector-${version}.jar`;
    }
  } catch (err) {
    if (version) {
      jarName = `authlib-injector-${version}.jar`;
    }
  }
  const jarPath = path.join(jarDir, jarName);

  const downloadIfNeeded = async () => {
    await fs.ensureDir(jarDir);
    const tempPath = path.join(jarDir, `.tmp-${Date.now()}-${jarName}`);
    let stream = null;
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok || !res.body) {
        throw new Error(`Failed to download authlib-injector (${res.status} ${res.statusText})`);
      }
      stream = fs.createWriteStream(tempPath);
      await pipeline(res.body, stream);
      if (sha256) {
        const computed = await new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const input = fs.createReadStream(tempPath);
          input.on('data', (chunk) => hash.update(chunk));
          input.on('error', reject);
          input.on('end', () => resolve(hash.digest('hex').toUpperCase()));
        });
        if (computed !== sha256.toUpperCase()) {
          throw new Error(`authlib-injector checksum mismatch (expected ${sha256}, got ${computed})`);
        }
      }
      await fs.move(tempPath, jarPath, { overwrite: true });
    } catch (err) {
      if (stream) {
        stream.close();
      }
      if (await fs.pathExists(tempPath)) {
        await fs.remove(tempPath);
      }
      throw err;
    }
  };

  if (!(await fs.pathExists(jarPath))) {
    await downloadIfNeeded();
  }

  cachedAuthlibInjectorPath = jarPath;
  return jarPath;
};

const parseJsonResponse = async (res) => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const performAuthRequest = async (endpoint, payload) => {
  if (!authEndpoints) {
    throw new Error('Authentication server is not configured.');
  }
  const url = `${authEndpoints.authServer}${endpoint}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
  } catch (err) {
    err.message = `Failed to reach authentication server: ${err.message}`;
    throw err;
  }

  if (res.status === 204) {
    return null;
  }

  const data = await parseJsonResponse(res);
  if (!res.ok) {
    const message = data?.errorMessage || data?.error || `Authentication request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.code = data?.error || null;
    error.body = data;
    throw error;
  }
  return data;
};

const performDraslRequest = async (pathSuffix, payload, options = {}) => {
  if (!authEndpoints) {
    throw new Error('Authentication server is not configured.');
  }
  const url = `${authEndpoints.baseUrl}${pathSuffix}`;
  const method = options.method || 'POST';
  const headers = {
    'Content-Type': 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
  };

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
  } catch (err) {
    err.message = `Failed to reach Drasl API: ${err.message}`;
    throw err;
  }

  const data = await parseJsonResponse(res);
  if (!res.ok) {
    const message = data?.errorMessage || data?.error || `Drasl API request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.code = data?.error || null;
    error.body = data;
    throw error;
  }
  return data;
};

const authenticateWithPassword = async (username, password) => {
  if (!authEndpoints) {
    throw new Error('Authentication server is not configured.');
  }
  const sanitizedUsername = String(username || '').trim();
  if (!sanitizedUsername || typeof password !== 'string' || !password.length) {
    throw new Error('Username and password are required.');
  }
  const clientToken = getClientToken();
  const body = {
    agent: { name: 'Minecraft', version: 1 },
    username: sanitizedUsername,
    password,
    clientToken,
    requestUser: true
  };
  const response = await performAuthRequest('/authenticate', body);
  return applyAuthResponse(response, currentAuthExtras());
};

const refreshAuthSession = async () => {
  const state = ensureAuthState();
  if (!state.accessToken) {
    throw new Error('No active session to refresh.');
  }
  const body = {
    accessToken: state.accessToken,
    clientToken: state.clientToken || getClientToken(),
    requestUser: true
  };
  const response = await performAuthRequest('/refresh', body);
  return applyAuthResponse(response, currentAuthExtras());
};

const invalidateAuthSession = async () => {
  const state = ensureAuthState();
  if (!state.accessToken) return;
  try {
    await performAuthRequest('/invalidate', {
      accessToken: state.accessToken,
      clientToken: state.clientToken || getClientToken()
    });
  } catch (err) {
    console.warn('[auth] Failed to invalidate session', err);
  }
};

const registerDraslAccount = async ({ username, password, playerName, inviteCode }) => {
  if (!authConfig) {
    throw new Error('Registration is not configured.');
  }
  if (!authConfig.allowRegistration) {
    throw new Error('Registration is disabled for this launcher.');
  }
  const sanitizedUsername = String(username || '').trim();
  if (!sanitizedUsername || typeof password !== 'string' || !password.length) {
    throw new Error('Username and password are required.');
  }
  const sanitizedPlayerName = String(playerName || sanitizedUsername).trim();
  const payload = {
    username: sanitizedUsername,
    password,
    playerName: sanitizedPlayerName || sanitizedUsername,
    inviteCode: inviteCode ? String(inviteCode).trim() || undefined : undefined,
    requestApiToken: false
  };
  await performDraslRequest('/drasl/api/v2/users', payload);
  return authenticateWithPassword(sanitizedUsername, password);
};

ipcMain.handle('app:bootstrap', async () => {
  const update = await getLatestUpdateInfo(true);
  return {
    settings: serializeSettings(),
    auth: serializeAuthState(),
    modpacks: serializeModpacks(),
    servers: serializeServers(),
    activeModpackId,
    paths: activePaths,
    defaults: {
      ramMb: DEFAULT_RAM,
      minRamMb: DEFAULT_MIN_RAM
    },
    update
  };
});

ipcMain.handle('app:update:refresh', async () => getLatestUpdateInfo(true));

ipcMain.handle('app:update:start', async () => {
  try {
    const info = await getLatestUpdateInfo(true);
    if (!info.enabled) {
      return { ok: false, error: 'Автообновления отключены.' };
    }
    if (!info.downloadUrl) {
      return {
        ok: false,
        error: info.error || 'Не удалось получить ссылку на обновление.'
      };
    }
    if (!info.needsUpdate) {
      return { ok: false, error: 'Текущая версия уже актуальна.' };
    }
    await downloadAndApplyUpdate(info);
    return { ok: true };
  } catch (err) {
    console.warn('[updates] Failed to start update:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('auth:status', async () => ({
  ok: true,
  auth: serializeAuthState()
}));

ipcMain.handle('auth:login', async (_event, payload = {}) => {
  try {
    const auth = await authenticateWithPassword(payload.username, payload.password);
    return { ok: true, auth };
  } catch (err) {
    console.warn('[auth] login failed', err);
    return {
      ok: false,
      error: err.message || 'Login failed',
      code: err.code || null,
      details: err.body || null
    };
  }
});

ipcMain.handle('auth:register', async (_event, payload = {}) => {
  try {
    const auth = await registerDraslAccount({
      username: payload.username,
      password: payload.password,
      playerName: payload.playerName,
      inviteCode: payload.inviteCode
    });
    return { ok: true, auth };
  } catch (err) {
    console.warn('[auth] registration failed', err);
    return {
      ok: false,
      error: err.message || 'Registration failed',
      code: err.code || null,
      details: err.body || null
    };
  }
});

ipcMain.handle('auth:logout', async () => {
  await invalidateAuthSession();
  const auth = await clearAuthState();
  return { ok: true, auth };
});

ipcMain.handle('auth:refresh', async () => {
  try {
    const auth = await refreshAuthSession();
    return { ok: true, auth };
  } catch (err) {
    console.warn('[auth] refresh failed', err);
    await clearAuthState();
    return {
      ok: false,
      error: err.message || 'Failed to refresh session',
      code: err.code || null
    };
  }
});

ipcMain.handle('settings:update', async (_event, patch) => {
  await updateUserSettings(patch);
  return serializeSettings();
});

ipcMain.handle('modpack:set', async (_event, modpackId) => {
  await updateActiveModpack(modpackId);
  return {
    activeModpackId,
    paths: activePaths,
    settings: serializeSettings()
  };
});

ipcMain.handle('fs:openModsDir', async (_event, modpackId) => {
  const targetModpack = modpackId ? getModpackById(modpackId) : activeModpack;
  const targetPaths = resolveModpackPaths(targetModpack);
  await ensurePath(targetPaths.modsDir);
  await shell.openPath(targetPaths.modsDir);
  return { ok: true };
});

ipcMain.handle('mods:sync', async () => {
  try {
    const zip = await downloadModsZip(activeModpack);
    const res = await syncModsFromZip(activeModpack, zip, activePaths.modsDir);
    await fs.remove(zip);
    return { ok: true, ...res, modsDir: activePaths.modsDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('packs:downloadShaderpacks', async () => {
  if (!shaderpacksRepoConfig.OWNER || !shaderpacksRepoConfig.REPO) {
    return { ok: false, error: 'Shaderpacks repository is not configured.' };
  }

  try {
    const result = await syncPackArchivesFromRepo(shaderpacksRepoConfig, activePaths.shaderpacksDir, {
      extensions: ['.zip'],
      kind: 'shader pack',
      tempPrefix: 'shaderpacks'
    });
    return { ok: true, ...result, targetDir: activePaths.shaderpacksDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('packs:downloadResourcepacks', async () => {
  if (!resourcepacksRepoConfig.OWNER || !resourcepacksRepoConfig.REPO) {
    return { ok: false, error: 'Resource packs repository is not configured.' };
  }

  try {
    const result = await syncPackArchivesFromRepo(resourcepacksRepoConfig, activePaths.resourcepacksDir, {
      extensions: ['.zip'],
      kind: 'resource pack',
      tempPrefix: 'resourcepacks'
    });
    return { ok: true, ...result, targetDir: activePaths.resourcepacksDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:status', async (_event, serverId) => {
  const server = getServerById(serverId);
  if (!server) {
    return { ok: false, error: 'Unknown server id', serverId };
  }

  try {
    const status = await fetchServerStatus(server);
    return {
      ok: true,
      server: {
        id: server.id,
        name: server.name,
        address: server.address,
        port: server.port,
        displayAddress: displayServerAddress(server)
      },
      status
    };
  } catch (err) {
    console.warn(`[server:status] ${serverId}`, err);
    return {
      ok: false,
      error: err.message || 'Failed to fetch server status',
      server: {
        id: server.id,
        name: server.name,
        address: server.address,
        port: server.port,
        displayAddress: displayServerAddress(server)
      }
    };
  }
});

ipcMain.handle('mc:launch', async (event, payload = {}) => {
  let windowHiddenForLaunch = false;
  let scheduleWindowRestore = null;
  const restoreWindowVisibility = () => {
    if (!windowHiddenForLaunch) {
      return;
    }
    windowHiddenForLaunch = false;
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  };

  try {
    const launcher = new Client();
    const authState = ensureAuthState();
    const requiresAuth = Boolean(authConfig);

    let sessionAuthorization = null;

    if (requiresAuth) {
      if (!authState.accessToken) {
        dialog.showErrorBox('Authentication Required', 'Please log in before launching the game.');
        return { ok: false, error: 'Authentication required' };
      }
      try {
        await refreshAuthSession();
      } catch (refreshErr) {
        console.warn('[auth] refresh before launch failed', refreshErr);
        await clearAuthState();
        dialog.showErrorBox('Authentication Error', `Failed to refresh session: ${refreshErr.message}. Please log in again.`);
        return { ok: false, error: 'Failed to refresh authentication. Please log in again.' };
      }

      const refreshed = ensureAuthState();
      if (!refreshed.selectedProfile || !refreshed.accessToken) {
        await clearAuthState();
        dialog.showErrorBox('Authentication Error', 'No playable profile available. Please log in again.');
        return { ok: false, error: 'Missing playable profile after refresh' };
      }

      sessionAuthorization = {
        access_token: refreshed.accessToken,
        client_token: refreshed.clientToken || getClientToken(),
        uuid: refreshed.selectedProfile.id,
        name: refreshed.selectedProfile.name,
        user_properties: formatUserPropertiesJson(refreshed.user?.properties)
      };
    }

    const nickname = sessionAuthorization
      ? sessionAuthorization.name
      : String(payload.username || userSettings.nickname || 'Player').slice(0, 32);
    const ramMb = clampRam(payload.ramMb !== undefined ? payload.ramMb : userSettings.ramMb);

    userSettings.nickname = nickname;
    userSettings.ramMb = ramMb;
    await persistUserSettings();

    await ensurePath(activePaths.gameRoot);
    await ensurePath(activePaths.modsDir);

    const baseVersion = deriveBaseVersion(activeModpack.forgeVersion || config.FORGE_VERSION);
    const customOverrides = buildMclcOverrides();

    const forgeInstaller = await ensureForgeInstaller(
      activeModpack.forgeVersion || config.FORGE_VERSION,
      customOverrides
    );
    const javaArgs = [...CLEAN_JAVA_ARGS];

    if (sessionAuthorization && authConfig) {
      const injectorPath = await ensureAuthlibInjector();
      if (!injectorPath) {
        throw new Error('authlib-injector is not available.');
      }
      const injectorEndpoint = `${authConfig.baseUrl}/authlib-injector`;
      javaArgs.push(`-javaagent:${injectorPath}=${injectorEndpoint}`);
    }

    const authorization = sessionAuthorization || {
      name: nickname || 'Player',
      uuid: '00000000-0000-0000-0000-000000000000',
      access_token: '0',
      client_token: getClientToken(),
      user_properties: '{}'
    };

    if (!authorization.user_properties) {
      const latest = ensureAuthState();
      authorization.user_properties = formatUserPropertiesJson(latest.user?.properties);
    }

    if (customOverrides?.url) {
      await ensureForgeVersionJsonForMirror(
        activePaths.gameRoot,
        activeModpack.forgeVersion || config.FORGE_VERSION,
        customOverrides
      );
    }
    let versionJsonPath = null;
    if (customOverrides?.url?.meta) {
      versionJsonPath = await ensureVersionMetadataForMirror(activePaths.gameRoot, baseVersion, customOverrides);
    }

    const opts = {
      authorization,
      root: activePaths.gameRoot,
      version: { number: baseVersion, type: 'release' },
      forge: forgeInstaller,
      memory: {
        max: `${ramMb}`,
        min: `${ramMb}`
      },
      javaPath: undefined,
      customArgs: javaArgs
    };

    if (customOverrides || versionJsonPath) {
      const overridesForLaunch = {};
      if (versionJsonPath) {
        overridesForLaunch.versionJson = versionJsonPath;
      }
      if (customOverrides) {
        for (const [key, value] of Object.entries(customOverrides)) {
          if (key === 'url' && value && typeof value === 'object') {
            overridesForLaunch.url = { ...(overridesForLaunch.url || {}), ...value };
          } else if (key === 'fw' && value && typeof value === 'object') {
            overridesForLaunch.fw = { ...(overridesForLaunch.fw || {}), ...value };
          } else {
            overridesForLaunch[key] = value;
          }
        }
      }
      opts.overrides = overridesForLaunch;
    }

    scheduleWindowRestore = () => {
      launcher.removeListener('close', scheduleWindowRestore);
      restoreWindowVisibility();
    };

    launcher.on('close', scheduleWindowRestore);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
      windowHiddenForLaunch = true;
    }

    launcher.on('debug', (log) => event.sender.send('mc:log', String(log)));
    launcher.on('data', (log) => event.sender.send('mc:log', String(log)));
    launcher.on('progress', (p) => event.sender.send('mc:progress', p));

    await launcher.launch(opts);
    return { ok: true };
  } catch (err) {
    if (typeof scheduleWindowRestore === 'function') {
      scheduleWindowRestore();
    } else {
      restoreWindowVisibility();
    }
    dialog.showErrorBox('MC Launch error', String(err));
    return { ok: false, error: String(err) };
  }
});
