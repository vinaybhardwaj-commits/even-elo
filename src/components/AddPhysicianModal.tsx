"use client";

import { useState } from "react";

const SPECIALTIES = [
  "General Surgery", "Cardiology", "Cardiothoracic Surgery", "Orthopaedics",
  "Neurology", "Neurosurgery", "Anaesthesia", "Gastroenterology", "Urology",
  "Plastics", "ENT", "Ophthalmology", "Paediatrics", "OBGYN", "Internal Medicine",
  "Dermatology", "Pulmonology", "Nephrology", "Endocrinology", "Oncology",
  "Radiology", "Pathology", "Emergency Medicine", "Other",
];

const COUNCILS = ["KMC", "MMC", "DMC", "MCI/NMC", "Other"];

export function AddPhysicianModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [regNo, setRegNo] = useState("");
  const [council, setCouncil] = useState("");
  const [regExpiry, setRegExpiry] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [joined, setJoined] = useState(new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!fullName.trim()) {
      setError("Full name is required.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/physicians", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          full_name: fullName.trim(),
          primary_specialty: specialty || null,
          registration_number: regNo.trim() || null,
          registration_council: council || null,
          registration_expiry: regExpiry || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          date_joined_network: joined || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error || "Could not create physician.");
        setSubmitting(false);
        return;
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4">
      <div className="bg-white rounded-xl border border-stone-200 w-full max-w-[520px] shadow-xl">
        <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">Add physician</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg">×</button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Full name *</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Dr Manoj Kumar"
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Primary specialty</label>
              <select
                value={specialty}
                onChange={(e) => setSpecialty(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              >
                <option value="">—</option>
                {SPECIALTIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Council</label>
              <select
                value={council}
                onChange={(e) => setCouncil(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm bg-white"
              >
                <option value="">—</option>
                {COUNCILS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Registration number</label>
              <input
                type="text"
                value={regNo}
                onChange={(e) => setRegNo(e.target.value)}
                placeholder="MCI-12345"
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Registration expiry</label>
              <input
                type="date"
                value={regExpiry}
                onChange={(e) => setRegExpiry(e.target.value)}
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="dr.kumar@even.in"
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91…"
                className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-500 mb-1">Joined network</label>
            <input
              type="date"
              value={joined}
              onChange={(e) => setJoined(e.target.value)}
              className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm outline-none focus:border-brand"
            />
          </div>
          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60">
              {submitting ? "Adding…" : "Add physician"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
