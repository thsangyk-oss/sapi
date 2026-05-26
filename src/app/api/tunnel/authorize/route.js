import { NextResponse } from "next/server";
import { startAuthorize, getAuthorizeStatus, cancelAuthorize } from "@/lib/tunnel/tunnelManager";

export const dynamic = "force-dynamic";

// GET — current login state (loginUrl, inProgress, authorized, zones)
export async function GET() {
  try {
    return NextResponse.json(await getAuthorizeStatus());
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST — spawn `cloudflared tunnel login`, return loginUrl as soon as it's printed.
// The child process keeps running in the background until cert.pem appears.
export async function POST() {
  try {
    const result = await startAuthorize();
    return NextResponse.json({ ...result, ...(await getAuthorizeStatus()) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// DELETE — cancel an in-progress login (kill the child)
export async function DELETE() {
  try {
    return NextResponse.json(cancelAuthorize());
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
