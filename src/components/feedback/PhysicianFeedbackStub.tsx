"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopNav } from "@/components/TopNav";
import {
  categoryLabel,
  formatFeedbackDate,
  type FeedbackFeedItem,
  type FeedbackHomePayload,
  type FeedbackPhysicianRow,
} from "@/lib/feedback-home";

/**
 * Physician-scoped list until Sprint 1.2 ships the detail page.
 * The summary chip is the empty state only.
 */
export function PhysicianFeedbackStub() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [row, setRow] = useState<FeedbackPhysicianRow | null>(null);
  const [feed, setFeed] = useState<FeedbackFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/incidents/home")
      .then((r) => r.json())
      .then((j: FeedbackHomePayload & { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (!j.ok) {
          setError(j.error || "Could not load feedback");
          return;
        }
        const physician = j.physicians.find((p) => p.physician_id === id) ?? null;
        setRow(physician);
        setFeed(j.feed.filter((item) => item.target_physician_id === id && item.status !== "retracted"));
        if (!physician) setError("This physician has no feedback in the current scope.");
      })
      .catch(() => {
        if (!cancelled) setError("Could not load feedback");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-[900px] px-6 py-8 lg:px-8">
        <div className="mb-4 text-sm text-stone-500">
          <Link href="/incidents" className="hover:text-stone-900">Patient Feedback</Link>
          <span className="mx-1.5">/</span>
          <span className="font-medium text-stone-900">{row?.name ?? "Physician"}</span>
        </div>

        {loading ? (
          <div className="py-16 text-center text-sm text-stone-500">Loading…</div>
        ) : error && !row ? (
          <div className="rounded-xl border border-stone-200 bg-white px-4 py-8 text-sm text-stone-600">{error}</div>
        ) : row ? (
          <>
            <h1 className="text-[1.45rem] font-bold tracking-tight text-stone-900">{row.name}</h1>
            <p className="mt-1 text-sm text-stone-500">{row.specialty}</p>

            <div className="mt-4 rounded-xl border border-stone-200 bg-white px-4 py-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Summary</div>
              <div className="mt-2">
                <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-stone-600">
                  {row.summary_label}
                </span>
              </div>
              <p className="mt-2 text-sm text-stone-500">A written summary is not available yet.</p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
                <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700">{row.positive} pos</span>
                <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-700">{row.negative} neg</span>
                <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 font-semibold text-stone-700">{row.total} total</span>
                <span className="text-stone-500">Last activity {formatFeedbackDate(row.last_activity)}</span>
              </div>
            </div>

            <h2 className="mb-2 mt-6 text-[15px] font-semibold text-stone-900">Feedback</h2>
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
              {feed.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-stone-500">No feedback in this scope.</div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {feed.map((item) => (
                    <Link key={item.id} href={`/incidents/${item.id}`} className="block px-4 py-3 hover:bg-stone-50">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className={`rounded-full px-2 py-0.5 font-medium ${item.polarity === "positive" ? "bg-emerald-50 text-emerald-700" : "bg-stone-800 text-white"}`}>
                          {item.polarity === "positive" ? "Positive" : "Negative"}
                        </span>
                        {item.severity ? <span className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-stone-700">{item.severity}</span> : null}
                        <span className="text-stone-500">{categoryLabel(item.category)}</span>
                        <span className="text-stone-400">{formatFeedbackDate(item.submitted_at)}</span>
                      </div>
                      {item.narrative_preview ? <div className="mt-1 truncate text-xs text-stone-500">{item.narrative_preview}</div> : null}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}
