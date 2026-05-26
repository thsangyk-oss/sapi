import {
  ensureCloudflared,
  killCloudflared,
  isCloudflaredRunning,
  setUnexpectedExitHandler,
  startLogin,
  cancelLogin,
  getLoginState,
  hasAuthorization,
  parseAuthorizedZones,
  ensureNamedTunnel,
  routeDns,
  writeTunnelConfig,
  spawnNamedTunnel,
  deleteNamedTunnel,
  getDownloadStatus,
  CERT_PATH,
} from "./cloudflared.js";
import { loadState, saveState, clearState } from "./state.js";
import { getSettings, updateSettings } from "@/lib/localDb";
import { waitForHealth, probeUrlAlive } from "./networkProbe.js";

const DEFAULT_TUNNEL_NAME = "sapi-local";

// In-process service state — separate from persistent state.json
const svc = {
  cancelToken: { cancelled: false },
  spawnInProgress: false,
  lastRestartAt: 0,
  activeLocalPort: null,
};

export function getTunnelService() { return svc; }
export function isTunnelManuallyDisabled() { return svc.cancelToken.cancelled; }
export function isTunnelReconnecting() { return svc.spawnInProgress; }

// ─── Persistent state helpers ────────────────────────────────────────────────
// state.json schema:
// {
//   tunnelId: string|null,
//   tunnelName: string|null,
//   credentialsFile: string|null,
//   subdomains: string[]
// }

function readState() {
  const s = loadState() || {};
  return {
    tunnelId: s.tunnelId || null,
    tunnelName: s.tunnelName || null,
    credentialsFile: s.credentialsFile || null,
    subdomains: Array.isArray(s.subdomains) ? s.subdomains : [],
  };
}

function writeState(next) {
  const current = readState();
  saveState({ ...current, ...next });
}

function isHostInZones(hostname, zones) {
  const host = (hostname || "").toLowerCase();
  return zones.some((z) => {
    const zone = z.toLowerCase();
    return host === zone || host.endsWith("." + zone);
  });
}

function validateSubdomain(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) throw new Error("hostname is required");
  // Simple FQDN sanity check
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error("Invalid hostname format");
  }
  return host;
}

// Mirror tunnelHosts into settings so other code (dashboardGuard) can read them
// without touching the tunnel state file.
async function syncSettingsHosts() {
  const state = readState();
  const primary = state.subdomains[0] || "";
  await updateSettings({
    tunnelEnabled: state.subdomains.length > 0,
    tunnelUrl: primary ? `https://${primary}` : "",
    tunnelHosts: state.subdomains,
  });
}

// ─── Authorization flow (cloudflared tunnel login) ───────────────────────────
export async function startAuthorize() {
  return startLogin();
}

export async function getAuthorizeStatus() {
  const login = getLoginState();
  const zones = await parseAuthorizedZones();
  return {
    authorized: hasAuthorization() && zones.length > 0,
    certPath: hasAuthorization() ? CERT_PATH : null,
    zones,
    login: {
      inProgress: login.inProgress,
      loginUrl: login.loginUrl,
      error: login.error,
    },
  };
}

export function cancelAuthorize() {
  cancelLogin();
  return { cancelled: true };
}

/**
 * Disconnect SAPI from the user's Cloudflare account:
 *   - stop the running tunnel
 *   - delete the SAPI-managed named tunnel from Cloudflare (the credentials JSON
 *     and DNS records remain — the latter can only be removed via dashboard)
 *   - clear local state and tunnelHosts
 *
 * Note: we deliberately do NOT delete ~/.cloudflared/cert.pem. That file may
 * be shared with the user's manual cloudflared usage, and they can run
 * `cloudflared tunnel logout` themselves if they want a clean wipe.
 */
export async function revokeAuthorization() {
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);
  killCloudflared(svc.activeLocalPort);

  const state = readState();
  if (state.tunnelId) {
    try { await deleteNamedTunnel(state.tunnelId); } catch { /* ignore */ }
  }
  // Drop the credentials JSON we manage; leave the user's cert.pem alone.
  if (state.credentialsFile) {
    const fs = await import("fs");
    try { if (fs.existsSync(state.credentialsFile)) fs.unlinkSync(state.credentialsFile); } catch {}
  }
  clearState();
  await updateSettings({ tunnelEnabled: false, tunnelUrl: "", tunnelHosts: [] });
  return { success: true };
}

