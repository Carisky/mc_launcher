const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const extract = require('extract-zip');
const os = require('os');
const { Client } = require('minecraft-launcher-core');
const { Rcon } = require('rcon-client');
const nbt = require('prismarine-nbt');

const DEFAULT_STATUS_API = 'https://api.mcstatus.io/v2/status/java';
const MIN_REFRESH_INTERVAL_MS = 10000;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const configRaw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(configRaw);

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
    activeProfileId: settings.activeProfileId || null,
    profiles: Array.isArray(settings.profiles) ? settings.profiles : [],
    selectedModpack: settings.selectedModpack || config.ACTIVE_MODPACK || modpacks[0].id
  };

  sanitized.ramMb = Math.max(DEFAULT_MIN_RAM, Math.min(65536, sanitized.ramMb));

  if (!modpacks.find(m => m.id === sanitized.selectedModpack)) {
    sanitized.selectedModpack = modpacks[0].id;
  }

  sanitized.profiles = sanitized.profiles.map(profile => ({
    id: profile.id || `profile-${Date.now()}`,
    label: String(profile.label || 'Профиль'),
    nickname: String(profile.nickname || sanitized.nickname).slice(0, 32),
    ramMb: Math.max(DEFAULT_MIN_RAM, Math.min(65536, Number(profile.ramMb) || sanitized.ramMb))
  }));

  if (sanitized.activeProfileId && !sanitized.profiles.find(p => p.id === sanitized.activeProfileId)) {
    sanitized.activeProfileId = null;
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

const persistUserSettings = async () => {
  await fs.ensureDir(path.dirname(USER_SETTINGS_PATH));
  await fs.writeJson(USER_SETTINGS_PATH, userSettings, { spaces: 2 });
};

const getModpackById = (id) => modpacks.find(mp => mp.id === id) || modpacks[0];

let activeModpackId = userSettings.selectedModpack;
let activeModpack = getModpackById(activeModpackId);

const resolveModpackPaths = (modpack) => {
  if (!usePerModpackRoots) {
    const gameRoot = BASE_GAME_ROOT;
    return {
      gameRoot,
      modsDir: path.join(gameRoot, 'mods')
    };
  }

  const customPath = modpack.gameRoot;
  const resolvedRoot = customPath
    ? (path.isAbsolute(customPath) ? customPath : path.join(BASE_GAME_ROOT, customPath))
    : path.join(BASE_GAME_ROOT, 'profiles', modpack.slug);

  return {
    gameRoot: resolvedRoot,
    modsDir: path.join(resolvedRoot, 'mods')
  };
};

let activePaths = resolveModpackPaths(activeModpack);

const updateActiveModpack = async (modpackId) => {
  activeModpackId = modpackId;
  activeModpack = getModpackById(modpackId);
  activePaths = resolveModpackPaths(activeModpack);
  userSettings.selectedModpack = activeModpack.id;
  await ensurePath(activePaths.modsDir);
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
  if (patch.activeProfileId !== undefined) {
    userSettings.activeProfileId = patch.activeProfileId && userSettings.profiles.find(p => p.id === patch.activeProfileId)
      ? patch.activeProfileId
      : null;
  }
  if (patch.selectedModpack !== undefined && modpacks.find(m => m.id === patch.selectedModpack)) {
    await updateActiveModpack(patch.selectedModpack);
  }
  await persistUserSettings();
  return userSettings;
};

const setProfile = async (profile) => {
  const profiles = [...userSettings.profiles];
  const existingIndex = profile.id ? profiles.findIndex(p => p.id === profile.id) : -1;
  const id = profile.id || `profile-${Date.now()}`;
  const normalized = {
    id,
    label: String(profile.label || 'Профиль').slice(0, 40),
    nickname: String(profile.nickname || userSettings.nickname).slice(0, 32),
    ramMb: clampRam(profile.ramMb !== undefined ? profile.ramMb : userSettings.ramMb)
  };

  if (existingIndex >= 0) {
    profiles.splice(existingIndex, 1, normalized);
  } else {
    profiles.push(normalized);
  }

  userSettings.profiles = profiles;
  userSettings.activeProfileId = normalized.id;
  userSettings.nickname = normalized.nickname;
  userSettings.ramMb = normalized.ramMb;
  await persistUserSettings();

  return userSettings;
};

const deleteProfile = async (profileId) => {
  userSettings.profiles = userSettings.profiles.filter(p => p.id !== profileId);
  if (userSettings.activeProfileId === profileId) {
    userSettings.activeProfileId = null;
  }
  await persistUserSettings();
  return userSettings;
};

const openProfile = async (profileId) => {
  const profile = userSettings.profiles.find(p => p.id === profileId);
  if (!profile) return userSettings;
  userSettings.activeProfileId = profile.id;
  userSettings.nickname = profile.nickname;
  userSettings.ramMb = clampRam(profile.ramMb);
  await persistUserSettings();
  return userSettings;
};

const serializeSettings = () => JSON.parse(JSON.stringify(userSettings));
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
  const win = new BrowserWindow({
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
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await ensurePath(BASE_GAME_ROOT);
  await ensurePath(activePaths.modsDir);
  await ensurePath(FORGE_DIR);
  await syncServersDat(activePaths.gameRoot, servers);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const downloadModsZip = async (modpack) => {
  const { OWNER, REPO, BRANCH } = modpack.github || {};
  if (!OWNER || !REPO) {
    throw new Error(`GitHub настройки не заданы для модпака "${modpack.name}"`);
  }

  const zipUrl = `https://codeload.github.com/${OWNER}/${REPO}/zip/refs/heads/${BRANCH}`;
  const tmpZip = path.join(os.tmpdir(), `modpack-${modpack.id}-${Date.now()}.zip`);

  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`GitHub ZIP fetch failed: ${res.status}`);
  const fileStream = fs.createWriteStream(tmpZip);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
  return tmpZip;
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

const ensureForgeInstaller = async (forgeVersion) => {
  const version = forgeVersion || config.FORGE_VERSION;
  if (!version) {
    throw new Error('Версия Forge не указана в конфигурации.');
  }
  const normalized = version.replace('forge-', '');
  const installerName = `forge-${normalized}-installer.jar`;
  const installerPath = path.join(FORGE_DIR, installerName);

  if (await fs.pathExists(installerPath)) return installerPath;

  await fs.ensureDir(FORGE_DIR);
  const forgeUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${normalized}/${installerName}`;

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

ipcMain.handle('app:bootstrap', async () => ({
  settings: serializeSettings(),
  modpacks: serializeModpacks(),
  servers: serializeServers(),
  activeModpackId,
  paths: activePaths,
  defaults: {
    ramMb: DEFAULT_RAM,
    minRamMb: DEFAULT_MIN_RAM
  }
}));

ipcMain.handle('settings:update', async (_event, patch) => {
  await updateUserSettings(patch);
  return serializeSettings();
});

ipcMain.handle('profiles:save', async (_event, profile) => {
  await setProfile(profile || {});
  return serializeSettings();
});

ipcMain.handle('profiles:delete', async (_event, profileId) => {
  await deleteProfile(profileId);
  return serializeSettings();
});

ipcMain.handle('profiles:activate', async (_event, profileId) => {
  await openProfile(profileId);
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
  try {
    const launcher = new Client();
    const nickname = String(payload.username || userSettings.nickname || 'Player').slice(0, 32);
    const ramMb = clampRam(payload.ramMb !== undefined ? payload.ramMb : userSettings.ramMb);

    userSettings.nickname = nickname;
    userSettings.ramMb = ramMb;
    await persistUserSettings();

    await ensurePath(activePaths.gameRoot);
    await ensurePath(activePaths.modsDir);

    const forgeInstaller = await ensureForgeInstaller(activeModpack.forgeVersion || config.FORGE_VERSION);

    const opts = {
      authorization: {
        name: nickname || 'Player',
        uuid: '00000000-0000-0000-0000-000000000000',
        access_token: '0'
      },
      root: activePaths.gameRoot,
      version: { number: deriveBaseVersion(activeModpack.forgeVersion || config.FORGE_VERSION), type: 'release' },
      forge: forgeInstaller,
      memory: {
        max: `${ramMb}`,
        min: `${Math.min(ramMb, DEFAULT_MIN_RAM)}`
      },
      javaPath: undefined,
      customArgs: CLEAN_JAVA_ARGS
    };

    launcher.on('debug', (log) => event.sender.send('mc:log', String(log)));
    launcher.on('data', (log) => event.sender.send('mc:log', String(log)));
    launcher.on('progress', (p) => event.sender.send('mc:progress', p));

    await launcher.launch(opts);
    return { ok: true };
  } catch (err) {
    dialog.showErrorBox('MC Launch error', String(err));
    return { ok: false, error: String(err) };
  }
});
