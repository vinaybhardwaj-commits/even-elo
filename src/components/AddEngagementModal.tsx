"use client";

import { useState } from "react";

interface Props {
  physicianId: string;
  defaultSpecialty?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AddEngagementModal({ physicianId, defaultSpecialty, onClose, onSaved }: Props) {
  const [hospitalCode, setHospitalCode] = useState("EHRC");
  const [engagementType, setEngagementType] = useState<"employed" | "part_time" | "visiting_consultant">("visiting_consultant");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const [specialty, setSpecialty] = useState(defaultSpecialty ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch(`/api/physicians/${physicianId}/engagements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hospital_code: hospitalCode,
          engagement_type: engagementType,
          start_date: startDate,
          end_date: endDate || null,
          specialty: specialty.trim() || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not save engagement.");
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
          <h2 className="text-base font-semibold tracking-tight">Add engagement</h2>
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
            <label className="block text-xs font-medium text-stone-500 mb-1">Engagement type</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                ["employed", "Employed"],
                ["part_time", "Part-time"],
                ["visiting_consultant", "Visiting Consultant"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setEngagementType(k)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border ${
                    engagementType === k
                      ? "bg-brand text-white border-brand"
                      : "bg-white text-stone-700 border-stone-200 hover:border-stone-300"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">End date (optional)</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Specialty at this hospital (optional)</label>
            <input
              type="text"
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
              placeholder={defaultSpecialty ?? "e.g. Cardiology"}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
            />
          </div>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Saving…" : "Add engagement"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
