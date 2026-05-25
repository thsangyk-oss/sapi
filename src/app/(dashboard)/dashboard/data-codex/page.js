"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge, Button, Card, CardSkeleton } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import {
  GROUP_COLORS,
  GROUP_ORDER,
  QUOTA_STATE_COLORS,
  TOKENS_PER_ACC_FULL,
  TOKENS_PER_PERCENT,
  computeQuotaHistogram,
  computeResetHistogram,
  computeStats,
  fmtPct,
  fmtTokens,
} from "./stats";

const GROUP_META = {
  group1: { label: "G1 — Active", short: "G1", canApply: false },
  group2: { label: "G2 — Waiting", short: "G2", canApply: true },
  group3: { label: "G3 — Reset <24h", short: "G3", canApply: true },
  group4: { label: "G4 — Reset 24–72h", short: "G4", canApply: true },
  group5: { label: "G5 — Reset >72h", short: "G5", canApply: true },
  groupError: { label: "Errors", short: "Err", canApply: true },
};

function classificationBadge(value) {
  if (!value) return { label: "—", variant: "default" };
  if (value === "active") return { label: "Active", variant: "success" };
  if (value === "reset_lt24") return { label: "<24h", variant: "warning" };
  if (value === "reset_24_72") return { label: "24-72h", variant: "warning" };
  if (value === "reset_gt72") return { label: ">72h", variant: "error" };
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
  let label;
  if (abs < 60000) label = "just now";
  else if (abs < 3600000) label = `${Math.round(abs / 60000)}m`;
  else if (abs < 86400000) label = `${Math.round(abs / 3600000)}h`;
  else label = `${Math.round(abs / 86400000)}d`;
  return diffMs < 0 ? `${label} ago` : `in ${label}`;
}

