import { describe, expect, it } from "vitest";
import { feasibility, planCampaign } from "../src/services/planner.js";

describe("feasibility", () => {
  it("allows a sane drivetime campaign", () => {
    const f = feasibility("2026-09-01", "2026-09-14", 6, "weekday_drivetime", []);
    expect(f.ok).toBe(true);
    expect(f.days).toBe(14);
  });

  it("rejects an impossible per-day load", () => {
    // all_day = 48 breaks/day max; 144 spots/day is over any rule.
    const f = feasibility("2026-09-01", "2026-09-14", 144, "weekday_drivetime", []);
    expect(f.ok).toBe(false);
    expect(f.reason).toContain("cannot fit");
  });

  it("rejects an inverted date range", () => {
    const f = feasibility("2026-09-14", "2026-09-01", 6, "all_day", []);
    expect(f.ok).toBe(false);
  });

  it("honours custom days", () => {
    const f = feasibility("2026-09-01", "2026-09-14", 6, "custom", [1, 2]);
    expect(f.ok).toBe(true);
  });
});

describe("planCampaign", () => {
  it("computes expected spots and value", () => {
    const plan = planCampaign({
      startDate: "2026-09-01", // Tuesday
      endDate: "2026-09-07", // Monday
      spotsPerDay: 6,
      rule: "all_day",
      customDays: [],
      ratePerSpot: 25,
      currency: "USD",
      tz: "UTC",
    });
    expect(plan.days).toBe(7);
    expect(plan.expectedSpots).toBe(42);
    expect(plan.totalValue).toBe(1050);
  });

  it("only includes drivetime breaks on weekdays", () => {
    const plan = planCampaign({
      startDate: "2026-09-05", // Saturday
      endDate: "2026-09-06", // Sunday
      spotsPerDay: 10,
      rule: "weekday_drivetime",
      customDays: [],
      ratePerSpot: 1,
      currency: "USD",
      tz: "UTC",
    });
    expect(plan.expectedSpots).toBe(0); // no weekday in range
  });

  it("anchors breaks at :15 and :45 in the station timezone", () => {
    const plan = planCampaign({
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      spotsPerDay: 4,
      rule: "all_day",
      customDays: [],
      ratePerSpot: 1,
      currency: "USD",
      tz: "UTC",
    });
    const minutes = plan.breaks.map((b) => new Date(b).getUTCMinutes());
    expect(minutes.every((m) => m === 15 || m === 45)).toBe(true);
  });
});
