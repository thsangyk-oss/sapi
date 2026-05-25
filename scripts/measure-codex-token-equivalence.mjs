// Measure how many tokens correspond to "1% used_percent" on a free-plan codex
// account, by burning ~3% of each of 3 G1 accounts and observing the delta.
//
//   Run from sapi root:
//     node scripts/measure-codex-token-equivalence.mjs
//
// Strategy per acc:
//   1. Fetch baseline used_percent.
//   2. Send N codex requests with a sizeable prompt; each response's SSE
//      stream emits a "response.completed" chunk with usage.{input_tokens,
//      output_tokens} → sum these.
//   3. Re-fetch used_percent.
//   4. tokens_per_percent = totalTokens / (newPct - oldPct).
//   5. Stop early if delta ≥ 3% to limit quota burn.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = process.env.DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "sapi");
const DB_PATH = path.join(DATA_DIR, "db.json");

const NUM_ACCS = Number(process.env.NUM_ACCS || 3);
const TARGET_BURN_PCT = Number(process.env.TARGET_BURN_PCT || 3);
const MAX_REQUESTS_PER_ACC = Number(process.env.MAX_REQUESTS || 8);
const MODEL = process.env.MODEL || "gpt-5.3-codex";

// A prompt designed to consume tokens without producing alarming output.
// ~3000 chars of synthetic but coherent text → ~750 input tokens.
const FILLER = `Please summarise the following technical notes in 2 sentences.

`;
const PARAGRAPH = `The HTTP protocol is a stateless application-layer protocol used to transfer hypertext requests and responses between clients and servers. It operates by issuing a request from the client containing a method (GET, POST, PUT, DELETE, etc.) and a target resource identifier; the server responds with a status code, headers, and an optional body. HTTP/1.1 introduced persistent connections and pipelining to improve latency, while HTTP/2 added multiplexed streams and header compression over a single TCP connection. HTTP/3 builds on QUIC, which uses UDP instead of TCP to reduce head-of-line blocking and allow faster handshakes. Compression negotiation, caching directives, and conditional requests further reduce bandwidth. Authentication is layered through headers such as Authorization and Cookie, while encryption is provided by TLS in HTTPS deployments. Common content types include application/json, text/html, application/xml, multipart/form-data for uploads, and binary streams for media. REST style APIs map CRUD semantics onto these methods. Modern web services frequently combine HTTP with WebSockets or Server-Sent Events for bidirectional and push-style communication. Rate limiting policies, idempotency tokens, and distributed tracing headers are commonplace in microservice architectures. Many gateways perform validation, transformation, and observability tasks transparently at the HTTP boundary. `;
const PROMPT = FILLER + PARAGRAPH.repeat(3);

function loadCodexAccs(limit) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  const codex = (db.providerConnections || [])
    .filter((c) => c.provider === "codex" && c.authType === "oauth" && c.accessToken && c.isActive !== false);
  // Prefer accs with LOW current quotaPercent left (UI claims they're closer to limit)
  // but for measurement we want some headroom — pick ones with reasonable remaining quota.
  // Just take first N for simplicity; user can re-run with different ordering.
  return codex.slice(0, limit);
}

