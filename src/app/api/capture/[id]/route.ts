import { NextResponse } from "next/server";
import { getCapture, isMissingCaptureTable } from "@/lib/capture/db";
import { toPublicCapture } from "@/lib/capture/present";
import { isUuid, migrationRequiredResponse, requireCaptureStaff } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: { id: string } }) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  const id = context.params.id;
  if (!isUuid(id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  try {
    const row = await getCapture(id);
    if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, capture: toPublicCapture(row) });
  } catch (error) {
    if (isMissingCaptureTable(error)) return migrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not load the capture." }, { status: 500 });
  }
}
