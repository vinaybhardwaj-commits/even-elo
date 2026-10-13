import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SourceTable, parseSourceTable } from "./source-table";

const good = {
  source: { tool: "overview_counts", query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns: ["metric", "value"],
  rows: [{ metric: "physicians_total", value: 3 }],
  row_count: 1,
};

describe("SourceTable", () => {
  afterEach(cleanup);

  it("renders rows with the tool and query hash as the source", () => {
    render(<SourceTable result={JSON.stringify(good)} />);
    expect(screen.getByText("physicians_total")).toBeTruthy();
    expect(screen.getByText(/Source: overview_counts · query 0123456789ab · 1 row · live, read-only/)).toBeTruthy();
  });

  it("labels fixture data as sample data", () => {
    render(<SourceTable result={{ ...good, mode: "fixture", synthetic: true }} />);
    expect(screen.getByText(/SAMPLE DATA/)).toBeTruthy();
  });

  it("refuses a payload without a source", () => {
    const { source: _s, ...noSource } = good;
    render(<SourceTable result={JSON.stringify(noSource)} />);
    expect(screen.getByRole("alert").textContent).toContain("missing source");
    expect(screen.queryByText("physicians_total")).toBeNull();
  });

  it("refuses a bad query hash, invalid JSON and model-written HTML", () => {
    expect(parseSourceTable({ ...good, source: { tool: "x", query_hash: "zz" } }).ok).toBe(false);
    expect(parseSourceTable("{not json").ok).toBe(false);
    expect(parseSourceTable("<table><tr><td>hi</td></tr></table>").ok).toBe(false);
  });

  it("never interprets cell content as HTML", () => {
    const evil = { ...good, rows: [{ metric: "<img src=x onerror=alert(1)>", value: 1 }] };
    const { container } = render(<SourceTable result={evil} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
