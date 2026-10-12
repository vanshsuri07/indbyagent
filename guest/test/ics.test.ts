/**
 * Tests for ics.ts: iCalendar parsing, timezone conversion, recurrence expansion.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseIcs,
  isValidIanaTimeZone,
  zonedTimeToUtc,
  icalTimeToUtcMs,
} from "../src/lib/ics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "..", "test", "fixtures");

describe("ics library", () => {
  describe("isValidIanaTimeZone", () => {
    it("returns true for standard IANA timezones", () => {
      assert.equal(isValidIanaTimeZone("UTC"), true);
      assert.equal(isValidIanaTimeZone("Asia/Calcutta"), true);
      assert.equal(isValidIanaTimeZone("America/New_York"), true);
      assert.equal(isValidIanaTimeZone("Europe/London"), true);
    });

    it("returns false for invalid or custom timezone names", () => {
      assert.equal(isValidIanaTimeZone("Invalid/Zone"), false);
      assert.equal(isValidIanaTimeZone("CustomTZ"), false);
      assert.equal(isValidIanaTimeZone(""), false);
    });
  });

  describe("zonedTimeToUtc", () => {
    it("converts midnight in UTC to UTC", () => {
      const d = zonedTimeToUtc(2026, 10, 20, 0, 0, 0, "UTC");
      assert.equal(d.toISOString(), "2026-10-20T00:00:00.000Z");
    });

    it("converts midnight in Asia/Calcutta (UTC+5:30) to previous day 18:30 UTC", () => {
      const d = zonedTimeToUtc(2026, 10, 20, 0, 0, 0, "Asia/Calcutta");
      assert.equal(d.toISOString(), "2026-10-19T18:30:00.000Z");
    });

    it("converts midnight in America/New_York (EDT UTC-4) to 04:00 UTC", () => {
      const d = zonedTimeToUtc(2026, 10, 20, 0, 0, 0, "America/New_York");
      assert.equal(d.toISOString(), "2026-10-20T04:00:00.000Z");
    });

    it("converts midday correctly", () => {
      const d = zonedTimeToUtc(2026, 10, 20, 14, 30, 0, "Asia/Calcutta");
      assert.equal(d.toISOString(), "2026-10-20T09:00:00.000Z");
    });
  });

  describe("parseIcs", () => {
    it("parses single timed events in UTC", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:single-1
DTSTART:20261020T100000Z
DTEND:20261020T120000Z
SUMMARY:Strategy Meeting
END:VEVENT
END:VCALENDAR`;

      const result = parseIcs({ icsContent: ics, calendarTz: "UTC" });
      assert.equal(result.intervals.length, 1);
      assert.equal(result.intervals[0].summary, "Strategy Meeting");
      assert.equal(result.intervals[0].isAllDay, false);
      assert.equal(
        new Date(result.intervals[0].startMs).toISOString(),
        "2026-10-20T10:00:00.000Z",
      );
      assert.equal(
        new Date(result.intervals[0].endMs).toISOString(),
        "2026-10-20T12:00:00.000Z",
      );
    });

    it("parses all-day events blocking the full calendar day in calendarTz", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:allday-1
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261021
SUMMARY:Company Holiday
END:VEVENT
END:VCALENDAR`;

      // In Asia/Calcutta (UTC+5:30), Oct 20 runs from Oct 19 18:30 UTC to Oct 20 18:30 UTC
      const result = parseIcs({ icsContent: ics, calendarTz: "Asia/Calcutta" });
      assert.equal(result.intervals.length, 1);
      assert.equal(result.intervals[0].summary, "Company Holiday");
      assert.equal(result.intervals[0].isAllDay, true);
      assert.equal(
        new Date(result.intervals[0].startMs).toISOString(),
        "2026-10-19T18:30:00.000Z",
      );
      assert.equal(
        new Date(result.intervals[0].endMs).toISOString(),
        "2026-10-20T18:30:00.000Z",
      );
    });

    it("filters out STATUS:CANCELLED and TRANSP:TRANSPARENT events", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:cancelled-1
STATUS:CANCELLED
DTSTART:20261020T100000Z
DTEND:20261020T120000Z
SUMMARY:Cancelled Meeting
END:VEVENT
BEGIN:VEVENT
UID:transp-1
TRANSP:TRANSPARENT
DTSTART:20261020T140000Z
DTEND:20261020T160000Z
SUMMARY:Free Time Reminder
END:VEVENT
BEGIN:VEVENT
UID:valid-1
DTSTART:20261020T180000Z
DTEND:20261020T190000Z
SUMMARY:Active Busy
END:VEVENT
END:VCALENDAR`;

      const result = parseIcs({ icsContent: ics, calendarTz: "UTC" });
      assert.equal(result.intervals.length, 1);
      assert.equal(result.intervals[0].summary, "Active Busy");
    });

    it("expands recurring events with RRULE and window bounds", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:recur-1
DTSTART:20261020T100000Z
DURATION:PT1H
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:Daily Standup
END:VEVENT
END:VCALENDAR`;

      const result = parseIcs({
        icsContent: ics,
        calendarTz: "UTC",
        windowStartMs: Date.parse("2026-10-21T00:00:00Z"),
        windowEndMs: Date.parse("2026-10-23T23:59:59Z"),
      });

      // Daily for 5 days: Oct 20, 21, 22, 23, 24
      // Clipped to [Oct 21, Oct 23]: Oct 21, 22, 23 should be included
      assert.equal(result.intervals.length, 3);
      assert.equal(
        new Date(result.intervals[0].startMs).toISOString(),
        "2026-10-21T10:00:00.000Z",
      );
      assert.equal(
        new Date(result.intervals[1].startMs).toISOString(),
        "2026-10-22T10:00:00.000Z",
      );
      assert.equal(
        new Date(result.intervals[2].startMs).toISOString(),
        "2026-10-23T10:00:00.000Z",
      );
    });

    it("handles recurrence exceptions (RECURRENCE-ID) properly", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:recur-ex-1
DTSTART:20261020T100000Z
DURATION:PT1H
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily Meeting
END:VEVENT
BEGIN:VEVENT
UID:recur-ex-1
RECURRENCE-ID:20261021T100000Z
DTSTART:20261021T150000Z
DURATION:PT1H
SUMMARY:Daily Meeting Moved
END:VEVENT
END:VCALENDAR`;

      const result = parseIcs({ icsContent: ics, calendarTz: "UTC" });
      assert.equal(result.intervals.length, 3);
      // Oct 20 at 10:00
      assert.equal(
        new Date(result.intervals[0].startMs).toISOString(),
        "2026-10-20T10:00:00.000Z",
      );
      // Oct 21 moved to 15:00
      assert.equal(
        new Date(result.intervals[1].startMs).toISOString(),
        "2026-10-21T15:00:00.000Z",
      );
      assert.equal(result.intervals[1].summary, "Daily Meeting Moved");
      // Oct 22 at 10:00
      assert.equal(
        new Date(result.intervals[2].startMs).toISOString(),
        "2026-10-22T10:00:00.000Z",
      );
    });

    it("parses all-features.ics fixture successfully", () => {
      const content = fs.readFileSync(
        path.join(fixturesDir, "all-features.ics"),
        "utf-8",
      );
      const result = parseIcs({
        icsContent: content,
        calendarTz: "Asia/Calcutta",
      });

      assert.ok(result.intervals.length >= 5);
      const summaries = result.intervals.map((i) => i.summary);
      assert.ok(summaries.includes("Full Day Off"));
      assert.ok(summaries.includes("Weekly Design Review"));
      assert.ok(summaries.includes("Weekly Design Review (Rescheduled)"));
      assert.ok(!summaries.includes("Cancelled Sync"));
      assert.ok(!summaries.includes("Optional Reminder"));
      assert.ok(summaries.includes("Custom Timezone Meeting"));
      assert.ok(summaries.includes("New York Call"));
      assert.ok(summaries.includes("Floating Time Event"));
    });

    it("throws descriptive error on malformed iCalendar data", () => {
      assert.throws(
        () => parseIcs({ icsContent: "NOT VALID ICS DATA", calendarTz: "UTC" }),
        /Failed to parse iCalendar data/,
      );
    });
  });
});
