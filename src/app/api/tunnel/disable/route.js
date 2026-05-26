import { NextResponse } from "next/server";
import { disableTunnel } from "@/lib/tunnel/tunnelManager";

export const dynamic = "force-dynamic";

// POST — stop the cloudflared process. Subdomains + authorization stay configured;
// next call to addSubdomain or watchdog tick will restart it.
export async function POST() {
  try {
    const result = await disableTunnel();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel disable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
