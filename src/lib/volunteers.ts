import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";
import { formatDateTime } from "@/lib/format";
import { buildCsvDocument } from "@/lib/csv";

// Session 30 — volunteer and crew management. Business logic behind
// /dashboard/events/[id]/volunteers, the volunteer check-in step of
// wristband provisioning, and the live-monitoring volunteer section,
// extracted for direct testability — same reasoning as sync-handlers.ts's
// own header comment.

export type VolunteerStatus = "INVITED" | "CONFIRMED" | "CHECKED_IN" | "NO_SHOW";

// zoneAccess is stored as a comma-joined String on the model (see its
// schema comment) — these two helpers are the only place that format is
// ever parsed or built.
export function parseZoneAccess(raw: string): string[] {
  return raw
    .split(",")
    .map((z) => z.trim())
    .filter(Boolean);
}

export function formatZoneAccess(zones: string[]): string {
  return zones
    .map((z) => z.trim())
    .filter(Boolean)
    .join(", ");
}

function shiftLabel(shiftStart: Date, shiftEnd: Date): string {
  const endTime = shiftEnd.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${formatDateTime(shiftStart)} – ${endTime}`;
}

export interface CreateVolunteerInput {
  eventId: string;
  name: string;
  phone: string;
  email?: string | null;
  role: string;
  shiftStart: Date;
  shiftEnd: Date;
  zoneAccess?: string[];
  notes?: string | null;
}

export async function createVolunteer(input: CreateVolunteerInput) {
  return prisma.volunteer.create({
    data: {
      eventId: input.eventId,
      name: input.name.trim(),
      phone: normalizeTanzaniaPhone(input.phone),
      email: input.email?.trim() || null,
      role: input.role.trim(),
      shiftStart: input.shiftStart,
      shiftEnd: input.shiftEnd,
      zoneAccess: formatZoneAccess(input.zoneAccess ?? []),
      notes: input.notes?.trim() || null,
    },
  });
}

// Minimal RFC-4180-ish line splitter (quoted fields, escaped "" inside
// them) — the counterpart to csvEscape in src/lib/csv.ts, which this
// codebase has never needed a parser for until now (every other CSV
// feature only ever exports).
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

const REQUIRED_CSV_COLUMNS = ["name", "phone", "role", "shiftstart", "shiftend"];

export interface ParsedVolunteerRow {
  name: string;
  phone: string;
  role: string;
  shiftStart: Date;
  shiftEnd: Date;
  email?: string | null;
  zoneAccess?: string[];
  notes?: string | null;
}

export interface ParsedVolunteerCsv {
  rows: ParsedVolunteerRow[];
  errors: string[];
}

// Header row is required (case-insensitive), column order doesn't matter.
// Required columns: name, phone, role, shiftStart, shiftEnd (parseable by
// `new Date(...)` — an ISO string is the safe bet). email/zoneAccess/notes
// are optional columns. A bad row is skipped and reported, not fatal to
// the whole import — one typo shouldn't block 200 good rows.
export function parseVolunteerCsv(text: string): ParsedVolunteerCsv {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], errors: ["The CSV file is empty."] };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: [`Missing required column(s): ${missing.join(", ")}`] };
  }

  const col = (name: string) => header.indexOf(name);
  const nameIdx = col("name");
  const phoneIdx = col("phone");
  const roleIdx = col("role");
  const startIdx = col("shiftstart");
  const endIdx = col("shiftend");
  const emailIdx = col("email");
  const zoneIdx = col("zoneaccess");
  const notesIdx = col("notes");

  const rows: ParsedVolunteerRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1; // 1-based, header is row 1
    const cells = splitCsvLine(lines[i]);
    const name = cells[nameIdx] ?? "";
    const phone = cells[phoneIdx] ?? "";
    const role = cells[roleIdx] ?? "";
    const shiftStartRaw = cells[startIdx] ?? "";
    const shiftEndRaw = cells[endIdx] ?? "";

    if (!name || !phone || !role || !shiftStartRaw || !shiftEndRaw) {
      errors.push(`Row ${rowNum}: missing a required value.`);
      continue;
    }

    const shiftStart = new Date(shiftStartRaw);
    const shiftEnd = new Date(shiftEndRaw);
    if (Number.isNaN(shiftStart.getTime()) || Number.isNaN(shiftEnd.getTime())) {
      errors.push(`Row ${rowNum}: couldn't parse shift start/end as a date.`);
      continue;
    }

    rows.push({
      name,
      phone,
      role,
      shiftStart,
      shiftEnd,
      email: emailIdx >= 0 ? cells[emailIdx] || null : null,
      zoneAccess: zoneIdx >= 0 && cells[zoneIdx] ? parseZoneAccess(cells[zoneIdx]) : [],
      notes: notesIdx >= 0 ? cells[notesIdx] || null : null,
    });
  }

  return { rows, errors };
}

