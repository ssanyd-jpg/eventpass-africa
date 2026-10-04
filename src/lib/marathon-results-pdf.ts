import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatDate, formatDateTime } from "@/lib/format";
import type { RankedMarathonFinisher, DNFAthlete } from "@/lib/marathon-results";

// Official marathon results PDF — a certified-looking finish-order record
// (TAAA, sponsors, runners' own memento), built with pdf-lib since this
// codebase has no existing PDF generation to follow a precedent from (the
// CSV export routes hand-roll text/csv instead — a PDF's binary structure
// isn't something to hand-roll the way csv.ts does).
//
// Medal emoji (🥇🥈🥉) can't be embedded as real glyphs through pdf-lib's
// standard fonts (WinAnsi has no emoji block), so top-3 category finishers
// get a small colored numbered circle instead — same meaning, actually
// renders.

export interface MarathonResultsPdfInput {
  eventTitle: string;
  eventType?: string;
  venue: string;
  city: string;
  startsAt: Date;
  totalStarters: number;
  totalFinishers: number;
  dnfCount: number;
  results: RankedMarathonFinisher[];
  dnfs: DNFAthlete[];
  generatedAt?: Date;
}

const PAGE_WIDTH = 595.28; // A4 portrait, in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const ROW_HEIGHT = 20;
const FOOTER_RESERVE = 36;

const INK = rgb(0.11, 0.11, 0.16);
const ACCENT = rgb(0.02, 0.36, 0.31); // Chaap-ish deep teal
const GREY = rgb(0.45, 0.45, 0.48);
const LINE = rgb(0.85, 0.85, 0.87);
const SHADE = rgb(0.96, 0.96, 0.98);
const GOLD = rgb(0.83, 0.69, 0.22);
const SILVER = rgb(0.68, 0.68, 0.7);
const BRONZE = rgb(0.72, 0.45, 0.2);
const WHITE = rgb(1, 1, 1);

const COL = {
  rank: { x: MARGIN, w: 32 },
  cat: { x: MARGIN + 32, w: 48 },
  name: { x: MARGIN + 32 + 48, w: 148 },
  category: { x: MARGIN + 32 + 48 + 148, w: 100 },
  gun: { x: MARGIN + 32 + 48 + 148 + 100, w: 68 },
  chip: { x: MARGIN + 32 + 48 + 148 + 100 + 68, w: 58 },
  pace: { x: MARGIN + 32 + 48 + 148 + 100 + 68 + 58, w: 61 },
};
const TABLE_RIGHT = COL.pace.x + COL.pace.w;

// pdf-lib's standard fonts only encode WinAnsi — fall back to a stripped
// ASCII copy rather than throwing on an unusual name/venue.
function drawTextSafe(page: PDFPage, text: string, opts: Parameters<PDFPage["drawText"]>[1]) {
  try {
    page.drawText(text, opts);
  } catch {
    page.drawText(text.replace(/[^\x20-\x7e]/g, "?"), opts);
  }
}

const MEDAL_COLOR = { 1: GOLD, 2: SILVER, 3: BRONZE } as const;

function drawMedal(page: PDFPage, x: number, y: number, rank: 1 | 2 | 3, font: PDFFont) {
  page.drawEllipse({ x, y, xScale: 7, yScale: 7, color: MEDAL_COLOR[rank] });
  drawTextSafe(page, String(rank), { x: x - 3, y: y - 3.5, size: 8, font, color: WHITE });
}

