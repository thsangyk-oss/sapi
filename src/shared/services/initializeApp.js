import os from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { cleanupProviderConnections, getSettings, updateSettings, getApiKeys } from "@/lib/localDb";
import {
  startTunnelIfConfigured,
  isTunnelManuallyDisabled, isTunnelReconnecting,
  getTunnelService,
} from "@/lib/tunnel/tunnelManager";
import { killCloudflared, isCloudflaredRunning, ensureCloudflared } from "@/lib/tunnel/cloudflared";
import { loadState } from "@/lib/tunnel/state";
import { checkInternet } from "@/lib/tunnel/networkProbe";
import {
  RESTART_COOLDOWN_MS, NETWORK_SETTLE_MS,
  WATCHDOG_INTERVAL_MS, NETWORK_CHECK_INTERVAL_MS,
} from "@/lib/tunnel/tunnelConfig";
import { getMitmStatus, startMitm, loadEncryptedPassword, initDbHooks, restoreToolDNS, removeAllDNSEntriesSync } from "@/mitm/manager";

// Inject correct paths and DB hooks into manager.js (CJS) from ESM context
(function bootstrapMitm() {
  if (!process.env.MITM_SERVER_PATH) {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const appSrc = dirname(dirname(thisFile));
      const candidate = join(appSrc, "mitm", "server.js");
      if (existsSync(candidate)) process.env.MITM_SERVER_PATH = candidate;
    } catch { /* ignore */ }
  }
  try { initDbHooks(getSettings, updateSettings); } catch { /* ignore */ }
})();

process.setMaxListeners(20);

// Survive Next.js hot reload
const g = global.__appSingleton ??= {
  signalHandlersRegistered: false,
  watchdogInterval: null,
  networkMonitorInterval: null,
  lastNetworkFingerprint: null,
  lastWatchdogTick: Date.now(),
  mitmStartInProgress: false,
  tunnelAutoResumed: false,
};

export async function initializeApp() {
  try {
    await cleanupProviderConnections();
    const settings = await getSettings();

    // Auto-resume tunnel (once per process) if state has subdomains configured.
    if (settings.tunnelEnabled && !g.tunnelAutoResumed) {
      g.tunnelAutoResumed = true;
      console.log("[InitApp] Tunnel was enabled, auto-resuming...");
      safeRestartTunnel("startup").catch((e) => console.log("[InitApp] Tunnel resume failed:", e.message));
    }

    if (!g.signalHandlersRegistered) {
      const cleanup = () => {
        try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
        killCloudflared();
        process.exit();
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("exit", () => { try { removeAllDNSEntriesSync(); } catch { /* ignore */ } });
      g.signalHandlersRegistered = true;
    }

    ensureCloudflared().catch(() => {});

    startWatchdog();
    startNetworkMonitor();
    autoStartMitm();
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

async function autoStartMitm() {
  if (g.mitmStartInProgress) return;
  g.mitmStartInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.mitmEnabled) return;
    const mitmStatus = await getMitmStatus();
    if (mitmStatus.running) return;

    const password = await loadEncryptedPassword();
    if (!password && process.platform !== "win32") {
      console.log("[InitApp] MITM was enabled but no saved password found, skipping auto-start");
      return;
    }

    const keys = await getApiKeys();
    const activeKey = keys.find(k => k.isActive !== false);

    console.log("[InitApp] MITM was enabled, auto-starting...");
    await startMitm(activeKey?.key || "sk_9router", password);
    console.log("[InitApp] MITM auto-started");
    try {
      await restoreToolDNS(password);
      console.log("[InitApp] DNS restored from saved state");
    } catch (e) {
      console.log("[InitApp] DNS restore failed:", e.message);
    }
  } catch (err) {
    console.log("[InitApp] MITM auto-start failed:", err.message);
  } finally {
    g.mitmStartInProgress = false;
  }
}

// ─── Safe restart (4 guards: spawn / cooldown / alive / internet) ────────────

async function safeRestartTunnel(reason) {
  const svc = getTunnelService();
  const settings = await getSettings();
  if (!settings.tunnelEnabled) return;
  if (svc.cancelToken.cancelled) return;
  if (svc.spawnInProgress) return;
  if (Date.now() - svc.lastRestartAt < RESTART_COOLDOWN_MS) return;

  const state = loadState();
  if (!Array.isArray(state?.subdomains) || state.subdomains.length === 0) return;

  // Trust the cloudflared process: if it's alive, the tunnel is fine.
  // Local HTTP probes are unreliable on restricted networks (corporate DNS
  // often blocks the new CNAME) and would otherwise cause an infinite
  // respawn loop → duplicate connectors → permanent "Reconnecting".
  if (isCloudflaredRunning()) return;

  if (!await checkInternet()) return;

  console.log(`[Tunnel] safeRestart (${reason})`);
  try {
    await startTunnelIfConfigured();
    svc.lastRestartAt = Date.now();
    console.log("[Tunnel] restart success");
  } catch (err) {
    console.log("[Tunnel] restart failed:", err.message);
  }
}

// ─── Watchdog: 60s tick check both services ──────────────────────────────────

function startWatchdog() {
  if (g.watchdogInterval) return;
  g.watchdogInterval = setInterval(() => {
    safeRestartTunnel("watchdog").catch(() => {});
  }, WATCHDOG_INTERVAL_MS);
  if (g.watchdogInterval.unref) g.watchdogInterval.unref();
}

// ─── Network monitor: detect IPv4 fingerprint change + sleep/wake ────────────

function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }
  return active.sort().join("|");
}

function startNetworkMonitor() {
  if (g.networkMonitorInterval) return;

  g.lastNetworkFingerprint = getNetworkFingerprint();
  g.lastWatchdogTick = Date.now();

  g.networkMonitorInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsed = now - g.lastWatchdogTick;
      g.lastWatchdogTick = now;

      const currentFingerprint = getNetworkFingerprint();
      const networkChanged = currentFingerprint !== g.lastNetworkFingerprint;
      const wasSleep = elapsed > NETWORK_CHECK_INTERVAL_MS * 3;

      if (networkChanged) g.lastNetworkFingerprint = currentFingerprint;
      if (!networkChanged && !wasSleep) return;

      // Wait for DHCP/DNS to settle before probing
      await new Promise((r) => setTimeout(r, NETWORK_SETTLE_MS));

      const reason = wasSleep && networkChanged ? "sleep+netchange"
        : wasSleep ? "sleep" : "netchange";
      safeRestartTunnel(reason).catch(() => {});
    } catch (err) {
      console.log("[NetworkMonitor] error:", err.message);
    }
  }, NETWORK_CHECK_INTERVAL_MS);

  if (g.networkMonitorInterval.unref) g.networkMonitorInterval.unref();
}

export default initializeApp;
