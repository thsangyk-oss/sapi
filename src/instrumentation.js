// Next.js instrumentation hook — fires once at server boot.
// Used to start the Data Codex hourly scheduler.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const mod = await import("@/lib/codex-data/scheduler");
    await mod.start();
  } catch (err) {
    console.error("[instrumentation] failed to start codex scheduler:", err);
  }
}
