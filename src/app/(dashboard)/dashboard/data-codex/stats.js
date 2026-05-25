// Dashboard-side aggregations for the Data Codex page.
//
// Token-equivalence constant comes from an empirical measurement of three
// G1 free-plan codex accounts (avg 7,464 tokens per 1% of the weekly window).
// See scripts/measure-codex-token-equivalence.mjs.

export const TOKENS_PER_PERCENT = 7464;
export const TOKENS_PER_ACC_FULL = TOKENS_PER_PERCENT * 100; // ~746,400 / acc / week

export const GROUP_ORDER = ["group1", "group2", "group3", "group4", "group5", "groupError"];

export function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return `${Math.round(Number(n) * 10) / 10}%`;
}

export function computeStats(data) {
  if (!data) return null;

  const perGroup = {};
  for (const g of GROUP_ORDER) {
    const accs = data.groups?.[g]?.accounts || [];
    const checked = accs.filter((a) => a.quotaPercent !== null && a.quotaPercent !== undefined);
    const sumPct = checked.reduce((s, a) => s + Number(a.quotaPercent || 0), 0);
    perGroup[g] = {
      count: accs.length,
      checkedCount: checked.length,
      avgPct: checked.length > 0 ? sumPct / checked.length : null,
      sumPct,
      tokensLeft: sumPct * TOKENS_PER_PERCENT, // tokens currently available
    };
  }

  const totalAccs = GROUP_ORDER.reduce((s, g) => s + perGroup[g].count, 0);

  // Quota-state buckets (token-weighted). G3/4/5 + Err are NOT usable now but
  // will return to full after their reset (Err on a successful retry).
  const usableNow = perGroup.group1.tokensLeft + perGroup.group2.tokensLeft;
  const recoveringSoon = perGroup.group3.count * TOKENS_PER_ACC_FULL;
  const recoveringMid = perGroup.group4.count * TOKENS_PER_ACC_FULL;
  const recoveringFar = perGroup.group5.count * TOKENS_PER_ACC_FULL;
  const lost = perGroup.groupError.count * TOKENS_PER_ACC_FULL;
  const grandTotal = usableNow + recoveringSoon + recoveringMid + recoveringFar + lost;

  return {
    perGroup,
    totalAccs,
    grandTotal,
    usableNow,
    recoveringSoon,
    recoveringMid,
    recoveringFar,
    lost,
  };
}

// Histogram of `hoursUntilReset` for G3/G4/G5 accounts.
// Bins are chosen to map cleanly onto the group cutoffs (24h / 72h).
export function computeResetHistogram(data) {
  if (!data) return [];
  const accs = [
    ...(data.groups?.group3?.accounts || []),
    ...(data.groups?.group4?.accounts || []),
    ...(data.groups?.group5?.accounts || []),
  ];
  const bins = [
    { label: "0-6h", min: 0, max: 6, group: "group3" },
    { label: "6-12h", min: 6, max: 12, group: "group3" },
    { label: "12-24h", min: 12, max: 24, group: "group3" },
    { label: "24-48h", min: 24, max: 48, group: "group4" },
    { label: "48-72h", min: 48, max: 72, group: "group4" },
    { label: "72h-7d", min: 72, max: 168, group: "group5" },
    { label: ">7d", min: 168, max: Infinity, group: "group5" },
  ].map((b) => ({ ...b, count: 0 }));

  for (const acc of accs) {
    const h = Number(acc.hoursUntilReset);
    if (!Number.isFinite(h)) continue;
    const bin = bins.find((b) => h >= b.min && h < b.max);
    if (bin) bin.count += 1;
  }
  return bins;
}

// Histogram of quotaPercent within one group (used for G1/G2 cards).
export function computeQuotaHistogram(accounts) {
  const bins = [
    { label: "0-10%", min: 0, max: 10 },
    { label: "10-25%", min: 10, max: 25 },
    { label: "25-50%", min: 25, max: 50 },
    { label: "50-75%", min: 50, max: 75 },
    { label: "75-100%", min: 75, max: 100.001 },
  ].map((b) => ({ ...b, count: 0 }));

  for (const acc of accounts || []) {
    const p = Number(acc.quotaPercent);
    if (!Number.isFinite(p)) continue;
    const bin = bins.find((b) => p >= b.min && p < b.max);
    if (bin) bin.count += 1;
  }
  return bins;
}

export const GROUP_COLORS = {
  group1: "#10b981", // green-500
  group2: "#3b82f6", // blue-500
  group3: "#f59e0b", // amber-500
  group4: "#facc15", // yellow-400
  group5: "#94a3b8", // slate-400
  groupError: "#ef4444", // red-500
};

export const QUOTA_STATE_COLORS = {
  usableNow: "#10b981",      // green
  recoveringSoon: "#f59e0b", // amber (G3)
  recoveringMid: "#facc15",  // yellow (G4)
  recoveringFar: "#94a3b8",  // slate (G5)
  lost: "#ef4444",            // red (Err)
};
