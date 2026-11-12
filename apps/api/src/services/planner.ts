import { zonedParts, zonedDate } from "@airwavehq/shared";
import { DEFAULT_BREAKS } from "@airwavehq/shared";
import type { CampaignFeasibility } from "@airwavehq/shared";

export interface CampaignPlan {
  days: number;
  breaks: number[]; // epoch ms of every eligible break
  expectedSpots: number;
  totalValue: number;
  windows: string[]; // human-readable descriptions
}

function ruleMatchesRule(
  rule: string,
  customDays: number[],
  dow: number,
  hour: number,
): boolean {
  switch (rule) {
    case "weekday_drivetime":
      return dow >= 1 && dow <= 5 && hour >= 6 && hour <= 19;
    case "weekends":
      return dow === 0 || dow === 6;
    case "custom":
      return customDays.includes(dow);
    default:
      return true;
  }
}

function hourlyWindows(rule: string, customDays: number[], dow: number): number[] {
  // Returns hours (0-23) where breaks are eligible for this day.
  switch (rule) {
    case "weekday_drivetime":
      return dow >= 1 && dow <= 5 ? Array.from({ length: 14 }, (_, i) => i + 6) : [];
    case "weekends":
      return dow === 0 || dow === 6 ? Array.from({ length: 24 }, (_, i) => i) : [];
    case "custom":
      return customDays.includes(dow) ? Array.from({ length: 24 }, (_, i) => i) : [];
    default:
      return Array.from({ length: 24 }, (_, i) => i);
  }
}

/** Feasibility: can `spotsPerDay` physically fit on every campaign day? */
export function feasibility(
  startDate: string,
  endDate: string,
  spotsPerDay: number,
  rule: string,
  customDays: number[],
): CampaignFeasibility {
  const days = daySpan(startDate, endDate);
  if (days <= 0) {
    return { ok: false, days: 0, breaksPerDay: 0, maxSpotsPerBreak: 4, feasiblePerDay: 0, reason: "End date is before start date" };
  }
  // Max spots per break: a 30s spot in a ~120s break, capped by maxPerHour=2 default.
  const maxSpotsPerBreak = 4;
  let maxBreaksPerDay = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(parseInt(startDate.slice(0, 4)), parseInt(startDate.slice(5, 7)) - 1, parseInt(startDate.slice(8, 10)) + i));
    const dow = (d.getUTCDay() + 7) % 7;
    maxBreaksPerDay = Math.max(maxBreaksPerDay, hourlyWindows(rule, customDays, dow).length * DEFAULT_BREAKS.length);
  }
  const feasiblePerDay = maxBreaksPerDay * maxSpotsPerBreak;
  if (spotsPerDay > feasiblePerDay) {
    return {
      ok: false,
      days,
      breaksPerDay: maxBreaksPerDay,
      maxSpotsPerBreak,
      feasiblePerDay,
      reason: `${spotsPerDay} spots/day cannot fit in ${maxBreaksPerDay} breaks/day (max ${feasiblePerDay})`,
    };
  }
  return { ok: true, days, breaksPerDay: maxBreaksPerDay, maxSpotsPerBreak, feasiblePerDay, reason: "Fits" };
}

/** Builds the expected schedule of airings for a campaign (for proposals & reconciliation). */
export function planCampaign(input: {
  startDate: string;
  endDate: string;
  spotsPerDay: number;
  rule: string;
  customDays: number[];
  ratePerSpot: number;
  currency: string;
  tz: string;
}): CampaignPlan {
  const days = daySpan(input.startDate, input.endDate);
  const breaks: number[] = [];
  const windows: string[] = [];
  let expectedSpots = 0;

  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(
      parseInt(input.startDate.slice(0, 4)),
      parseInt(input.startDate.slice(5, 7)) - 1,
      parseInt(input.startDate.slice(8, 10)) + i,
    ));
    const isoDay = d.toISOString().slice(0, 10);
    const dow = (d.getUTCDay() + 7) % 7;
    const hours = hourlyWindows(input.rule, input.customDays, dow);
    const dayBreaks: number[] = [];
    for (const h of hours) {
      for (const b of DEFAULT_BREAKS) {
        // Local break time in station tz.
        const guess = Date.parse(`${isoDay}T${String(h).padStart(2, "0")}:${String(b).padStart(2, "0")}:00Z`);
        // Convert the guessed UTC instant back through the zone to get the correct instant.
        const p = zonedParts(guess, input.tz);
        const breakMinutesOfDay = p.minutesOfDay - p.minute + b;
        const at = p.localMidnightMs + breakMinutesOfDay * 60_000;
        dayBreaks.push(at);
      }
    }
    dayBreaks.sort((a, b) => a - b);
    // Spread the daily spots across the day's breaks.
    const spotsToday = Math.min(input.spotsPerDay, dayBreaks.length);
    const step = dayBreaks.length / spotsToday;
    const chosen: number[] = [];
    for (let s = 0; s < spotsToday; s++) {
      chosen.push(dayBreaks[Math.floor(s * step)]!);
    }
    for (const at of chosen) {
      breaks.push(at);
      windows.push(`${zonedDate(at, input.tz)} ${new Date(at).toISOString().slice(11, 16)}Z`);
    }
    expectedSpots += spotsToday;
  }

  breaks.sort((a, b) => a - b);
  return {
    days,
    breaks,
    expectedSpots,
    totalValue: Math.round(expectedSpots * input.ratePerSpot * 100) / 100,
    windows,
  };
}

function daySpan(startDate: string, endDate: string): number {
  const s = Date.parse(`${startDate}T00:00:00Z`);
  const e = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}
