"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ADVISORY_FALLBACK,
  noteClassLabel,
  type NoteClass,
  type PortalAuditSignal,
} from "@/lib/doctor-audits";

/**
 * Portal "Findings" panel (WM2) — the governance findings routed to this physician.
 *
 * Private reactions and workflow responses have separate flags. PORTAL_FINDINGS_RESPOND can stay
 * dark while the read-only Findings destination and private research reactions remain available.
 *
 * ⚠️ A PRIVATE REACTION AND A WORKFLOW RESPONSE ARE NOT THE SAME GESTURE, and the card must never
 * let them read as one. Row A is private, notifies nobody, and says so in its own header. Row B
 * leaves the building, goes to the care manager, and cannot be revised here afterwards. They are
 * separated by a rule, headed separately, and worded separately for that reason alone.
 *
 * ⚠️ AN OUTAGE IS NOT AN EMPTY HISTORY. The three states below are deliberately distinguishable:
 *   · unmapped  — you are signed in, governance has not linked your record.
 *   · no signals — we asked, and there is nothing routed to you.
 *   · unavailable — we could not reach the system that knows. NOT "you have none".
 * Collapsing the third into the second would tell a doctor they are clear when nobody checked.
 * A button that fails follows the same rule: it says it did not save, never nothing at all.
 *
 * The advisory line is rendered at the top of every populated state and beside the empty one. It is
 * the framing that makes these findings readable as support rather than as a score, so it is not
 * conditional on there being anything to frame.
 *
 * note_class filter chips (All | OPD | Discharge summary | OT) re-fetch via the BFF with optional
 * `note_class` so a mixed OPD+DS inbox is filterable on one Findings page. Selection is local
 * state — Findings has no existing URL-query filter pattern.
 *
 * Card idioms follow src/components/v2/OpdSignalsSection.tsx; the chip buttons follow
 * src/components/portal/IncidentReporting.tsx.
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

/** The three reaction verbs and their labels, exact. Order is fixed: the two readings of a finding
 *  a doctor is most likely to have, then the way out. */
const REACTION_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ["already_knew", "I already knew this"],
  ["surprised", "This surprised me"],
  ["dismiss", "Dismiss"],
];

/** The only two `response_required` values the portal can answer. Anything else — "none", or a
 *  value upstream adds later — gets no Row B rather than a guess at what it wants. */
const RESPONDABLE = ["acknowledgment", "explanation"];

const SAVE_FAILED = "Could not save. Try again.";
const chipCls = (on: boolean) =>
  `px-3 py-2 rounded-lg text-[12.5px] font-medium border disabled:opacity-50 ${
    on ? "bg-brand text-white border-brand" : "bg-white border-stone-200 text-stone-600"
  }`;
const rowCls = "mt-3 pt-3 border-t border-stone-100";
const rowHeadCls = "text-[12px] font-semibold text-stone-500";

/** Filter chip values. `all` omits the query param so CDMSS returns the mixed inbox. */
type NoteClassFilter = "all" | NoteClass;

const NOTE_CLASS_FILTERS: ReadonlyArray<readonly [NoteClassFilter, string]> = [
  ["all", "All"],
  ["opd", "OPD"],
  ["discharge_summary", "Discharge summary"],
  ["ot", "OT"],
];

function fmtDay(d: string | null | undefined) {
  return d ? String(d).slice(0, 10) : "—";
}

/** The recorded response, read defensively. `response` is typed `unknown` upstream and this is the
 *  only place the portal looks inside it, so a shape change costs one missing line, not a crash. */
function readResponse(r: unknown): { verb: string; type: string; verdict: string; comment: string } | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const verb = typeof o.verb === "string" ? o.verb : "";
  const type = typeof o.type === "string" ? o.type : "";
  const verdict = typeof o.verdict === "string" ? o.verdict : "";
  const comment = typeof o.comment === "string" ? o.comment : "";
  if (!verb && !type && !verdict && !comment) return null;
  return { verb, type, verdict, comment };
}

const responseLabel = (verb: string) =>
  verb === "needs_clarification"
    ? "Needs clarification"
    : verb
      ? `${verb[0].toUpperCase()}${verb.slice(1)}`
      : "";

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

/**
 * Row A — the private reaction.
 *
 * Once a reaction exists, all three chips are dead. There is no "change my mind" here on purpose:
 * this is a research record of a first reading, and a chip that can be re-pressed records the last
 * reading instead. The `already_recorded` answer exists for exactly the race that creates — two
 * tabs, one doctor — and resolves it by refetching rather than by overwriting.
 */