// ─── Subdomain management ────────────────────────────────────────────────────
export async function addSubdomain(hostname, localPort = 20128) {
  const host = validateSubdomain(hostname);
  if (!hasAuthorization()) throw new Error("Not authorized. Run authorize first.");
  const zones = await parseAuthorizedZones();
  if (!isHostInZones(host, zones)) {
    throw new Error(`Host ${host} is not under an authorized zone (${zones.join(", ") || "none"}). Re-authorize the parent domain first.`);
  }

  // Ensure the tunnel exists
  let state = readState();
  if (!state.tunnelId) {
    const tunnel = await ensureNamedTunnel(state.tunnelName || DEFAULT_TUNNEL_NAME);
    state = {
      ...state,
      tunnelId: tunnel.id,
      tunnelName: tunnel.name,
      credentialsFile: tunnel.credentialsFile,
    };
    writeState(state);
  }

  // Add DNS route (idempotent — cloudflared returns success or "exists")
  await routeDns(state.tunnelId, host);

  // Append subdomain (dedupe)
  if (!state.subdomains.includes(host)) {
    state = { ...state, subdomains: [...state.subdomains, host] };
    writeState(state);
  }

  await restartTunnel(localPort);
  await syncSettingsHosts();
  return { hostname: host, subdomains: state.subdomains };
}

export async function removeSubdomain(hostname, localPort = 20128) {
  const host = String(hostname || "").trim().toLowerCase();
  const state = readState();
  const next = state.subdomains.filter((h) => h !== host);
  if (next.length === state.subdomains.length) return { removed: false, subdomains: state.subdomains };
  writeState({ subdomains: next });
  await restartTunnel(localPort);
  await syncSettingsHosts();
  // NB: The CNAME on Cloudflare's side is left orphaned. cloudflared CLI has
  // no `route dns delete`; user must remove via dashboard if they care.
  return { removed: true, subdomains: next };
}

// ─── Tunnel lifecycle ────────────────────────────────────────────────────────
async function restartTunnel(localPort) {
  svc.cancelToken = { cancelled: false };
  svc.activeLocalPort = localPort;
  killCloudflared(localPort);

  const state = readState();
  if (!state.tunnelId || state.subdomains.length === 0) return; // nothing to run

  svc.spawnInProgress = true;
  try {
    const configPath = writeTunnelConfig({
      tunnelId: state.tunnelId,
      credentialsFile: state.credentialsFile,
      subdomains: state.subdomains,
      localPort,
    });
    await spawnNamedTunnel(state.tunnelId, configPath);
    svc.lastRestartAt = Date.now();

    // Verify the first subdomain serves /api/health (DNS may take a few seconds
    // to propagate at the Cloudflare edge after `route dns`).
    const publicUrl = `https://${state.subdomains[0]}`;
    try { await waitForHealth(publicUrl, svc.cancelToken); } catch { /* warn but don't fail */ }
  } finally {
    svc.spawnInProgress = false;
  }
}

export async function startTunnelIfConfigured(localPort = 20128) {
  const state = readState();
  if (!state.tunnelId || state.subdomains.length === 0) return { skipped: true };
  if (isCloudflaredRunning()) {
    if (await probeUrlAlive(`https://${state.subdomains[0]}`)) {
      return { alreadyRunning: true };
    }
  }
  await restartTunnel(localPort);
  return { started: true };
}

export async function disableTunnel() {
  svc.cancelToken.cancelled = true;
  setUnexpectedExitHandler(null);
  killCloudflared(svc.activeLocalPort);
  await updateSettings({ tunnelEnabled: false });
  return { success: true };
}

// ─── Status (for /api/tunnel/status) ─────────────────────────────────────────
export async function getTunnelStatus() {
  const state = readState();
  const zones = await parseAuthorizedZones();
  const settings = await getSettings();
  const login = getLoginState();
  const running = isCloudflaredRunning();

  return {
    authorized: hasAuthorization() && zones.length > 0,
    zones,
    tunnelId: state.tunnelId,
    tunnelName: state.tunnelName,
    subdomains: state.subdomains,
    primaryUrl: state.subdomains[0] ? `https://${state.subdomains[0]}` : "",
    enabled: state.subdomains.length > 0 && running,
    settingsEnabled: settings.tunnelEnabled === true,
    running,
    reconnecting: svc.spawnInProgress,
    login: {
      inProgress: login.inProgress,
      loginUrl: login.loginUrl,
      error: login.error,
    },
    download: getDownloadStatus(),
  };
}
