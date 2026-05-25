import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
} from "@/lib/localDb";
import {
  loadCodexData,
  removeAccountFromGroup,
  GROUP_NAMES,
} from "@/lib/codex-data/storage";

const GROUP1_LIMIT = 70;

// POST /api/codex-data/apply  { group }
// Promote every account in `group` (group2..5) into group1 (db.providerConnections),
// up to the group1 capacity. Accounts that don't fit stay in their source group.
export async function POST(request) {
  try {
    const body = await request.json();
    const { group } = body || {};
    if (!GROUP_NAMES.includes(group)) {
      return NextResponse.json({ error: `group must be one of ${GROUP_NAMES.join(", ")}` }, { status: 400 });
    }

    const data = await loadCodexData();
    const sourceAccounts = (data.groups[group] || []).slice();
    if (sourceAccounts.length === 0) {
      return NextResponse.json({ ok: true, applied: 0, skipped: 0, reason: "Source group is empty" });
    }

    const activeCodex = await getProviderConnections({ provider: "codex", isActive: true });
    const room = Math.max(0, GROUP1_LIMIT - activeCodex.length);
    if (room === 0) {
      return NextResponse.json({
        ok: false,
        applied: 0,
        skipped: sourceAccounts.length,
        reason: `Group 1 is already at the ${GROUP1_LIMIT} limit.`,
      }, { status: 409 });
    }

    const toApply = sourceAccounts.slice(0, room);
    const skipped = sourceAccounts.slice(room);

    const applied = [];
    const failed = [];
    for (const snapshot of toApply) {
      const { id: _oldId, isActive: _ignored, ...rest } = snapshot;
      try {
        const created = await createProviderConnection({ ...rest, isActive: true });
        await removeAccountFromGroup(group, snapshot.id);
        applied.push({ from: group, oldId: snapshot.id, newId: created.id, name: created.name });
      } catch (err) {
        failed.push({ id: snapshot.id, name: snapshot.name, error: err.message });
      }
    }

    return NextResponse.json({
      ok: true,
      applied: applied.length,
      skipped: skipped.length + failed.length,
      details: { applied, failed, skippedReason: skipped.length > 0 ? `group1 limit (${GROUP1_LIMIT}) reached` : null },
    });
  } catch (err) {
    console.error("[codex-data apply]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
