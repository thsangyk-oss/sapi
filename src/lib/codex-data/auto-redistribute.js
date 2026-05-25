// Hourly maintenance for Data Codex.
//
//  reclassifyResetGroups: re-buckets accounts in G3/G4/G5 based on their stored
//    `lastQuotaSummary.earliestResetAt` vs current time. No API calls — purely
//    a re-shuffle of stored snapshots:
//      - resetAt has passed              → move to G2 (assume quota restored,
//                                          will be confirmed on next G1 cycle)
//      - resetAt < 24h ahead             → move to G3
//      - resetAt 24..72h ahead           → move to G4
//      - resetAt > 72h ahead             → move to G5
//      - resetAt missing                 → leave alone
//
//  cycleGroup1: actively checks every group1 account's quota (API), evicts
//    exhausted accounts to G3/G4/G5 based on their resetAt, then refills the
//    db.providerConnections pool from G2 (sorted by quotaPercent ASC) until
//    GROUP1_LIMIT is reached.

import {
  getProviderConnections,
  createProviderConnection,
  deleteProviderConnection,
  updateProviderConnection,
} from "@/lib/localDb";
import {
  loadCodexData,
  addAccountToGroup,
  removeAccountFromGroup,
  updateAccountInGroup,
} from "@/lib/codex-data/storage";
import { checkAccountQuota } from "@/lib/codex-data/check";
import { classifyQuota } from "@/lib/codex-data/categorize";
import { computeQuotaTotals, buildSummary } from "@/lib/codex-data/format";

const GROUP1_LIMIT = 70;
const HOUR_MS = 3600 * 1000;
const RESET_GROUPS = ["group3", "group4", "group5"];

// Pure: given stored earliestResetAt + now, return one of:
//   "active" (reset passed → assumed has quota), "reset_lt24",
//   "reset_24_72", "reset_gt72", or null (no resetAt → cannot decide).
function bucketByResetAt(resetAtIso, now = Date.now()) {
  if (!resetAtIso) return null;
  const t = new Date(resetAtIso).getTime();
  if (!Number.isFinite(t)) return null;
  const deltaH = (t - now) / HOUR_MS;
  if (deltaH <= 0) return "active";
  if (deltaH < 24) return "reset_lt24";
  if (deltaH < 72) return "reset_24_72";
  return "reset_gt72";
}

const BUCKET_TO_GROUP = {
  reset_lt24: "group3",
  reset_24_72: "group4",
  reset_gt72: "group5",
};

export async function reclassifyResetGroups({ now = Date.now(), concurrency = 5 } = {}) {
  const stored = await loadCodexData();
  const moves = [];
  const expiredAccs = []; // { acc, sourceGroup } — resetAt has passed, needs API check

  // Phase 1: local re-bucket for accounts whose resetAt is still in the future.
  // Accounts whose reset has passed get queued for a real quota check.
  for (const sourceGroup of RESET_GROUPS) {
    const arr = (stored.groups[sourceGroup] || []).slice();
    for (const acc of arr) {
      const resetAt = acc.lastQuotaSummary?.earliestResetAt || null;
      const bucket = bucketByResetAt(resetAt, now);
      if (!bucket) continue;
      if (bucket === "active") {
        // resetAt passed → defer to phase 2 (check API before deciding).
        expiredAccs.push({ acc, sourceGroup });
        continue;
      }
      const target = BUCKET_TO_GROUP[bucket];
      if (!target || target === sourceGroup) continue;
      try {
        await removeAccountFromGroup(sourceGroup, acc.id);
        await addAccountToGroup(target, acc);
        moves.push({ id: acc.id, name: acc.name || acc.email, from: sourceGroup, to: target, bucket, method: "local" });
      } catch (err) {
        moves.push({ id: acc.id, name: acc.name || acc.email, from: sourceGroup, to: target, error: err.message, method: "local" });
      }
    }
  }

  // Phase 2: for expired accs, call quota API to confirm state before moving.
  // Verified-active → G2, still-resetting → corresponding bucket, error → groupError.
  if (expiredAccs.length > 0) {
    await mapConcurrent(expiredAccs, concurrency, async ({ acc, sourceGroup }) => {
      const checked = await checkOneForCycle(acc);
      const nowIso = new Date().toISOString();

      // Decide target.
      let target;
      let bucketLabel;
      if (checked.error) {
        target = "groupError";
        bucketLabel = "error";
      } else if (checked.classification === "active") {
        target = "group2";
        bucketLabel = "active";
      } else if (BUCKET_TO_GROUP[checked.classification]) {
        target = BUCKET_TO_GROUP[checked.classification];
        bucketLabel = checked.classification;
      } else {
        // "unknown" or anything else — leave in place but update fields.
        try {
          await updateAccountInGroup(sourceGroup, acc.id, {
            lastCheckedAt: nowIso,
            lastClassification: checked.classification,
            lastQuotaSummary: checked.summary,
            lastError: checked.error,
            accessToken: checked.refreshed?.accessToken,
            refreshToken: checked.refreshed?.refreshToken,
            expiresAt: checked.refreshed?.expiresAt,
          });
        } catch { /* ignore */ }
        moves.push({ id: acc.id, name: acc.name || acc.email, from: sourceGroup, to: sourceGroup, bucket: "unknown", method: "verified-stay" });
        return;
      }

      if (target === sourceGroup) {
        // Re-bucketed to same group — just refresh stored fields.
        try {
          await updateAccountInGroup(sourceGroup, acc.id, {
            lastCheckedAt: nowIso,
            lastClassification: checked.classification,
            lastQuotaSummary: checked.summary,
            lastError: checked.error,
            accessToken: checked.refreshed?.accessToken,
            refreshToken: checked.refreshed?.refreshToken,
            expiresAt: checked.refreshed?.expiresAt,
          });
        } catch { /* ignore */ }
        moves.push({ id: acc.id, name: acc.name || acc.email, from: sourceGroup, to: sourceGroup, bucket: bucketLabel, method: "verified-stay" });
        return;
      }

      const snapshot = {
        ...acc,
        ...(checked.refreshed || {}),
        isActive: false,
        lastCheckedAt: nowIso,
        lastClassification: checked.classification,
        lastQuotaSummary: checked.summary,
        lastError: checked.error,
      };
      try {
        await addAccountToGroup(target, snapshot);
        await removeAccountFromGroup(sourceGroup, acc.id);
        moves.push({ id: acc.id, name: acc.name || acc.email, from: sourceGroup, to: target, bucket: bucketLabel, method: "verified-move" });
      } catch (err) {
        moves.push({ id: acc.id, name: acc.name || acc.email, from: sourceGroup, to: target, error: err.message, method: "verified-move" });
      }
    });
  }

  return { moves, verified: expiredAccs.length };
}

