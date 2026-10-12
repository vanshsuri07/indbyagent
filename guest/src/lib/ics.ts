/**
 * iCalendar (.ics) parser and busy interval extractor using ical.js.
 *
 * Supports RFC 5545 features:
 * - VTIMEZONE components and IANA TZID parameters
 * - All-day events (VALUE=DATE) blocking full calendar days in calendar-tz
 * - Floating times interpreted in calendar-tz
 * - Recurring events (RRULE, EXDATE, recurrence exceptions via RECURRENCE-ID)
 * - Filtering of STATUS:CANCELLED and TRANSP:TRANSPARENT events
 * - Expansion window clipping to prevent unbounded recurrence loops
 */
import ICAL from "ical.js";

export interface BusyInterval {
  startMs: number;
  endMs: number;
  summary: string;
  isAllDay: boolean;
}

export interface ParseIcsResult {
  intervals: BusyInterval[];
  totalEventsChecked: number;
  recurringExpanded: number;
  warnings: string[];
}

export interface ParseIcsOptions {
  icsContent: string;
  calendarTz: string;
  windowStartMs?: number;
  windowEndMs?: number;
}

/**
 * Validate whether a string is a recognized IANA timezone identifier.
 */
export function isValidIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert local date/time parts in a given IANA timezone to a UTC Date.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const approxUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  });

  function getParts(ms: number): number {
    const parts = formatter.formatToParts(new Date(ms));
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") {
        map[p.type] = parseInt(p.value, 10);
      }
    }
    const h = (map.hour ?? 0) % 24;
    return Date.UTC(
      map.year ?? year,
      (map.month ?? month) - 1,
      map.day ?? day,
      h,
      map.minute ?? 0,
      map.second ?? 0,
    );
  }

  const asZoned = getParts(approxUtc);
  const diff = asZoned - approxUtc;
  let candidate = approxUtc - diff;

  const targetZoned = Date.UTC(year, month - 1, day, hour, minute, second);
  const checkZoned = getParts(candidate);
  if (checkZoned !== targetZoned) {
    const diff2 = checkZoned - targetZoned;
    candidate -= diff2;
  }
  return new Date(candidate);
}

/**
 * Convert an ICAL.Time instance to UTC milliseconds.
 */
export function icalTimeToUtcMs(
  time: ICAL.Time,
  propTzid: string | null | undefined,
  calendarTz: string,
): number {
  if (time.isDate) {
    return zonedTimeToUtc(time.year, time.month, time.day, 0, 0, 0, calendarTz).getTime();
  }

  // UTC time (e.g. Z suffix)
  if (time.zone && (time.zone.tzid === "UTC" || time.zone === ICAL.Timezone.utcTimezone)) {
    return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  }

  // Registered VTIMEZONE
  if (
    time.zone &&
    time.zone.tzid &&
    time.zone.tzid !== "floating" &&
    ICAL.TimezoneService.has(time.zone.tzid)
  ) {
    return time.toUnixTime() * 1000;
  }

  // IANA timezone from property TZID parameter
  const tzid = propTzid || (time.zone && time.zone.tzid !== "floating" ? time.zone.tzid : null);
  if (tzid && isValidIanaTimeZone(tzid)) {
    return zonedTimeToUtc(
      time.year,
      time.month,
      time.day,
      time.hour,
      time.minute,
      time.second,
      tzid,
    ).getTime();
  }

  // Floating or unresolvable timezone -> calendarTz
  return zonedTimeToUtc(
    time.year,
    time.month,
    time.day,
    time.hour,
    time.minute,
    time.second,
    calendarTz,
  ).getTime();
}

/**
 * Determine whether a component should be ignored based on STATUS or TRANSP.
 */
function shouldIgnoreComponent(comp: ICAL.Component): boolean {
  const status = comp.getFirstPropertyValue("status");
  if (typeof status === "string" && status.toUpperCase() === "CANCELLED") {
    return true;
  }
  const transp = comp.getFirstPropertyValue("transp");
  if (typeof transp === "string" && transp.toUpperCase() === "TRANSPARENT") {
    return true;
  }
  return false;
}

/**
 * Parse an iCalendar string and extract busy time intervals.
 */
