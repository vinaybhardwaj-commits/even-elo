"use client";

import { useCallback, useEffect, useState } from "react";
import { ADVISORY_FALLBACK, type PortalAuditSignal } from "@/lib/doctor-audits";

/**
 * Portal "Findings" panel (WM2) — the governance findings routed to this physician.
 *
 * ⚠️ TWO PANELS IN ONE FILE, AND THE FLAG IS THE ONLY THING BETWEEN THEM. With `reactions` false
 * this renders exactly what v0 rendered: no buttons, no forms, and the v0 sentence pointing a
 * doctor at their care manager. With it true the card gains two rows, and the v0 sentence goes —
 * because "until in-portal responses ship" stops being true the moment they have.
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

function fmtDay(d: string | null | undefined) {
  return d ? String(d).slice(0, 10) : "—";
}

/** The recorded response, read defensively. `response` is typed `unknown` upstream and this is the
 *  only place the portal looks inside it, so a shape change costs one missing line, not a crash. */
function readResponse(r: unknown): { type: string; verdict: string; comment: string } | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  const verdict = typeof o.verdict === "string" ? o.verdict : "";
  const comment = typeof o.comment === "string" ? o.comment : "";
  if (!type && !verdict && !comment) return null;
  return { type, verdict, comment };
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
 * Only on a `routed` thread that asked for one. An explanation cannot be sent empty (the buttons
 * stay dead until there is text) because "disagree" with no words is a rejection the care manager
 * cannot act on. The consequence of Disagree is stated under the buttons, before it is pressed.
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
  const isExplanation = s.response_required === "explanation";
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(verdict: string | null) {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/portal/findings/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          signal_id: s.signal_id,
          type: s.response_required,
          verdict,
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
        rows={3}
        placeholder={isExplanation ? "Your explanation (required)" : "Comment (optional)"}
        className="mt-1.5 w-full rounded-lg border border-stone-200 px-3 py-2.5 text-[16px] bg-white"
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {isExplanation ? (
          <>
            <button
              type="button"
              disabled={busy || empty}
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
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => send(null)} className={chipCls(true)}>
            Acknowledge
          </button>
        )}
      </div>
      {isExplanation && (
        <p className="mt-1.5 text-[12px] text-stone-500">
          Disagree sends this finding back to your care manager.
        </p>
      )}
      {err && <div className="mt-1.5 text-[12.5px] text-rose-600">{err}</div>}
    </div>
  );
}

function SignalCard({
  s,
  reactions,
  onRefetch,
  onReplace,
}: {
  s: PortalAuditSignal;
  reactions: boolean;
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
        </div>
      )}

      {reactions ? (
        <>
          <ReactionRow s={s} onRefetch={onRefetch} />
          {recorded ? (
            <div className={rowCls}>
              <p className="text-[12px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2 leading-snug break-words">
                You responded: {[recorded.type, recorded.verdict, recorded.comment].filter(Boolean).join(" · ")}
              </p>
            </div>
          ) : canRespond ? (
            <ResponseRow s={s} onRefetch={onRefetch} onReplace={onReplace} />
          ) : null}
        </>
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

export function FindingsForDoctor({ reactions = false }: { reactions?: boolean }) {
  const [data, setData] = useState<FindingsData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    fetch("/api/portal/findings")
      .then((r) => r.json())
      .then((j: FindingsData) => setData(j))
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // One card's signal, swapped in place after a response. Cheaper and steadier than a full refetch:
  // the other cards do not flicker, and the doctor sees the status chip change on the card they
  // just answered.
  const replaceSignal = useCallback((next: PortalAuditSignal) => {
    setData((d) =>
      d ? { ...d, signals: (d.signals ?? []).map((x) => (x.signal_id === next.signal_id ? next : x)) } : d,
    );
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
            <SignalCard
              key={s.signal_id}
              s={s}
              reactions={reactions}
              onRefetch={load}
              onReplace={replaceSignal}
            />
          ))}
        </div>
      </div>
    </Shell>
  );
}
