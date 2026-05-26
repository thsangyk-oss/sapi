import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/localDb";
import { getUsageDb, getApiKeyHeartbeats } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 60 * 60 * 1000;

// GET /api/keys/stats - Per-key 24h aggregates + live heartbeat for the keys page.
// Keyed by API key id so the client can join with /api/keys without exposing the
// full key string in this payload.
export async function GET() {
  try {
    const [keys, db] = await Promise.all([getApiKeys(), getUsageDb()]);

    // Build keyString -> id index. Map heartbeats first so we count activity
    // even before the first completed request is persisted.
    const idByKeyString = {};
    for (const k of keys) {
      if (k.key) idByKeyString[k.key] = k.id;
    }

    const stats = {};
    for (const k of keys) {
      stats[k.id] = {
        tokens24h: 0,
        promptTokens24h: 0,
        completionTokens24h: 0,
        requests24h: 0,
        lastUsedTs: null,
        activeNow: false,
      };
    }

    const cutoff = Date.now() - WINDOW_MS;
    const history = db.data?.history || [];
    for (const entry of history) {
      if (!entry?.apiKey || typeof entry.apiKey !== "string") continue;
      const id = idByKeyString[entry.apiKey];
      if (!id || !stats[id]) continue;
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      if (!ts || ts < cutoff) continue;

      const prompt = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
      const completion = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
      stats[id].promptTokens24h += prompt;
      stats[id].completionTokens24h += completion;
      stats[id].tokens24h += prompt + completion;
      stats[id].requests24h += 1;
      if (!stats[id].lastUsedTs || ts > stats[id].lastUsedTs) {
        stats[id].lastUsedTs = ts;
      }
    }

    // Overlay heartbeats (mid-flight requests that haven't completed yet)
    const heartbeats = getApiKeyHeartbeats();
    const now = Date.now();
    for (const [keyString, hbTs] of Object.entries(heartbeats)) {
      const id = idByKeyString[keyString];
      if (!id || !stats[id]) continue;
      if (!stats[id].lastUsedTs || hbTs > stats[id].lastUsedTs) {
        stats[id].lastUsedTs = hbTs;
      }
      // Within the last 90s: treat as "currently active" for stronger pulse.
      if (now - hbTs < 90 * 1000) {
        stats[id].activeNow = true;
      }
    }

    return NextResponse.json({ stats });
  } catch (error) {
    console.log("Error fetching key stats:", error);
    return NextResponse.json({ error: "Failed to fetch key stats" }, { status: 500 });
  }
}
