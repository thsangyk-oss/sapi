// Refresh OAuth + fetch quota for a single codex account snapshot.
// Mirrors src/app/api/usage/[connectionId]/route.js but works on any
// account object (in-DB or codex-data.json snapshot) and lets the caller
// decide whether to persist refreshed tokens back to the database.

import "open-sse/index.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { updateProviderConnection } from "@/lib/localDb";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  const msg = [usage?.message, usage?.error].filter(Boolean).join(" ").toLowerCase();
  if (!msg) return false;
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

function describeRefreshError(result, fallback = "Refresh returned no credentials") {
  if (!result) return fallback;
  if (typeof result === "string") return result;
  if (result.error === "unrecoverable_refresh_error") {
    return `Refresh token invalid or already used${result.code ? ` (${result.code})` : ""}`;
  }
  if (result.error) {
    return `${result.error}${result.code ? ` (${result.code})` : ""}${result.status ? ` HTTP ${result.status}` : ""}`;
  }
  return fallback;
}

function emptyRefreshStatus() {
  return {
    attempted: false,
    refreshed: false,
    status: "not_needed",
    error: null,
    attempts: [],
  };
}

function mergeRefreshStatus(current, result, reason) {
  if (!result) return current;
  const next = { ...current, attempts: current.attempts.slice() };
  if (result.attempted) {
    next.attempted = true;
    next.status = result.refreshed ? "refreshed" : "failed";
    next.attempts.push({
      reason,
      refreshed: !!result.refreshed,
      error: result.error || null,
    });
  }
  if (result.refreshed) {
    next.refreshed = true;
    next.status = "refreshed";
    next.error = null;
  } else if (result.error) {
    next.error = result.error;
  }
  return next;
}

export function buildRefreshStatusPatch(refreshStatus) {
  if (!refreshStatus) return {};
  const patch = {
    lastRefreshStatus: refreshStatus.status,
    lastRefreshError: refreshStatus.error || null,
  };
  if (refreshStatus.attempted) patch.lastRefreshAttemptedAt = new Date().toISOString();
  if (refreshStatus.refreshed) patch.lastRefreshedAt = new Date().toISOString();
  return patch;
}

async function buildProxyOptions(account) {
  const proxyConfig = await resolveConnectionProxyConfig(account.providerSpecificData);
  return {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
}

// Refresh credentials in-memory; returns the updated patch (may be empty).
// Does not write anywhere. Caller is responsible for persistence.
// Exported so the scheduler can run preemptive token-renewal sweeps without
// the cost of a full quota fetch.
export async function refreshAccountInMemory(account, { force = false } = {}) {
  const proxyOptions = await buildProxyOptions(account);
  return refreshInMemory(account, { force, proxyOptions });
}

async function refreshInMemory(account, { force = false, proxyOptions } = {}) {
  const executor = getExecutor(account.provider);
  const credentials = {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt || account.tokenExpiresAt,
    providerSpecificData: account.providerSpecificData,
  };
  const needsRefresh = force || executor.needsRefresh(credentials);
  if (!needsRefresh) return { patch: {}, refreshed: false, attempted: false, error: null };

  if (!credentials.refreshToken) {
    const error = "No refresh token available";
    if (account.accessToken) return { patch: {}, refreshed: false, attempted: true, error };
    throw new Error(error);
  }

  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);
  if (!refreshResult) {
    const error = describeRefreshError(refreshResult);
    if (account.accessToken) return { patch: {}, refreshed: false, attempted: true, error };
    throw new Error(`${error}. Please re-authorize the connection.`);
  }

  if (refreshResult.error || !refreshResult.accessToken) {
    const error = describeRefreshError(refreshResult, "Refresh response did not include an access token");
    if (account.accessToken) return { patch: {}, refreshed: false, attempted: true, error };
    throw new Error(`${error}. Please re-authorize the connection.`);
  }

  const patch = { updatedAt: new Date().toISOString() };
  if (refreshResult.accessToken) patch.accessToken = refreshResult.accessToken;
  if (refreshResult.refreshToken) patch.refreshToken = refreshResult.refreshToken;
  if (refreshResult.expiresIn) {
    patch.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
  } else if (refreshResult.expiresAt) {
    patch.expiresAt = refreshResult.expiresAt;
  }
  return { patch, refreshed: true, attempted: true, error: null };
}

