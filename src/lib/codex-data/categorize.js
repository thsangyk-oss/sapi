const HOUR_MS = 3600 * 1000;

/**
 * Inspect a quota response (from getUsageForProvider) for a codex account
 * and return one of: "active" | "waiting" | "reset_lt24" | "reset_24_72" | "reset_gt72" | "unknown".
 *
 *   active     – has quota remaining (used < total on at least one quota)
 *   waiting    – same as active conceptually; caller decides whether to promote into group 1
 *                (kept distinct so split() can refill group 1 from group 2)
 *   reset_*    – no quota remaining; bucketed by time until earliest reset
 *   unknown    – cannot determine (no quotas reported, or auth/network error)
 *
 * This function only returns the *quality* of the account. It does not assign a group;
 * the split logic uses these values plus the account's current group to compute moves.
 */
export function classifyQuota(usage, { now = Date.now() } = {}) {
  if (!usage || usage.error) return "unknown";
  if (Array.isArray(usage.quotas) ? usage.quotas.length === 0 : !usage.quotas) return "unknown";

  const quotas = normalizeQuotas(usage.quotas);
  if (quotas.length === 0) return "unknown";

  const hasRemaining = quotas.some((q) => quotaHasRemaining(q));
  if (hasRemaining) return "active";

  // All exhausted — bucket by soonest reset
  const earliestResetMs = quotas
    .map((q) => parseResetMs(q.resetAt))
    .filter((ms) => Number.isFinite(ms) && ms > now)
    .reduce((min, ms) => (min === null || ms < min ? ms : min), null);

  if (earliestResetMs === null) return "reset_gt72"; // no reset time → treat as far-future

  const hours = (earliestResetMs - now) / HOUR_MS;
  if (hours < 24) return "reset_lt24";
  if (hours < 72) return "reset_24_72";
  return "reset_gt72";
}

function normalizeQuotas(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([name, q]) => ({ name, ...q }));
  }
  return [];
}

function quotaHasRemaining(q) {
  const used = Number(q.used);
  const total = Number(q.total);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    // Unknown shape – assume available if there's no clear "exhausted" signal
    return true;
  }
  return used < total;
}

function parseResetMs(resetAt) {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Map a classifyQuota result + current group into the *target* group after a split.
 *
 *   active  → group1 if there is room, otherwise group2
 *   reset_* → corresponding group3/4/5
 *   unknown → stay in current group (don't move blind)
 */
export function targetGroupFor(classification, { currentGroup, group1HasRoom }) {
  switch (classification) {
    case "active":
      return group1HasRoom ? "group1" : "group2";
    case "reset_lt24":
      return "group3";
    case "reset_24_72":
      return "group4";
    case "reset_gt72":
      return "group5";
    case "unknown":
    default:
      return currentGroup;
  }
}

export const HOUR_MS_CONST = HOUR_MS;
