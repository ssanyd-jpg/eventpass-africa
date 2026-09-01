import { afterEach, describe, expect, it, vi } from "vitest";
import * as claude from "./claude";
import { summarizeSurveyTheme } from "./survey-summary";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("summarizeSurveyTheme", () => {
  it("skips the API call entirely below the response-count threshold", async () => {
    const spy = vi.spyOn(claude, "callClaude");
    const result = await summarizeSurveyTheme("How was it?", ["Great!", "Loved it"]);
    expect(result).toEqual({ ok: false, reason: "TOO_FEW_RESPONSES", message: "Not enough responses yet to summarize." });
    expect(spy).not.toHaveBeenCalled();
  });

  it("calls Claude and returns the trimmed summary once the threshold is met", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: true, text: "  Most attendees loved the venue.  " });
    const result = await summarizeSurveyTheme("How was it?", ["Great!", "Loved it", "Amazing venue", "So good"]);
    expect(result).toEqual({ ok: true, summary: "Most attendees loved the venue." });
  });

  it("propagates a callClaude failure unchanged", async () => {
    vi.spyOn(claude, "callClaude").mockResolvedValue({ ok: false, reason: "REQUEST_FAILED", message: "HTTP 500" });
    const result = await summarizeSurveyTheme("q", ["a", "b", "c"]);
    expect(result).toEqual({ ok: false, reason: "REQUEST_FAILED", message: "HTTP 500" });
  });
});
