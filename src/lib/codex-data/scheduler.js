// Background scheduler for Data Codex hourly maintenance.
//
// Singleton — survives module hot-reload by stashing handles on globalThis.
// Persists `lastRun`, `nextRun`, and `enabled` inside codex-data.json so the
// dashboard banner is consistent across process restarts.

import { loadCodexData, saveCodexData } from "@/lib/codex-data/storage";
import { runCycle } from "@/lib/codex-data/auto-redistribute";

const STATE_KEY = "__sapi_codex_scheduler__";
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 30 * 1000; // give server 30s to warm up before first tick

function getState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = {
      interval: null,
      running: false,
      enabled: true,
      lastRun: null,
      lastResult: null,
      nextRun: null,
      intervalMs: DEFAULT_INTERVAL_MS,
      starting: false,
    };
  }
  return globalThis[STATE_KEY];
}

async function loadPersistedState() {
  try {
    const data = await loadCodexData();
    return data.scheduler || null;
  } catch { return null; }
}

async function persistState(patch) {
  try {
    const data = await loadCodexData();
    const scheduler = { ...(data.scheduler || {}), ...patch };
    await saveCodexData({ ...data, scheduler });
  } catch { /* best-effort */ }
}

async function tick() {
  const s = getState();
  if (s.running || !s.enabled) {
    // Schedule next regardless.
    s.nextRun = Date.now() + s.intervalMs;
    return;
  }
  s.running = true;
  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    result = await runCycle({ concurrency: 5 });
  } catch (err) {
    error = err.message;
    console.error("[codex-scheduler] tick failed:", err);
  } finally {
    const finishedAt = Date.now();
    s.running = false;
    s.lastRun = startedAt;
    s.lastResult = { startedAt, finishedAt, durationMs: finishedAt - startedAt, ok: !error, error, result };
    s.nextRun = finishedAt + s.intervalMs;
    await persistState({
      lastRun: s.lastRun,
      lastResult: s.lastResult,
      nextRun: s.nextRun,
      enabled: s.enabled,
      intervalMs: s.intervalMs,
    });
  }
}

export async function start() {
  const s = getState();
  if (s.interval || s.starting) return;
  s.starting = true;

  // Restore persisted prefs.
  const persisted = await loadPersistedState();
  if (persisted) {
    if (typeof persisted.enabled === "boolean") s.enabled = persisted.enabled;
    if (typeof persisted.intervalMs === "number" && persisted.intervalMs >= 60_000) s.intervalMs = persisted.intervalMs;
    if (typeof persisted.lastRun === "number") s.lastRun = persisted.lastRun;
    if (persisted.lastResult) s.lastResult = persisted.lastResult;
  }

  // Compute initial delay: respect lastRun if recent, else use STARTUP_DELAY_MS.
  const nowMs = Date.now();
  let initialDelay = STARTUP_DELAY_MS;
  if (s.lastRun) {
    const elapsed = nowMs - s.lastRun;
    if (elapsed < s.intervalMs) initialDelay = Math.max(STARTUP_DELAY_MS, s.intervalMs - elapsed);
  }
  s.nextRun = nowMs + initialDelay;
  await persistState({ enabled: s.enabled, intervalMs: s.intervalMs, nextRun: s.nextRun });

  s.starting = false;

  s.interval = setTimeout(async function loop() {
    await tick();
    s.interval = setTimeout(loop, s.intervalMs);
  }, initialDelay);

  console.log(`[codex-scheduler] started; first tick in ${Math.round(initialDelay / 1000)}s, interval ${Math.round(s.intervalMs / 1000)}s`);
}

export function stop() {
  const s = getState();
  if (s.interval) {
    clearTimeout(s.interval);
    s.interval = null;
  }
}

export async function setEnabled(enabled) {
  const s = getState();
  s.enabled = !!enabled;
  await persistState({ enabled: s.enabled });
  return getStatus();
}

export async function setIntervalMs(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
    throw new Error("intervalMs must be ≥ 60000 (60 seconds)");
  }
  const s = getState();
  s.intervalMs = Math.floor(intervalMs);
  // Reset timer with new interval.
  if (s.interval) clearTimeout(s.interval);
  s.nextRun = Date.now() + s.intervalMs;
  await persistState({ intervalMs: s.intervalMs, nextRun: s.nextRun });
  s.interval = setTimeout(async function loop() {
    await tick();
    s.interval = setTimeout(loop, s.intervalMs);
  }, s.intervalMs);
  return getStatus();
}

export async function runNow() {
  await tick();
  return getStatus();
}

export function getStatus() {
  const s = getState();
  return {
    enabled: s.enabled,
    running: s.running,
    intervalMs: s.intervalMs,
    lastRun: s.lastRun,
    nextRun: s.nextRun,
    lastResult: s.lastResult,
  };
}
