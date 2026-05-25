import { NextResponse } from "next/server";
import { getStatus, setEnabled, setIntervalMs, runNow, start } from "@/lib/codex-data/scheduler";

// GET /api/codex-data/scheduler — return scheduler status.
export async function GET() {
  try {
    // Ensure it's running (in case instrumentation hook didn't fire — e.g.
    // dev mode quirks). Idempotent.
    await start().catch(() => {});
    return NextResponse.json(getStatus());
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/codex-data/scheduler  { action: "toggle"|"setInterval"|"runNow", ... }
export async function POST(request) {
  try {
    const body = await request.json();
    const { action } = body || {};
    if (action === "toggle") {
      const next = await setEnabled(!!body.enabled);
      return NextResponse.json({ ok: true, status: next });
    }
    if (action === "setInterval") {
      const ms = Number(body.intervalMs);
      const next = await setIntervalMs(ms);
      return NextResponse.json({ ok: true, status: next });
    }
    if (action === "runNow") {
      const next = await runNow();
      return NextResponse.json({ ok: true, status: next });
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
