import { NextResponse } from "next/server";
import { removeSubdomain, getTunnelStatus } from "@/lib/tunnel/tunnelManager";

export const dynamic = "force-dynamic";

// DELETE — remove a subdomain (rewrites config + restarts tunnel)
// NB: leaves the orphaned CNAME at Cloudflare; user must clean up via dashboard.
export async function DELETE(_request, { params }) {
  try {
    const { host } = await params;
    const hostname = decodeURIComponent(host || "");
    const result = await removeSubdomain(hostname);
    const status = await getTunnelStatus();
    return NextResponse.json({ ...result, status });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