export async function buildMarathonResultsPdf(input: MarathonResultsPdfInput): Promise<Uint8Array> {
  const isMountainBike = input.eventType === "MOUNTAIN_BIKE";
  const athleteLabel = isMountainBike ? "Rider" : "Athlete";
  const paceColLabel = isMountainBike ? "Speed" : "Pace";

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdfDoc.embedFont(StandardFonts.Courier);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function newPage() {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }

  function ensureSpace(minRemaining: number) {
    if (y - minRemaining < MARGIN + FOOTER_RESERVE) {
      newPage();
      drawTableHeader();
    }
  }

  function drawTableHeader() {
    drawTextSafe(page, "Rank", { x: COL.rank.x, y, size: 8, font: bold, color: GREY });
    drawTextSafe(page, "Cat.", { x: COL.cat.x, y, size: 8, font: bold, color: GREY });
    drawTextSafe(page, athleteLabel, { x: COL.name.x, y, size: 8, font: bold, color: GREY });
    drawTextSafe(page, "Category", { x: COL.category.x, y, size: 8, font: bold, color: GREY });
    drawTextSafe(page, "Gun time", { x: COL.gun.x, y, size: 8, font: bold, color: GREY });
    drawTextSafe(page, "Chip time", { x: COL.chip.x, y, size: 8, font: bold, color: GREY });
    drawTextSafe(page, paceColLabel, { x: COL.pace.x, y, size: 8, font: bold, color: GREY });
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: TABLE_RIGHT, y }, thickness: 1, color: LINE });
    y -= ROW_HEIGHT - 4;
  }

  // ---- Header (page 1) ----
  drawTextSafe(page, input.eventTitle, { x: MARGIN, y, size: 22, font: bold, color: INK });
  y -= 24;
  drawTextSafe(page, "OFFICIAL RESULTS", { x: MARGIN, y, size: 12, font: bold, color: ACCENT });
  y -= 18;
  drawTextSafe(page, `${formatDate(input.startsAt)}  ·  ${input.venue}, ${input.city}`, { x: MARGIN, y, size: 10, font, color: GREY });
  y -= 14;
  drawTextSafe(page, "Powered by Chaap · chaap.africa", { x: MARGIN, y, size: 9, font, color: GREY });
  y -= 13;
  drawTextSafe(page, `Generated ${formatDateTime(input.generatedAt ?? new Date())}`, { x: MARGIN, y, size: 9, font, color: GREY });
  y -= 22;

  const statW = (TABLE_RIGHT - MARGIN) / 3;
  const stats: [string, number][] = [
    ["Total starters", input.totalStarters],
    ["Total finishers", input.totalFinishers],
    ["DNF", input.dnfCount],
  ];
  stats.forEach(([label, value], i) => {
    const x = MARGIN + i * statW;
    drawTextSafe(page, String(value), { x, y, size: 16, font: bold, color: INK });
    drawTextSafe(page, label.toUpperCase(), { x, y: y - 13, size: 7, font, color: GREY });
  });
  y -= 34;

  page.drawLine({ start: { x: MARGIN, y }, end: { x: TABLE_RIGHT, y }, thickness: 1.5, color: ACCENT });
  y -= 20;

  // ---- Results table ----
  drawTableHeader();

  if (input.results.length === 0) {
    drawTextSafe(page, "No finishers recorded for this event.", { x: MARGIN, y, size: 10, font, color: GREY });
    y -= ROW_HEIGHT;
  }

  input.results.forEach((r, i) => {
    ensureSpace(ROW_HEIGHT);

    if (i % 2 === 1) {
      page.drawRectangle({ x: MARGIN, y: y - 5, width: TABLE_RIGHT - MARGIN, height: ROW_HEIGHT, color: SHADE });
    }

    drawTextSafe(page, String(r.overallRank), { x: COL.rank.x, y, size: 9, font: mono, color: INK });

    if (r.medal) {
      drawMedal(page, COL.cat.x + 7, y + 3, r.medal, bold);
      drawTextSafe(page, String(r.categoryRank), { x: COL.cat.x + 20, y, size: 9, font: mono, color: INK });
    } else {
      drawTextSafe(page, String(r.categoryRank), { x: COL.cat.x, y, size: 9, font: mono, color: INK });
    }

    drawTextSafe(page, truncate(r.athleteName, 24), { x: COL.name.x, y, size: 9, font, color: INK });
    drawTextSafe(page, truncate(r.ticketTypeName, 16), { x: COL.category.x, y, size: 9, font, color: GREY });
    drawTextSafe(page, r.gunTimeFormatted, { x: COL.gun.x, y, size: 9, font: mono, color: INK });
    drawTextSafe(page, r.chipTimeFormatted ?? "—", { x: COL.chip.x, y, size: 9, font: mono, color: GREY });
    drawTextSafe(page, isMountainBike ? r.speed : r.pace, { x: COL.pace.x, y, size: 9, font: mono, color: INK });

    y -= ROW_HEIGHT;
  });

  // ---- DNF section ----
  ensureSpace(50);
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: TABLE_RIGHT, y }, thickness: 1, color: LINE });
  y -= 22;
  drawTextSafe(page, "Did Not Finish", { x: MARGIN, y, size: 13, font: bold, color: INK });
  y -= 20;

  if (input.dnfs.length === 0) {
    drawTextSafe(page, "No DNFs recorded.", { x: MARGIN, y, size: 10, font, color: GREY });
    y -= ROW_HEIGHT;
  } else {
    input.dnfs.forEach((d, i) => {
      ensureSpace(ROW_HEIGHT);
      if (i % 2 === 1) {
        page.drawRectangle({ x: MARGIN, y: y - 5, width: TABLE_RIGHT - MARGIN, height: ROW_HEIGHT, color: SHADE });
      }
      drawTextSafe(page, d.bib, { x: COL.rank.x, y, size: 9, font: mono, color: INK });
      drawTextSafe(page, truncate(d.athleteName, 30), { x: COL.name.x, y, size: 9, font, color: INK });
      drawTextSafe(page, truncate(d.ticketTypeName, 20), { x: COL.category.x, y, size: 9, font, color: GREY });
      if (d.reason) drawTextSafe(page, d.reason, { x: COL.gun.x, y, size: 9, font, color: GREY });
      y -= ROW_HEIGHT;
    });
  }

  // ---- Footer (page numbers + event name, every page) ----
  const pages = pdfDoc.getPages();
  pages.forEach((p, i) => {
    drawTextSafe(p, `${input.eventTitle} · Official Results`, { x: MARGIN, y: 20, size: 8, font, color: GREY });
    const label = `Page ${i + 1} of ${pages.length}`;
    drawTextSafe(p, label, { x: TABLE_RIGHT - font.widthOfTextAtSize(label, 8), y: 20, size: 8, font, color: GREY });
  });

  return pdfDoc.save();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
