import { describe, expect, it, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent, createTestVendor } from "@/lib/test-fixtures";
import { handleSellTickets, handleRecordSessionAttendance, handleCaptureExhibitorLead } from "@/lib/sync-handlers";
import { getConferenceAnalyticsData } from "@/lib/conference-sessions-data";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

// Neon connection-pool drain, same reasoning timing.test.ts's own afterEach
// gives — setupConference chains several sequential Prisma calls, and this
// file layers multiple handler calls on top of it.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

// A CONFERENCE event with one session, one attendee with a provisioned
// (ticket-linked) NFC credential, and one approved exhibitor vendor — the
// conference analogue of timing.test.ts's setupMarathon.
async function setupConference() {
  const { user: owner, organizationId } = await newOrganizer();
  const event = await createTestEvent(organizationId, [{ priceCents: 500_000, quantityTotal: 200 }]);
  await prisma.event.update({ where: { id: event.id }, data: { eventType: "CONFERENCE" } });

  const attendee = await createTestUser({ name: "Amina Attendee" });
  await handleSellTickets(attendee.id, {
    clientId: uid("order"),
    eventId: event.id,
    items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [uid("TIX")] }],
  });
  const ticket = await prisma.ticket.findFirstOrThrow({ where: { eventId: event.id, order: { userId: attendee.id } } });

  const nfcUid = uid("nfc").toUpperCase();
  const credential = await prisma.credential.create({
    data: {
      organizationId,
      ticketId: ticket.id,
      code: ticket.code,
      nfcUid,
      status: "ACTIVE",
      createdByUserId: owner.id,
      createdByName: owner.name,
    },
  });

  const eventSession = await prisma.conferenceSession.create({
    data: {
      eventId: event.id,
      clientId: uid("sess"),
      name: "Opening Keynote",
      speaker: "Dr. Nia Okoro",
      location: "Main Hall",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 3600_000),
    },
  });

  const vendor = await createTestVendor(event.id, { name: "Acme Exhibit" });

  return { owner, organizationId, event, attendee, ticket, credential, eventSession, vendor };
}

function attendancePayload(overrides: Record<string, unknown>) {
  return { clientId: uid("att"), recordedAt: new Date().toISOString(), ...overrides };
}

describe("ConferenceSession creation", () => {
  it("stores name, speaker, room/location, and start/end times correctly", async () => {
    const { eventSession, event } = await setupConference();
    const fresh = await prisma.conferenceSession.findUniqueOrThrow({ where: { id: eventSession.id } });
    expect(fresh.eventId).toBe(event.id);
    expect(fresh.name).toBe("Opening Keynote");
    expect(fresh.speaker).toBe("Dr. Nia Okoro");
    expect(fresh.location).toBe("Main Hall");
    expect(fresh.startsAt.getTime()).toBeLessThan(fresh.endsAt.getTime());
  });
});

