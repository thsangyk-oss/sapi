import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  deleteProviderConnection,
} from "@/lib/localDb";
import {
  loadCodexData,
  addAccountToGroup,
  removeAccountFromGroup,
} from "@/lib/codex-data/storage";
import { computeQuotaTotals } from "@/lib/codex-data/format";

const GROUP1_LIMIT = 70;
const RESET_BUCKETS = {
  reset_lt24: "group3",
  reset_24_72: "group4",
  reset_gt72: "group5",
};

// POST /api/codex-data/split
//
// Holistic redistribution based on each account's cached lastClassification +
// lastQuotaSummary (populated by /check or /check-one). Rules:
//
//   - Accounts classified "active" form a single pool, sorted ASC by
//     quotaPercent. The 70 lowest-% land in group 1 (use them before they hit
//     a reset wall). The rest go to group 2.
//   - Accounts classified "reset_lt24" / "reset_24_72" / "reset_gt72" go to
//     group 3 / 4 / 5 respectively.
//   - Accounts without a classification (null) or classified "unknown" are
//     left in their current group — the user hasn't told us anything about
//     them yet.
//   - groupError accounts are never touched by split (they sit there until
//     the user manually checks or moves them).
//   - Any account whose target is group1 ends up inserted into db.json with
//     isActive=true via createProviderConnection (upsert-by-email).
export async function POST() {
  try {
    const dbAll = await getProviderConnections({ provider: "codex" });
    const stored = await loadCodexData();

    const pool = [];
    for (const acc of dbAll) {
      pool.push({ acc, currentGroup: "group1", ...evalAcc(acc) });
    }
    for (const g of ["group2", "group3", "group4", "group5"]) {
      for (const acc of stored.groups[g] || []) {
        pool.push({ acc, currentGroup: g, ...evalAcc(acc) });
      }
    }
    // groupError intentionally excluded — leave them alone.

    // Assign targets.
    for (const entry of pool) {
      const reset = RESET_BUCKETS[entry.classification];
      if (reset) entry.target = reset;
      else if (entry.classification === "active") entry.target = "ACTIVE_POOL";
      else entry.target = null;
    }

    // Sort actives by remaining quota ASC, assign top 70 → group1, rest → group2.
    const actives = pool.filter((e) => e.target === "ACTIVE_POOL");
    actives.sort((a, b) => {
      const pa = a.quotaPercent === null ? 101 : a.quotaPercent;
      const pb = b.quotaPercent === null ? 101 : b.quotaPercent;
      return pa - pb;
    });
    for (let i = 0; i < actives.length; i++) {
      actives[i].target = i < GROUP1_LIMIT ? "group1" : "group2";
    }

    // Execute moves.
    const moves = [];
    const failures = [];
    let group1Inserted = 0;

    // Process group1 evictions first (frees DB capacity before promotions).
    const ordered = [
      ...pool.filter((e) => e.target && e.currentGroup === "group1" && e.target !== "group1"),
      ...pool.filter((e) => e.target && e.currentGroup !== "group1" && e.target === "group1"),
      ...pool.filter((e) => e.target && e.currentGroup !== "group1" && e.target !== "group1" && e.currentGroup !== e.target),
    ];

    for (const entry of ordered) {
      const { acc, currentGroup, target } = entry;
      try {
        if (currentGroup === "group1" && target !== "group1") {
          const snapshot = { ...acc, isActive: false };
          await addAccountToGroup(target, snapshot);
          await deleteProviderConnection(acc.id);
        } else if (currentGroup !== "group1" && target === "group1") {
          const { id: _oldId, isActive: _ig, ...rest } = acc;
          await createProviderConnection({ ...rest, isActive: true });
          await removeAccountFromGroup(currentGroup, acc.id);
          group1Inserted++;
        } else {
          await removeAccountFromGroup(currentGroup, acc.id);
          await addAccountToGroup(target, acc);
        }
        moves.push({ id: acc.id, name: acc.name || acc.email, from: currentGroup, to: target, quotaPercent: entry.quotaPercent });
      } catch (err) {
        failures.push({ id: acc.id, name: acc.name || acc.email, from: currentGroup, to: target, error: err.message });
      }
    }

    // Sanity sweep: ensure every "active" with target=group1 actually sits in
    // db.json with isActive=true (covers accounts that were already in group1
    // but inactive, or where createProviderConnection upserted to an inactive
    // existing record).
    const finalDb = await getProviderConnections({ provider: "codex" });
    const dbByEmail = new Map(finalDb.map((c) => [c.email, c]));
    const intendedG1 = pool.filter((e) => e.target === "group1");
    let reactivated = 0;
    for (const entry of intendedG1) {
      const dbEntry = dbByEmail.get(entry.acc.email);
      if (!dbEntry) continue;
      if (dbEntry.isActive === false) {
        const { updateProviderConnection } = await import("@/lib/localDb");
        await updateProviderConnection(dbEntry.id, { isActive: true });
        reactivated++;
      }
    }

    const finalActive = await getProviderConnections({ provider: "codex", isActive: true });
    return NextResponse.json({
      ok: true,
      moves: moves.length,
      failures: failures.length,
      group1ActiveInDb: finalActive.length,
      group1Limit: GROUP1_LIMIT,
      activesTotal: actives.length,
      reactivated,
      details: { moves, failures },
    });
  } catch (err) {
    console.error("[codex-data split]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function evalAcc(acc) {
  const totals = computeQuotaTotals(acc.lastQuotaSummary);
  return {
    classification: acc.lastClassification || null,
    quotaPercent: totals.quotaPercent,
  };
}
