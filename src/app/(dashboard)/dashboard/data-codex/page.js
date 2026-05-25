"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardSkeleton } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const GROUP_META = {
  group1: {
    title: "Group 1 — Active (in db.json)",
    description: "Accounts currently used by the app. Capacity 70.",
    canApply: false,
  },
  group2: {
    title: "Group 2 — Waiting (has quota)",
    description: "Reserve accounts with quota; promoted into group 1 by Split.",
    canApply: true,
  },
  group3: {
    title: "Group 3 — Resetting < 24h",
    description: "Quota exhausted, will reset within a day.",
    canApply: true,
  },
  group4: {
    title: "Group 4 — Resetting 24–72h",
    description: "Quota exhausted, reset between 1 and 3 days.",
    canApply: true,
  },
  group5: {
    title: "Group 5 — Resetting > 72h",
    description: "Quota exhausted, reset is more than 3 days out.",
    canApply: true,
  },
  groupError: {
    title: "Errors",
    description: "Accounts that failed to check (auth expired, network error, etc.). Auto-collected from group-wide Check.",
    canApply: true,
  },
};

const GROUP_ORDER = ["group1", "group2", "group3", "group4", "group5", "groupError"];

function classificationBadge(value) {
  if (!value) return { label: "—", variant: "default" };
  if (value === "active") return { label: "Active", variant: "success" };
  if (value === "reset_lt24") return { label: "Reset <24h", variant: "warning" };
  if (value === "reset_24_72") return { label: "Reset 24-72h", variant: "warning" };
  if (value === "reset_gt72") return { label: "Reset >72h", variant: "error" };
  if (value === "unknown") return { label: "Unknown", variant: "default" };
  return { label: value, variant: "default" };
}

function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatRelative(value) {
  if (!value) return "—";
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  let label;
  if (abs < 60000) label = "just now";
  else if (abs < 3600000) label = `${m}m`;
  else if (abs < 86400000) label = `${h}h`;
  else label = `${d}d`;
  return diffMs < 0 ? `${label} ago` : `in ${label}`;
}