describe("handleRecordSessionAttendance", () => {
  it("records attendance via NFC uid, resolving the attendee's name and ticket type", async () => {
    const { organizationId, event, eventSession, credential } = await setupConference();
    const result: any = await handleRecordSessionAttendance(
      organizationId,
      attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credential.nfcUid })
    );
    expect(result.ok).toBe(true);
    expect(result.attendance.credentialId).toBe(credential.id);
    expect(result.attendance.attendeeName).toBe("Amina Attendee");
    expect(result.attendance.eventSessionName).toBe("Opening Keynote");
  });

  it("also resolves via a QR/manual ticket code scan, landing on the same credential", async () => {
    const { organizationId, event, eventSession, credential, ticket } = await setupConference();
    const result: any = await handleRecordSessionAttendance(
      organizationId,
      attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, ticketCode: ticket.code })
    );
    expect(result.ok).toBe(true);
    expect(result.attendance.credentialId).toBe(credential.id);
  });

  // "Recorded offline and syncs" in practice means: a device queues the tap
  // locally then replays it once connectivity returns. The client-side half
  // of that (Dexie outbox) isn't exercised by a server-only test — what's
  // testable and load-bearing here is that a replayed/retried sync (the
  // same clientId arriving twice, exactly what an offline device's outbox
  // does on reconnect) is idempotent rather than duplicating.
  it("is idempotent — replaying the same clientId (an offline device syncing later) returns the same row rather than duplicating", async () => {
    const { organizationId, event, eventSession, credential } = await setupConference();
    const payload = attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credential.nfcUid });

    const first: any = await handleRecordSessionAttendance(organizationId, payload);
    const second: any = await handleRecordSessionAttendance(organizationId, payload);
    expect(second.attendance.id).toBe(first.attendance.id);

    const count = await prisma.sessionAttendance.count({ where: { credentialId: credential.id, eventSessionId: eventSession.id } });
    expect(count).toBe(1);
  });

  // Neon cold-start/latency headroom, same reasoning as the idempotent-
  // replay test above.
  it("returns the existing row on a re-scan of the same attendee at the same session (no duplicate)", { timeout: 120000 }, async () => {
    const { organizationId, event, eventSession, credential } = await setupConference();
    const first: any = await handleRecordSessionAttendance(organizationId, attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credential.nfcUid }));
    const second: any = await handleRecordSessionAttendance(organizationId, attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credential.nfcUid }));
    expect(second.attendance.id).toBe(first.attendance.id);
    const count = await prisma.sessionAttendance.count({ where: { credentialId: credential.id, eventSessionId: eventSession.id } });
    expect(count).toBe(1);
  });

  it("rejects a tap with no matching provisioned credential", async () => {
    const { organizationId, event, eventSession } = await setupConference();
    const result: any = await handleRecordSessionAttendance(
      organizationId,
      attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: "NEVER-PROVISIONED" })
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CREDENTIAL_NOT_FOUND");
  });

  // Neon cold-start/latency headroom, same reasoning timing.test.ts's own
  // heavier tests document — this one chains setupConference plus a second
  // full attendee+ticket+credential creation plus two handler calls.
  it("the room's live attendanceCount aggregate reflects every synced tap, not just one device's own", { timeout: 120000 }, async () => {
    const { organizationId, event, eventSession, credential } = await setupConference();
    const attendeeTwo = await createTestUser({ name: "Second Attendee" });
    await handleSellTickets(attendeeTwo.id, {
      clientId: uid("order"),
      eventId: event.id,
      items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [uid("TIX")] }],
    });
    const ticketTwo = await prisma.ticket.findFirstOrThrow({ where: { eventId: event.id, order: { userId: attendeeTwo.id } } });
    const credentialTwo = await prisma.credential.create({
      data: {
        organizationId,
        ticketId: ticketTwo.id,
        code: ticketTwo.code,
        nfcUid: uid("nfc").toUpperCase(),
        status: "ACTIVE",
        createdByUserId: credential.createdByUserId,
        createdByName: credential.createdByName,
      },
    });

    await handleRecordSessionAttendance(organizationId, attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credential.nfcUid }));
    await handleRecordSessionAttendance(organizationId, attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credentialTwo.nfcUid }));

    const fresh = await prisma.conferenceSession.findUniqueOrThrow({
      where: { id: eventSession.id },
      include: { _count: { select: { attendances: true } } },
    });
    expect(fresh._count.attendances).toBe(2);
  });
});

