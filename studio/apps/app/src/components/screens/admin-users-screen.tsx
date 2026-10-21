"use client";

import { useMemo, useState } from "react";
import { HOSPITAL_ROLES, SETTABLE_STATUSES, USER_STATUSES, type AdminParams, type AdminPayload } from "@/lib/screens/admin-schema";
import { postAdminWrite, useAdmin } from "@/lib/screens/use-admin";
import { DataTable, StatTile, ToolSection } from "./parts";
import { ConfirmCard, asScreenState } from "./admin-parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// Users and hospital roles: the read parts of even-elo /admin/users. Password hashes, PINs and requested-role blobs
// are never loaded. Create, PIN reset, role revoke and delete stay on the old page (a PIN, or a hard delete).

type Row = AdminPayload["table"]["rows"][number];
const str = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
const countOf = (data: NonNullable<AdminPayload["counts"]>, status: string) => {
  const n = data.rows.find((r) => r.status === status)?.users;
  return typeof n === "number" ? n : 0;
};

export function AdminUsersScreen() {
  const [status, setStatus] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = useMemo<AdminParams<"users">>(() => (status ? { status: status as (typeof USER_STATUSES)[number] } : {}), [status]);
  const users = useAdmin("users", params);

  useScreenContext("admin-users", selectedId ? { profile_id: selectedId } : {}, { table: "staff users", ...params }, [{ tool: "admin_users", params, state: asScreenState(users) }]);

  return (
    <ScreenFrame title="Users and roles">
      <p className="scr-muted">Staff accounts and their hospital roles. Create, PIN reset, role removal and delete stay on the old admin page.</p>
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()} aria-label="User filters">
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setSelectedId(null);
            }}
          >
            <option value="">All</option>
            {USER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
      </form>

      {users.status === "ok" && users.data.counts && (
        <section className="scr-card" aria-label="User counts">
          <header className="scr-card-head">
            <h2>Counts</h2>
            <p>Across all accounts, whatever the filter above.</p>
          </header>
          <div className="scr-tiles">
            <StatTile label="Active" value={countOf(users.data.counts, "active")} data={users.data.counts} />
            <StatTile label="Pending approval" value={countOf(users.data.counts, "pending_approval")} data={users.data.counts} />
            <StatTile label="Suspended" value={countOf(users.data.counts, "suspended")} data={users.data.counts} />
          </div>
        </section>
      )}

      <ToolSection title="Users" state={asScreenState(users)} retry={users.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["full_name", "email", "status", "position_label", "hospital_code", "roles", "last_login_at"]}
            labels={{ full_name: "name", position_label: "position", hospital_code: "hospital", last_login_at: "last login" }}
            renderCell={{
              full_name: (v, row) => (
                <button type="button" aria-pressed={row.profile_id === selectedId} onClick={() => setSelectedId(String(row.profile_id))}>
                  {str(v)}
                </button>
              ),
              last_login_at: (v) => str(v).slice(0, 10),
            }}
            empty="No users match."
          />
        )}
      </ToolSection>

      {users.status === "ok" && selectedId && (
        <Detail
          key={selectedId}
          row={users.data.table.rows.find((r) => r.profile_id === selectedId) ?? null}
          profileId={selectedId}
          writeEnabled={users.data.write_enabled}
          onChanged={users.retry}
        />
      )}
    </ScreenFrame>
  );
}

function Detail({ row, profileId, writeEnabled, onChanged }: { row: Row | null; profileId: string; writeEnabled: boolean; onChanged: () => void }) {
  const rolesParams = useMemo<AdminParams<"roles">>(() => ({ profile_id: profileId }), [profileId]);
  const roles = useAdmin("roles", rolesParams);
  const [next, setNext] = useState<(typeof SETTABLE_STATUSES)[number]>("active");
  const [hospital, setHospital] = useState("");
  const [role, setRole] = useState<(typeof HOSPITAL_ROLES)[number]>("hr");
  const hospitalOk = /^[A-Za-z0-9_-]{1,20}$/.test(hospital.trim());
  return (
    <>
      <ToolSection title={`Hospital roles${row ? ` · ${str(row.full_name)}` : ""}`} state={asScreenState(roles)} retry={roles.retry}>
        {(data) => <DataTable data={data} columns={["hospital_code", "role", "granted_at"]} renderCell={{ granted_at: (v) => str(v).slice(0, 10) }} empty="No hospital roles granted." />}
      </ToolSection>
      <section className="scr-card" aria-label="User changes">
        <header className="scr-card-head">
          <h2>Change this user</h2>
          <p>Each change calls the existing even-elo route as you. Role removal is not offered here.</p>
        </header>
        <ConfirmCard
          title="Set account status"
          effect={`Sets the account status to ${next}. Approving a pending account also applies the roles it requested, as on the old page.`}
          enabled={writeEnabled && row?.status !== next}
          disabledNote={writeEnabled ? `Already ${next}.` : undefined}
          submit={() => postAdminWrite("set_status", { profile_id: profileId, status: next })}
          onDone={onChanged}
        >
          <label>
            New status
            <select value={next} onChange={(e) => setNext(e.target.value as (typeof SETTABLE_STATUSES)[number])}>
              {SETTABLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </ConfirmCard>
        <ConfirmCard
          title="Grant a hospital role"
          effect={`Grants ${role.replace(/_/g, " ")} at ${hospital.trim().toUpperCase() || "the hospital you enter"}. An existing grant is left as it is.`}
          enabled={writeEnabled}
          canConfirm={hospitalOk}
          submit={() => postAdminWrite("grant_role", { profile_id: profileId, hospital_code: hospital.trim().toUpperCase(), role })}
          onDone={() => {
            roles.retry();
            onChanged();
          }}
        >
          <label>
            Hospital code
            <input value={hospital} maxLength={20} onChange={(e) => setHospital(e.target.value)} />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as (typeof HOSPITAL_ROLES)[number])}>
              {HOSPITAL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </ConfirmCard>
      </section>
    </>
  );
}
