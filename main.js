const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const extract = require('extract-zip');
const os = require('os');
const { Client } = require('minecraft-launcher-core');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const GAME_ROOT = path.resolve(__dirname, config.GAME_ROOT || './runtime');
const MODS_DIR = path.join(GAME_ROOT, 'mods');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 620,
    resizable: false,
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
  await fs.ensureDir(MODS_DIR);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ======= Синхронизация модов из GitHub =======
async function downloadModsZip() {
  const { OWNER, REPO, BRANCH } = config.GITHUB;
  const zipUrl = `https://codeload.github.com/${OWNER}/${REPO}/zip/refs/heads/${BRANCH}`;
  const tmpZip = path.join(os.tmpdir(), `modpack-${Date.now()}.zip`);

  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`GitHub ZIP fetch failed: ${res.status}`);
  const fileStream = fs.createWriteStream(tmpZip);
  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
  return tmpZip;
}

async function syncModsFromZip(zipPath) {
  const tmpDir = path.join(os.tmpdir(), `mods-${Date.now()}`);
  await fs.ensureDir(tmpDir);
  await extract(zipPath, { dir: tmpDir });

  // Найти распакованный корень репо
  const [rootFolder] = await fs.readdir(tmpDir);
  const repoRoot = path.join(tmpDir, rootFolder);
  const sub = (config.GITHUB.SUBDIR || '').replace(/^\/+|\/+$/g, '');
  const sourceMods = sub ? path.join(repoRoot, sub) : repoRoot;

  const exists = await fs.pathExists(sourceMods);
  if (!exists) throw new Error(`Папка с модами не найдена в ZIP: ${sourceMods}`);

  const srcFiles = (await fs.readdir(sourceMods)).filter(f => f.endsWith('.jar'));
  await fs.ensureDir(MODS_DIR);

  // Копируем/обновляем
  for (const f of srcFiles) {
    await fs.copy(path.join(sourceMods, f), path.join(MODS_DIR, f), { overwrite: true });
  }

  if (config.DELETE_EXTRA_MODS) {
    const dstFiles = (await fs.readdir(MODS_DIR)).filter(f => f.endsWith('.jar'));
    const toDelete = dstFiles.filter(f => !srcFiles.includes(f));
    for (const f of toDelete) await fs.remove(path.join(MODS_DIR, f));
  }

  return { copied: srcFiles.length };
}

ipcMain.handle('mods:sync', async () => {
  try {
    const zip = await downloadModsZip();
    const res = await syncModsFromZip(zip);
    await fs.remove(zip);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ======= Запуск Minecraft (offline) =======
ipcMain.handle('mc:launch', async (e, { username, ramMb }) => {
  try {
    const launcher = new Client();

    const opts = {
      authorization: {
        name: username || 'Player',
        uuid: '00000000-0000-0000-0000-000000000000',
        access_token: '0'
      },
      root: GAME_ROOT,
      version: { number: config.FORGE_VERSION, type: 'release' },
      memory: {
        max: `${ramMb || 2048}`,
        min: `${Math.min(ramMb || 2048, 1024)}`
      },
      javaPath: undefined,
      customArgs: config.JAVA_ARGS || []
    };

    launcher.on('debug', (log) => e.sender.send('mc:log', String(log)));
    launcher.on('data', (log) => e.sender.send('mc:log', String(log)));
    launcher.on('progress', (p) => e.sender.send('mc:progress', p));

    await launcher.launch(opts);
    return { ok: true };
  } catch (err) {
    dialog.showErrorBox('MC Launch error', String(err));
    return { ok: false, error: String(err) };
  }
});
