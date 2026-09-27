import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { CaptureBanner } from "@/components/capture/CaptureChrome";
import { CaptureFlagOff } from "@/components/capture/CaptureFlagOff";
import { isOtCaptureEnabled } from "@/lib/capture/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OtSheetsPage() {
  if (!isOtCaptureEnabled()) {
    return <CaptureFlagOff title="OT sheets" crumb="OT sheets" />;
  }
  return (
    <>
      <TopNav />
      <CaptureBanner kicker="Stage 2" />
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-7">
        <div className="mb-3 flex items-center gap-2 text-[13px] text-stone-500">
          <Link href="/surgical-governance" className="font-medium text-brand hover:underline">
            Surgical Governance
          </Link>
          <span>/</span>
          <span className="font-semibold text-stone-900">OT sheets</span>
        </div>
        <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight">
          OT sheets
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
            Stage 2
          </span>
        </h1>
        <p className="mb-5 mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
          Extracted OT Tracking Sheets will be listed here after OCR. Stage 1 only stores images on the capture queue.
          There are no live extracted fields and no surgical-case links.
        </p>
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ["Sheets today", "0", "Stage 2"],
            ["Needs review", "0", "Stage 2"],
            ["Approved", "0", "Stage 2"],
            ["Abx on-time", "—", "Stage 2"],
          ].map(([label, value, hint]) => (
            <div key={label} className="rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-sm">
              <div className="text-[12px] text-stone-500">{label}</div>
              <div className="mt-1 text-[1.55rem] font-bold leading-none tracking-tight text-stone-400">{value}</div>
              <div className="mt-1 text-[11px] text-stone-500">{hint}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 px-6 py-10 text-center">
          <div className="text-base font-semibold">No OT sheets yet</div>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-stone-500">
            OCR does not run in Stage 1. Open the capture queue to see stored images. This list stays empty on purpose.
          </p>
          <Link
            href="/surgical-governance/capture-queue"
            className="mt-4 inline-block text-sm font-semibold text-brand hover:underline"
          >
            Open capture queue
          </Link>
        </div>
      </main>
    </>
  );
}
