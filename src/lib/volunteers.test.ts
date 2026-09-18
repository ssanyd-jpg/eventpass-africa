import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser, addMembership } from "@/lib/test-fixtures";
import {
  createVolunteer,
  parseVolunteerCsv,
  bulkImportVolunteers,
  sendVolunteerInvite,
  setVolunteerStatus,
  checkInVolunteer,
  findVolunteerByPhone,
  parseZoneAccess,
  formatZoneAccess,
  isNoShow,
  summarizeVolunteers,
  getVolunteerCounts,
} from "@/lib/volunteers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("createVolunteer", () => {
  it("creates a volunteer with normalized phone and joined zone access", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const volunteer = await createVolunteer({
      eventId: event.id,
      name: "  Asha Juma  ",
      phone: "0712345678",
      email: "asha@example.com",
      role: "Gate crew",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
      zoneAccess: ["General Admission", " Pitch-side "],
      notes: "  Speaks Swahili and English  ",
    });

    expect(volunteer.name).toBe("Asha Juma");
    expect(volunteer.phone).toBe("+255712345678");
    expect(volunteer.role).toBe("Gate crew");
    expect(volunteer.zoneAccess).toBe("General Admission, Pitch-side");
    expect(volunteer.status).toBe("INVITED");
    expect(volunteer.notes).toBe("Speaks Swahili and English");
    expect(volunteer.wristbandCredentialId).toBeNull();
  });

  it("defaults email/zoneAccess/notes when omitted", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const volunteer = await createVolunteer({
      eventId: event.id,
      name: "Baraka Mnyika",
      phone: "0712000000",
      role: "Water station",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
    });

    expect(volunteer.email).toBeNull();
    expect(volunteer.zoneAccess).toBe("");
    expect(volunteer.notes).toBeNull();
  });
});

describe("parseZoneAccess / formatZoneAccess", () => {
  it("round-trips a comma-separated list, trimming and dropping blanks", () => {
    const zones = parseZoneAccess("General Admission,  Pitch-side ,, VIP");
    expect(zones).toEqual(["General Admission", "Pitch-side", "VIP"]);
    expect(formatZoneAccess(zones)).toBe("General Admission, Pitch-side, VIP");
  });

  it("formats an empty list as an empty string", () => {
    expect(formatZoneAccess([])).toBe("");
  });
});

describe("parseVolunteerCsv", () => {
  it("parses a well-formed CSV with all optional columns", () => {
    const csv = [
      "name,phone,role,shiftStart,shiftEnd,email,zoneAccess,notes",
      "Asha Juma,0712345678,Gate crew,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z,asha@example.com,\"General Admission, VIP\",Team lead",
      "Baraka Mnyika,0712000000,Medical,2026-10-01T09:00:00Z,2026-10-01T17:00:00Z,,,",
    ].join("\n");

    const { rows, errors } = parseVolunteerCsv(csv);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      email: "asha@example.com",
      zoneAccess: ["General Admission", "VIP"],
      notes: "Team lead",
    });
    expect(rows[0].shiftStart.toISOString()).toBe("2026-10-01T08:00:00.000Z");
    expect(rows[1].email).toBeNull();
    expect(rows[1].zoneAccess).toEqual([]);
  });

  it("parses a CSV with only the required columns, in a different order", () => {
    const csv = ["phone,name,shiftEnd,role,shiftStart", "0712345678,Asha,2026-10-01T16:00:00Z,Gate crew,2026-10-01T08:00:00Z"].join("\n");

    const { rows, errors } = parseVolunteerCsv(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Asha");
  });

  it("reports missing required columns without parsing any rows", () => {
    const csv = ["name,phone", "Asha,0712345678"].join("\n");
    const { rows, errors } = parseVolunteerCsv(csv);
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/Missing required column/);
  });

  it("skips a row missing a required value and reports it, without dropping good rows", () => {
    const csv = [
      "name,phone,role,shiftStart,shiftEnd",
      "Asha Juma,0712345678,Gate crew,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z",
      "No Phone Here,,Medical,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z",
      "Baraka Mnyika,0712000000,Water station,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z",
    ].join("\n");

    const { rows, errors } = parseVolunteerCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(["Asha Juma", "Baraka Mnyika"]);
    expect(errors).toEqual(["Row 3: missing a required value."]);
  });

  it("skips a row with an unparseable shift date", () => {
    const csv = ["name,phone,role,shiftStart,shiftEnd", "Asha,0712345678,Gate crew,not-a-date,2026-10-01T16:00:00Z"].join("\n");
    const { rows, errors } = parseVolunteerCsv(csv);
    expect(rows).toEqual([]);
    expect(errors[0]).toMatch(/couldn't parse shift/i);
  });

  it("reports an empty file", () => {
    expect(parseVolunteerCsv("").errors[0]).toMatch(/empty/i);
  });
});

