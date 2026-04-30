import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteParams {
  params: { vcId: string };
}

/**
 * POST /api/recompute/[vcId] — STUB.
 *
 * Real engine ships in ELO.3b. For ELO.2 this endpoint exists so that the
 * cases create / void paths can `fetch` it without 404'ing. Returns
 * `{ stub: true, vc_id }` so callers can verify the wire is connected.
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  if (!UUID_RE.test(params.vcId)) {
    return NextResponse.json({ ok: false, error: "invalid vcId" }, { status: 400 });
  }
  let trigger = "manual";
  let triggered_by_position = "Committee Admin";
  try {
    const body = await req.json();
    if (body?.trigger) trigger = body.trigger;
    if (body?.triggered_by_position) triggered_by_position = body.triggered_by_position;
  } catch {
    /* body optional */
  }
  return NextResponse.json({
    ok: true,
    stub: true,
    vc_id: params.vcId,
    trigger,
    triggered_by_position,
    note: "Engine ships in ELO.3b — this is a stub.",
  });
}