function ReactionRow({ s, onRefetch }: { s: PortalAuditSignal; onRefetch: () => void }) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = s.my_reaction?.reaction ?? picked;
  const locked = Boolean(s.my_reaction) || busy || saved;

  async function react(v: string) {
    if (locked) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/portal/findings/react", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signal_id: s.signal_id, reaction: v }),
      });
      const j = await r.json();
      setBusy(false);
      if (j.ok) {
        setPicked(v);
        setSaved(true);
      } else if (j.error === "already_recorded") {
        onRefetch();
      } else if (j.error === "unmapped") {
        // Governance has not linked this doctor, so there is nothing to attach a reaction to.
        // Hide the row rather than leave three buttons that cannot work.
        setHidden(true);
      } else {
        setErr(SAVE_FAILED);
      }
    } catch {
      setBusy(false);
      setErr(SAVE_FAILED);
    }
  }

  if (hidden) return null;
  return (
    <div className={rowCls}>
      <div className={rowHeadCls}>Your reaction · private research record · not sent to governance</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {REACTION_CHOICES.map(([v, label]) => (
          <button
            key={v}
            type="button"
            disabled={locked}
            onClick={() => react(v)}
            className={chipCls(selected === v)}
          >
            {label}
          </button>
        ))}
      </div>
      {saved && <div className="mt-1.5 text-[12px] text-stone-500">Recorded</div>}
      {err && <div className="mt-1.5 text-[12.5px] text-rose-600">{err}</div>}
    </div>
  );
}

/**
 * Row B — the workflow response.
 *
 * Only on a `routed` thread that asked for one. Disagree and Needs clarification require context;
 * Agree may be sent without a comment. One in-flight submit locks every control.
 */
function ResponseRow({
  s,
  onRefetch,
  onReplace,
}: {
  s: PortalAuditSignal;
  onRefetch: () => void;
  onReplace: (next: PortalAuditSignal) => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(verb: "agree" | "disagree" | "needs_clarification") {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/portal/findings/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signal_id: s.signal_id,
          verb,
          comment,
        }),
      });
      const j = await r.json();
      if (j.ok) {
        // Stay busy: this row is about to be replaced by the recorded response either way.
        if (j.signal) onReplace(j.signal as PortalAuditSignal);
        else onRefetch();
        return;
      }
      setBusy(false);
      if (j.error === "already_responded") {
        setErr("This thread already has a response. Changes go through your care manager.");
        onRefetch();
      } else if (j.error === "closed") {
        setErr("This finding is closed.");
        onRefetch();
      } else if (j.error === "invalid") {
        setErr(j.message || SAVE_FAILED);
      } else {
        setErr(SAVE_FAILED);
      }
    } catch {
      setBusy(false);
      setErr(SAVE_FAILED);
    }
  }

  const empty = comment.trim().length === 0;
  return (
    <div className={rowCls}>
      <div className={rowHeadCls}>Response · goes to your care manager</div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        disabled={busy}
        rows={3}
        placeholder="Add context (required for disagree or clarification)"
        className="mt-1.5 w-full rounded-lg border border-stone-200 px-3 py-2.5 text-[16px] bg-white"
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => send("agree")}
          className={chipCls(true)}
        >
          Agree
        </button>
        <button
          type="button"
          disabled={busy || empty}
          onClick={() => send("disagree")}
          className={chipCls(false)}
        >
          Disagree
        </button>
        <button
          type="button"
          disabled={busy || empty}
          onClick={() => send("needs_clarification")}
          className={chipCls(false)}
        >
          Needs clarification
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-stone-500">
        Disagree or Needs clarification sends this finding back to your care manager.
      </p>
      {err && <div className="mt-1.5 text-[12.5px] text-rose-600">{err}</div>}
    </div>
  );
}