export interface BulkImportResult {
  created: number;
  errors: string[];
}

export async function bulkImportVolunteers(eventId: string, csvText: string): Promise<BulkImportResult> {
  const { rows, errors } = parseVolunteerCsv(csvText);
  for (const row of rows) {
    await createVolunteer({ ...row, eventId });
  }
  return { created: rows.length, errors };
}

export async function sendVolunteerInvite(volunteerId: string) {
  const volunteer = await prisma.volunteer.findUnique({
    where: { id: volunteerId },
    include: { event: { select: { title: true } } },
  });
  if (!volunteer) return null;

  // The volunteer portal's URL (see src/app/volunteer/[eventId]/[volunteerId])
  // is this invite's only distribution channel — "no login, access by
  // unique URL sent via WhatsApp" per spec — so it rides along on the same
  // message rather than a separate send.
  const portalUrl = `${process.env.NEXTAUTH_URL ?? ""}/volunteer/${volunteer.eventId}/${volunteer.id}`;
  const message = `👋 You've been invited to volunteer at ${volunteer.event.title}. Your role: ${volunteer.role}, Shift: ${shiftLabel(volunteer.shiftStart, volunteer.shiftEnd)}. Reply YES to confirm. Your volunteer pass: ${portalUrl}`;

  await sendNotification({
    type: "VOLUNTEER_INVITED",
    channel: "WHATSAPP",
    recipient: volunteer.phone,
    subject: `Volunteer invitation — ${volunteer.event.title}`,
    body: message,
  });

  // "Reply YES to confirm" describes the attendee-facing copy, not a wired
  // inbound flow — this codebase has no inbound WhatsApp webhook anywhere
  // (sendWhatsApp/sendNotification are outbound-only choke points), so
  // there's nothing here to parse a reply against. Confirmation is a manual
  // organiser action (see setVolunteerStatus) until/unless that webhook
  // exists — same honest scope call as Session 29 not inventing a Zone
  // model. Sending an invite is a notification, not a status transition —
  // a volunteer is already INVITED from creation (see the model's default)
  // and re-sending must never regress someone already CONFIRMED/CHECKED_IN.
  return volunteer;
}

export async function setVolunteerStatus(volunteerId: string, status: VolunteerStatus) {
  return prisma.volunteer.update({ where: { id: volunteerId }, data: { status } });
}

export async function listVolunteers(eventId: string) {
  return prisma.volunteer.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } });
}

export async function findVolunteerByPhone(eventId: string, phone: string) {
  return prisma.volunteer.findFirst({ where: { eventId, phone: normalizeTanzaniaPhone(phone) } });
}

export interface CheckInVolunteerInput {
  eventId: string;
  phone: string;
  nfcUid: string;
  organizationId: string;
  createdByUserId: string;
  createdByName: string;
}

