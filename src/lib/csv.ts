// Hand-rolled CSV encoding (RFC 4180-ish) — no new dependency, matching this
// codebase's preference for hand-rolling small well-understood formats (see
// the Airpay checksum scheme) over pulling in a library for one use case.

export function csvEscape(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvEscape).join(",");
}

// One labeled "section" of a multi-table CSV: a title line, a header row,
// then its data rows. buildCsvDocument separates sections with a blank
// line — spreadsheet tools (Excel, Google Sheets, Numbers) render this as
// one flat sheet with visually distinct blocks, no library needed.
export interface CsvSection {
  title: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

export function buildCsvDocument(sections: CsvSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(csvRow([section.title]));
    lines.push(csvRow(section.headers));
    for (const row of section.rows) lines.push(csvRow(row));
    lines.push(""); // blank separator between sections
  }
  return lines.join("\r\n");
}

// A plain numeric major-units figure a spreadsheet can actually sum.
// Every currency's cents column (including zero-decimal ones like
// TZS/UGX/RWF) is stored as real minor units and divided by 100 for
// display — see formatCents in ./format.ts, which does the same division
// and only varies the *rounding* shown, not the underlying scale.
export function centsToMajorUnits(cents: number): number {
  return cents / 100;
}
