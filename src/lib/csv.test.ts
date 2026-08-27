import { describe, expect, it } from "vitest";
import { csvEscape, csvRow, buildCsvDocument, centsToMajorUnits } from "./csv";

describe("csvEscape", () => {
  it("leaves a plain value untouched", () => {
    expect(csvEscape("Bongo Beats")).toBe("Bongo Beats");
    expect(csvEscape(42)).toBe("42");
  });

  it("quotes and escapes a value containing a comma", () => {
    expect(csvEscape("Nairobi, Kenya")).toBe('"Nairobi, Kenya"');
  });

  it("quotes and doubles internal quotes", () => {
    expect(csvEscape('Say "hi"')).toBe('"Say ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvEscape("line one\nline two")).toBe('"line one\nline two"');
  });

  it("renders null/undefined as an empty cell", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
});

describe("csvRow", () => {
  it("joins escaped cells with commas", () => {
    expect(csvRow(["Spice Grill", 3000, null])).toBe("Spice Grill,3000,");
  });
});

describe("buildCsvDocument", () => {
  it("renders each section as a title, header row, data rows, and a blank separator", () => {
    const doc = buildCsvDocument([
      { title: "Revenue", headers: ["Date", "Amount"], rows: [["2026-08-01", 100]] },
      { title: "Tickets", headers: ["Date", "Sold"], rows: [["2026-08-01", 5]] },
    ]);
    expect(doc.split("\r\n")).toEqual([
      "Revenue",
      "Date,Amount",
      "2026-08-01,100",
      "",
      "Tickets",
      "Date,Sold",
      "2026-08-01,5",
      "",
    ]);
  });

  it("handles a section with zero data rows", () => {
    const doc = buildCsvDocument([{ title: "Empty", headers: ["A", "B"], rows: [] }]);
    expect(doc.split("\r\n")).toEqual(["Empty", "A,B", ""]);
  });
});

describe("centsToMajorUnits", () => {
  it("divides by 100 for a two-decimal currency", () => {
    expect(centsToMajorUnits(650000)).toBe(6500);
  });

  it("also divides by 100 for a zero-decimal currency — stored minor units are the same scale", () => {
    expect(centsToMajorUnits(1500000)).toBe(15000);
  });
});