// Provisions a wristband for a volunteer, the same way handleProvisionCredential
// does for an attendee's ticket/wallet — a fresh Credential row, resolved at
// scan time via Credential.volunteerId. Kept online-only (a direct Server
// Action, not a queueOp outbox entry): the provisioning page's offline path
// exists for attendee check-in at the gate, which volunteers don't need —
// they're provisioned once, at the volunteer desk, which has connectivity.
//
// "Their wristband automatically grants access only to their assigned
// zones" is realized as the zones this function returns for the desk to
// display, not a runtime gate restriction — no gate/location-scoped
// enforcement exists anywhere in this codebase for ticket check-in either
// (the gate scanner accepts any valid credential at any scan point), so
// there is no existing mechanism this feature could plug into without
// inventing one wholesale, beyond this spec's own scope.
export async function checkInVolunteer(input: CheckInVolunteerInput) {
  const volunteer = await findVolunteerByPhone(input.eventId, input.phone);
  if (!volunteer) return null;

  const credential = await prisma.credential.create({
    data: {
      code: `VOL-${volunteer.id.slice(-8).toUpperCase()}`,
      nfcUid: input.nfcUid,
      organizationId: input.organizationId,
      volunteerId: volunteer.id,
      createdByUserId: input.createdByUserId,
      createdByName: input.createdByName,
    },
  });

  const updated = await prisma.volunteer.update({
    where: { id: volunteer.id },
    data: { status: "CHECKED_IN", wristbandCredentialId: credential.id },
  });

  return { volunteer: updated, credentialId: credential.id };
}

// A volunteer counts as a no-show once their shift has started and they
// still haven't checked in — computed live rather than a status a cron
// flips, so it's always correct even for a volunteer who checks in late
// (they simply stop counting as a no-show the moment status flips).
export function isNoShow(volunteer: { status: string; shiftStart: Date }, now: Date): boolean {
  if (volunteer.status === "CHECKED_IN") return false;
  return volunteer.shiftStart.getTime() <= now.getTime();
}

export interface VolunteerRoleCount {
  role: string;
  assigned: number;
  checkedIn: number;
}

export interface VolunteerCounts {
  assigned: number;
  checkedIn: number;
  noShows: number;
  byRole: VolunteerRoleCount[];
}

export function summarizeVolunteers(
  volunteers: { role: string; status: string; shiftStart: Date }[],
  now: Date = new Date()
): VolunteerCounts {
  const byRole = new Map<string, VolunteerRoleCount>();
  let checkedIn = 0;
  let noShows = 0;

  for (const v of volunteers) {
    const entry = byRole.get(v.role) ?? { role: v.role, assigned: 0, checkedIn: 0 };
    entry.assigned += 1;
    if (v.status === "CHECKED_IN") {
      entry.checkedIn += 1;
      checkedIn += 1;
    }
    if (isNoShow(v, now)) noShows += 1;
    byRole.set(v.role, entry);
  }

  return { assigned: volunteers.length, checkedIn, noShows, byRole: Array.from(byRole.values()) };
}

export async function getVolunteerCounts(eventId: string, now: Date = new Date()): Promise<VolunteerCounts> {
  const volunteers = await prisma.volunteer.findMany({
    where: { eventId },
    select: { role: true, status: true, shiftStart: true },
  });
  return summarizeVolunteers(volunteers, now);
}

export async function buildVolunteerCsv(eventId: string, eventTitle: string): Promise<string> {
  const volunteers = await listVolunteers(eventId);
  return buildCsvDocument([
    {
      title: `Volunteers — ${eventTitle}`,
      headers: ["Name", "Phone", "Email", "Role", "Shift start", "Shift end", "Zone access", "Status", "Notes"],
      rows: volunteers.map((v) => [
        v.name,
        v.phone,
        v.email ?? "",
        v.role,
        v.shiftStart.toISOString(),
        v.shiftEnd.toISOString(),
        v.zoneAccess,
        v.status,
        v.notes ?? "",
      ]),
    },
  ]);
}
