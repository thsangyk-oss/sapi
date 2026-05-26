import fs from "fs";
import path from "path";
import https from "https";
import os from "os";
import { execSync, execFileSync, spawn } from "child_process";
import { savePid, loadPid, clearPid, TUNNEL_DATA_DIR } from "./state.js";
import { DATA_DIR } from "@/lib/dataDir.js";

const BIN_DIR = path.join(DATA_DIR, "bin");
const BINARY_NAME = "cloudflared";
const IS_WINDOWS = os.platform() === "win32";
const BIN_NAME = IS_WINDOWS ? `${BINARY_NAME}.exe` : BINARY_NAME;
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);
const POWERSHELL_HIDDEN_COMMAND = "powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command";

// cloudflared insists on using ~/.cloudflared/cert.pem for the existence check
// during `tunnel login` (even when --origincert points elsewhere — confirmed
// on cloudflared 2026.5.1). Rather than fight that, we use its default home and
// pick up any cert the user may have already authorized through the CLI directly.
export const CF_HOME_DIR = path.join(os.homedir(), ".cloudflared");
export const CERT_PATH = path.join(CF_HOME_DIR, "cert.pem");
export const CONFIG_PATH = path.join(TUNNEL_DATA_DIR, "config.yml");

const GITHUB_BASE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download";

const PLATFORM_MAPPINGS = {
  darwin: { x64: "cloudflared-darwin-amd64.tgz", arm64: "cloudflared-darwin-arm64.tgz" },
  win32:  { x64: "cloudflared-windows-amd64.exe", ia32: "cloudflared-windows-386.exe", arm64: "cloudflared-windows-386.exe" },
  linux:  { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64" },
};
const PLATFORM_FALLBACK = {
  darwin: "cloudflared-darwin-amd64.tgz",
  win32: "cloudflared-windows-386.exe",
  linux: "cloudflared-linux-amd64",
};

function getDownloadUrl() {
  const platform = os.platform();
  const arch = os.arch();
  const mapping = PLATFORM_MAPPINGS[platform];
  if (!mapping) throw new Error(`Unsupported platform: ${platform}`);
  return `${GITHUB_BASE_URL}/${mapping[arch] || PLATFORM_FALLBACK[platform]}`;
}

// ─── Download tracking ───────────────────────────────────────────────────────
const dlState = { downloading: false, progress: 0 };
export function getDownloadStatus() { return { ...dlState }; }

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }
      const total = parseInt(response.headers["content-length"], 10) || 0;
      let received = 0;
      dlState.downloading = true; dlState.progress = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0) dlState.progress = Math.round((received / total) * 100);
      });
      response.pipe(file);
      file.on("finish", () => {
        dlState.downloading = false; dlState.progress = 100;
        file.close(() => resolve(dest));
      });
      file.on("error", (err) => {
        dlState.downloading = false; dlState.progress = 0;
        file.close(); try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    }).on("error", (err) => {
      dlState.downloading = false; dlState.progress = 0;
      file.close(); try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

const MIN_BINARY_SIZE = 1024 * 1024;
function isValidBinary(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MIN_BINARY_SIZE) return false;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString("hex");
    if (IS_WINDOWS) return magic.startsWith("4d5a");
    if (os.platform() === "darwin") return magic.startsWith("cffaedfe") || magic.startsWith("cefaedfe");
    return magic.startsWith("7f454c46");
  } catch { return false; }
}

let downloadPromise = null;
export async function ensureCloudflared() {
  if (downloadPromise) return downloadPromise;
  downloadPromise = _ensureCloudflared().finally(() => { downloadPromise = null; });
  return downloadPromise;
}
async function _ensureCloudflared() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmpPath = `${BIN_PATH}.tmp`;
  if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch {}
  if (fs.existsSync(BIN_PATH)) {
    if (!isValidBinary(BIN_PATH)) { console.log("[cloudflared] Invalid binary, re-downloading..."); fs.unlinkSync(BIN_PATH); }
    else { if (!IS_WINDOWS) fs.chmodSync(BIN_PATH, "755"); return BIN_PATH; }
  }
  const url = getDownloadUrl();
  const isArchive = url.endsWith(".tgz");
  const dest = isArchive ? path.join(BIN_DIR, "cloudflared.tgz.tmp") : tmpPath;
  await downloadFile(url, dest);
  if (isArchive) {
    execSync(`tar -xzf "${dest}" -C "${BIN_DIR}"`, { stdio: "pipe", windowsHide: true });
    fs.unlinkSync(dest);
  } else {
    fs.renameSync(dest, BIN_PATH);
  }
  if (!IS_WINDOWS) fs.chmodSync(BIN_PATH, "755");
  return BIN_PATH;
}

