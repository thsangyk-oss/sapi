import { NextResponse } from "next/server";
import { getTunnelStatus } from "@/lib/tunnel/tunnelManager";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const tunnel = await getTunnelStatus();
    return NextResponse.json({ tunnel, download: tunnel.download });
  } catch (error) {
    console.error("Tunnel status error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
