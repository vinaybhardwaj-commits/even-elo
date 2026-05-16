import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const csv = [
    "physician_email,hospital_code,feedback_period,csat_score,complaint_count,source",
    "vinay.bhardwaj@even.in,EHRC,2026-Q1,8.4,1,EHRC frontdesk survey",
    "vinay.bhardwaj@even.in,EHRC,2026-Q2,8.7,0,EHRC frontdesk survey",
  ].join("\n") + "\n";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="epi-patient-feedback-template.csv"',
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