function formatHours(h) {
  if (h === null || h === undefined) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

function quotaPercentColor(pct) {
  if (pct === null || pct === undefined) return "text-text-muted";
  if (pct <= 0) return "text-red-500 font-semibold";
  if (pct < 25) return "text-orange-500";
  if (pct < 50) return "text-yellow-600";
  return "text-green-600";
}

export default function DataCodexPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [liveResults, setLiveResults] = useState({}); // { [accId]: result }
  const [checkProgress, setCheckProgress] = useState(null); // { group, done, total }
  const [checkAbort, setCheckAbort] = useState(null); // AbortController while a check stream is open
  const notify = useNotificationStore((s) => s.addNotification);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/codex-data", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      notify({ message: `Failed to load: ${err.message}`, type: "error" });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const runOp = useCallback(async (key, opPromiseFn, { onSuccessMsg } = {}) => {
    setBusy(key);
    try {
      const res = await opPromiseFn();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (onSuccessMsg) notify({ message: onSuccessMsg(body), type: "success" });
      await load();
      return body;
    } catch (err) {
      notify({ message: err.message, type: "error" });
    } finally {
      setBusy(null);
    }
  }, [load, notify]);

  // Streaming check: POSTs to /check and consumes SSE events.
  // Abortable via the Stop button (controller.abort()).
  const handleCheck = useCallback(async (group) => {
    const controller = new AbortController();
    setCheckAbort(controller);
    setBusy(`check:${group}`);
    setCheckProgress({ group, done: 0, total: 0 });
    setLiveResults({});
    let userAborted = false;
    try {
      const res = await fetch("/api/codex-data/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ""}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalTotal = 0;
      let errorCount = 0;
      let movedToError = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!chunk.startsWith("data:")) continue;
          const payload = chunk.slice(5).trim();
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }
          if (evt.type === "start") {
            setCheckProgress({ group, done: 0, total: evt.total });
            finalTotal = evt.total;
          } else if (evt.type === "progress") {
            setLiveResults((prev) => ({ ...prev, [evt.acc.id]: evt.acc }));
            setCheckProgress({ group, done: evt.done, total: evt.total });
            if (evt.acc.error) errorCount++;
            if (evt.movedToError) movedToError++;
          } else if (evt.type === "done") {
            finalTotal = evt.processed ?? evt.total;
            if (evt.movedToError) movedToError = evt.movedToError;
          } else if (evt.type === "error") {
            throw new Error(evt.error);
          }
        }
      }
      const parts = [`Checked ${finalTotal} acc in ${group}`];
      if (errorCount) parts.push(`${errorCount} errored`);
      if (movedToError) parts.push(`${movedToError} → Errors`);
      notify({ message: parts.join(" · "), type: "success" });
      await load();
    } catch (err) {
      if (err.name === "AbortError") {
        userAborted = true;
        notify({ message: "Check stopped", type: "info" });
        await load();
      } else {
        notify({ message: `Check failed: ${err.message}`, type: "error" });
      }
    } finally {
      setBusy(null);
      setCheckProgress(null);
      setCheckAbort(null);
    }
    return userAborted;
  }, [load, notify]);

  const handleStopCheck = useCallback(() => {
    if (checkAbort) checkAbort.abort();
  }, [checkAbort]);

  // Per-row single-acc check (JSON, not stream).
  const handleCheckOne = useCallback(async (accountId) => {
    const key = `checkone:${accountId}`;
    setBusy(key);
    try {
      const res = await fetch("/api/codex-data/check-one", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setLiveResults((prev) => ({ ...prev, [body.acc.id]: body.acc }));
      const msg = body.movedToError
        ? `${body.acc.name}: error → moved to Errors`
        : body.acc.error
          ? `${body.acc.name}: ${body.acc.error.slice(0, 80)}`
          : `${body.acc.name}: ${body.acc.classification}${body.acc.quotaPercent !== null ? ` (${body.acc.quotaPercent}% left)` : ""}`;
      notify({ message: msg, type: body.acc.error ? "warning" : "success" });
      await load();
    } catch (err) {
      notify({ message: err.message, type: "error" });
    } finally {
      setBusy(null);
    }
  }, [load, notify]);

  const handleApply = (group) => runOp(
    `apply:${group}`,
    () => fetch("/api/codex-data/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group }),
    }),
    { onSuccessMsg: (b) => b.reason ? b.reason : `Applied ${b.applied} account(s) from ${group} → group 1` },
  );

  const handleSplit = () => runOp(
    "split",
    () => fetch("/api/codex-data/split", { method: "POST" }),
    { onSuccessMsg: (b) => `Split made ${b.moves} move(s); group1 ${b.group1Count}/${b.group1Limit}` },
  );

  const handleScatter = () => {
    if (!globalThis.confirm("Shuffle ALL codex accounts and randomly distribute: 70 to group 1, the rest evenly across groups 2-5. Existing per-group assignments will be discarded. Continue?")) return;
    return runOp(
      "scatter",
      () => fetch("/api/codex-data/scatter", { method: "POST" }),
      { onSuccessMsg: (b) => `Scattered ${b.total} acc(s): G1=${b.distribution.group1}, G2=${b.distribution.group2}, G3=${b.distribution.group3}, G4=${b.distribution.group4}, G5=${b.distribution.group5}` },
    );
  };

  const handleMove = (accountId, toGroup) => runOp(
    `move:${accountId}:${toGroup}`,
    () => fetch("/api/codex-data/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, toGroup }),
    }),
    { onSuccessMsg: () => `Moved to ${toGroup}` },
  );

  if (loading) return <div className="p-6"><CardSkeleton /></div>;
  if (!data) return <div className="p-6 text-text-muted">No data.</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-main">Data Codex</h1>
          <p className="text-sm text-text-muted mt-1">
            Manage codex OAuth accounts across 5 buckets based on quota state. Group 1 (max {data.group1Limit}) feeds db.json.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            icon="shuffle"
            onClick={handleScatter}
            loading={busy === "scatter"}
            disabled={Boolean(busy)}
          >
            Scatter (random)
          </Button>
          <Button
            variant="primary"
            icon="call_split"
            onClick={handleSplit}
            loading={busy === "split"}
            disabled={Boolean(busy)}
          >
            Split (Tách)
          </Button>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-1">
        {GROUP_ORDER.map((g) => {
          const meta = GROUP_META[g];
          const bucket = data.groups[g] || { accounts: [], count: 0 };
          const capLabel = g === "group1" ? ` / ${data.group1Limit}` : "";
          const isChecking = checkProgress?.group === g;
          return (
            <Card key={g} className="p-4">
              <div className="flex items-start justify-between mb-3 gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-text-main">
                    {meta.title}
                    <span className="ml-2 text-text-muted text-sm font-normal">
                      ({bucket.count}{capLabel})
                    </span>
                    {isChecking && (
                      <span className="ml-2 text-xs text-brand-500 font-medium">
                        ⏳ checking {checkProgress.done}/{checkProgress.total}
                      </span>
                    )}
                  </h2>
                  <p className="text-xs text-text-muted mt-0.5">{meta.description}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {meta.canApply && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="check_circle"
                      onClick={() => handleApply(g)}
                      loading={busy === `apply:${g}`}
                      disabled={Boolean(busy) || bucket.count === 0}
                    >
                      Apply
                    </Button>
                  )}
                  {isChecking ? (
                    <Button
                      size="sm"
                      variant="danger"
                      icon="stop"
                      onClick={handleStopCheck}
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      icon="refresh"
                      onClick={() => handleCheck(g)}
                      loading={busy === `check:${g}`}
                      disabled={Boolean(busy) || bucket.count === 0}
                    >
                      Check
                    </Button>
                  )}
                </div>
              </div>

              {bucket.accounts.length === 0 ? (
                <p className="text-sm text-text-muted italic px-1">No accounts.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-text-muted border-b border-border-subtle">
                        <th className="py-2 pr-3">Account</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3 text-right">Quota left</th>
                        <th className="py-2 pr-3">Reset in</th>
                        <th className="py-2 pr-3">Error</th>
                        <th className="py-2 pr-3">Checked</th>
                        <th className="py-2 pr-3 text-right">Move to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bucket.accounts.map((accFromInitial) => {
                        // Live results take precedence over initial-load data.
                        const live = liveResults[accFromInitial.id];
                        const acc = live
                          ? { ...accFromInitial, ...live, lastCheckedAt: new Date().toISOString() }
                          : accFromInitial;
                        const b = classificationBadge(acc.classification || acc.lastClassification);
                        const pct = acc.quotaPercent;
                        const pctLabel = pct === null || pct === undefined ? "—" : `${pct}%`;
                        const usedTotal = acc.quotaUsed !== null && acc.quotaTotal !== null && acc.quotaTotal !== undefined
                          ? `${acc.quotaUsed}/${acc.quotaTotal}` : null;
                        return (
                          <tr key={accFromInitial.id} className={`border-b border-border-subtle/40 ${live ? "bg-brand-500/[0.03]" : ""}`}>
                            <td className="py-2 pr-3 text-text-main truncate max-w-[240px]" title={acc.name || acc.email}>
                              {acc.name || acc.email || acc.id}
                            </td>
                            <td className="py-2 pr-3"><Badge variant={b.variant}>{b.label}</Badge></td>
                            <td className={`py-2 pr-3 text-right font-mono tabular-nums ${quotaPercentColor(pct)}`}>
                              {pctLabel}
                              {usedTotal && <div className="text-[10px] text-text-muted font-normal">{usedTotal}</div>}
                            </td>
                            <td className="py-2 pr-3 text-text-muted">
                              {formatHours(acc.hoursUntilReset)}
                              {acc.earliestResetAt && (
                                <div className="text-[10px] text-text-muted/70" title={formatTime(acc.earliestResetAt)}>
                                  {formatRelative(acc.earliestResetAt)}
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-3 max-w-[200px]">
                              {acc.error ? (
                                <span className="text-[11px] text-red-500 truncate block" title={acc.error}>{acc.error}</span>
                              ) : (
                                <span className="text-text-muted">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-3 text-text-muted text-xs" title={formatTime(acc.lastCheckedAt)}>
                              {formatRelative(acc.lastCheckedAt)}
                            </td>
                            <td className="py-2 pr-3 text-right">
                              <div className="inline-flex gap-1 items-center flex-wrap justify-end">
                                <button
                                  onClick={() => handleCheckOne(accFromInitial.id)}
                                  disabled={Boolean(busy)}
                                  className="size-6 inline-flex items-center justify-center rounded border border-border-subtle text-brand-500 hover:bg-brand-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                                  title="Check this account"
                                >
                                  <span className="material-symbols-outlined text-[14px]">
                                    {busy === `checkone:${accFromInitial.id}` ? "progress_activity" : "refresh"}
                                  </span>
                                </button>
                                {GROUP_ORDER.filter((other) => other !== g).map((other) => (
                                  <button
                                    key={other}
                                    onClick={() => handleMove(accFromInitial.id, other)}
                                    disabled={Boolean(busy)}
                                    className="px-2 py-0.5 text-[11px] rounded border border-border-subtle text-text-muted hover:bg-surface-2 hover:text-text-main disabled:opacity-40 disabled:cursor-not-allowed"
                                    title={`Move to ${other}`}
                                  >
                                    {other === "groupError" ? "Err" : other.replace("group", "G")}
                                  </button>
                                ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
