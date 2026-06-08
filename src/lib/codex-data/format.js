// Shared formatters for codex-data check results.

export function makeResult(acc, classification, summary, error, meta = {}) {
  const { quotaUsed, quotaTotal, quotaPercent } = computeQuotaTotals(summary);
  const earliestResetAt = summary?.earliestResetAt || null;
  const hoursUntilReset = earliestResetAt
    ? Math.max(0, Math.round((new Date(earliestResetAt).getTime() - Date.now()) / 36e5 * 10) / 10)
    : null;
  const refreshStatus = meta.refreshStatus || null;
  return {
    id: acc.id,
    name: acc.name || acc.email || acc.id,
    classification,
    quotaUsed,
    quotaTotal,
    quotaPercent,
    earliestResetAt,
    hoursUntilReset,
    error,
    refreshed: meta.refreshed ?? refreshStatus?.refreshed ?? false,
    refreshStatus: refreshStatus?.status || acc.lastRefreshStatus || null,
    refreshError: refreshStatus?.error || acc.lastRefreshError || null,
  };
}

export function computeQuotaTotals(summary) {
  if (!summary || !Array.isArray(summary.quotas) || summary.quotas.length === 0) {
    return { quotaUsed: null, quotaTotal: null, quotaPercent: null };
  }
  let used = 0;
  let total = 0;
  let worstRemainingPct = null;
  for (const q of summary.quotas) {
    const u = Number(q.used);
    const t = Number(q.total);
    if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) continue;
    used += u;
    total += t;
    const remPct = ((t - u) / t) * 100;
    if (worstRemainingPct === null || remPct < worstRemainingPct) worstRemainingPct = remPct;
  }
  if (total === 0) return { quotaUsed: null, quotaTotal: null, quotaPercent: null };
  const pct = worstRemainingPct ?? ((total - used) / total) * 100;
  return { quotaUsed: used, quotaTotal: total, quotaPercent: Math.round(pct * 10) / 10 };
}

export function buildSummary(usage) {
  if (!usage || usage.error) return null;
  const quotas = normalizeQuotas(usage.quotas);
  if (quotas.length === 0) return null;
  const earliestReset = quotas
    .map((q) => q.resetAt && new Date(q.resetAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0] || null;
  return {
    quotas: quotas.map((q) => ({ name: q.name, used: q.used, total: q.total, resetAt: q.resetAt })),
    earliestResetAt: earliestReset ? new Date(earliestReset).toISOString() : null,
  };
}

export function normalizeQuotas(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([name, q]) => ({ name, ...q }));
  }
  return [];
}
