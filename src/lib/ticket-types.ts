// Session 14 — pure, DB-free rules for the gate scanner's VIP fast-track
// signal. Kept separate from sync-handlers.ts/the scanner page so the
// decision logic itself (name match OR explicit flag, "already checked in"
// always wins) is directly testable without a database or a browser.

// A ticket type counts as VIP/fast-track if its name contains "VIP"
// (case-insensitive, e.g. "VIP", "VIP Pass", "Backstage VIP") OR if the
// organiser explicitly flagged it via TicketType.isFastTrack — either is
// sufficient, matching Session 14's spec exactly.
export function isFastTrackTicketType(ticketTypeName: string, isFastTrack: boolean): boolean {
  return isFastTrack || /vip/i.test(ticketTypeName);
}

export type GateSignal = "vip" | "standard" | "already";

// What the gate scanner should show for a ticket it has already matched
// against a valid (non-refunded/non-pending) order. "already" always wins
// over "vip" — a VIP attendee re-scanning a second time is still an
// already-checked-in re-entry attempt, not a fresh fast-track moment.
export function resolveGateSignal(input: {
  checkedIn: boolean;
  ticketTypeName: string;
  isFastTrack: boolean;
}): GateSignal {
  if (input.checkedIn) return "already";
  return isFastTrackTicketType(input.ticketTypeName, input.isFastTrack) ? "vip" : "standard";
}
