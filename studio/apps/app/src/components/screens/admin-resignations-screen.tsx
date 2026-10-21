"use client";

import { useMemo, useState } from "react";
import type { AdminParams } from "@/lib/screens/admin-schema";
import { postAdminWrite, useAdmin } from "@/lib/screens/use-admin";
import { DataTable, ToolSection } from "./parts";
import { AdminSubnav, ConfirmCard, asScreenState } from "./admin-parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// Resignation requests: the read part of even-elo /admin/resignations. The reason text a physician wrote is not loaded.
const str = (v: unknown) => (v === null || v === undefined ? "–" : String(v));

export function AdminResignationsScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = useMemo<AdminParams<"resignations">>(() => ({}), []);
  const list = useAdmin("resignations", params);

  useScreenContext("admin-resignations", selectedId ? { request_id: selectedId } : {}, { table: "resignation requests" }, [{ tool: "admin_resignations", params, state: asScreenState(list) }]);

  const selected = list.status === "ok" ? list.data.table.rows.find((r) => r.request_id === selectedId) ?? null : null;
  return (
    <ScreenFrame title="Resignation requests">
      <AdminSubnav current="/admin/resignations" />
      <p className="scr-muted">Requests from physicians, pending first. The reason text is on the old admin page only.</p>
      <ToolSection title="Requests" state={asScreenState(list)} retry={list.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["requested_at", "physician_name", "hospital_code", "intended_last_date", "status"]}
            labels={{ requested_at: "requested", physician_name: "physician", hospital_code: "hospital", intended_last_date: "intended last day" }}
            renderCell={{
              requested_at: (v, row) => (
                <button type="button" aria-pressed={row.request_id === selectedId} onClick={() => setSelectedId(String(row.request_id))}>
                  {str(v).slice(0, 10)}
                </button>
              ),
            }}
            empty="No resignation requests."
          />
        )}
      </ToolSection>
      {list.status === "ok" && selected && (
        <section className="scr-card" aria-label="Resignation changes">
          <header className="scr-card-head">
            <h2>Process this request</h2>
          </header>
          <ConfirmCard
            key={String(selected.request_id)}
            title="Process resignation"
            effect={`Marks ${str(selected.physician_name)}'s active engagement${selected.hospital_code ? ` at ${str(selected.hospital_code)}` : "s"} as resigned and the request as processed. The physician is emailed. Records are kept.`}
            enabled={list.data.write_enabled && selected.status === "pending"}
            disabledNote={list.data.write_enabled ? "Only a pending request can be processed." : undefined}
            submit={() => postAdminWrite("process_resignation", { request_id: String(selected.request_id) })}
            onDone={list.retry}
          />
        </section>
      )}
    </ScreenFrame>
  );
}