function SignalCard({
  s,
  reactions,
  respond,
  onRefetch,
  onReplace,
}: {
  s: PortalAuditSignal;
  reactions: boolean;
  respond: boolean;
  onRefetch: () => void;
  onReplace: (next: PortalAuditSignal) => void;
}) {
  const rep = s.representative;
  const recorded = readResponse(s.response);
  const canRespond = RESPONDABLE.includes(s.response_required) && s.status === "routed";
  return (
    <div className="border border-stone-200 rounded-lg px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold break-words">{s.label}</div>
          <div className="text-[11.5px] text-stone-400 font-mono mt-0.5">{s.reference}</div>
        </div>
        <span className="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-600">
          {noteClassLabel(s.note_class)}
        </span>
        <span
          className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-medium ${
            STATUS_TONE[s.status] ?? "bg-stone-100 text-stone-700"
          }`}
        >
          {respond && s.status === "routed"
            ? "awaiting your response"
            : STATUS_LABEL[s.status] ?? s.status}
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
              {rep.citations.map((c) =>
                // Upstream can send a citation with no url. Rendering that as a link gives a doctor a
                // clickable source that goes nowhere — a trust leak on the element meant to earn trust.
                // No url, no link: same text, plainly, with nothing that reads as pressable.
                c.url && c.url.trim() ? (
                  <a
                    key={c.n}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-brand font-medium break-words"
                  >
                    [{c.n}] {c.title}
                  </a>
                ) : (
                  <span key={c.n} className="text-[12px] text-stone-500 break-words">
                    [{c.n}] {c.title}
                  </span>
                )
              )}
            </div>
          )}
          {s.pdf_url ? (
            <a
              href={s.pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-[12.5px] font-semibold text-brand hover:bg-brand hover:text-white"
            >
              Download audit findings PDF
            </a>
          ) : null}
        </div>
      )}

      {!rep && s.pdf_url ? (
        <div className="mt-3 pt-3 border-t border-stone-100">
          <a
            href={s.pdf_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-[12.5px] font-semibold text-brand hover:bg-brand hover:text-white"
          >
            Download audit findings PDF
          </a>
        </div>
      ) : null}

      {s.triage && (s.triage.rationale || s.triage.policy_version) && (
        <div className={rowCls}>
          <div className={rowHeadCls}>Triage context</div>
          {s.triage.rationale && (
            <p className="mt-1 text-[12.5px] text-stone-600 leading-snug break-words">
              {s.triage.rationale}
            </p>
          )}
          {s.triage.policy_version && (
            <p className="mt-1 text-[11px] text-stone-400">
              Policy {s.triage.policy_version}
            </p>
          )}
        </div>
      )}

      {reactions && <ReactionRow s={s} onRefetch={onRefetch} />}
      {respond ? (
        recorded ? (
          <div className={rowCls}>
            <p className="text-[12px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2 leading-snug break-words">
              You responded:{" "}
              {[
                responseLabel(recorded.verb || recorded.verdict),
                recorded.comment,
              ].filter(Boolean).join(" · ")}
            </p>
          </div>
        ) : canRespond ? (
          <ResponseRow s={s} onRefetch={onRefetch} onReplace={onReplace} />
        ) : null
      ) : (
        /* The reply channel, stated in words because there is deliberately no control to press. */
        s.response_required !== "none" && (
          <p className="mt-3 text-[12px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2 leading-snug">
            A response is requested — until in-portal responses ship, respond via your care manager.
          </p>
        )
      )}
    </div>
  );
}

export function FindingsForDoctor({
  reactions = false,
  respond = false,
}: {
  reactions?: boolean;
  respond?: boolean;
}) {
  const [data, setData] = useState<FindingsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [noteClassFilter, setNoteClassFilter] = useState<NoteClassFilter>("all");

  const load = useCallback(() => {
    setFailed(false);
    const qs =
      noteClassFilter === "all"
        ? ""
        : `?note_class=${encodeURIComponent(noteClassFilter)}`;
    fetch(`/api/portal/findings${qs}`)
      .then((r) => r.json())
      .then((j: FindingsData) => setData(j))
      .catch(() => setFailed(true));
  }, [noteClassFilter]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // One card's signal, swapped in place after a response. Cheaper and steadier than a full refetch:
  // the other cards do not flicker, and the doctor sees the status chip change on the card they
  // just answered.
  const replaceSignal = useCallback((next: PortalAuditSignal) => {
    setData((d) =>
      d
        ? {
            ...d,
            signals: (d.signals ?? []).map((x) =>
              x.signal_id === next.signal_id
                ? { ...next, triage: next.triage ?? x.triage, note_class: next.note_class ?? x.note_class }
                : x,
            ),
          }
        : d,
    );
  }, []);

  const filterChips = (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by note class">
      {NOTE_CLASS_FILTERS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => setNoteClassFilter(value)}
          className={chipCls(noteClassFilter === value)}
          aria-pressed={noteClassFilter === value}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (failed || (data && data.ok === false)) {
    // Reaching here means we could not get an answer — from the network or from upstream. Say so.
    return (
      <Shell>
        <div className="px-5 py-4 space-y-3">
          {filterChips}
          <div className="text-sm text-stone-600">Findings are temporarily unavailable.</div>
        </div>
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell count="…">
        <div className="px-5 py-4 space-y-3">
          {filterChips}
          <div className="text-center text-sm text-stone-400">Loading…</div>
        </div>
      </Shell>
    );
  }

  if (!data.mapped) {
    return (
      <Shell>
        <div className="px-5 py-4 space-y-3">
          {filterChips}
          <div className="text-sm text-stone-600">
            Your CAT profile is not yet linked. Findings appear once governance links your record.
          </div>
        </div>
      </Shell>
    );
  }

  const signals = data.signals ?? [];
  const advisory = data.advisory || ADVISORY_FALLBACK;

  if (signals.length === 0) {
    return (
      <Shell count={0}>
        <div className="px-5 py-4 space-y-3">
          {filterChips}
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
        {filterChips}
        <div className="space-y-2.5">
          {signals.map((s) => (
            <SignalCard
              key={s.signal_id}
              s={s}
              reactions={reactions}
              respond={respond}
              onRefetch={load}
              onReplace={replaceSignal}
            />
          ))}
        </div>
      </div>
    </Shell>
  );
}
