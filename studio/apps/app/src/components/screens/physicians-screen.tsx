"use client";

import { useMemo, useState } from "react";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import type { ScreenToolParams } from "@/lib/screens/tool-schema";
import { BASE_PATH, DataTable, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

type Filters = { status: "" | "active" | "inactive" | "terminated"; name: string; specialty: string; hospital: string };
const EMPTY: Filters = { status: "", name: "", specialty: "", hospital: "" };
const PAGE = 200;

export function toParams(f: Filters, offset = 0): ScreenToolParams<"list_physicians"> {
  const filter: NonNullable<ScreenToolParams<"list_physicians">["filter"]> = {};
  if (f.status) filter.status = f.status;
  if (f.name.trim()) filter.name_contains = f.name.trim().slice(0, 80);
  if (f.specialty.trim()) filter.specialty_contains = f.specialty.trim().slice(0, 80);
  if (f.hospital.trim()) filter.hospital_code = f.hospital.trim().slice(0, 40);
  return { filter, limit: PAGE, offset };
}

export function PhysiciansScreen() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const params = useMemo(() => toParams(applied, offset), [applied, offset]);
  const list = useScreenTool("list_physicians", params);

  useScreenContext("physicians", {}, params.filter ?? {}, [{ tool: "list_physicians", params, state: list }]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }) as Filters);

  return (
    <ScreenFrame title="Physicians">
      <form
        className="scr-filters scr-form"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
          setOffset(0);
        }}
      >
        <label>
          Name
          <input value={draft.name} onChange={set("name")} maxLength={80} />
        </label>
        <label>
          Specialty
          <input value={draft.specialty} onChange={set("specialty")} maxLength={80} />
        </label>
        <label>
          Hospital code
          <input value={draft.hospital} onChange={set("hospital")} maxLength={40} />
        </label>
        <label>
          Status
          <select value={draft.status} onChange={set("status")}>
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="terminated">Terminated</option>
          </select>
        </label>
        <button type="submit">Apply</button>
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY);
            setApplied(EMPTY);
            setOffset(0);
          }}
        >
          Clear
        </button>
      </form>

      <ToolSection title="Roster" state={list} retry={list.retry}>
        {(data) => (
          <>
            <Pager offset={offset} rowCount={data.row_count} total={data.total} onPage={setOffset} />
            <DataTable
              data={data}
              columns={["full_name", "primary_specialty", "current_status", "hospitals", "date_joined_network"]}
              labels={{ full_name: "name", primary_specialty: "specialty", current_status: "status", date_joined_network: "joined" }}
              rowHref={(row) => (row.physician_id ? `/physicians/${String(row.physician_id)}` : null)}
              renderCell={{
                // A plain anchor (full page load) so the click never depends on client-side routing.
                full_name: (v, row) =>
                  row.physician_id ? <a href={`${BASE_PATH}/physicians/${String(row.physician_id)}`}>{v === null ? "–" : String(v)}</a> : v === null ? "–" : String(v),
              }}
              empty={offset > 0 ? "No physicians on this page." : "No physicians match these filters."}
            />
            <Pager offset={offset} rowCount={data.row_count} total={data.total} onPage={setOffset} />
          </>
        )}
      </ToolSection>
    </ScreenFrame>
  );
}

function Pager({ offset, rowCount, total, onPage }: { offset: number; rowCount: number; total?: number; onPage: (offset: number) => void }) {
  const hasPrev = offset > 0;
  const hasNext = total !== undefined ? offset + rowCount < total : rowCount >= PAGE;
  if (!hasPrev && !hasNext && total === undefined) return null;
  const first = rowCount === 0 ? 0 : offset + 1;
  return (
    <nav className="scr-pager" aria-label="Roster pages">
      <span className="scr-muted" data-testid="roster-range">
        {total !== undefined ? `Showing ${first}–${offset + rowCount} of ${total}` : `Showing ${first}–${offset + rowCount}`}
      </span>
      <button type="button" disabled={!hasPrev} onClick={() => onPage(Math.max(0, offset - PAGE))}>
        Previous
      </button>
      <button type="button" disabled={!hasNext} onClick={() => onPage(offset + PAGE)}>
        Next
      </button>
    </nav>
  );
}