export function parseIcs(options: ParseIcsOptions): ParseIcsResult {
  const { icsContent, calendarTz, windowStartMs, windowEndMs } = options;
  const warnings: string[] = [];
  const intervals: BusyInterval[] = [];

  let jcal: unknown;
  try {
    jcal = ICAL.parse(icsContent);
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse iCalendar data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const rootComp = new ICAL.Component(jcal as any[]);

  // Register all VTIMEZONE components
  const vtimezones = rootComp.getAllSubcomponents("vtimezone");
  for (const vtz of vtimezones) {
    try {
      ICAL.TimezoneService.register(new ICAL.Timezone(vtz));
    } catch (err: unknown) {
      warnings.push(
        `Failed to register VTIMEZONE: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const vevents = rootComp.getAllSubcomponents("vevent");
  let totalEventsChecked = 0;
  let recurringExpanded = 0;

  // Separate master events from recurrence exceptions
  const primaryEvents = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];

  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) {
      exceptions.push(ev);
    } else {
      primaryEvents.set(ev.uid, ev);
    }
  }

  // Relate exceptions to their primary event
  for (const ex of exceptions) {
    const primary = primaryEvents.get(ex.uid);
    if (primary) {
      try {
        primary.relateException(ex);
      } catch (err: unknown) {
        warnings.push(
          `Failed to relate recurrence exception for event ${ex.uid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      // Orphaned recurrence exception: treat as standalone event
      primaryEvents.set(`${ex.uid}_exception_${ex.recurrenceId?.toString()}`, ex);
    }
  }

  const MAX_EXPANSIONS_PER_EVENT = 10_000;

  for (const [, ev] of primaryEvents) {
    totalEventsChecked++;

    if (shouldIgnoreComponent(ev.component)) {
      continue;
    }

    const summary = ev.summary || "(untitled event)";
    const dtstartProp = ev.component.getFirstProperty("dtstart");
    const dtendProp = ev.component.getFirstProperty("dtend");
    const propStartTzid = dtstartProp?.getParameter("tzid") as string | undefined;
    const propEndTzid = (dtendProp?.getParameter("tzid") as string | undefined) || propStartTzid;

    if (ev.isRecurring()) {
      let it: any;
      try {
        it = ev.iterator();
      } catch (err: unknown) {
        warnings.push(
          `Failed to create recurrence iterator for event "${summary}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      let expansions = 0;
      let next: ICAL.Time | null;
      while ((next = it.next())) {
        expansions++;
        if (expansions > MAX_EXPANSIONS_PER_EVENT) {
          warnings.push(
            `Recurrence expansion exceeded ${MAX_EXPANSIONS_PER_EVENT} occurrences for "${summary}". Stopping expansion.`,
          );
          break;
        }

        const details = ev.getOccurrenceDetails(next);
        if (shouldIgnoreComponent(details.item.component)) {
          continue;
        }

        const occItemStartProp = details.item.component.getFirstProperty("dtstart");
        const occItemEndProp = details.item.component.getFirstProperty("dtend");
        const occStartTzid =
          (occItemStartProp?.getParameter("tzid") as string | undefined) || propStartTzid;
        const occEndTzid =
          (occItemEndProp?.getParameter("tzid") as string | undefined) || occStartTzid;

        const isAllDay = details.startDate.isDate;
        let startMs: number;
        let endMs: number;

        if (isAllDay) {
          startMs = zonedTimeToUtc(
            details.startDate.year,
            details.startDate.month,
            details.startDate.day,
            0,
            0,
            0,
            calendarTz,
          ).getTime();
          const endDate = details.endDate || details.startDate;
          endMs = zonedTimeToUtc(
            endDate.year,
            endDate.month,
            endDate.day,
            0,
            0,
            0,
            calendarTz,
          ).getTime();
          if (endMs <= startMs) {
            endMs = startMs + 24 * 3600 * 1000;
          }
        } else {
          startMs = icalTimeToUtcMs(details.startDate, occStartTzid, calendarTz);
          endMs = details.endDate
            ? icalTimeToUtcMs(details.endDate, occEndTzid, calendarTz)
            : startMs;
          if (endMs < startMs) {
            endMs = startMs;
          }
        }

        // If recurrence has passed beyond the end of our evaluation window, break early
        if (windowEndMs !== undefined && startMs > windowEndMs) {
          break;
        }

        // If recurrence ended before our evaluation window, skip it
        if (windowStartMs !== undefined && endMs < windowStartMs) {
          continue;
        }

        recurringExpanded++;
        intervals.push({
          startMs,
          endMs,
          summary: details.item.summary || summary,
          isAllDay,
        });
      }
    } else {
      // Non-recurring single event
      const isAllDay = ev.startDate.isDate;
      let startMs: number;
      let endMs: number;

      if (isAllDay) {
        startMs = zonedTimeToUtc(
          ev.startDate.year,
          ev.startDate.month,
          ev.startDate.day,
          0,
          0,
          0,
          calendarTz,
        ).getTime();
        const endDate = ev.endDate || ev.startDate;
        endMs = zonedTimeToUtc(
          endDate.year,
          endDate.month,
          endDate.day,
          0,
          0,
          0,
          calendarTz,
        ).getTime();
        if (endMs <= startMs) {
          endMs = startMs + 24 * 3600 * 1000;
        }
      } else {
        startMs = icalTimeToUtcMs(ev.startDate, propStartTzid, calendarTz);
        endMs = ev.endDate ? icalTimeToUtcMs(ev.endDate, propEndTzid, calendarTz) : startMs;
        if (endMs < startMs) {
          endMs = startMs;
        }
      }

      // Check window clipping
      if (windowEndMs !== undefined && startMs > windowEndMs) {
        continue;
      }
      if (windowStartMs !== undefined && endMs < windowStartMs) {
        continue;
      }

      intervals.push({
        startMs,
        endMs,
        summary,
        isAllDay,
      });
    }
  }

  return {
    intervals,
    totalEventsChecked,
    recurringExpanded,
    warnings,
  };
}