async function checkOneForCycle(acc) {
  try {
    const { account: refreshed, usage } = await checkAccountQuota(acc, { persistToDb: true });
    const classification = classifyQuota(usage);
    const summary = buildSummary(usage);
    const errorMsg = usage?.error || null;
    return { acc, refreshed, classification, summary, error: errorMsg };
  } catch (err) {
    return { acc, refreshed: acc, classification: "unknown", summary: null, error: err.message };
  }
}

async function mapConcurrent(items, limit, fn) {
  let next = 0;
  const out = new Array(items.length);
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function cycleGroup1({ concurrency = 5, now = Date.now() } = {}) {
  // 1. Check current G1 accounts (write back results to db).
  const g1Accounts = await getProviderConnections({ provider: "codex", isActive: true });
  const checked = await mapConcurrent(g1Accounts, concurrency, checkOneForCycle);

  // Persist patch on each db record.
  const nowIso = new Date(now).toISOString();
  for (const r of checked) {
    const patch = {
      lastCheckedAt: nowIso,
      lastClassification: r.classification,
      lastQuotaSummary: r.summary,
      lastError: r.error,
    };
    try { await updateProviderConnection(r.acc.id, patch); } catch { /* ignore */ }
  }

  // 2. Evict G1 accounts that aren't "active".
  const evictions = [];
  for (const r of checked) {
    if (r.classification === "active") continue;
    // Decide target group from classification (use stored resetAt where available).
    let target = BUCKET_TO_GROUP[r.classification];
    if (!target) {
      // unknown / error → groupError
      target = "groupError";
    }
    try {
      const snapshot = {
        ...r.acc,
        ...r.refreshed,
        isActive: false,
        lastCheckedAt: nowIso,
        lastClassification: r.classification,
        lastQuotaSummary: r.summary,
        lastError: r.error,
      };
      await addAccountToGroup(target, snapshot);
      await deleteProviderConnection(r.acc.id);
      evictions.push({ id: r.acc.id, name: r.acc.name || r.acc.email, to: target });
    } catch (err) {
      evictions.push({ id: r.acc.id, name: r.acc.name || r.acc.email, to: target, error: err.message });
    }
  }

  // 3. Refill from G2 (sorted by quotaPercent ASC) until G1 reaches limit.
  const stored = await loadCodexData();
  const g2 = (stored.groups.group2 || []).slice();
  g2.sort((a, b) => {
    const pa = computeQuotaTotals(a.lastQuotaSummary).quotaPercent ?? 101;
    const pb = computeQuotaTotals(b.lastQuotaSummary).quotaPercent ?? 101;
    return pa - pb;
  });

  const dbCurrentlyActive = await getProviderConnections({ provider: "codex", isActive: true });
  let room = Math.max(0, GROUP1_LIMIT - dbCurrentlyActive.length);
  const promotions = [];
  for (const candidate of g2) {
    if (room <= 0) break;
    try {
      const { id: _oldId, isActive: _ig, ...rest } = candidate;
      const created = await createProviderConnection({ ...rest, isActive: true });
      await removeAccountFromGroup("group2", candidate.id);
      promotions.push({ id: candidate.id, newId: created.id, name: created.name });
      room--;
    } catch (err) {
      promotions.push({ id: candidate.id, name: candidate.name, error: err.message });
    }
  }

  return {
    checked: checked.length,
    evicted: evictions.length,
    promoted: promotions.length,
    details: { evictions, promotions },
  };
}

export async function runCycle({ concurrency = 5 } = {}) {
  const t0 = Date.now();
  const reclassify = await reclassifyResetGroups();
  const cycle = await cycleGroup1({ concurrency });
  return {
    durationMs: Date.now() - t0,
    reclassify: { moves: reclassify.moves.length, details: reclassify.moves },
    cycle,
  };
}