describe("bulkImportVolunteers", () => {
  it("creates every valid row for the given event and returns the count and errors", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const csv = [
      "name,phone,role,shiftStart,shiftEnd",
      "Asha Juma,0712345678,Gate crew,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z",
      "Missing Role,0712000001,,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z",
      "Baraka Mnyika,0712000000,Water station,2026-10-01T08:00:00Z,2026-10-01T16:00:00Z",
    ].join("\n");

    const result = await bulkImportVolunteers(event.id, csv);

    expect(result.created).toBe(2);
    expect(result.errors).toEqual(["Row 3: missing a required value."]);
    const saved = await prisma.volunteer.findMany({ where: { eventId: event.id } });
    expect(saved).toHaveLength(2);
    expect(saved.map((v) => v.name).sort()).toEqual(["Asha Juma", "Baraka Mnyika"]);
  });
});

describe("sendVolunteerInvite", () => {
  it("sends a WhatsApp invitation with role, shift, and the volunteer portal link", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const volunteer = await createVolunteer({
      eventId: event.id,
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
    });

    await sendVolunteerInvite(volunteer.id);

    const logs = await prisma.notificationLog.findMany({ where: { type: "VOLUNTEER_INVITED", recipient: volunteer.phone } });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toContain("You've been invited to volunteer at");
    expect(logs[0].body).toContain("Gate crew");
    expect(logs[0].body).toContain("Reply YES to confirm");
    expect(logs[0].body).toContain(`/volunteer/${event.id}/${volunteer.id}`);
  });

  it("does not change a volunteer's status", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const volunteer = await createVolunteer({
      eventId: event.id,
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
    });
    await setVolunteerStatus(volunteer.id, "CONFIRMED");

    await sendVolunteerInvite(volunteer.id);

    const reloaded = await prisma.volunteer.findUniqueOrThrow({ where: { id: volunteer.id } });
    expect(reloaded.status).toBe("CONFIRMED");
  });

  it("returns null for an unknown volunteer id", async () => {
    expect(await sendVolunteerInvite("does-not-exist")).toBeNull();
  });
});

