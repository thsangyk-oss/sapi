import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/lib/localDb";
import {
  findAccountAcrossGroups,
  updateAccountInGroup,
  removeAccountFromGroup,
  addAccountToGroup,
} from "@/lib/codex-data/storage";
import { checkAccountQuota } from "@/lib/codex-data/check";
import { classifyQuota } from "@/lib/codex-data/categorize";
import { makeResult, buildSummary } from "@/lib/codex-data/format";

// POST /api/codex-data/check-one  { accountId, autoMoveOnError? }
// Check a single codex account regardless of its current group. Used by the
// per-row check icon. Returns JSON (no streaming). Honors the same auto-move-
// to-groupError behavior as the group check (skipped when source == groupError
// to avoid recycling, or when autoMoveOnError is explicitly false).
export async function POST(request) {
  try {
    const body = await request.json();
    const { accountId, autoMoveOnError = true } = body || {};
    if (!accountId || typeof accountId !== "string") {
      return NextResponse.json({ error: "accountId is required" }, { status: 400 });
    }

    const dbConn = await getProviderConnectionById(accountId);
    let source;
    if (dbConn && dbConn.provider === "codex") {
      source = { group: "group1", account: dbConn };
    } else {
      const inStorage = await findAccountAcrossGroups(accountId);
      if (inStorage) source = inStorage;
    }
    if (!source) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    if (source.account.provider !== "codex") {
      return NextResponse.json({ error: "Only codex accounts are supported" }, { status: 400 });
    }

    const persistToDb = source.group === "group1";
    const shouldAutoMove = autoMoveOnError && source.group !== "groupError";

    const { account: refreshed, usage } = await checkAccountQuota(source.account, { persistToDb });
    const classification = classifyQuota(usage);
    const summary = buildSummary(usage);
    const errorMsg = usage?.error || null;
    const nowIso = new Date().toISOString();

    let moved = false;
    if (errorMsg && shouldAutoMove) {
      try {
        const snapshot = {
          ...source.account,
          ...refreshed,
          isActive: false,
          lastCheckedAt: nowIso,
          lastClassification: "unknown",
          lastQuotaSummary: null,
          lastError: errorMsg,
        };
        await addAccountToGroup("groupError", snapshot);
        if (source.group === "group1") await deleteProviderConnection(source.account.id);
        else await removeAccountFromGroup(source.group, source.account.id);
        moved = true;
      } catch { /* fall back to in-place update */ }
    }

    if (!moved) {
      const patch = {
        lastCheckedAt: nowIso,
        lastClassification: classification,
        lastQuotaSummary: summary,
        lastError: errorMsg,
      };
      if (source.group === "group1") {
        await updateProviderConnection(source.account.id, patch);
      } else {
        await updateAccountInGroup(source.group, source.account.id, {
          ...patch,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: refreshed.expiresAt,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      acc: makeResult(source.account, classification, summary, errorMsg),
      sourceGroup: source.group,
      movedToError: moved,
    });
  } catch (err) {
    console.error("[codex-data check-one]", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
