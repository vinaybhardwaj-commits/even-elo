"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopNav } from "@/components/TopNav";
import { HeadlineStrip, type HeadlineStat } from "@/components/shell/HeadlineStrip";
import { formatFeedbackDate } from "@/lib/feedback-home";
import {
  NO_FEEDBACK_COPY,
  NO_FEEDBACK_SUMMARY_COPY,
  REGENERATE_HINT,
  REGENERATE_LABEL,
  STALE_HINT,
  SUMMARY_EMPTY_COPY,
  SUMMARY_EMPTY_TITLE,
  SUMMARY_PANEL_TITLE,
  shortPhysicianId,
  timelineCategory,
  type FeedbackDetailPayload,
  type FeedbackTimelineItem,
} from "@/lib/feedback-detail";

const HOSPITAL_EVENT = "epi-hospital-filter";

const SEV_CHIP: Record<string, string> = {
  low: "bg-stone-100 text-stone-600",
  medium: "bg-amber-50 text-amber-800",
  high: "bg-orange-50 text-orange-800",
  critical: "bg-red-100 text-red-800",
};

const STATUS_CHIP: Record<string, string> = {
  open: "bg-blue-50 text-blue-800",
  closed: "bg-stone-100 text-stone-600",
  retracted: "bg-red-50 text-red-700",
};

