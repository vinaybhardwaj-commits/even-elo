"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  is_super_admin: boolean;
  is_sgc_member: boolean;
  is_hr: boolean;
  is_site_medical_head: boolean;
  position_label: string;
  hospital_code: string;
  last_login_at: string | null;
  created_at: string;
  submitted_count: number;
  retracted_count: number;
}

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  pending_approval: "bg-amber-50 text-amber-700",
  suspended: "bg-stone-100 text-stone-600",
  rejected: "bg-red-50 text-red-700",
};

const AVATAR_COLORS = [
  "bg-teal-100 text-teal-800", "bg-orange-100 text-orange-800", "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800", "bg-lime-100 text-lime-800", "bg-sky-100 text-sky-800",
];
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export default function UsersPage() {
  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const url = filter ? `/api/admin/profiles?status=${filter}` : "/api/admin/profiles";
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.rows ?? []);
          setCounts(j.counts ?? {});
        }
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  async function toggleFlag(id: string, key: string, value: boolean) {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/profiles/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        alert(j.error || "Update failed");
      }
      load();
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(id: string, status: string) {
    setBusy(id);
    try {
      await fetch(`/api/admin/profiles/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="text-sm text-stone-500 mb-2">
          <Link href="/admin" className="hover:text-stone-900">Admin</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">Users</span>
        </div>
        <div className="flex items-end justify-between mb-5">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Users</h1>
            <div className="text-sm text-stone-500 mt-1">
              {Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mb-4 text-sm">
          {["", "active", "pending_approval", "suspended", "rejected"].map((s) => (
            <button
              key={s || "all"}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium ${
                filter === s ? "bg-brand text-white" : "bg-white border border-stone-200 text-stone-700 hover:bg-stone-50"
              }`}
            >
              {s ? s.replace("_", " ") : "all"}
              {counts[s] !== undefined && s ? ` (${counts[s]})` : ""}
            </button>
          ))}
        </div>

        <div className="card overflow-hidden bg-white border border-stone-200 rounded-xl">
          <table className="w-full">
            <thead>
              <tr className="text-left text-[11px] font-medium text-stone-500 tracking-wider uppercase border-b border-stone-200 bg-stone-50">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Position</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Roles</th>
                <th className="px-4 py-3">Reports</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3 w-44">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-stone-500">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-stone-500">No users in this filter.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-[11px] font-medium ${colorFor(r.full_name)}`}>
                        {initials(r.full_name)}
                      </span>
                      <div>
                        <div className="text-sm font-medium text-stone-900">{r.full_name}</div>
                        <div className="text-xs text-stone-500">{r.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-stone-700">{r.position_label} · {r.hospital_code}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_PILL[r.status] ?? "bg-stone-100 text-stone-600"}`}>
                      {r.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                      {[
                        ["is_super_admin", "Super", r.is_super_admin],
                        ["is_sgc_member", "SGC", r.is_sgc_member],
                        ["is_hr", "HR", r.is_hr],
                        ["is_site_medical_head", "Site MH", r.is_site_medical_head],
                      ].map(([k, label, val]) => (
                        <button
                          key={k as string}
                          onClick={() => toggleFlag(r.id, k as string, !val)}
                          disabled={busy === r.id}
                          className={`px-2 py-0.5 rounded-full font-medium ${
                            val
                              ? "bg-teal-100 text-teal-800"
                              : "bg-stone-100 text-stone-500 hover:bg-stone-200"
                          }`}
                          title={val ? `Click to remove ${label}` : `Click to grant ${label}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.submitted_count > 0 ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        r.retracted_count > 0 ? "bg-amber-50 text-amber-800" : "bg-stone-100 text-stone-700"
                      }`} title={`${r.retracted_count} retracted of ${r.submitted_count} submitted`}>
                        {r.retracted_count}/{r.submitted_count}
                        {r.retracted_count > 0 ? " retracted" : ""}
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-500 num">
                    {r.last_login_at ? new Date(r.last_login_at).toISOString().slice(0, 10) : "never"}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={r.status}
                      onChange={(e) => changeStatus(r.id, e.target.value)}
                      disabled={busy === r.id}
                      className="px-2 py-1 border border-stone-200 rounded text-xs bg-white"
                    >
                      <option value="active">Active</option>
                      <option value="pending_approval">Pending</option>
                      <option value="suspended">Suspend</option>
                      <option value="rejected">Reject</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
