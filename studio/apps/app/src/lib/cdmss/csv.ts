// CSV for the worklist export. Cells starting with = + - @ are prefixed with ' so a spreadsheet never runs them.
const esc = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\r\n") + "\r\n";
}