// ─── Authorize (login) flow ──────────────────────────────────────────────────
// Login spawns cloudflared in a child process which prints a URL the user must
// open in their browser to authorize a Cloudflare zone. The process keeps running
// until the user finishes the flow (or it is cancelled), then writes cert.pem.

let loginProcess = null;
let loginState = {
  inProgress: false,
  loginUrl: "",
  error: "",
  startedAt: 0,
};

export function getLoginState() {
  return { ...loginState, certExists: fs.existsSync(CERT_PATH) };
}

export function cancelLogin() {
  if (loginProcess) {
    try { loginProcess.kill(); } catch {}
    loginProcess = null;
  }
  loginState = { inProgress: false, loginUrl: "", error: "cancelled", startedAt: 0 };
}

export async function startLogin() {
  // If a cert already exists (user authorized previously, possibly via the CLI
  // directly), skip the login flow and treat as already authorized.
  if (fs.existsSync(CERT_PATH)) {
    return { loginUrl: "", certPath: CERT_PATH, alreadyAuthorized: true };
  }
  if (loginState.inProgress) return { loginUrl: loginState.loginUrl };
  if (!fs.existsSync(CF_HOME_DIR)) fs.mkdirSync(CF_HOME_DIR, { recursive: true });
  const binaryPath = await ensureCloudflared();

  loginState = { inProgress: true, loginUrl: "", error: "", startedAt: Date.now() };

  // Don't pass --origincert here: cloudflared 2026.5.1 ignores it for the
  // existence pre-check and still resolves the default path. Default-path-only
  // also means revoke can leave the user's cert alone if they want to keep it.
  const child = spawn(binaryPath, ["tunnel", "login"], {
    detached: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  loginProcess = child;

  let stderrBuf = "";
  let stdoutBuf = "";
  return new Promise((resolve, reject) => {
    let resolved = false;
    const collectUrl = (data, kind) => {
      const msg = data.toString();
      if (kind === "err") stderrBuf += msg; else stdoutBuf += msg;
      const m = msg.match(/https:\/\/dash\.cloudflare\.com[^\s]+/);
      if (m && !loginState.loginUrl) {
        loginState.loginUrl = m[0];
        if (!resolved) { resolved = true; resolve({ loginUrl: m[0] }); }
      }
    };
    child.stdout.on("data", (d) => collectUrl(d, "out"));
    child.stderr.on("data", (d) => collectUrl(d, "err"));

    child.on("exit", (code) => {
      loginProcess = null;
      loginState.inProgress = false;
      if (fs.existsSync(CERT_PATH)) {
        // success — leave loginState as final snapshot
      } else if (code !== 0) {
        // Surface cloudflared's own stderr so the UI can show the real reason
        const tail = (stderrBuf || stdoutBuf || "").trim().split("\n").slice(-3).join(" ");
        loginState.error = tail || `cloudflared login exited with code ${code}`;
      }
      if (!resolved) {
        resolved = true;
        if (fs.existsSync(CERT_PATH)) resolve({ loginUrl: loginState.loginUrl, certPath: CERT_PATH });
        else reject(new Error(loginState.error || "Login failed before producing cert"));
      }
    });

    child.on("error", (err) => {
      loginProcess = null;
      loginState.inProgress = false;
      loginState.error = err.message;
      if (!resolved) { resolved = true; reject(err); }
    });

    // Safety: if we never see a URL after 30s, surface error
    setTimeout(() => {
      if (!resolved && !loginState.loginUrl) {
        resolved = true;
        const tail = (stderrBuf || stdoutBuf || "").trim().split("\n").slice(-3).join(" ");
        reject(new Error(tail || "cloudflared login did not produce a URL in time"));
      }
    }, 30000);
  });
}

// ─── Cert parsing ────────────────────────────────────────────────────────────
// cert.pem from cloudflared 2026+ contains a single ARGO TUNNEL TOKEN block —
// a base64-encoded JSON with { accountID, zoneID, apiToken }. There is no zone
// NAME inside, so we resolve zoneID → name via the Cloudflare API and cache it.
//
// For older cloudflared releases the cert is a real X.509 with the zone in CN;
// we still try that path as a fallback.

/** Extract { accountID, zoneID, apiToken } from the cert. Returns null if missing. */
export function parseArgoTunnelToken() {
  if (!fs.existsSync(CERT_PATH)) return null;
  try {
    const pem = fs.readFileSync(CERT_PATH, "utf-8");
    const m = pem.match(/-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/);
    if (!m) return null;
    const decoded = Buffer.from(m[1].replace(/\s/g, ""), "base64").toString("utf-8");
    const json = JSON.parse(decoded);
    if (!json.zoneID || !json.apiToken) return null;
    return { accountID: json.accountID || null, zoneID: json.zoneID, apiToken: json.apiToken };
  } catch {
    return null;
  }
}

function parseX509Zones() {
  try {
    const pem = fs.readFileSync(CERT_PATH, "utf-8");
    const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
    if (blocks.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const forge = require("node-forge");
    const zones = new Set();
    for (const m of blocks) {
      try {
        const cert = forge.pki.certificateFromPem(m[0]);
        const cn = cert.subject.getField("CN")?.value;
        if (cn) zones.add(cn);
        const san = cert.getExtension("subjectAltName");
        if (san?.altNames) for (const n of san.altNames) if (n.value) zones.add(n.value);
      } catch { /* skip */ }
    }
    return [...zones];
  } catch { return []; }
}

// Cache: zoneID -> { name, fetchedAt }
const zoneNameCache = new Map();
const ZONE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchZoneName(zoneID, apiToken) {
  const cached = zoneNameCache.get(zoneID);
  if (cached && Date.now() - cached.fetchedAt < ZONE_CACHE_TTL_MS) return cached.name;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneID}`, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const name = data?.result?.name || null;
    if (name) zoneNameCache.set(zoneID, { name, fetchedAt: Date.now() });
    return name;
  } catch {
    return null;
  }
}

/**
 * Return the authorized zone names. Async because we need a CF API round-trip
 * to translate the zoneID stored in the cert into a domain name. Falls back to
 * X.509 parsing for older cloudflared cert formats.
 */
export async function parseAuthorizedZones() {
  if (!fs.existsSync(CERT_PATH)) return [];
  const token = parseArgoTunnelToken();
  if (token) {
    const name = await fetchZoneName(token.zoneID, token.apiToken);
    if (name) return [name];
    // API call failed but we know the cert is valid — show the zoneID as a
    // last-resort placeholder so the UI still reflects "authorized".
    return [token.zoneID.slice(0, 8) + "… (zone)"];
  }
  // Legacy X.509 cert path
  const legacy = parseX509Zones();
  return legacy;
}

export function hasAuthorization() {
  return fs.existsSync(CERT_PATH);
}

// ─── Named-tunnel ops (create / list / route DNS) ────────────────────────────
function runCfCli(args, opts = {}) {
  // Synchronous CLI helper. Throws on non-zero with stderr included.
  try {
    const out = execFileSync(BIN_PATH, args, {
      windowsHide: true,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return out;
  } catch (err) {
    const stderr = err.stderr?.toString?.() || "";
    const stdout = err.stdout?.toString?.() || "";
    const msg = (stderr + stdout).trim() || err.message;
    const e = new Error(`cloudflared ${args.join(" ")} failed: ${msg}`);
    e.code = err.status;
    throw e;
  }
}

export async function listTunnels() {
  await ensureCloudflared();
  // cert.pem is at the default ~/.cloudflared/cert.pem so cloudflared finds it
  // without us passing --origincert.
  const out = runCfCli(["tunnel", "list", "-o", "json"]);
  try { return JSON.parse(out); } catch { return []; }
}

/**
 * Ensure a named tunnel exists. Returns { id, name, credentialsFile }.
 * The credentials JSON is written by cloudflared next to the cert.
 */
export async function ensureNamedTunnel(name) {
  await ensureCloudflared();
  // Try to find an existing tunnel with this name (not deleted yet).
  const list = await listTunnels().catch(() => []);
  const existing = list.find((t) => t.name === name && !t.deleted_at);
  if (existing) {
    const credentialsFile = path.join(CF_HOME_DIR, `${existing.id}.json`);
    return { id: existing.id, name, credentialsFile, existed: true };
  }
  // Create a new one
  const out = runCfCli(["tunnel", "create", name]);
  // The output mentions the credentials file path; also predictably <CF_HOME>/<UUID>.json
  const uuidMatch = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!uuidMatch) throw new Error(`Could not parse tunnel UUID from output: ${out}`);
  const id = uuidMatch[0];
  const credentialsFile = path.join(CF_HOME_DIR, `${id}.json`);
  return { id, name, credentialsFile, existed: false };
}

/** Route a hostname to a tunnel via DNS CNAME. */
export async function routeDns(tunnelIdOrName, hostname) {
  await ensureCloudflared();
  runCfCli(["tunnel", "route", "dns", tunnelIdOrName, hostname]);
}

/** Delete a tunnel (must be stopped + have no active connections). */
export async function deleteNamedTunnel(tunnelIdOrName) {
  await ensureCloudflared();
  try {
    runCfCli(["tunnel", "delete", "-f", tunnelIdOrName]);
  } catch (e) {
    console.log("[cloudflared] tunnel delete failed:", e.message);
  }
}

// ─── Config + run named tunnel ───────────────────────────────────────────────
export function writeTunnelConfig({ tunnelId, credentialsFile, subdomains, localPort }) {
  const ingress = (subdomains || []).map((h) => ({ hostname: h, service: `http://127.0.0.1:${localPort}` }));
  // Trailing catch-all is required by cloudflared
  ingress.push({ service: "http_status:404" });
  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    `ingress:`,
    ...ingress.flatMap((rule) => {
      if (rule.hostname) {
        return [
          `  - hostname: ${rule.hostname}`,
          `    service: ${rule.service}`,
        ];
      }
      return [`  - service: ${rule.service}`];
    }),
    "",
  ].join("\n");
  if (!fs.existsSync(TUNNEL_DATA_DIR)) fs.mkdirSync(TUNNEL_DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, yaml, "utf-8");
  return CONFIG_PATH;
}

let cloudflaredProcess = null;
let unexpectedExitHandler = null;
export function setUnexpectedExitHandler(handler) { unexpectedExitHandler = handler; }

/**
 * Spawn `cloudflared tunnel --config <path> run <id>`. Resolves once 4 edge
 * connections are registered, or after 90s (whichever comes first).
 */
export async function spawnNamedTunnel(tunnelId, configPath) {
  const binaryPath = await ensureCloudflared();
  const child = spawn(
    binaryPath,
    ["tunnel", "--config", configPath, "run", tunnelId],
    { detached: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  cloudflaredProcess = child;
  savePid(child.pid);

  return new Promise((resolve, reject) => {
    let connections = 0;
    let resolved = false;
    const timeout = setTimeout(() => { resolved = true; resolve(child); }, 90000);

    const handleLog = (data) => {
      const msg = data.toString();
      const matches = msg.match(/Registered tunnel connection/g);
      if (matches) {
        connections += matches.length;
        if (connections >= 4 && !resolved) { resolved = true; clearTimeout(timeout); resolve(child); }
      }
    };
    child.stdout.on("data", handleLog);
    child.stderr.on("data", handleLog);

    child.on("error", (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); } });

    child.on("exit", (code) => {
      cloudflaredProcess = null;
      clearPid();
      const wasConnected = resolved;
      if (!resolved) {
        resolved = true; clearTimeout(timeout);
        const msg = code === 1
          ? `cloudflared exited with code 1 (auth/network/credential issue)`
          : `cloudflared exited with code ${code}`;
        reject(new Error(msg));
        return;
      }
      if (wasConnected && unexpectedExitHandler) unexpectedExitHandler();
    });
  });
}

// ─── Process lifecycle ───────────────────────────────────────────────────────
function killCloudflaredByPort(port) {
  if (!port) return;
  try {
    if (IS_WINDOWS) {
      const psCmd = `Get-CimInstance Win32_Process -Filter \\"Name='cloudflared.exe'\\" | Where-Object { $_.CommandLine -match ':${port}(\\D|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      execSync(`${POWERSHELL_HIDDEN_COMMAND} "${psCmd}"`, { stdio: "ignore", windowsHide: true });
    } else {
      execSync(`pkill -f "cloudflared.*:${port}([^0-9]|$)" 2>/dev/null || true`, { stdio: "ignore", windowsHide: true });
    }
  } catch { /* ignore */ }
}

export function killCloudflared(localPort) {
  if (cloudflaredProcess) {
    try { cloudflaredProcess.kill(); } catch {}
    cloudflaredProcess = null;
  }
  const pid = loadPid();
  if (pid) {
    try { process.kill(pid); } catch {}
    clearPid();
  }
  killCloudflaredByPort(localPort);
}

export function isCloudflaredRunning() {
  const pid = loadPid();
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