describe("handleCaptureExhibitorLead", () => {
  it("captures a lead with notes correctly", async () => {
    const { organizationId, event, vendor, credential } = await setupConference();
    const result: any = await handleCaptureExhibitorLead(organizationId, {
      clientId: uid("lead"),
      eventId: event.id,
      vendorId: vendor.id,
      nfcUid: credential.nfcUid,
      notes: "Interested in the premium plan — follow up Monday",
    });
    expect(result.ok).toBe(true);
    expect(result.lead.vendorId).toBe(vendor.id);
    expect(result.lead.credentialId).toBe(credential.id);
    expect(result.lead.attendeeName).toBe("Amina Attendee");
    expect(result.lead.notes).toBe("Interested in the premium plan — follow up Monday");
  });

  it("captures a lead with no note as null, not an empty string", async () => {
    const { organizationId, event, vendor, ticket } = await setupConference();
    const result: any = await handleCaptureExhibitorLead(organizationId, {
      clientId: uid("lead"),
      eventId: event.id,
      vendorId: vendor.id,
      ticketCode: ticket.code,
    });
    expect(result.ok).toBe(true);
    expect(result.lead.notes).toBeNull();
  });

  it("is idempotent — replaying the same clientId returns the same row rather than duplicating", { timeout: 120000 }, async () => {
    const { organizationId, event, vendor, credential } = await setupConference();
    const payload = { clientId: uid("lead"), eventId: event.id, vendorId: vendor.id, nfcUid: credential.nfcUid, notes: "note" };
    const first: any = await handleCaptureExhibitorLead(organizationId, payload);
    const second: any = await handleCaptureExhibitorLead(organizationId, payload);
    expect(second.lead.id).toBe(first.lead.id);
  });

  // Unlike SessionAttendance, an exhibitor lead has no per-(vendor,
  // attendee) uniqueness — a re-tap (attendee revisits the booth, or staff
  // re-taps to add a note) is a genuinely new lead row, same "no dedup"
  // convention SPONSOR_TAP follows for repeat taps.
  it("allows repeat taps for the same attendee at the same exhibitor without deduping", { timeout: 120000 }, async () => {
    const { organizationId, event, vendor, credential } = await setupConference();
    await handleCaptureExhibitorLead(organizationId, { clientId: uid("lead"), eventId: event.id, vendorId: vendor.id, nfcUid: credential.nfcUid });
    await handleCaptureExhibitorLead(organizationId, { clientId: uid("lead"), eventId: event.id, vendorId: vendor.id, nfcUid: credential.nfcUid });
    const count = await prisma.exhibitorLead.count({ where: { vendorId: vendor.id, credentialId: credential.id } });
    expect(count).toBe(2);
  });

  it("rejects a tap with no matching provisioned credential", async () => {
    const { organizationId, event, vendor } = await setupConference();
    const result: any = await handleCaptureExhibitorLead(organizationId, {
      clientId: uid("lead"),
      eventId: event.id,
      vendorId: vendor.id,
      nfcUid: "NEVER-PROVISIONED",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CREDENTIAL_NOT_FOUND");
  });
});

describe("getConferenceAnalyticsData", () => {
  it("aggregates session attendance and exhibitor lead totals correctly", { timeout: 120000 }, async () => {
    const { organizationId, event, eventSession, credential, vendor } = await setupConference();
    await handleRecordSessionAttendance(organizationId, attendancePayload({ eventId: event.id, eventSessionId: eventSession.id, nfcUid: credential.nfcUid }));
    await handleCaptureExhibitorLead(organizationId, { clientId: uid("lead"), eventId: event.id, vendorId: vendor.id, nfcUid: credential.nfcUid });

    const data = await getConferenceAnalyticsData(event.id);
    expect(data).not.toBeNull();
    expect(data!.sessions).toHaveLength(1);
    expect(data!.sessions[0].attendanceCount).toBe(1);
    expect(data!.totalAttendance).toBe(1);
    expect(data!.totalLeads).toBe(1);
    expect(data!.exhibitorLeadTotals).toEqual([{ label: "Acme Exhibit", value: 1 }]);
    expect(data!.peakHour).not.toBeNull();
  });

  it("returns null for an event id that doesn't exist", async () => {
    const data = await getConferenceAnalyticsData("nonexistent-event-id");
    expect(data).toBeNull();
  });
});
