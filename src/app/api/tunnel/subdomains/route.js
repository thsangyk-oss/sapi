import { NextResponse } from "next/server";
import { addSubdomain, getTunnelStatus } from "@/lib/tunnel/tunnelManager";

export const dynamic = "force-dynamic";

// POST { hostname } — register a subdomain (DNS route + restart tunnel)
export async function POST(request) {
  try {
    const body = await request.json();
    const hostname = body?.hostname;
    if (!hostname) return NextResponse.json({ error: "hostname is required" }, { status: 400 });
    const result = await addSubdomain(hostname);
    const status = await getTunnelStatus();
    return NextResponse.json({ ...result, status });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
