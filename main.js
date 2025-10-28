const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const extract = require('extract-zip');
const os = require('os');
const { Client } = require('minecraft-launcher-core');

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
