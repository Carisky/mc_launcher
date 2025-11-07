const { app } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const fetch = require('node-fetch');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');

const UPDATE_SCRIPT_PREFIX = 'mc-launcher-updater-';
const UPDATE_LOG_PATH = path.join(os.tmpdir(), 'mc-launcher-update.log');
const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

const defaultLogger = {
  warn: (...args) => console.warn(...args)
};

const ensureFn = (fn) => (typeof fn === 'function' ? fn : () => {});

module.exports = function createUpdateService(options) {
  const {
    appVersion,
    updateConfig,
    sendEvent,
    logger = defaultLogger
  } = options || {};

  if (!appVersion) {
    throw new Error('createUpdateService requires appVersion');
  }
  if (!updateConfig) {
    throw new Error('createUpdateService requires updateConfig');
  }

  const emit = ensureFn(sendEvent);

  const sendUpdateEvent = (payload) => {
    if (!payload) return;
    try {
      emit(payload);
    } catch (err) {
      logger.warn('[updates] Failed to send update event:', err);
    }
  };

  const broadcastUpdateState = (state) => {
    sendUpdateEvent({ type: 'state', state });
  };

  let cachedUpdateInfo = null;
  let updateCheckPromise = null;
  let updateDownloadTask = null;

  const writeUpdateScript = async (scriptPath) => {
    const script = `'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const waitForExit = async (pid, timeoutMs = 120000) => {
  if (!pid || Number.isNaN(pid) || pid <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (!err || err.code === 'ESRCH' || err.code === 'EPERM') return;
      throw err;
    }
    await sleep(200);
  }
  throw new Error('Timed out waiting for process ' + pid);
};

const appendLog = async (message) => {
  try {
    await fs.promises.appendFile(${JSON.stringify(UPDATE_LOG_PATH)}, new Date().toISOString() + ' - ' + message + '\\n', 'utf8');
  } catch {}
};

const removeIfExists = async (target) => {
  if (!target) return;
  try {
    await fs.promises.unlink(target);
  } catch (err) {
    if (!err || err.code === 'ENOENT') return;
    throw err;
  }
};

(async () => {
  const downloadPath = path.resolve(process.argv[2] || '');
  const targetPath = path.resolve(process.argv[3] || '');
  const parentPid = Number(process.argv[4] || 0);

  if (!downloadPath || !targetPath) {
    throw new Error('Updater: missing download or target path.');
  }

  await appendLog('Updater started. parentPid=' + parentPid + ', downloadPath=' + downloadPath);
  await waitForExit(parentPid);
  await appendLog('Parent exited');

  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await removeIfExists(targetPath);
      await fs.promises.rename(downloadPath, targetPath);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (err && err.code === 'EXDEV') {
        try {
          await fs.promises.copyFile(downloadPath, targetPath);
          await removeIfExists(downloadPath);
          lastError = null;
          break;
        } catch (copyErr) {
          lastError = copyErr;
        }
      }
      await sleep(500);
    }
  }

  if (lastError) {
    await appendLog('Failed to apply update: ' + (lastError.stack || lastError));
    throw lastError;
  }

  try {
    await fs.promises.chmod(targetPath, 0o755);
  } catch {}

  await appendLog('Update applied, relaunching');

  try {
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

    const child = spawn(targetPath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(targetPath),
      env: childEnv
    });
    child.unref();
  } catch (err) {
    await appendLog('Failed to relaunch: ' + (err.stack || err));
  }

  try {
    await removeIfExists(process.argv[1]);
  } catch {}

  await appendLog('Updater finished');
})().catch(async (err) => {
  await appendLog('Updater error: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
`;

    await fs.promises.writeFile(scriptPath, script, 'utf8');
  };

  const createUpdateScript = async () => {
    const scriptPath = path.join(
      os.tmpdir(),
      `${UPDATE_SCRIPT_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`
    );
    await writeUpdateScript(scriptPath);
    return scriptPath;
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
    const comparison = compareVersionStrings(releaseVersion, appVersion);
    return {
      enabled: true,
      enforce: updateConfig.enforce,
      status: 'ok',
      currentVersion: appVersion,
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
        currentVersion: appVersion,
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
        logger.warn('[updates] Failed to retrieve update info:', err);
        const failure = {
          enabled: true,
          enforce: updateConfig.enforce,
          status: 'error',
          currentVersion: appVersion,
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

  const resolveUpdateTargetPath = () => {
    const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableExecutable && typeof portableExecutable === 'string') {
      try {
        const normalized = path.resolve(portableExecutable);
        if (fs.existsSync(normalized)) {
          return normalized;
        }
        const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
        if (portableDir && typeof portableDir === 'string') {
          const combined = path.resolve(portableDir, path.basename(portableExecutable));
          if (fs.existsSync(combined)) {
            return combined;
          }
        }
      } catch (err) {
        logger.warn('[updates] Failed to resolve portable executable path:', err);
      }
    }

    return process.execPath;
  };

  const scheduleUpdateReplacement = async (downloadPath, targetPath) => {
    if (!downloadPath) {
      throw new Error('Update payload path is missing.');
    }

    const resolvedTarget = targetPath || resolveUpdateTargetPath();
    if (!resolvedTarget) {
      throw new Error('Unable to resolve target executable path.');
    }

    const targetDir = path.dirname(resolvedTarget);
    if (!(await fs.pathExists(targetDir))) {
      throw new Error(`Target directory "${targetDir}" doesn't exist.`);
    }

    const scriptPath = await createUpdateScript();
    const args = [scriptPath, downloadPath, resolvedTarget, String(process.pid)];
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1'
    };

    try {
      const updater = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: targetDir,
        env
      });
      updater.unref();
    } catch (err) {
      throw new Error(`Failed to launch updater helper: ${err.message || err}`);
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

    const targetPath = resolveUpdateTargetPath();
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

      sendUpdateEvent({ type: 'status', status: 'installing' });

      await scheduleUpdateReplacement(tempPath, targetPath);
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
        logger.warn('[updates] Failed to cleanup temporary update file:', cleanupErr);
      }

      throw err;
    } finally {
      updateDownloadTask = null;
    }
  };

  return {
    getLatestUpdateInfo,
    downloadAndApplyUpdate,
    getCachedUpdateInfo: () => cachedUpdateInfo
  };
};
