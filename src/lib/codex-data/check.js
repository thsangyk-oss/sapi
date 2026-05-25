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
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
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
async function refreshInMemory(account, { force = false, proxyOptions } = {}) {
  const executor = getExecutor(account.provider);
  const credentials = {
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt || account.tokenExpiresAt,
    providerSpecificData: account.providerSpecificData,
  };
  const needsRefresh = force || executor.needsRefresh(credentials);
  if (!needsRefresh) return { patch: {}, refreshed: false };

  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);
  if (!refreshResult) {
    if (account.accessToken) return { patch: {}, refreshed: false };
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  const patch = { updatedAt: new Date().toISOString() };
  if (refreshResult.accessToken) patch.accessToken = refreshResult.accessToken;
  if (refreshResult.refreshToken) patch.refreshToken = refreshResult.refreshToken;
  if (refreshResult.expiresIn) {
    patch.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
  } else if (refreshResult.expiresAt) {
    patch.expiresAt = refreshResult.expiresAt;
  }
  return { patch, refreshed: true };
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
  try {
    const r = await refreshInMemory(account, { force: false, proxyOptions });
    refreshPatch = r.patch;
  } catch (err) {
    return {
      account,
      usage: { error: `Credential refresh failed: ${err.message}` },
      refreshed: false,
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
      refreshPatch = { ...refreshPatch, ...retry.patch };
      updatedAccount = { ...updatedAccount, ...retry.patch };
      usage = await getUsageForProvider(updatedAccount, proxyOptions);
    } catch (err) {
      usage = { error: `Force-refresh failed: ${err.message}` };
    }
  }

  if (persistToDb && Object.keys(refreshPatch).length > 0) {
    try { await updateProviderConnection(account.id, refreshPatch); } catch { /* best-effort */ }
  }

  return { account: updatedAccount, usage, refreshed: Object.keys(refreshPatch).length > 0 };
}
