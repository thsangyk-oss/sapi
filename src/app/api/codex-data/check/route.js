import {
  getProviderConnections,
  updateProviderConnection,
  deleteProviderConnection,
} from "@/lib/localDb";
import {
  loadCodexData,
  updateAccountInGroup,
  removeAccountFromGroup,
  addAccountToGroup,
  GROUP_NAMES,
} from "@/lib/codex-data/storage";
import { checkAccountQuota } from "@/lib/codex-data/check";
import { classifyQuota } from "@/lib/codex-data/categorize";
import { makeResult, buildSummary } from "@/lib/codex-data/format";

// POST /api/codex-data/check  { group, concurrency? }
// Streams Server-Sent Events as each account finishes. Events:
//   { type: "start",    total, group, concurrency }
//   { type: "progress", done, total, acc: <result>, movedToError? }
//   { type: "done",     total, errored, movedToError }
//   { type: "error",    error }              // fatal stream error
//
// Side effects:
//   - Successful check: persists lastCheckedAt/lastClassification/lastQuotaSummary
//     in place (db for group1, codex-data.json for group2..5/groupError).
//   - Errored check (when source group != groupError): moves the account to
//     groupError with lastError set. Removes it from the source group.
//   - Client abort (request.signal): workers finish current acc then stop.
export async function POST(request) {
  const enc = new TextEncoder();
  const sendLine = (controller, obj) =>
    controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { group } = body || {};
  const allGroups = ["group1", ...GROUP_NAMES];
  if (!allGroups.includes(group)) {
    return Response.json({ error: `group must be one of ${allGroups.join(", ")}` }, { status: 400 });
  }

  const requested = Number(body?.concurrency);
  const concurrency = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.max(1, Math.floor(requested)), 50)
    : 5;

  let accounts;
  if (group === "group1") {
    accounts = await getProviderConnections({ provider: "codex", isActive: true });
  } else {
    const data = await loadCodexData();
    accounts = (data.groups[group] || []).slice();
  }

  const persistToDb = group === "group1";
  const autoMoveErrors = group !== "groupError"; // don't recycle errors within the error bin

  let aborted = false;
  request.signal?.addEventListener?.("abort", () => { aborted = true; });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => {
        try { sendLine(controller, o); } catch { /* stream closed by client */ }
      };
      try {
        send({ type: "start", total: accounts.length, group, concurrency });

        if (accounts.length === 0) {
          send({ type: "done", total: 0, errored: 0, movedToError: 0 });
          try { controller.close(); } catch { /* */ }
          return;
        }

        let done = 0;
        let errored = 0;
        let movedToError = 0;

        await mapConcurrent(accounts, concurrency, async (acc) => {
          if (aborted) return;
          const { result, moved } = await checkOne(acc, group, persistToDb, autoMoveErrors);
          done += 1;
          if (result.error) errored += 1;
          if (moved) movedToError += 1;
          send({ type: "progress", done, total: accounts.length, acc: result, movedToError: moved });
        }, () => aborted);

        send({
          type: "done",
          total: accounts.length,
          processed: done,
          errored,
          movedToError,
          aborted,
        });
      } catch (err) {
        send({ type: "error", error: err.message });
      } finally {
        try { controller.close(); } catch { /* */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function checkOne(acc, group, persistToDb, autoMoveErrors) {
  try {
    const { account: refreshed, usage, refreshed: didRefresh, refreshStatus } = await checkAccountQuota(acc, { persistToDb });
    const classification = classifyQuota(usage);
    const summary = buildSummary(usage);
    const nowIso = new Date().toISOString();
    const errorMsg = usage?.error || null;
    const refreshFields = pickRefreshFields(refreshed);
    const resultMeta = { refreshed: didRefresh, refreshStatus };

    // If usage errored and we're allowed to recycle, move to groupError.
    if (errorMsg && autoMoveErrors) {
      const snapshot = {
        ...acc,
        ...refreshed, // preserve any refreshed tokens
        isActive: false,
        lastCheckedAt: nowIso,
        lastClassification: "unknown",
        lastQuotaSummary: null,
        lastError: errorMsg,
        ...refreshFields,
      };
      try {
        await addAccountToGroup("groupError", snapshot);
        if (group === "group1") {
          await deleteProviderConnection(acc.id);
        } else {
          await removeAccountFromGroup(group, acc.id);
        }
        return {
          result: makeResult(refreshed, classification, summary, errorMsg, resultMeta),
          moved: true,
        };
      } catch {
        // fall through and update in place if move failed
      }
    }

    const patch = {
      lastCheckedAt: nowIso,
      lastClassification: classification,
      lastQuotaSummary: summary,
      lastError: errorMsg,
      ...refreshFields,
    };
    if (group === "group1") {
      await updateProviderConnection(acc.id, patch);
    } else {
      await updateAccountInGroup(group, acc.id, {
        ...patch,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      });
    }
    return { result: makeResult(refreshed, classification, summary, errorMsg, resultMeta), moved: false };
  } catch (err) {
    // Hard exception (network, code bug). Treat same as auth error.
    const errorMsg = err.message;
    if (autoMoveErrors) {
      try {
        await addAccountToGroup("groupError", {
          ...acc,
          isActive: false,
          lastCheckedAt: new Date().toISOString(),
          lastClassification: "unknown",
          lastError: errorMsg,
        });
        if (group === "group1") await deleteProviderConnection(acc.id);
        else await removeAccountFromGroup(group, acc.id);
        return { result: makeResult(acc, "unknown", null, errorMsg), moved: true };
      } catch { /* */ }
    }
    return { result: makeResult(acc, "unknown", null, errorMsg), moved: false };
  }
}

function pickRefreshFields(account) {
  const fields = {};
  for (const key of ["lastRefreshStatus", "lastRefreshError", "lastRefreshAttemptedAt", "lastRefreshedAt"]) {
    if (account?.[key] !== undefined) fields[key] = account[key];
  }
  return fields;
}

// Worker-pool concurrent runner. Polls shouldAbort() between items.
async function mapConcurrent(items, limit, fn, shouldAbort = () => false) {
  let next = 0;
  async function worker() {
    while (true) {
      if (shouldAbort()) return;
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}
