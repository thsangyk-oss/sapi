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

    const group1 = activeCodex.map(summarize);
    const groups = {
      group1: { accounts: group1, limit: GROUP1_LIMIT, count: group1.length },
    };
    for (const g of ["group2", "group3", "group4", "group5", "groupError"]) {
      const arr = stored.groups[g] || [];
      groups[g] = { accounts: arr.map(summarize), count: arr.length };
    }

    return NextResponse.json({ groups, updatedAt: stored.updatedAt, group1Limit: GROUP1_LIMIT });
  } catch (err) {
    console.error("[codex-data GET]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
