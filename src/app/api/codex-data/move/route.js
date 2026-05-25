import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  getProviderConnections,
  createProviderConnection,
  deleteProviderConnection,
} from "@/lib/localDb";
import {
  loadCodexData,
  addAccountToGroup,
  removeAccountFromGroup,
  findAccountAcrossGroups,
  GROUP_NAMES,
} from "@/lib/codex-data/storage";

const GROUP1_LIMIT = 70;
const ALL_GROUPS = ["group1", ...GROUP_NAMES];

// POST /api/codex-data/move  { accountId, toGroup }
// Moves a single codex account between groups. group1 ↔ db.providerConnections,
// group2..5 ↔ codex-data.json.
//
// Note about identity: moving group2..5 → group1 calls createProviderConnection,
// which (by current localDb behavior) issues a fresh id. The response carries the
// new id so the UI can resync. Round-tripping an account thus changes its id.
export async function POST(request) {
  try {
    const body = await request.json();
    const { accountId, toGroup } = body || {};

    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "accountId is required" }, { status: 400 });
    }
    if (!ALL_GROUPS.includes(toGroup)) {
      return NextResponse.json({ error: `toGroup must be one of ${ALL_GROUPS.join(", ")}` }, { status: 400 });
    }

    // Locate the account: group1 (db) or storage (group2-5).
    const dbConnection = await getProviderConnectionById(accountId);
    let source;
    if (dbConnection && dbConnection.provider === "codex") {
      source = { group: "group1", account: dbConnection };
    } else {
      const inStorage = await findAccountAcrossGroups(accountId);
      if (inStorage) source = inStorage;
    }
    if (!source) {
      return NextResponse.json({ error: "Account not found in any group" }, { status: 404 });
    }
    if (source.group === toGroup) {
      return NextResponse.json({ ok: true, noop: true, account: source.account });
    }
    if (source.account.provider !== "codex") {
      return NextResponse.json({ error: "Only codex accounts can be moved via this endpoint" }, { status: 400 });
    }

    // Enforce group1 limit.
    if (toGroup === "group1") {
      const activeCodex = await getProviderConnections({ provider: "codex", isActive: true });
      if (activeCodex.length >= GROUP1_LIMIT) {
        return NextResponse.json({
          error: `Group 1 is full (${activeCodex.length}/${GROUP1_LIMIT}). Move an account out first.`,
        }, { status: 409 });
      }
    }

    // group1 → group2..5: snapshot then delete from db.
    if (source.group === "group1" && toGroup !== "group1") {
      const snapshot = { ...source.account, isActive: false };
      await addAccountToGroup(toGroup, snapshot);
      await deleteProviderConnection(source.account.id);
      return NextResponse.json({ ok: true, from: "group1", to: toGroup, account: snapshot });
    }

    // group2..5 → group1: insert into db (gets new id), then remove from storage.
    if (source.group !== "group1" && toGroup === "group1") {
      const { id: _oldId, isActive: _ignored, ...rest } = source.account;
      const created = await createProviderConnection({ ...rest, isActive: true });
      await removeAccountFromGroup(source.group, source.account.id);
      return NextResponse.json({ ok: true, from: source.group, to: "group1", account: created, idChanged: created.id !== source.account.id });
    }

    // group2..5 → group3..5: rewrite in storage.
    await removeAccountFromGroup(source.group, source.account.id);
    await addAccountToGroup(toGroup, source.account);
    return NextResponse.json({ ok: true, from: source.group, to: toGroup, account: source.account });
  } catch (err) {
    console.error("[codex-data move]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