async function fetchUsedPercent(accessToken) {
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`usage HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const primary = data?.rate_limit?.primary_window;
  if (!primary) throw new Error("no primary_window in response");
  return {
    usedPercent: Number(primary.used_percent),
    resetAt: primary.reset_at,
    windowSeconds: primary.limit_window_seconds,
  };
}

async function sendCodexRequest(accessToken) {
  const body = {
    model: MODEL,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: PROMPT }],
    }],
    instructions: "You are a concise technical assistant. Respond in at most two short sentences.",
    stream: true,
    store: false,
    reasoning: { effort: "low", summary: "auto" },
  };
  const res = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "originator": "codex-cli",
      "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
      "session_id": `tokmeasure_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`responses HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  // Stream parse → look for the response.completed event with usage.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt?.response?.usage) usage = evt.response.usage;
        if (evt?.type === "response.completed" && evt?.response?.usage) usage = evt.response.usage;
      } catch { /* ignore non-json */ }
    }
  }
  return usage;
}

async function measureOne(acc) {
  console.log(`\n[${acc.email}] starting baseline check...`);
  const before = await fetchUsedPercent(acc.accessToken);
  console.log(`  baseline used_percent = ${before.usedPercent}%, resetAt = ${new Date(before.resetAt * 1000).toISOString()}`);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  const requests = [];

  for (let i = 0; i < MAX_REQUESTS_PER_ACC; i++) {
    process.stdout.write(`  request ${i + 1}/${MAX_REQUESTS_PER_ACC}... `);
    try {
      const usage = await sendCodexRequest(acc.accessToken);
      if (!usage) {
        console.log("(no usage in response)");
        requests.push({ ok: false, reason: "no usage" });
        continue;
      }
      const it = Number(usage.input_tokens || 0);
      const ot = Number(usage.output_tokens || 0);
      const tt = Number(usage.total_tokens || it + ot);
      totalInputTokens += it;
      totalOutputTokens += ot;
      totalTokens += tt;
      requests.push({ ok: true, input: it, output: ot, total: tt });
      console.log(`in=${it}, out=${ot}, total=${tt}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      requests.push({ ok: false, reason: err.message });
      break;
    }

    // Mid-loop usage check to bail when target burn reached.
    if ((i + 1) % 2 === 0) {
      try {
        const mid = await fetchUsedPercent(acc.accessToken);
        const deltaPct = mid.usedPercent - before.usedPercent;
        process.stdout.write(`    mid check: ${mid.usedPercent}% (delta ${deltaPct}%)\n`);
        if (deltaPct >= TARGET_BURN_PCT) {
          console.log(`    reached target burn ${TARGET_BURN_PCT}%, stopping.`);
          break;
        }
      } catch (err) {
        console.log(`    mid check failed: ${err.message}`);
      }
    }
  }

  console.log(`  finishing with usage check...`);
  const after = await fetchUsedPercent(acc.accessToken);
  const deltaPct = after.usedPercent - before.usedPercent;
  const tokensPerPct = deltaPct > 0 ? totalTokens / deltaPct : null;
  const summary = {
    email: acc.email,
    baselinePct: before.usedPercent,
    finalPct: after.usedPercent,
    deltaPct,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens,
    tokensPerPct,
    requests: requests.length,
    okRequests: requests.filter((r) => r.ok).length,
  };
  console.log(`  RESULT: delta=${deltaPct}%, tokens=${totalTokens} (in=${totalInputTokens}, out=${totalOutputTokens}), tokens/1% = ${tokensPerPct?.toFixed(0) ?? "N/A"}`);
  return summary;
}

async function main() {
  const accs = loadCodexAccs(NUM_ACCS);
  if (accs.length === 0) {
    console.error("No active codex accs found in db.json");
    process.exit(1);
  }
  console.log(`Measuring on ${accs.length} acc(s), model=${MODEL}, target burn ${TARGET_BURN_PCT}%`);

  const results = [];
  for (const acc of accs) {
    try {
      const summary = await measureOne(acc);
      results.push(summary);
    } catch (err) {
      console.log(`[${acc.email}] FATAL: ${err.message}`);
      results.push({ email: acc.email, error: err.message });
    }
  }

  console.log("\n=== AGGREGATE ===");
  const valid = results.filter((r) => Number.isFinite(r.tokensPerPct) && r.tokensPerPct > 0);
  for (const r of results) {
    if (r.error) console.log(`  ${r.email}: ERROR ${r.error}`);
    else console.log(`  ${r.email}: ${r.tokensPerPct?.toFixed(0) ?? "N/A"} tokens/% (delta=${r.deltaPct}%, total=${r.totalTokens})`);
  }
  if (valid.length > 0) {
    const avg = valid.reduce((s, r) => s + r.tokensPerPct, 0) / valid.length;
    console.log(`\nAverage tokens per 1% across ${valid.length} acc(s): ${avg.toFixed(0)}`);
    console.log(`→ 100% ≈ ${(avg * 100).toFixed(0)} tokens per 7-day window`);
  } else {
    console.log("\nNo valid measurements (delta=0 or all errored).");
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
