#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const fetch = require("node-fetch");

// ===== Paths
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");

// ===== .env load with override + BOM-safe fallback
const envPath = path.join(ROOT, ".env");
try {
  // optional dependency; won't throw if missing
  require("dotenv").config({ path: envPath, override: true });
} catch {}
if (fs.existsSync(envPath) && !process.env.GITHUB_TOKEN) {
  let content = fs.readFileSync(envPath, "utf8");
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const l = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const i = l.indexOf("=");
    if (i === -1) return;
    const key = l.slice(0, i).trim();
    let value = l.slice(i + 1).trim();
    if (!key) return;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, "\n");
    if (!process.env[key]) process.env[key] = value;
  });
}
console.log(
  "[env] .env:",
  fs.existsSync(envPath),
  "GITHUB_TOKEN:",
  (process.env.GITHUB_TOKEN || "").slice(0, 6)
);

// ===== Utils
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const norm = (s) => String(s || "").trim();

const resolveGithubAuthHeader = (token) => `token ${String(token || "").trim()}`;

const composeHeaders = (token, extra = {}) => {
  const base = {
    Accept: "application/vnd.github+json",
    Authorization: resolveGithubAuthHeader(token),
    "User-Agent": "mc-launcher-release-script",
  };
  const headers = { ...base, ...(extra || {}) };
  if (!/^token\s+\S/.test(headers.Authorization || "")) {
    throw new Error("Auth header is missing or empty");
  }
  return headers;
};

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve();
    });
  });

const findLatestPortableExe = async () => {
  const entries = await fs.promises.readdir(DIST_DIR, { withFileTypes: true });
  const exes = await Promise.all(
    entries
      .filter((e) => e.isFile && e.isFile() && e.name.toLowerCase().endsWith(".exe"))
      .map(async (e) => {
        const fullPath = path.join(DIST_DIR, e.name);
        const stats = await fs.promises.stat(fullPath);
        return { name: e.name, path: fullPath, mtimeMs: stats.mtimeMs };
      })
  );
  if (!exes.length) return null;
  exes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return exes[0];
};

const resolveUpdateConfig = () => {
  const configPath = path.join(ROOT, "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    const config = readJson(configPath);
    return config.APP_UPDATES || {};
  } catch (err) {
    console.warn("[buildPortableRemotePush] Failed to parse config.json:", err);
    return {};
  }
};

const ensureReleaseContext = (pkg, updateConfig) => {
  const version = pkg.version;
  if (!version) throw new Error('package.json must define a "version"');

  const githubCfg = updateConfig.github || {};

  const owner =
    norm(process.env.RELEASE_OWNER) ||
    norm(githubCfg.OWNER) ||
    norm(githubCfg.owner) ||
    norm(process.env.GITHUB_OWNER);

  const repo =
    norm(process.env.RELEASE_REPO) ||
    norm(githubCfg.REPO) ||
    norm(githubCfg.repo) ||
    norm(process.env.GITHUB_REPO);

  const assetName =
    norm(process.env.RELEASE_ASSET_NAME) ||
    norm(githubCfg.ASSET_NAME) ||
    norm(githubCfg.assetName) ||
    null;

  if (!owner || !repo) {
    throw new Error(
      "Release repository is not configured. Set APP_UPDATES.github in config.json or provide RELEASE_OWNER/RELEASE_REPO."
    );
  }

  const tag = norm(process.env.RELEASE_TAG) || `v${version}`;
  const releaseName = norm(process.env.RELEASE_TITLE) || `Compass MC Launcher ${version}`;
  const releaseBody =
    norm(process.env.RELEASE_BODY) || `Automated portable build for Compass MC Launcher ${version}.`;

  return { owner, repo, assetName, version, tag, releaseName, releaseBody };
};

// ===== GitHub call with strict headers and redirect control
const callGithub = async (url, options = {}, token) => {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: composeHeaders(token, options.headers),
    body: options.body,
    redirect: options.redirect || "follow",
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`GitHub API ${response.status}: ${text}`);
    error.status = response.status;
    error.responseText = text;
    error.urlTried = url;
    throw error;
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
};

// ===== Release helpers
const ensureRelease = async (ctx, token) => {
  const apiBase = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}`;

  try {
    const existing = await callGithub(
      `${apiBase}/releases/tags/${encodeURIComponent(ctx.tag)}`,
      { redirect: "manual" },
      token
    );
    await callGithub(
      `${apiBase}/releases/${existing.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: ctx.releaseName,
          body: ctx.releaseBody,
          draft: false,
          prerelease: false,
        }),
        headers: { "Content-Type": "application/json" },
      },
      token
    );
    return existing;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  return callGithub(
    `${apiBase}/releases`,
    {
      method: "POST",
      body: JSON.stringify({
        tag_name: ctx.tag,
        name: ctx.releaseName,
        body: ctx.releaseBody,
        draft: false,
        prerelease: false,
      }),
      headers: { "Content-Type": "application/json" },
    },
    token
  );
};

