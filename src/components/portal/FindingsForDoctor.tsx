"use client";

import { useEffect, useState } from "react";
import { ADVISORY_FALLBACK, type PortalAuditSignal } from "@/lib/doctor-audits";

/**
 * Portal "Findings" panel (WM2 v0) — the governance findings routed to this physician.
 *
 * ⚠️ A DESTINATION, NOT A CONVERSATION. This panel has NO buttons, no forms, and no control of any
 * kind. v0 shows a doctor what was routed to them and tells them where to reply — with their care
 * manager — because in-portal responses do not exist yet. A button here would be an affordance
 * wired to nothing, and the one thing worse than not being able to answer a finding is appearing
 * to be able to.
 *
 * ⚠️ AN OUTAGE IS NOT AN EMPTY HISTORY. The three states below are deliberately distinguishable:
 *   · unmapped  — you are signed in, governance has not linked your record.
 *   · no signals — we asked, and there is nothing routed to you.
 *   · unavailable — we could not reach the system that knows. NOT "you have none".
 * Collapsing the third into the second would tell a doctor they are clear when nobody checked.
 *
 * The advisory line is rendered at the top of every populated state and beside the empty one. It is
 * the framing that makes these findings readable as support rather than as a score, so it is not
 * conditional on there being anything to frame.
 *
 * Card idioms follow src/components/v2/OpdSignalsSection.tsx.
 */

interface FindingsData {
  ok: boolean;
  mapped: boolean;
  doctor?: { name?: string; speciality?: string };
  window?: { days: number };
  signals?: PortalAuditSignal[];
  advisory?: string;
  error?: string;
}

/** Status → what it means to the doctor. `routed` is the one that must name the reply channel. */
const STATUS_LABEL: Record<string, string> = {
  routed: "awaiting response (via your care manager)",
  responded: "responded",
  escalated: "escalated",
  ruled: "ruled",
  closed: "closed",
};

const STATUS_TONE: Record<string, string> = {
  routed: "bg-amber-50 text-amber-700",
  responded: "bg-sky-50 text-sky-700",
  escalated: "bg-rose-50 text-rose-700",
  ruled: "bg-stone-100 text-stone-700",
  closed: "bg-emerald-50 text-emerald-700",
};

function fmtDay(d: string | null | undefined) {
  return d ? String(d).slice(0, 10) : "—";
}

function Shell({ children, count }: { children: React.ReactNode; count?: number | "…" }) {
  return (
    <section className="bg-white border border-stone-200 rounded-xl">
      <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Findings{" "}
          {count !== undefined && (
            <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">
              {count}
            </span>
          )}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Advisory({ text }: { text: string }) {
  return <p className="text-[12.5px] text-stone-500 leading-snug">{text}</p>;
}

function SignalCard({ s }: { s: PortalAuditSignal }) {
  const rep = s.representative;
  return (
    <div className="border border-stone-200 rounded-lg px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold break-words">{s.label}</div>
          <div className="text-[11.5px] text-stone-400 font-mono mt-0.5">{s.reference}</div>
        </div>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${
            STATUS_TONE[s.status] ?? "bg-stone-100 text-stone-700"
          }`}
        >
          {STATUS_LABEL[s.status] ?? s.status}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-stone-500">
        <span>Routed {fmtDay(s.routed_at)}</span>
        <span>
          {s.instances} {s.instances === 1 ? "instance" : "instances"}
        </span>
        <span>
          Window {fmtDay(s.window?.from)} – {fmtDay(s.window?.to)}
        </span>
      </div>

      {rep && (
        <div className="mt-3 pt-3 border-t border-stone-100">
          <div className="text-sm font-medium break-words">{rep.subject}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-stone-500">
            <span>{rep.verdict}</span>
            <span>Note {fmtDay(rep.note_date)}</span>
          </div>
          {rep.rationale && (
            <p className="mt-1.5 text-[13px] text-stone-600 leading-snug break-words">{rep.rationale}</p>
          )}
          {Array.isArray(rep.citations) && rep.citations.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {rep.citations.map((c) => (
                <a
                  key={c.n}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-brand font-medium break-words"
                >
                  [{c.n}] {c.title}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The reply channel, stated in words because there is deliberately no control to press. */}
      {s.response_required !== "none" && (
        <p className="mt-3 text-[12px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2 leading-snug">
          A response is requested — until in-portal responses ship, respond via your care manager.
        </p>
      )}
    </div>
  );
}

export function FindingsForDoctor() {
  const [data, setData] = useState<FindingsData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/portal/findings")
      .then((r) => r.json())
      .then((j: FindingsData) => setData(j))
      .catch(() => setFailed(true));
  }, []);

  if (failed || (data && data.ok === false)) {
    // Reaching here means we could not get an answer — from the network or from upstream. Say so.
    return (
      <Shell>
        <div className="px-5 py-6 text-sm text-stone-600">Findings are temporarily unavailable.</div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell count="…">
        <div className="px-5 py-6 text-center text-sm text-stone-400">Loading…</div>
      </Shell>
    );
  }

  if (!data.mapped) {
    return (
      <Shell>
        <div className="px-5 py-6 text-sm text-stone-600">
          Your CAT profile is not yet linked. Findings appear once governance links your record.
        </div>
      </Shell>
    );
  }

  const signals = data.signals ?? [];
  const advisory = data.advisory || ADVISORY_FALLBACK;

  if (signals.length === 0) {
    return (
      <Shell count={0}>
        <div className="px-5 py-6 space-y-2">
          <div className="text-sm text-stone-600">No routed findings.</div>
          <Advisory text={advisory} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell count={signals.length}>
      <div className="px-5 py-4 space-y-3">
        <Advisory text={advisory} />
        <div className="space-y-2.5">
          {signals.map((s) => (
            <SignalCard key={s.signal_id} s={s} />
          ))}
        </div>
      </div>
    </Shell>
  );
}
