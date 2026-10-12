/**
 * Ranking and clash detection logic for dates polls.
 *
 * Compares poll options against busy calendar intervals, drops conflicting
 * options, ranks the remaining options soonest first, and formats clash reasons
 * in the party timezone.
 */
import type { BusyInterval } from "./ics.js";

export interface DroppedOption {
  option: string;
  reason: string;
  clashes: BusyInterval[];
}

export interface RankingResult {
  /** Kept option strings, matching poll.options exactly, sorted soonest first (max 8). */
  kept: string[];
  /** Dropped options with reason and clash details. */
  dropped: DroppedOption[];
  /** Whether kept options exceeded 8 and were truncated. */
  truncated: boolean;
  /** Total number of non-clashing options before truncation. */
  totalKept: number;
}

/**
 * Format an instant for display in the given timezone.
 */
function formatInstant(ms: number, timeZone: string, includeDate = true): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(includeDate ? { weekday: "short" } : {}),
  };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(ms));
  }
}

/**
 * Format a time-of-day for brief end-time display.
 */
function formatTimeOnly(ms: number, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(ms));
  }
}

/**
 * Format an all-day date in the given timezone as "Fri 16 Oct" (no clock time).
 */
function formatAllDayDate(ms: number, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(new Date(ms));
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).formatToParts(
      new Date(ms),
    );
  }
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${weekday} ${day} ${month}`.trim();
}

/**
 * Format a clash description for a given busy interval in the party timezone.
 */
export function describeClash(interval: BusyInterval, timeZone: string): string {
  if (interval.isAllDay) {
    const dayStr = formatAllDayDate(interval.startMs, timeZone);
    return `all-day event '${interval.summary}' on ${dayStr}`;
  }
  const startStr = formatInstant(interval.startMs, timeZone, true);
  const endStr = formatTimeOnly(interval.endMs, timeZone);
  return `event '${interval.summary}' (${startStr} – ${endStr})`;
}

/**
 * Evaluate poll date options against calendar busy intervals.
 */
export function evaluatePollOptions(
  options: string[],
  durationMinutes: number,
  partyTimezone: string,
  busyIntervals: BusyInterval[],
): RankingResult {
  const durationMs = durationMinutes * 60 * 1000;
  const nonClashing: { option: string; startMs: number }[] = [];
  const dropped: DroppedOption[] = [];

  for (const opt of options) {
    const optStartMs = Date.parse(opt);
    const optEndMs = optStartMs + durationMs;

    // Overlap condition: startA < endB && startB < endA (touching boundaries do not clash)
    const clashes = busyIntervals.filter(
      (b) => b.startMs < optEndMs && optStartMs < b.endMs,
    );

    if (clashes.length > 0) {
      const descriptions = clashes.map((c) => describeClash(c, partyTimezone));
      const reason = `clashes with ${descriptions.join("; ")}`;
      dropped.push({
        option: opt,
        reason,
        clashes,
      });
    } else {
      nonClashing.push({ option: opt, startMs: optStartMs });
    }
  }

  // Sort soonest first
  nonClashing.sort((a, b) => a.startMs - b.startMs);

  const totalKept = nonClashing.length;
  const truncated = totalKept > 8;
  const kept = nonClashing.slice(0, 8).map((x) => x.option);

  return {
    kept,
    dropped,
    truncated,
    totalKept,
  };
}

/**
 * Check if the current ranking matches the new ranking by instant equality.
 */
export function rankingMatches(
  currentRanking: string[] | undefined,
  newRanking: string[],
): boolean {
  if (!currentRanking) return false;
  if (currentRanking.length !== newRanking.length) return false;
  for (let i = 0; i < currentRanking.length; i++) {
    const cur = currentRanking[i];
    const next = newRanking[i];
    if (cur === next) continue;
    if (Date.parse(cur) === Date.parse(next)) continue;
    return false;
  }
  return true;
}