function formatHours(h) {
  if (h === null || h === undefined) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

function quotaPctColor(pct) {
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
  const [liveResults, setLiveResults] = useState({});
  const [checkProgress, setCheckProgress] = useState(null);
  const [checkAbort, setCheckAbort] = useState(null);
  const [scheduler, setScheduler] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const notify = useNotificationStore((s) => s.addNotification);

  const stats = useMemo(() => computeStats(data), [data]);
  const resetHistogram = useMemo(() => computeResetHistogram(data), [data]);

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

  const loadScheduler = useCallback(async () => {
    try {
      const res = await fetch("/api/codex-data/scheduler", { cache: "no-store" });
      if (res.ok) setScheduler(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); loadScheduler(); }, [load, loadScheduler]);

  useEffect(() => {
    const id = setInterval(loadScheduler, 20_000);
    return () => clearInterval(id);
  }, [loadScheduler]);

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

  const handleCheck = useCallback(async (group) => {
    const controller = new AbortController();
    setCheckAbort(controller);
    setBusy(`check:${group}`);
    setCheckProgress({ group, done: 0, total: 0 });
    setLiveResults({});
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
  }, [load, notify]);

  const handleStopCheck = useCallback(() => {
    if (checkAbort) checkAbort.abort();
  }, [checkAbort]);

  const handleCheckOne = useCallback(async (accountId) => {
    setBusy(`checkone:${accountId}`);
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
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group }),
    }),
    { onSuccessMsg: (b) => b.reason ? b.reason : `Applied ${b.applied} acc from ${group} → G1` },
  );

  const handleSplit = () => runOp(
    "split",
    () => fetch("/api/codex-data/split", { method: "POST" }),
    { onSuccessMsg: (b) => `Split: ${b.moves} move(s); G1 ${b.group1ActiveInDb}/${b.group1Limit}` },
  );

  const handleScatter = () => {
    if (!globalThis.confirm("Shuffle ALL codex accounts and randomly distribute: 70 to G1, the rest evenly across G2-G5. Continue?")) return;
    return runOp(
      "scatter",
      () => fetch("/api/codex-data/scatter", { method: "POST" }),
      { onSuccessMsg: (b) => `Scattered ${b.total} acc: G1=${b.distribution.group1}, G2=${b.distribution.group2}, G3=${b.distribution.group3}, G4=${b.distribution.group4}, G5=${b.distribution.group5}` },
    );
  };

  const handleMove = (accountId, toGroup) => runOp(
    `move:${accountId}:${toGroup}`,
    () => fetch("/api/codex-data/move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, toGroup }),
    }),
    { onSuccessMsg: () => `Moved to ${toGroup}` },
  );

  const handleSchedulerToggle = useCallback(async () => {
    if (!scheduler) return;
    setBusy("scheduler:toggle");
    try {
      const res = await fetch("/api/codex-data/scheduler", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", enabled: !scheduler.enabled }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setScheduler(body.status);
      notify({ message: `Auto job ${body.status.enabled ? "enabled" : "disabled"}`, type: "success" });
    } catch (err) {
      notify({ message: err.message, type: "error" });
    } finally {
      setBusy(null);
    }
  }, [scheduler, notify]);

  const handleSchedulerRunNow = useCallback(async () => {
    setBusy("scheduler:run");
    try {
      const res = await fetch("/api/codex-data/scheduler", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "runNow" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setScheduler(body.status);
      const r = body.status.lastResult;
      notify({
        message: r?.ok
          ? `Cycle done in ${Math.round((r.durationMs || 0) / 1000)}s — moved ${r.result?.reclassify?.moves ?? 0}, evicted ${r.result?.cycle?.evicted ?? 0}, promoted ${r.result?.cycle?.promoted ?? 0}`
          : `Cycle failed: ${r?.error || "unknown"}`,
        type: r?.ok ? "success" : "error",
      });
      await load();
    } catch (err) {
      notify({ message: err.message, type: "error" });
    } finally {
      setBusy(null);
    }
  }, [load, notify]);

  if (loading) return <div className="p-6"><CardSkeleton /></div>;
  if (!data || !stats) return <div className="p-6 text-text-muted">No data.</div>;

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-main">Data Codex</h1>
          <p className="text-sm text-text-muted mt-1">
            {stats.totalAccs} codex accounts across 6 buckets · 1% ≈ {TOKENS_PER_PERCENT.toLocaleString()} tokens (free plan, measured).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon="shuffle" onClick={handleScatter} loading={busy === "scatter"} disabled={Boolean(busy)}>
            Scatter
          </Button>
          <Button variant="primary" icon="call_split" onClick={handleSplit} loading={busy === "split"} disabled={Boolean(busy)}>
            Split
          </Button>
        </div>
      </div>

      {/* Scheduler banner */}
      {scheduler && <SchedulerBanner scheduler={scheduler} busy={busy} onToggle={handleSchedulerToggle} onRunNow={handleSchedulerRunNow} />}

      {/* Overview card */}
      <OverviewCard stats={stats} />

      {/* G1 & G2 side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ActiveGroupCard
          group="group1"
          data={data}
          stats={stats}
          selected={selectedGroup === "group1"}
          onSelect={() => setSelectedGroup(selectedGroup === "group1" ? null : "group1")}
          onCheck={() => handleCheck("group1")}
          onApply={null}
          checkProgress={checkProgress}
          busy={busy}
          onStop={handleStopCheck}
        />
        <ActiveGroupCard
          group="group2"
          data={data}
          stats={stats}
          selected={selectedGroup === "group2"}
          onSelect={() => setSelectedGroup(selectedGroup === "group2" ? null : "group2")}
          onCheck={() => handleCheck("group2")}
          onApply={() => handleApply("group2")}
          checkProgress={checkProgress}
          busy={busy}
          onStop={handleStopCheck}
        />
      </div>

      {/* G3-G5 combined row */}
      <ResetsCombinedCard
        data={data}
        stats={stats}
        histogram={resetHistogram}
        selected={selectedGroup}
        onSelectGroup={(g) => setSelectedGroup(selectedGroup === g ? null : g)}
        onCheck={handleCheck}
        onApply={handleApply}
        checkProgress={checkProgress}
        busy={busy}
        onStop={handleStopCheck}
      />

      {/* Errors */}
      <ErrorsCard
        data={data}
        stats={stats}
        selected={selectedGroup === "groupError"}
        onSelect={() => setSelectedGroup(selectedGroup === "groupError" ? null : "groupError")}
        onCheck={() => handleCheck("groupError")}
        onApply={() => handleApply("groupError")}
        checkProgress={checkProgress}
        busy={busy}
        onStop={handleStopCheck}
      />

      {/* Table — appears when a group is selected */}
      {selectedGroup && (
        <AccountsTable
          group={selectedGroup}
          accounts={data.groups[selectedGroup]?.accounts || []}
          liveResults={liveResults}
          busy={busy}
          onMove={handleMove}
          onCheckOne={handleCheckOne}
        />
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function SchedulerBanner({ scheduler, busy, onToggle, onRunNow }) {
  return (
    <Card className="p-3 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="font-semibold text-text-main">
          Auto job
          <Badge variant={scheduler.enabled ? "success" : "default"} className="ml-2">
            {scheduler.enabled ? "ON" : "OFF"}
          </Badge>
          {scheduler.running && <Badge variant="info" className="ml-1">running</Badge>}
        </span>
        <span className="text-text-muted">Last: <span className="text-text-main">{formatRelative(scheduler.lastRun ? new Date(scheduler.lastRun).toISOString() : null)}</span></span>
        <span className="text-text-muted">Next: <span className="text-text-main">{scheduler.enabled ? formatRelative(scheduler.nextRun ? new Date(scheduler.nextRun).toISOString() : null) : "—"}</span></span>
        <span className="text-text-muted">Interval: <span className="text-text-main">{Math.round((scheduler.intervalMs || 0) / 60000)}m</span></span>
        {scheduler.lastResult && (
          <span className="text-text-muted text-xs">
            Last:{" "}
            {scheduler.lastResult.ok ? (
              <>
                reclass {scheduler.lastResult.result?.reclassify?.moves ?? 0} ·
                evict {scheduler.lastResult.result?.cycle?.evicted ?? 0} ·
                promote {scheduler.lastResult.result?.cycle?.promoted ?? 0}
              </>
            ) : <span className="text-red-500">{scheduler.lastResult.error}</span>}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant={scheduler.enabled ? "ghost" : "secondary"} icon={scheduler.enabled ? "pause" : "play_arrow"} onClick={onToggle} loading={busy === "scheduler:toggle"} disabled={Boolean(busy)}>
          {scheduler.enabled ? "Disable" : "Enable"}
        </Button>
        <Button size="sm" variant="outline" icon="bolt" onClick={onRunNow} loading={busy === "scheduler:run" || scheduler.running} disabled={Boolean(busy) || scheduler.running}>
          Run now
        </Button>
      </div>
    </Card>
  );
}

function OverviewCard({ stats }) {
  // Group distribution data for stacked bar.
  const groupBarData = GROUP_ORDER.map((g) => ({
    group: g,
    label: GROUP_META[g].short,
    count: stats.perGroup[g].count,
    fill: GROUP_COLORS[g],
  }));

  // Quota state pie (token-weighted).
  const pieData = [
    { name: "Usable now (G1+G2)", value: stats.usableNow, fill: QUOTA_STATE_COLORS.usableNow },
    { name: "Reset <24h (G3)", value: stats.recoveringSoon, fill: QUOTA_STATE_COLORS.recoveringSoon },
    { name: "Reset 24-72h (G4)", value: stats.recoveringMid, fill: QUOTA_STATE_COLORS.recoveringMid },
    { name: "Reset >72h (G5)", value: stats.recoveringFar, fill: QUOTA_STATE_COLORS.recoveringFar },
    { name: "Errors", value: stats.lost, fill: QUOTA_STATE_COLORS.lost },
  ].filter((d) => d.value > 0);

  return (
    <Card className="p-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* KPIs */}
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase text-text-muted tracking-wider">Overview</p>
            <p className="text-3xl font-bold text-text-main mt-1">{stats.totalAccs} <span className="text-base text-text-muted font-normal">accounts</span></p>
          </div>
          <div className="space-y-1.5 text-sm">
            <KpiRow color={QUOTA_STATE_COLORS.usableNow} label="Usable now" value={fmtTokens(stats.usableNow)} sub={`${stats.perGroup.group1.count + stats.perGroup.group2.count} acc · G1+G2`} />
            <KpiRow color={QUOTA_STATE_COLORS.recoveringSoon} label="Reset soon (<24h)" value={fmtTokens(stats.recoveringSoon)} sub={`${stats.perGroup.group3.count} acc · G3`} />
            <KpiRow color={QUOTA_STATE_COLORS.recoveringMid} label="Reset 24-72h" value={fmtTokens(stats.recoveringMid)} sub={`${stats.perGroup.group4.count} acc · G4`} />
            <KpiRow color={QUOTA_STATE_COLORS.recoveringFar} label="Reset >72h" value={fmtTokens(stats.recoveringFar)} sub={`${stats.perGroup.group5.count} acc · G5`} />
            <KpiRow color={QUOTA_STATE_COLORS.lost} label="Errored" value={fmtTokens(stats.lost)} sub={`${stats.perGroup.groupError.count} acc · Err`} />
          </div>
        </div>

        {/* Account count per group bar */}
        <div>
          <p className="text-xs uppercase text-text-muted tracking-wider mb-2">Accounts per group</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={groupBarData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--text-muted, #888)" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "var(--text-muted, #888)" }} axisLine={false} tickLine={false} width={32} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {groupBarData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Token state pie */}
        <div>
          <p className="text-xs uppercase text-text-muted tracking-wider mb-2">Token state (weekly window)</p>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={70} paddingAngle={2}>
                {pieData.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                formatter={(value, name) => [`${fmtTokens(value)} tokens`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
          <p className="text-center text-xs text-text-muted mt-1">
            Total cap: <span className="font-mono text-text-main">{fmtTokens(stats.grandTotal)}</span>
          </p>
        </div>
      </div>
    </Card>
  );
}

function KpiRow({ color, label, value, sub }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="text-text-main truncate">{label}</span>
      </div>
      <div className="text-right">
        <span className="font-mono text-text-main">{value}</span>
        {sub && <span className="text-text-muted text-xs ml-2">{sub}</span>}
      </div>
    </div>
  );
}

function ActiveGroupCard({ group, data, stats, selected, onSelect, onCheck, onApply, checkProgress, busy, onStop }) {
  const meta = GROUP_META[group];
  const gs = stats.perGroup[group];
  const accs = data.groups[group]?.accounts || [];
  const hist = useMemo(() => computeQuotaHistogram(accs), [accs]);
  const limit = group === "group1" ? data.group1Limit : null;
  const isChecking = checkProgress?.group === group;

  return (
    <Card
      className={`p-4 cursor-pointer transition-all ${selected ? "ring-2 ring-brand-500/50" : "hover:border-brand-500/30"}`}
      onClick={onSelect}
      style={{ borderLeftColor: GROUP_COLORS[group], borderLeftWidth: 4 }}
    >
      <div className="flex items-start justify-between gap-2 mb-3" onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="text-base font-semibold text-text-main">{meta.label}</h3>
          <p className="text-2xl font-bold text-text-main mt-1">
            {gs.count}{limit && <span className="text-text-muted text-base font-normal"> / {limit}</span>}
            <span className="text-xs text-text-muted ml-2 font-normal">acc</span>
            {isChecking && <span className="ml-2 text-xs text-brand-500">⏳ {checkProgress.done}/{checkProgress.total}</span>}
          </p>
        </div>
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          {onApply && (
            <Button size="sm" variant="secondary" icon="check_circle" onClick={onApply} loading={busy === `apply:${group}`} disabled={Boolean(busy) || gs.count === 0}>
              Apply
            </Button>
          )}
          {isChecking ? (
            <Button size="sm" variant="danger" icon="stop" onClick={onStop}>Stop</Button>
          ) : (
            <Button size="sm" variant="outline" icon="refresh" onClick={onCheck} loading={busy === `check:${group}`} disabled={Boolean(busy) || gs.count === 0}>
              Check
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-text-muted text-xs">Avg quota left</p>
          <p className={`text-xl font-bold ${quotaPctColor(gs.avgPct)}`}>{fmtPct(gs.avgPct)}</p>
          <p className="text-text-muted text-xs">{gs.checkedCount}/{gs.count} checked</p>
        </div>
        <div>
          <p className="text-text-muted text-xs">Tokens left</p>
          <p className="text-xl font-bold text-text-main font-mono">{fmtTokens(gs.tokensLeft)}</p>
          <p className="text-text-muted text-xs">~{fmtTokens(gs.count * TOKENS_PER_ACC_FULL)} max</p>
        </div>
      </div>

      <div className="mt-3">
        <p className="text-text-muted text-xs mb-1">Quota distribution</p>
        <ResponsiveContainer width="100%" height={80}>
          <BarChart data={hist} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--text-muted, #888)" }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} formatter={(v) => [`${v} acc`, "Count"]} />
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {hist.map((b, i) => {
                const colors = ["#ef4444", "#f97316", "#facc15", "#84cc16", "#10b981"];
                return <Cell key={i} fill={colors[i] || GROUP_COLORS[group]} />;
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="text-xs text-text-muted mt-2 text-center">
        {selected ? "Click to collapse table" : "Click to view accounts"}
      </p>
    </Card>
  );
}

function ResetsCombinedCard({ data, stats, histogram, selected, onSelectGroup, onCheck, onApply, checkProgress, busy, onStop }) {
  // Color bars by their group region
  const barColor = (b) => GROUP_COLORS[b.group];

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-base font-semibold text-text-main">Resetting accounts (G3 - G5)</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Distribution of hours-until-reset. Tap a sub-card below to view accounts.
          </p>
        </div>
        <div className="flex gap-4 text-sm">
          <span><span className="size-2.5 rounded-full inline-block mr-1.5" style={{ backgroundColor: GROUP_COLORS.group3 }} />G3: <b>{stats.perGroup.group3.count}</b></span>
          <span><span className="size-2.5 rounded-full inline-block mr-1.5" style={{ backgroundColor: GROUP_COLORS.group4 }} />G4: <b>{stats.perGroup.group4.count}</b></span>
          <span><span className="size-2.5 rounded-full inline-block mr-1.5" style={{ backgroundColor: GROUP_COLORS.group5 }} />G5: <b>{stats.perGroup.group5.count}</b></span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={histogram} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--text-muted, #888)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--text-muted, #888)" }} axisLine={false} tickLine={false} width={32} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} formatter={(v) => [`${v} acc`, "Count"]} />
          <Bar dataKey="count" radius={[6, 6, 0, 0]}>
            {histogram.map((b, i) => <Cell key={i} fill={barColor(b)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
        {["group3", "group4", "group5"].map((g) => (
          <MiniGroupCard
            key={g}
            group={g}
            stats={stats}
            selected={selected === g}
            isChecking={checkProgress?.group === g}
            checkProgress={checkProgress}
            busy={busy}
            onSelect={() => onSelectGroup(g)}
            onCheck={() => onCheck(g)}
            onApply={() => onApply(g)}
            onStop={onStop}
          />
        ))}
      </div>
    </Card>
  );
}

function MiniGroupCard({ group, stats, selected, isChecking, checkProgress, busy, onSelect, onCheck, onApply, onStop }) {
  const meta = GROUP_META[group];
  const gs = stats.perGroup[group];
  return (
    <div
      onClick={onSelect}
      className={`p-3 rounded-lg border cursor-pointer transition-all ${selected ? "ring-2 ring-brand-500/50 bg-brand-500/5" : "border-border-subtle hover:border-brand-500/30 hover:bg-surface-2/30"}`}
      style={{ borderLeftColor: GROUP_COLORS[group], borderLeftWidth: 4 }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase text-text-muted tracking-wider">{meta.short}</p>
          <p className="text-2xl font-bold text-text-main">
            {gs.count}
            {isChecking && <span className="ml-2 text-xs text-brand-500">⏳ {checkProgress.done}/{checkProgress.total}</span>}
          </p>
          <p className="text-xs text-text-muted">~{fmtTokens(gs.count * TOKENS_PER_ACC_FULL)} on reset</p>
        </div>
        <div className="flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
          {isChecking ? (
            <Button size="sm" variant="danger" icon="stop" onClick={onStop}>Stop</Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" icon="check_circle" onClick={onApply} loading={busy === `apply:${group}`} disabled={Boolean(busy) || gs.count === 0}>
                Apply
              </Button>
              <Button size="sm" variant="outline" icon="refresh" onClick={onCheck} loading={busy === `check:${group}`} disabled={Boolean(busy) || gs.count === 0}>
                Check
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorsCard({ data, stats, selected, onSelect, onCheck, onApply, checkProgress, busy, onStop }) {
  const gs = stats.perGroup.groupError;
  const isChecking = checkProgress?.group === "groupError";
  if (gs.count === 0 && !selected) {
    // Compact empty state when no errors and not selected
    return (
      <Card className="p-3 flex items-center justify-between text-sm text-text-muted">
        <span><span className="size-2.5 rounded-full inline-block mr-2" style={{ backgroundColor: GROUP_COLORS.groupError }} />Errors: <b className="text-text-main">0</b> — no broken accounts</span>
      </Card>
    );
  }
  return (
    <Card
      className={`p-4 cursor-pointer transition-all ${selected ? "ring-2 ring-red-500/50" : "hover:border-red-500/30"}`}
      onClick={onSelect}
      style={{ borderLeftColor: GROUP_COLORS.groupError, borderLeftWidth: 4 }}
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-text-main">Errors</h3>
          <p className="text-2xl font-bold text-red-500">
            {gs.count}
            {isChecking && <span className="ml-2 text-xs text-brand-500">⏳ {checkProgress.done}/{checkProgress.total}</span>}
          </p>
          <p className="text-xs text-text-muted">Accounts that failed last check — likely revoked or rate-limited</p>
        </div>
        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" icon="check_circle" onClick={onApply} loading={busy === "apply:groupError"} disabled={Boolean(busy) || gs.count === 0}>
            Apply
          </Button>
          {isChecking ? (
            <Button size="sm" variant="danger" icon="stop" onClick={onStop}>Stop</Button>
          ) : (
            <Button size="sm" variant="outline" icon="refresh" onClick={onCheck} loading={busy === "check:groupError"} disabled={Boolean(busy) || gs.count === 0}>
              Check
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function AccountsTable({ group, accounts, liveResults, busy, onMove, onCheckOne }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-text-main">
          {GROUP_META[group].label} <span className="text-text-muted font-normal text-sm">— {accounts.length} accounts</span>
        </h3>
      </div>
      {accounts.length === 0 ? (
        <p className="text-sm text-text-muted italic px-1">No accounts.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-text-muted border-b border-border-subtle">
                <th className="py-2 pr-3">Account</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3 text-right">Quota left</th>
                <th className="py-2 pr-3 text-right">Tokens left</th>
                <th className="py-2 pr-3">Reset in</th>
                <th className="py-2 pr-3">Error</th>
                <th className="py-2 pr-3">Checked</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((accFromInitial) => {
                const live = liveResults[accFromInitial.id];
                const acc = live
                  ? { ...accFromInitial, ...live, lastCheckedAt: new Date().toISOString() }
                  : accFromInitial;
                const b = classificationBadge(acc.classification || acc.lastClassification);
                const pct = acc.quotaPercent;
                const tokensLeft = Number.isFinite(pct) ? Math.round(pct * TOKENS_PER_PERCENT) : null;
                return (
                  <tr key={accFromInitial.id} className={`border-b border-border-subtle/40 ${live ? "bg-brand-500/[0.03]" : ""}`}>
                    <td className="py-2 pr-3 text-text-main truncate max-w-[240px]" title={acc.name || acc.email}>
                      {acc.name || acc.email || acc.id}
                    </td>
                    <td className="py-2 pr-3"><Badge variant={b.variant}>{b.label}</Badge></td>
                    <td className={`py-2 pr-3 text-right font-mono tabular-nums ${quotaPctColor(pct)}`}>{fmtPct(pct)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-text-main">{tokensLeft !== null ? fmtTokens(tokensLeft) : "—"}</td>
                    <td className="py-2 pr-3 text-text-muted">
                      {formatHours(acc.hoursUntilReset)}
                      {acc.earliestResetAt && (
                        <div className="text-[10px] text-text-muted/70" title={formatTime(acc.earliestResetAt)}>
                          {formatRelative(acc.earliestResetAt)}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 max-w-[200px]">
                      {acc.error || acc.lastError ? (
                        <span className="text-[11px] text-red-500 truncate block" title={acc.error || acc.lastError}>{acc.error || acc.lastError}</span>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-text-muted text-xs" title={formatTime(acc.lastCheckedAt)}>{formatRelative(acc.lastCheckedAt)}</td>
                    <td className="py-2 pr-3 text-right">
                      <div className="inline-flex gap-1 items-center flex-wrap justify-end">
                        <button
                          onClick={() => onCheckOne(accFromInitial.id)}
                          disabled={Boolean(busy)}
                          className="size-6 inline-flex items-center justify-center rounded border border-border-subtle text-brand-500 hover:bg-brand-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Check this account"
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            {busy === `checkone:${accFromInitial.id}` ? "progress_activity" : "refresh"}
                          </span>
                        </button>
                        {GROUP_ORDER.filter((other) => other !== group).map((other) => (
                          <button
                            key={other}
                            onClick={() => onMove(accFromInitial.id, other)}
                            disabled={Boolean(busy)}
                            className="px-2 py-0.5 text-[11px] rounded border border-border-subtle text-text-muted hover:bg-surface-2 hover:text-text-main disabled:opacity-40 disabled:cursor-not-allowed"
                            title={`Move to ${other}`}
                          >
                            {GROUP_META[other].short}
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
}