export function PhysicianFeedbackDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [data, setData] = useState<FeedbackDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    function load() {
      setLoading(true);
      fetch(`/api/incidents/physician/${id}`)
        .then((r) => r.json())
        .then((j: FeedbackDetailPayload & { ok?: boolean; error?: string }) => {
          if (cancelled) return;
          if (!j.ok) {
            setData(null);
            setError(j.error || "Could not load feedback");
            return;
          }
          setData(j);
          setError("");
        })
        .catch(() => {
          if (!cancelled) setError("Could not load feedback");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    load();
    window.addEventListener(HOSPITAL_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(HOSPITAL_EVENT, load);
    };
  }, [id]);

  const physician = data?.physician;
  const headline = data?.headline;
  const hasFeedback = (headline?.total ?? 0) > 0;
  const specBits = [
    physician?.specialty,
    ...(physician?.hospital_codes ?? []),
    physician ? shortPhysicianId(physician.id) : "",
  ].filter(Boolean);

  const stats: HeadlineStat[] = headline
    ? [
        { label: "Feedback total", value: String(headline.total), hint: "This physician" },
        { label: "Negative", value: String(headline.negative), hint: headline.negative_hint, tone: "danger" },
        { label: "Positive", value: String(headline.positive), hint: headline.positive_hint, tone: "ok" },
        { label: "Last activity", value: formatFeedbackDate(headline.last_activity), hint: "IST date", compact: true },
        { label: "Summary", value: headline.summaries_label, hint: "Not generated yet", tone: "muted", compact: true },
      ]
    : [];

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[1180px] px-6 py-8 lg:px-8">
        <nav className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px] text-stone-500" aria-label="Breadcrumb">
          <Link href="/incidents" className="font-medium text-brand hover:underline">Patient Feedback</Link>
          <span aria-hidden className="text-stone-400">/</span>
          <span className="font-semibold text-stone-900">{physician?.name ?? "Physician"}</span>
        </nav>

        {loading && !data ? (
          <div className="py-16 text-center text-sm text-stone-500">Loading…</div>
        ) : error && !data ? (
          <div className="rounded-xl border border-stone-200 bg-white px-4 py-8 text-sm text-stone-600">
            {error}
            <div className="mt-3">
              <Link href="/incidents" className="font-medium text-brand hover:underline">← Feedback home</Link>
            </div>
          </div>
        ) : physician && headline ? (
          <>
            <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="flex flex-wrap items-center gap-2 text-[1.55rem] font-bold tracking-tight text-stone-900">
                  {physician.name}
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">
                    Live
                  </span>
                </h1>
                <p className="mt-0.5 text-sm text-stone-500">
                  {specBits.map((bit, i) => (
                    <span key={`${bit}-${i}`}>
                      {i > 0 ? " · " : ""}
                      {i === specBits.length - 1 ? <span className="font-mono text-[12px]">{bit}</span> : bit}
                    </span>
                  ))}
                </p>
              </div>
              <Link href="/incidents" className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-stone-800 hover:bg-stone-50">
                ← Feedback home
              </Link>
            </div>
            <p className="mb-4 text-sm text-stone-500">
              {hasFeedback ? SUMMARY_EMPTY_TITLE + ". Regenerate stays off until a summary can be stored." : NO_FEEDBACK_COPY}
            </p>

            <HeadlineStrip stats={stats} />

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
              <section className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3">
                  <h2 className="text-[15px] font-semibold text-stone-900">
                    Feedback timeline
                    <span className="ml-1.5 text-[12px] font-medium text-stone-500">· {data.timeline.length} shown · newest first</span>
                  </h2>
                  <span className="text-[12px] text-stone-500">Date, polarity, category, severity, status, source</span>
                </div>
                {data.timeline.length === 0 ? (
                  <div className="px-4 py-16 text-center text-sm text-stone-500">{NO_FEEDBACK_COPY}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="bg-stone-50 text-left text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                          <th className="px-4 py-2.5 font-semibold">Date</th>
                          <th className="px-4 py-2.5 font-semibold">Polarity</th>
                          <th className="px-4 py-2.5 font-semibold">Category</th>
                          <th className="px-4 py-2.5 font-semibold">Severity</th>
                          <th className="px-4 py-2.5 font-semibold">Status</th>
                          <th className="px-4 py-2.5 font-semibold">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.timeline.map((row) => (
                          <TimelineRow key={row.id} row={row} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <aside className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)] lg:sticky lg:top-16" aria-label="Summary">
                <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
                  <h2 className="text-[15px] font-semibold text-stone-900">{SUMMARY_PANEL_TITLE}</h2>
                  <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-stone-600">
                    {headline.summaries}
                  </span>
                </div>
                <div className="px-4 py-5">
                  <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-4 py-6 text-center" role="status">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-soft text-[15px] font-bold text-[#0d5f58]" aria-hidden>
                      ✦
                    </div>
                    <div className="text-[15px] font-semibold text-stone-900">{SUMMARY_EMPTY_TITLE}</div>
                    <p className="mx-auto mt-1 max-w-[36ch] text-[13px] leading-relaxed text-stone-500">
                      {hasFeedback ? SUMMARY_EMPTY_COPY : NO_FEEDBACK_SUMMARY_COPY}
                    </p>
                    <div className="mt-4">
                      <button
                        type="button"
                        disabled
                        aria-disabled="true"
                        title={REGENERATE_HINT}
                        className="cursor-not-allowed rounded-md bg-stone-300 px-3 py-1.5 text-[12px] font-semibold text-stone-500"
                      >
                        {REGENERATE_LABEL}
                      </button>
                      <div className="mt-1.5 text-[11px] leading-snug text-stone-500">{REGENERATE_HINT}</div>
                    </div>
                  </div>
                  <p className="mt-3 text-center text-[11px] leading-snug text-stone-400">{STALE_HINT}</p>
                </div>
              </aside>
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}

function TimelineRow({ row }: { row: FeedbackTimelineItem }) {
  return (
    <tr className="relative border-t border-stone-200 hover:bg-stone-50">
      <td className="whitespace-nowrap px-4 py-3 text-[12px] text-stone-500">
        <Link href={`/incidents/${row.id}`} className="font-medium text-brand after:absolute after:inset-0 hover:underline">
          {formatFeedbackDate(row.submitted_at)}
        </Link>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[12px] font-semibold ${row.polarity === "positive" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {row.polarity}
        </span>
      </td>
      <td className="px-4 py-3 font-medium text-stone-900">{timelineCategory(row)}</td>
      <td className="px-4 py-3">
        {row.severity ? (
          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${SEV_CHIP[row.severity] ?? "bg-stone-100 text-stone-600"}`}>
            {row.severity}
          </span>
        ) : (
          <span className="text-stone-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_CHIP[row.status] ?? "bg-stone-100 text-stone-600"}`}>
          {row.status}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[12px] font-semibold text-violet-700">
          {row.source}
        </span>
      </td>
    </tr>
  );
}
