/**
 * Tests for ranking.ts: clash evaluation, option ordering, truncation, equality checks.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import {
  evaluatePollOptions,
  rankingMatches,
  describeClash,
} from "../src/lib/ranking.js";
import type { BusyInterval } from "../src/lib/ics.js";

describe("ranking library", () => {
  describe("evaluatePollOptions", () => {
    it("drops clashing options and names event and times in party timezone", () => {
      const busy: BusyInterval[] = [
        {
          startMs: Date.parse("2026-10-20T10:30:00Z"),
          endMs: Date.parse("2026-10-20T11:30:00Z"),
          summary: "Dentist",
          isAllDay: false,
        },
      ];

      // Option is 10:00 UTC for 120 mins -> [10:00, 12:00] UTC. Clashes with [10:30, 11:30]!
      const options = ["2026-10-20T10:00:00.000Z", "2026-10-21T10:00:00.000Z"];
      const result = evaluatePollOptions(options, 120, "Asia/Calcutta", busy);

      assert.equal(result.kept.length, 1);
      assert.equal(result.kept[0], "2026-10-21T10:00:00.000Z");
      assert.equal(result.dropped.length, 1);
      assert.equal(result.dropped[0].option, "2026-10-20T10:00:00.000Z");
      assert.ok(result.dropped[0].reason.includes("Dentist"));
      // 10:30 UTC is 16:00 IST (4:00 PM) in Asia/Calcutta
      assert.ok(result.dropped[0].reason.includes("4:00 PM"));
    });

    it("does NOT clash on touching boundaries", () => {
      const busy: BusyInterval[] = [
        // Event ends right as option starts: [08:00, 10:00] UTC
        {
          startMs: Date.parse("2026-10-20T08:00:00Z"),
          endMs: Date.parse("2026-10-20T10:00:00Z"),
          summary: "Prior Standup",
          isAllDay: false,
        },
        // Event starts right as option ends: [12:00, 14:00] UTC
        {
          startMs: Date.parse("2026-10-20T12:00:00Z"),
          endMs: Date.parse("2026-10-20T14:00:00Z"),
          summary: "Subsequent Review",
          isAllDay: false,
        },
      ];

      // Option is [10:00, 12:00] UTC
      const options = ["2026-10-20T10:00:00.000Z"];
      const result = evaluatePollOptions(options, 120, "UTC", busy);

      assert.equal(result.kept.length, 1);
      assert.equal(result.dropped.length, 0);
    });

    it("ranks kept options soonest first regardless of input order", () => {
      const options = [
        "2026-10-25T14:00:00.000Z",
        "2026-10-21T10:00:00.000Z",
        "2026-10-23T18:00:00.000Z",
      ];
      const result = evaluatePollOptions(options, 120, "UTC", []);

      assert.deepEqual(result.kept, [
        "2026-10-21T10:00:00.000Z",
        "2026-10-23T18:00:00.000Z",
        "2026-10-25T14:00:00.000Z",
      ]);
      assert.equal(result.truncated, false);
    });

    it("truncates kept options to 8 if more than 8 survive", () => {
      const options = [
        "2026-10-20T10:00:00.000Z",
        "2026-10-21T10:00:00.000Z",
        "2026-10-22T10:00:00.000Z",
        "2026-10-23T10:00:00.000Z",
        "2026-10-24T10:00:00.000Z",
        "2026-10-25T10:00:00.000Z",
        "2026-10-26T10:00:00.000Z",
        "2026-10-27T10:00:00.000Z",
        "2026-10-28T10:00:00.000Z",
        "2026-10-29T10:00:00.000Z",
      ];

      const result = evaluatePollOptions(options, 120, "UTC", []);
      assert.equal(result.totalKept, 10);
      assert.equal(result.truncated, true);
      assert.equal(result.kept.length, 8);
      assert.equal(result.kept[0], "2026-10-20T10:00:00.000Z");
      assert.equal(result.kept[7], "2026-10-27T10:00:00.000Z");
    });

    it("returns empty kept list if all options clash", () => {
      const busy: BusyInterval[] = [
        {
          startMs: Date.parse("2026-10-20T00:00:00Z"),
          endMs: Date.parse("2026-10-20T23:59:59Z"),
          summary: "All Day Block",
          isAllDay: true,
        },
      ];
      const options = ["2026-10-20T10:00:00.000Z", "2026-10-20T14:00:00.000Z"];
      const result = evaluatePollOptions(options, 120, "UTC", busy);

      assert.equal(result.kept.length, 0);
      assert.equal(result.dropped.length, 2);
    });

    it("formats all-day clash reasons as \"clashes with all-day event 'Holiday' on Fri 16 Oct\" without clock time", () => {
      // 2026-10-16 midnight in Asia/Calcutta is 2026-10-15T18:30:00.000Z
      const busy: BusyInterval[] = [
        {
          startMs: Date.parse("2026-10-15T18:30:00.000Z"),
          endMs: Date.parse("2026-10-16T18:30:00.000Z"),
          summary: "Holiday",
          isAllDay: true,
        },
      ];
      const options = ["2026-10-16T09:35:00.000Z"];
      const result = evaluatePollOptions(options, 120, "Asia/Calcutta", busy);

      assert.equal(result.dropped.length, 1);
      assert.equal(
        result.dropped[0].reason,
        "clashes with all-day event 'Holiday' on Fri 16 Oct",
      );
    });
  });

  describe("rankingMatches", () => {
    it("returns true for matching rankings", () => {
      assert.equal(
        rankingMatches(
          ["2026-10-20T10:00:00.000Z", "2026-10-21T10:00:00.000Z"],
          ["2026-10-20T10:00:00.000Z", "2026-10-21T10:00:00.000Z"],
        ),
        true,
      );
    });

    it("returns true for instant equality with different string format", () => {
      assert.equal(
        rankingMatches(
          ["2026-10-20T10:00:00Z"],
          ["2026-10-20T10:00:00.000Z"],
        ),
        true,
      );
    });

    it("returns false if order differs", () => {
      assert.equal(
        rankingMatches(
          ["2026-10-21T10:00:00.000Z", "2026-10-20T10:00:00.000Z"],
          ["2026-10-20T10:00:00.000Z", "2026-10-21T10:00:00.000Z"],
        ),
        false,
      );
    });

    it("returns false if lengths differ or undefined", () => {
      assert.equal(
        rankingMatches(
          ["2026-10-20T10:00:00.000Z"],
          ["2026-10-20T10:00:00.000Z", "2026-10-21T10:00:00.000Z"],
        ),
        false,
      );
      assert.equal(
        rankingMatches(undefined, ["2026-10-20T10:00:00.000Z"]),
        false,
      );
    });
  });
});
