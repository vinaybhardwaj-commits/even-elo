import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isOtCaptureEnabled } from "@/lib/capture/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Staff shell asks this so Capture queue links appear only when the flag is on. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    enabled: isOtCaptureEnabled() && user.is_super_admin === true,
  });
}