/**
 * Check a codex account's quota.
 *
 * @param {object} account - Connection-shaped object (id, provider, accessToken, refreshToken, expiresAt, providerSpecificData)
 * @param {object} opts
 * @param {boolean} opts.persistToDb - When true, writes refreshed tokens back to db.providerConnections via updateProviderConnection
 * @returns {Promise<{ account, usage, refreshed }>}
 *          account is the (possibly token-refreshed) account snapshot.
 *          usage is the quota response from getUsageForProvider (may contain {error} or {message}).
 */
export async function checkAccountQuota(account, { persistToDb = false } = {}) {
  if (!account || account.provider !== "codex") {
    throw new Error("checkAccountQuota: only codex accounts are supported");
  }

  const proxyOptions = await buildProxyOptions(account);

  // First refresh attempt (non-forced).
  let refreshPatch = {};
  let refreshStatus = emptyRefreshStatus();
  try {
    const r = await refreshInMemory(account, { force: false, proxyOptions });
    refreshStatus = mergeRefreshStatus(refreshStatus, r, "expiry");
    refreshPatch = r.patch;
  } catch (err) {
    refreshStatus = mergeRefreshStatus(refreshStatus, {
      attempted: true,
      refreshed: false,
      error: err.message,
    }, "expiry");
    return {
      account: { ...account, ...buildRefreshStatusPatch(refreshStatus) },
      usage: { error: `Credential refresh failed: ${err.message}` },
      refreshed: false,
      refreshStatus,
    };
  }

  let updatedAccount = { ...account, ...refreshPatch };

  let usage;
  try {
    usage = await getUsageForProvider(updatedAccount, proxyOptions);
  } catch (err) {
    usage = { error: err.message };
  }

  // Retry once with forced refresh on auth-expired hint.
  if (isAuthExpiredMessage(usage) && updatedAccount.refreshToken) {
    try {
      const retry = await refreshInMemory(updatedAccount, { force: true, proxyOptions });
      refreshStatus = mergeRefreshStatus(refreshStatus, retry, "auth_error");
      if (!retry.refreshed) {
        usage = {
          ...usage,
          error: `Credential refresh failed after auth error: ${retry.error || "unknown refresh failure"}`,
        };
      } else {
        refreshPatch = { ...refreshPatch, ...retry.patch };
        updatedAccount = { ...updatedAccount, ...retry.patch };
        usage = await getUsageForProvider(updatedAccount, proxyOptions);
      }
    } catch (err) {
      refreshStatus = mergeRefreshStatus(refreshStatus, {
        attempted: true,
        refreshed: false,
        error: err.message,
      }, "auth_error");
      usage = { error: `Force-refresh failed: ${err.message}` };
    }
  } else if (isAuthExpiredMessage(usage) && !updatedAccount.refreshToken) {
    refreshStatus = mergeRefreshStatus(refreshStatus, {
      attempted: true,
      refreshed: false,
      error: "Authentication expired and no refresh token is available",
    }, "auth_error");
    usage = {
      ...usage,
      error: "Authentication expired and no refresh token is available",
    };
  }

  const refreshStatusPatch = buildRefreshStatusPatch(refreshStatus);
  updatedAccount = { ...updatedAccount, ...refreshStatusPatch };

  if (persistToDb && Object.keys({ ...refreshPatch, ...refreshStatusPatch }).length > 0) {
    try { await updateProviderConnection(account.id, { ...refreshPatch, ...refreshStatusPatch }); } catch { /* best-effort */ }
  }

  return {
    account: updatedAccount,
    usage,
    refreshed: refreshStatus.refreshed,
    refreshStatus,
  };
}
