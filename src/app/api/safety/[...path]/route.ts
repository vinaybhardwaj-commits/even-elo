import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE = process.env.INCIDENT_API_BASE;
const APITOK = process.env.INCIDENT_API_TOKEN;

async function authed(): Promise<boolean> {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") return false;
  return !!(u.is_super_admin || u.is_sgc_member);
}

async function fwd(req: NextRequest, path: string[], method: string): Promise<NextResponse> {
  if (!(await authed())) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  if (!BASE || !APITOK) return NextResponse.json({ ok: false, error: "Incident API not configured" }, { status: 500 });
  const url = `${BASE}/api/${(path || []).join("/")}${req.nextUrl.search || ""}`;
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${APITOK}`, "Content-Type": "application/json" } };
  if (method !== "GET" && method !== "DELETE") init.body = await req.text();
  const res = await fetch(url, init);
  const body = await res.text();
  return new NextResponse(body, { status: res.status, headers: { "Content-Type": res.headers.get("content-type") || "application/json" } });
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "GET"); }
export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "POST"); }
export async function PATCH(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "PATCH"); }
export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "DELETE"); }
