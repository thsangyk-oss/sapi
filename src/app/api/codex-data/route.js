import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { loadCodexData } from "@/lib/codex-data/storage";
import { computeQuotaTotals } from "@/lib/codex-data/format";

const GROUP1_LIMIT = 70;

function summarize(account) {
  const totals = computeQuotaTotals(account.lastQuotaSummary);
  const earliestResetAt = account.lastQuotaSummary?.earliestResetAt || null;
  const hoursUntilReset = earliestResetAt
    ? Math.max(0, Math.round((new Date(earliestResetAt).getTime() - Date.now()) / 36e5 * 10) / 10)
    : null;
  return {
    id: account.id,
    name: account.name || account.email || account.id,
    email: account.email || null,
    priority: account.priority ?? null,
    isActive: account.isActive !== false,
    expiresAt: account.expiresAt || account.tokenExpiresAt || null,
    lastUsedAt: account.lastUsedAt || null,
    lastCheckedAt: account.lastCheckedAt || null,
    lastClassification: account.lastClassification || null,
    quotaPercent: totals.quotaPercent,
    quotaUsed: totals.quotaUsed,
    quotaTotal: totals.quotaTotal,
    earliestResetAt,
    hoursUntilReset,
    lastError: account.lastError || null,
  };
}


// GET /api/codex-data — returns the 5 groups for the dashboard.
// group1 is derived from db.providerConnections (provider="codex", isActive!=false).
// group2..5 come from codex-data.json.
export async function GET() {
  try {
    const [activeCodex, stored] = await Promise.all([
      getProviderConnections({ provider: "codex", isActive: true }),
      loadCodexData(),
    ]);

    const groups = {};
    const rawById = {
      group1: activeCodex.map(summarize),
      group2: (stored.groups.group2 || []).map(summarize),
      group3: (stored.groups.group3 || []).map(summarize),
      group4: (stored.groups.group4 || []).map(summarize),
      group5: (stored.groups.group5 || []).map(summarize),
      groupError: (stored.groups.groupError || []).map(summarize),
    };

    // Sort:
    //  - group1, group2: by quotaPercent ASC (lowest remaining first; nulls last)
    //  - group3, group4, group5: by earliestResetAt ASC (soonest reset first; nulls last)
    //  - groupError: by lastCheckedAt DESC (most recent failure first)
    rawById.group1 = sortByQuotaAsc(rawById.group1);
    rawById.group2 = sortByQuotaAsc(rawById.group2);
    rawById.group3 = sortByResetAsc(rawById.group3);
    rawById.group4 = sortByResetAsc(rawById.group4);
    rawById.group5 = sortByResetAsc(rawById.group5);
    rawById.groupError = sortByCheckedDesc(rawById.groupError);

    groups.group1 = { accounts: rawById.group1, limit: GROUP1_LIMIT, count: rawById.group1.length };
    for (const g of ["group2", "group3", "group4", "group5", "groupError"]) {
      groups[g] = { accounts: rawById[g], count: rawById[g].length };
    }

    return NextResponse.json({ groups, updatedAt: stored.updatedAt, group1Limit: GROUP1_LIMIT });
  } catch (err) {
    console.error("[codex-data GET]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function sortByQuotaAsc(accounts) {
  return [...accounts].sort((a, b) => {
    const pa = a.quotaPercent === null || a.quotaPercent === undefined ? Number.POSITIVE_INFINITY : a.quotaPercent;
    const pb = b.quotaPercent === null || b.quotaPercent === undefined ? Number.POSITIVE_INFINITY : b.quotaPercent;
    return pa - pb;
  });
}

function sortByResetAsc(accounts) {
  return [...accounts].sort((a, b) => {
    const ra = a.earliestResetAt ? new Date(a.earliestResetAt).getTime() : Number.POSITIVE_INFINITY;
    const rb = b.earliestResetAt ? new Date(b.earliestResetAt).getTime() : Number.POSITIVE_INFINITY;
    return ra - rb;
  });
}

function sortByCheckedDesc(accounts) {
  return [...accounts].sort((a, b) => {
    const ta = a.lastCheckedAt ? new Date(a.lastCheckedAt).getTime() : 0;
    const tb = b.lastCheckedAt ? new Date(b.lastCheckedAt).getTime() : 0;
    return tb - ta;
  });
}
