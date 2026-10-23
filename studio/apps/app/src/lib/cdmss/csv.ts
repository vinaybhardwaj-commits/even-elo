// CSV for the worklist export. A cell stays raw only if it is a plain negative number (-5, -12.5). Every other cell that
// starts with - = + @ tab or CR gets a ' prefix so a spreadsheet never runs it ("-1+1" and "-2+3*cmd|..." are formulas).
const esc = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+@\t\r-]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  return [columns.map(esc).join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\r\n") + "\r\n";
}