describe("checkInVolunteer", () => {
  it("provisions a Credential, links it back, and sets status to CHECKED_IN", async () => {
    const { user, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const volunteer = await createVolunteer({
      eventId: event.id,
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
      zoneAccess: ["General Admission"],
    });

    const result = await checkInVolunteer({
      eventId: event.id,
      phone: "0712345678", // unnormalized input, same as the desk would type
      nfcUid: "04:AA:BB:CC",
      organizationId,
      createdByUserId: user.id,
      createdByName: user.name,
    });

    expect(result).not.toBeNull();
    expect(result!.volunteer.status).toBe("CHECKED_IN");
    expect(result!.volunteer.wristbandCredentialId).toBe(result!.credentialId);

    const credential = await prisma.credential.findUniqueOrThrow({ where: { id: result!.credentialId } });
    expect(credential.volunteerId).toBe(volunteer.id);
    expect(credential.nfcUid).toBe("04:AA:BB:CC");
    expect(credential.organizationId).toBe(organizationId);

    const reloaded = await prisma.volunteer.findUniqueOrThrow({ where: { id: volunteer.id } });
    expect(reloaded.status).toBe("CHECKED_IN");
    expect(reloaded.wristbandCredentialId).toBe(result!.credentialId);
  });

  it("returns null when no volunteer matches the phone number for this event", async () => {
    const { user, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await checkInVolunteer({
      eventId: event.id,
      phone: "0799999999",
      nfcUid: "04:00:00:00",
      organizationId,
      createdByUserId: user.id,
      createdByName: user.name,
    });

    expect(result).toBeNull();
  });

  it("does not match a volunteer from a different event", async () => {
    const { user, organizationId } = await newOrganizer();
    const eventA = await createTestEvent(organizationId);
    const eventB = await createTestEvent(organizationId);
    await createVolunteer({
      eventId: eventA.id,
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
    });

    const result = await checkInVolunteer({
      eventId: eventB.id,
      phone: "0712345678",
      nfcUid: "04:00:00:01",
      organizationId,
      createdByUserId: user.id,
      createdByName: user.name,
    });

    expect(result).toBeNull();
  });
});

describe("findVolunteerByPhone", () => {
  it("finds a volunteer regardless of how the phone number was formatted", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await createVolunteer({
      eventId: event.id,
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      shiftStart: new Date("2026-10-01T08:00:00Z"),
      shiftEnd: new Date("2026-10-01T16:00:00Z"),
    });

    expect(await findVolunteerByPhone(event.id, "+255712345678")).not.toBeNull();
    expect(await findVolunteerByPhone(event.id, "255712345678")).not.toBeNull();
    expect(await findVolunteerByPhone(event.id, "0712345678")).not.toBeNull();
  });
});

describe("isNoShow", () => {
  const shiftStart = new Date("2026-10-01T08:00:00Z");

  it("is false before the shift has started", () => {
    expect(isNoShow({ status: "INVITED", shiftStart }, new Date("2026-10-01T07:59:59Z"))).toBe(false);
  });

  it("is true once the shift has started and status isn't CHECKED_IN", () => {
    expect(isNoShow({ status: "INVITED", shiftStart }, new Date("2026-10-01T08:00:00Z"))).toBe(true);
    expect(isNoShow({ status: "CONFIRMED", shiftStart }, new Date("2026-10-01T09:00:00Z"))).toBe(true);
  });

  it("is false once checked in, even long after shift start", () => {
    expect(isNoShow({ status: "CHECKED_IN", shiftStart }, new Date("2026-10-01T12:00:00Z"))).toBe(false);
  });
});

describe("summarizeVolunteers / getVolunteerCounts", () => {
  it("computes assigned, checked-in, no-show, and per-role counts", () => {
    const now = new Date("2026-10-01T09:00:00Z");
    const volunteers = [
      { role: "Gate crew", status: "CHECKED_IN", shiftStart: new Date("2026-10-01T08:00:00Z") },
      { role: "Gate crew", status: "INVITED", shiftStart: new Date("2026-10-01T08:00:00Z") }, // no-show
      { role: "Medical", status: "CONFIRMED", shiftStart: new Date("2026-10-01T10:00:00Z") }, // shift hasn't started
    ];

    const summary = summarizeVolunteers(volunteers, now);

    expect(summary.assigned).toBe(3);
    expect(summary.checkedIn).toBe(1);
    expect(summary.noShows).toBe(1);
    expect(summary.byRole).toEqual(
      expect.arrayContaining([
        { role: "Gate crew", assigned: 2, checkedIn: 1 },
        { role: "Medical", assigned: 1, checkedIn: 0 },
      ])
    );
  });

  it("reads live volunteer rows for an event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await createVolunteer({
      eventId: event.id,
      name: "Asha Juma",
      phone: "0712345678",
      role: "Gate crew",
      shiftStart: new Date(Date.now() - 3600000),
      shiftEnd: new Date(Date.now() + 3600000),
    });
    await checkInVolunteer({
      eventId: event.id,
      phone: "0712345678",
      nfcUid: "04:00:00:02",
      organizationId,
      createdByUserId: (await newOrganizer()).user.id,
      createdByName: "Front Desk",
    });

    const counts = await getVolunteerCounts(event.id);
    expect(counts.assigned).toBe(1);
    expect(counts.checkedIn).toBe(1);
    expect(counts.noShows).toBe(0);
  });
});
