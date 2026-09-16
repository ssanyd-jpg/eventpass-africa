import { describe, expect, it } from "vitest";
import { EVENT_MODE_CONFIG, EVENT_TYPES, hasFeature } from "@/lib/event-modes";

describe("hasFeature", () => {
  it("is true for chipTiming/publicLeaderboard only on MARATHON", () => {
    expect(hasFeature("MARATHON", "chipTiming")).toBe(true);
    expect(hasFeature("MARATHON", "publicLeaderboard")).toBe(true);
    expect(hasFeature("GENERAL", "chipTiming")).toBe(false);
    expect(hasFeature("CONFERENCE", "chipTiming")).toBe(false);
    expect(hasFeature("FOOTBALL", "chipTiming")).toBe(false);
  });

  it("is true for sessionCheckIn/exhibitorLeads only on CONFERENCE", () => {
    expect(hasFeature("CONFERENCE", "sessionCheckIn")).toBe(true);
    expect(hasFeature("CONFERENCE", "exhibitorLeads")).toBe(true);
    expect(hasFeature("GENERAL", "sessionCheckIn")).toBe(false);
    expect(hasFeature("MARATHON", "exhibitorLeads")).toBe(false);
  });

  it("reflects the explicit CONCERT/FESTIVAL defaults", () => {
    expect(hasFeature("CONCERT", "vipFastTrack")).toBe(true);
    expect(hasFeature("CONCERT", "groupWallets")).toBe(false);
    expect(hasFeature("FESTIVAL", "groupWallets")).toBe(true);
    expect(hasFeature("FESTIVAL", "vipFastTrack")).toBe(false);
  });

  it("defaults multiDayPass and stageSchedule to false for every type", () => {
    for (const type of EVENT_TYPES) {
      expect(hasFeature(type, "multiDayPass")).toBe(false);
      expect(hasFeature(type, "stageSchedule")).toBe(false);
    }
  });

  it("is false for an unrecognized eventType instead of throwing", () => {
    expect(hasFeature("NOT_A_REAL_TYPE", "chipTiming")).toBe(false);
  });
});

describe("EVENT_MODE_CONFIG", () => {
  it("has an entry for every EVENT_TYPES member with a non-empty bilingual label", () => {
    for (const type of EVENT_TYPES) {
      const config = EVENT_MODE_CONFIG[type];
      expect(config.label.length).toBeGreaterThan(0);
      expect(config.labelSw.length).toBeGreaterThan(0);
    }
  });

  it("gives CONFERENCE a MULTI_ZONE default gate mode and MARATHON a SINGLE_ENTRY one", () => {
    expect(EVENT_MODE_CONFIG.CONFERENCE.defaultGateMode).toBe("MULTI_ZONE");
    expect(EVENT_MODE_CONFIG.MARATHON.defaultGateMode).toBe("SINGLE_ENTRY");
  });
});