const removeAssetIfExists = async (release, assetName, ctx, token) => {
  if (!release || !Array.isArray(release.assets) || !release.assets.length) return;
  const existingAsset = release.assets.find((a) => a.name === assetName);
  if (!existingAsset) return;
  const apiBase = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}`;
  await callGithub(`${apiBase}/releases/assets/${existingAsset.id}`, { method: "DELETE" }, token);
};

const uploadAsset = async (release, assetPath, assetName, ctx, token) => {
  const stat = await fs.promises.stat(assetPath);
  const uploadUrl = `https://uploads.github.com/repos/${ctx.owner}/${ctx.repo}/releases/${release.id}/assets?name=${encodeURIComponent(
    assetName
  )}`;

  const stream = fs.createReadStream(assetPath);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: resolveGithubAuthHeader(token),
      "User-Agent": "mc-launcher-release-script",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
    },
    body: stream,
    redirect: "manual",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to upload asset: ${response.status} ${text}`);
  }
};

// ===== Probes (diagnostics)
const probes = async (ctx, token) => {
  const H = composeHeaders(token);
  console.log("[probe] /user");
  const u = await fetch("https://api.github.com/user", { headers: H, redirect: "manual" });
  console.log("status=", u.status);

  const repoUrl = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}`;
  console.log("[probe] repo:", repoUrl);
  const r = await fetch(repoUrl, { headers: H, redirect: "manual" });
  console.log("status=", r.status, "sso=", r.headers.get("x-github-sso"));

  const tagUrl = `${repoUrl}/releases/tags/${encodeURIComponent(ctx.tag)}`;
  console.log("[probe] tag:", tagUrl);
  const t = await fetch(tagUrl, { headers: H, redirect: "manual" });
  console.log("status=", t.status, "location=", t.headers.get("location"), "sso=", t.headers.get("x-github-sso"));
  if (t.status !== 200 && t.status !== 404) {
    const body = await t.text();
    console.log("body.head=", body.slice(0, 200));
  }
};

// ===== Main
const main = async () => {
  const pkg = readJson(path.join(ROOT, "package.json"));
  const updateConfig = resolveUpdateConfig();
  const ctx = ensureReleaseContext(pkg, updateConfig);

  const token = norm(process.env.GITHUB_TOKEN);
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN не найден: проверьте .env (UTF-8 без BOM), переменные окружения или загрузку dotenv."
    );
  }

  console.log("[ctx]", ctx);
  console.log("[auth]", resolveGithubAuthHeader(token).split(" ")[0], token.slice(0, 6) + "...");

  // Diagnostics first
  await probes(ctx, token);

  console.log("[buildPortableRemotePush] Building portable executable...");
  const runBuild = async () => {
    const env = process.env;
    if (env.npm_execpath) {
      const nodeExec = env.npm_node_execpath || process.execPath;
      await runCommand(nodeExec, [env.npm_execpath, "run", "build:portable"], { cwd: ROOT });
      return;
    }
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const options = { cwd: ROOT };
    if (process.platform === "win32") options.shell = true;
    await runCommand(npmCmd, ["run", "build:portable"], options);
  };
  await runBuild();

  const latestExe = await findLatestPortableExe();
  if (!latestExe) throw new Error("Portable executable not found in dist/.");

  console.log(`[buildPortableRemotePush] Latest portable exe: ${latestExe.name}`);

  const desiredAssetName = ctx.assetName || latestExe.name || `mc-launcher-portable-${ctx.version}.exe`;
  const assetPath = path.join(DIST_DIR, desiredAssetName);

  if (path.basename(latestExe.path) !== desiredAssetName) {
    console.log(`[buildPortableRemotePush] Copying ${latestExe.name} -> ${desiredAssetName}`);
    await fs.promises.copyFile(latestExe.path, assetPath);
  } else {
    console.log("[buildPortableRemotePush] Using existing executable name.");
  }

  const release = await ensureRelease(ctx, token);
  console.log(`[buildPortableRemotePush] Release ready: ${ctx.owner}/${ctx.repo} ${ctx.tag}`);

  await removeAssetIfExists(release, desiredAssetName, ctx, token);
  console.log(`[buildPortableRemotePush] Uploading asset ${desiredAssetName} (${ctx.version})`);
  await uploadAsset(release, assetPath, desiredAssetName, ctx, token);
  console.log("[buildPortableRemotePush] Upload complete.");
};

main().catch((err) => {
  console.error("[buildPortableRemotePush] Failed:", err);
  process.exitCode = 1;
});
