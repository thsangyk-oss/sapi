import { NextResponse } from "next/server";
import { revokeAuthorization } from "@/lib/tunnel/tunnelManager";

export const dynamic = "force-dynamic";

// POST — fully de-authorize: stop tunnel, delete CF tunnel registration + local cert + credentials.
// CF dashboard DNS records for orphaned hostnames must be cleaned up manually.
export async function POST() {
  try {
    const result = await revokeAuthorization();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
