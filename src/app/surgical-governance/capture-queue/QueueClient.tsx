"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopNav } from "@/components/TopNav";
import { CaptureBanner, HospitalSwitcher, StatusChip } from "@/components/capture/CaptureChrome";
import { SurgicalCaptureNav } from "@/components/capture/SurgicalCaptureNav";

interface CaptureItem {
  id: string;
  title: string;
  subtitle: string;
  provenance: string;
  status: string;
  image_path: string;
  content_type: string;
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "queued", label: "queued" },
  { id: "processing", label: "processing" },
  { id: "needs_review", label: "needs_review" },
  { id: "extracted", label: "extracted" },
  { id: "voided", label: "voided" },
] as const;

const CARDS = [
  { key: "queued", label: "Queued", hint: "Stored · OCR is Stage 2", tone: "text-stone-900" },
  { key: "processing", label: "Processing", hint: "Stage 2", tone: "text-amber-700" },
  { key: "needs_review", label: "Needs review", hint: "Stage 2", tone: "text-red-700" },
  { key: "extracted", label: "Extracted", hint: "Stage 2", tone: "text-emerald-700" },
] as const;

function cardCount(counts: Record<string, number>, key: string): number {
  if (key === "queued") return (counts.queued ?? 0) + (counts.stored ?? 0);
  return counts[key] ?? 0;
}

export function QueueClient() {
  const [hospital, setHospital] = useState("EHRC");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [rows, setRows] = useState<CaptureItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/capture/queue?hospital=${hospital}&status=${filter}`)
      .then((response) => response.json())
      .then((json: { ok?: boolean; error?: string; counts?: Record<string, number>; captures?: CaptureItem[] }) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || "Could not load the capture queue.");
          setRows([]);
          return;
        }
        setError(null);
        setCounts(json.counts ?? {});
        setRows(json.captures ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the capture queue.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hospital, filter]);

  const visibleCount = rows.length;

  return (
    <>
      <TopNav />
      <CaptureBanner />
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-2.5 sm:px-6">
        <span className="rounded-full border border-stone-200 bg-stone-100 px-3 py-1 text-[12px] font-medium text-stone-600">
          <strong className="font-semibold text-[#0d5f58]">Stage 1</strong>
          <span> · store only · no OCR</span>
        </span>
        <HospitalSwitcher value={hospital} onChange={setHospital} />
      </div>
      <main className="mx-auto max-w-[1180px] px-4 py-6 sm:px-7">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-stone-500">
          <Link href="/surgical-governance" className="font-medium text-brand hover:underline">
            Surgical Governance
          </Link>
          <span>/</span>
          <span className="font-semibold text-stone-900">Capture queue</span>
        </div>
        <SurgicalCaptureNav current="queue" />
        <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight">
          Capture queue
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
            Stage 1
          </span>
        </h1>
        <p className="mb-5 mt-1 max-w-3xl text-sm leading-relaxed text-stone-500">
          Images from <span className="font-mono text-[13px]">upload.governance.evenos.app</span> or{" "}
          <Link href="/capture" className="font-medium text-brand hover:underline">
            /capture
          </Link>
          . No auth on upload · provenance stored. Status stays queued until Stage 2 OCR.
        </p>

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {CARDS.map((card) => (
            <div key={card.key} className="rounded-xl border border-stone-200 bg-white px-4 py-3 shadow-sm">
              <div className="text-[12px] text-stone-500">{card.label}</div>
              <div className={`mt-1 text-[1.55rem] font-bold leading-none tracking-tight ${card.tone}`}>
                {cardCount(counts, card.key)}
              </div>
              <div className="mt-1 text-[11px] text-stone-500">{card.hint}</div>
            </div>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              className={
                "rounded-full border px-3 py-1 text-[13px] font-medium " +
                (filter === item.id
                  ? "border-brand bg-brand text-white"
                  : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50")
              }
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-stone-500">
            {hospital} · {visibleCount} shown
            {(counts.voided ?? 0) > 0 && filter !== "voided" ? ` · ${counts.voided} voided` : ""}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
            <h2 className="text-[15px] font-semibold">Recent captures</h2>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
              gov_document_captures
            </span>
          </div>
          {error && <p className="px-4 py-6 text-sm text-red-800">{error}</p>}
          {!error && loading && <p className="px-4 py-6 text-sm text-stone-500">Loading captures…</p>}
          {!error && !loading && rows.length === 0 && (
            <p className="px-4 py-8 text-sm text-stone-500">
              No captures in this view. Photos from the phone site land here as queued. Nothing is extracted yet.
            </p>
          )}
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/surgical-governance/capture-queue/${row.id}`}
              className="grid grid-cols-[56px_1fr_auto] items-center gap-3 border-b border-stone-200 px-4 py-3 text-inherit no-underline last:border-b-0 hover:bg-stone-50"
            >
              <Thumb path={row.image_path} heic={/hei[cf]/i.test(row.content_type)} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{row.title}</div>
                <div className="mt-0.5 text-xs text-stone-500">{row.subtitle}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-stone-400">{row.provenance}</div>
              </div>
              <StatusChip status={row.status} />
            </Link>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-dashed border-teal-300 bg-teal-50 px-4 py-3 text-sm leading-relaxed text-teal-900">
          <strong className="text-brand">Stage 1:</strong> the queue is visible to the Governance staff session only.
          The capture site has no auth gate — junk is voided here from the capture detail. OCR is Stage 2. OT sheets
          stay empty until then.
        </div>
        <p className="mt-4 text-sm">
          <Link href="/surgical-governance/ot-sheets" className="font-medium text-brand hover:underline">
            OT sheets
          </Link>
          <span className="text-stone-400"> · Stage 2</span>
          <span className="mx-2 text-stone-300">·</span>
          <Link href="/capture" className="font-medium text-brand hover:underline">
            Phone capture site
          </Link>
        </p>
      </main>
    </>
  );
}

function Thumb({ path, heic }: { path: string; heic: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed || heic) {
    return (
      <div className="grid h-14 w-14 place-items-center rounded-lg border border-stone-200 bg-stone-200 text-center text-[10px] font-semibold leading-tight text-stone-500">
        {heic ? "HEIC" : "OT"}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={path}
      alt=""
      className="h-14 w-14 rounded-lg border border-stone-200 object-cover"
      onError={() => setFailed(true)}
    />
  );
}
