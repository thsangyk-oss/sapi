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

const GROUP1_LIMIT = 70;

// Fisher-Yates shuffle (in place).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// POST /api/codex-data/scatter
// Collect every codex account (db + codex-data.json), shuffle, then:
//   - put the first 70 into group1 (db, isActive=true)
//   - distribute the rest evenly across group2..group5 (round-robin)
//
// Identity note: accounts entering group1 from storage go through
// createProviderConnection which mints a fresh id (current localDb behavior),
// so the id of an account may change. The OAuth credentials and email stay
// the same, so the account still works.
export async function POST() {
  try {
    // 1. Gather everything.
    const dbAll = await getProviderConnections({ provider: "codex" });
    const stored = await loadCodexData();
    const pool = [];
    for (const acc of dbAll) pool.push({ acc, current: "group1" });
    for (const g of ["group2", "group3", "group4", "group5", "groupError"]) {
      for (const acc of stored.groups[g] || []) pool.push({ acc, current: g });
    }
    if (pool.length === 0) {
      return NextResponse.json({ ok: true, total: 0, distribution: { group1: 0, group2: 0, group3: 0, group4: 0, group5: 0 } });
    }

    // 2. Shuffle and assign targets.
    shuffle(pool);
    const g1Take = Math.min(pool.length, GROUP1_LIMIT);
    for (let i = 0; i < g1Take; i++) pool[i].target = "group1";
    for (let i = g1Take; i < pool.length; i++) {
      pool[i].target = `group${2 + ((i - g1Take) % 4)}`;
    }

    // 3. Execute moves.
    const moves = { stayed: 0, moved: 0, failed: 0 };
    const failures = [];
    for (const entry of pool) {
      const { acc, current, target } = entry;
      if (current === target) {
        // group1 stay: ensure isActive=true (it already is per our query); group2-5 stay needs no work
        moves.stayed++;
        continue;
      }
      try {
        if (current === "group1" && target !== "group1") {
          const snapshot = { ...acc, isActive: false };
          await addAccountToGroup(target, snapshot);
          await deleteProviderConnection(acc.id);
        } else if (current !== "group1" && target === "group1") {
          const { id: _oldId, isActive: _ig, ...rest } = acc;
          await createProviderConnection({ ...rest, isActive: true });
          await removeAccountFromGroup(current, acc.id);
        } else {
          // both in codex-data storage — addAccountToGroup is atomic
          // (removes from every other group internally), no race window.
          await addAccountToGroup(target, acc);
        }
        moves.moved++;
      } catch (err) {
        moves.failed++;
        failures.push({ id: acc.id, name: acc.name || acc.email, from: current, to: target, error: err.message });
      }
    }

    // 4. Final counts.
    const distribution = { group1: 0, group2: 0, group3: 0, group4: 0, group5: 0 };
    for (const entry of pool) distribution[entry.target]++;

    return NextResponse.json({
      ok: true,
      total: pool.length,
      group1Limit: GROUP1_LIMIT,
      distribution,
      moves,
      failures,
    });
  } catch (err) {
    console.error("[codex-data scatter]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
