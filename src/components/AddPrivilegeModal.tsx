"use client";

import { useState } from "react";

const BASIS_OPTIONS = [
  { v: "initial", label: "Initial grant" },
  { v: "annual_review", label: "Annual review" },
  { v: "case_review", label: "Case review" },
  { v: "vc_observation_pass", label: "VC observation pass" },
] as const;

export function AddPrivilegeModal({
  physicianId,
  defaultSpecialty,
  onClose,
  onSaved,
}: {
  physicianId: string;
  defaultSpecialty?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [hospitalCode, setHospitalCode] = useState("EHRC");
  const [procedure, setProcedure] = useState(defaultSpecialty ?? "");
  const [grantedDate, setGrantedDate] = useState(new Date().toISOString().slice(0, 10));
  const [basis, setBasis] = useState<string>("initial");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!procedure.trim()) {
      setError("Procedure or specialty is required.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch(`/api/physicians/${physicianId}/privileges`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hospital_code: hospitalCode,
          procedure_or_specialty: procedure.trim(),
          granted_date: grantedDate,
          basis,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not grant privilege.");
        setSubmitting(false);
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[480px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Grant privilege</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Hospital</label>
            <select
              value={hospitalCode}
              onChange={(e) => setHospitalCode(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
            >
              <option value="EHRC">EHRC — Even Hospital Race Course Road</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Procedure or specialty *</label>
            <input
              type="text"
              value={procedure}
              onChange={(e) => setProcedure(e.target.value)}
              placeholder={defaultSpecialty ?? "e.g. General Surgery, Laparoscopic procedures"}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Granted on</label>
            <input
              type="date"
              value={grantedDate}
              onChange={(e) => setGrantedDate(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Basis</label>
            <div className="grid grid-cols-2 gap-2">
              {BASIS_OPTIONS.map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setBasis(opt.v)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border ${
                    basis === opt.v
                      ? "bg-brand text-white border-brand"
                      : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Saving…" : "Grant privilege"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
