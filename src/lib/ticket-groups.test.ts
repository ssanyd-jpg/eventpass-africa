import { describe, expect, it } from "vitest";
import { summarizeGroupSales } from "@/lib/ticket-groups";

describe("summarizeGroupSales", () => {
  it("returns zeroed figures with a null average for no groups", () => {
    const result = summarizeGroupSales([]);
    expect(result).toEqual({ groupCount: 0, totalGroupTickets: 0, averageGroupSize: null });
  });

  it("sums ticket counts and computes the average group size", () => {
    const result = summarizeGroupSales([{ ticketCount: 4 }, { ticketCount: 6 }, { ticketCount: 5 }]);
    expect(result.groupCount).toBe(3);
    expect(result.totalGroupTickets).toBe(15);
    expect(result.averageGroupSize).toBe(5);
  });

  it("rounds a non-integer average to one decimal place", () => {
    const result = summarizeGroupSales([{ ticketCount: 3 }, { ticketCount: 4 }]);
    expect(result.averageGroupSize).toBe(3.5);
  });
});
