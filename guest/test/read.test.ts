/**
 * Tests for indby-guest read command.
 *
 * Uses node:test and node:assert. Runs an in-process HTTP server on port 0
 * to serve fixtures — no Next dev server or internet needed.
 */
import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeInviteUrl, isNormalized, looksLikeToken } from "../src/lib/invite-url.js";
import type { NormalizedInviteUrl, InviteUrlError } from "../src/lib/invite-url.js";
import {
  formatInvite,
  formatTime,
  formatDateOnly,
  parseAction,
  formatCrossOriginWarning,
  getCrossOriginWarnings,
} from "../src/lib/format.js";
import { fetchInvite } from "../src/lib/client.js";
import type { FetchResult, FetchError } from "../src/lib/client.js";
import type { Invite } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "..", "test", "fixtures");

// ---------- helpers ----------

async function loadFixture(name: string): Promise<string> {
  return readFile(join(fixturesDir, name), "utf-8");
}

/** Narrow to NormalizedInviteUrl or fail the test. */
function expectNormalized(r: NormalizedInviteUrl | InviteUrlError): NormalizedInviteUrl {
  if (!isNormalized(r)) {
    assert.fail(`Expected normalized URL but got error: ${(r as InviteUrlError).error}`);
  }
  return r;
}

/** Narrow to InviteUrlError or fail the test. */
function expectUrlError(r: NormalizedInviteUrl | InviteUrlError): InviteUrlError {
  if (isNormalized(r)) {
    assert.fail(`Expected error but got normalized URL: ${r.jsonUrl}`);
  }
  return r;
}

/** Narrow to FetchResult (ok) or fail the test. */
function expectFetchOk(r: FetchResult | FetchError): FetchResult {
  if (!r.ok) {
    assert.fail(`Expected fetch OK but got error: ${r.message}`);
  }
  return r;
}

/** Narrow to FetchError or fail the test. */
function expectFetchError(r: FetchResult | FetchError): FetchError {
  if (r.ok) {
    assert.fail(`Expected fetch error but got OK`);
  }
  return r;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------- invite-url.ts (pure, no server) ----------

describe("normalizeInviteUrl", () => {
  it("normalises a bare invite URL to .json", () => {
    const r = expectNormalized(normalizeInviteUrl("http://localhost:3000/i/TESTTOKEN_abc123def456"));
    assert.equal(r.jsonUrl, "http://localhost:3000/i/TESTTOKEN_abc123def456.json");
    assert.equal(r.origin, "http://localhost:3000");
    assert.equal(r.token, "TESTTOKEN_abc123def456");
  });

  it("normalises a .json URL (idempotent)", () => {
    const r = expectNormalized(normalizeInviteUrl("http://localhost:3000/i/TESTTOKEN_abc123def456.json"));
    assert.equal(r.jsonUrl, "http://localhost:3000/i/TESTTOKEN_abc123def456.json");
  });

  it("strips trailing slash", () => {
    const r = expectNormalized(normalizeInviteUrl("http://localhost:3000/i/TESTTOKEN_abc123def456/"));
    assert.equal(r.jsonUrl, "http://localhost:3000/i/TESTTOKEN_abc123def456.json");
  });

  it("strips query and hash", () => {
    const r = expectNormalized(normalizeInviteUrl("http://localhost:3000/i/TESTTOKEN_abc123def456?foo=bar#baz"));
    assert.equal(r.jsonUrl, "http://localhost:3000/i/TESTTOKEN_abc123def456.json");
  });

  it("preserves https origin", () => {
    const r = expectNormalized(normalizeInviteUrl("https://indbyagent.com/i/TESTTOKEN_abc123def456"));
    assert.equal(r.origin, "https://indbyagent.com");
    assert.equal(r.jsonUrl, "https://indbyagent.com/i/TESTTOKEN_abc123def456.json");
  });

  it("rejects /j/ join link with specific message", () => {
    const r = expectUrlError(normalizeInviteUrl("http://localhost:3000/j/abc123"));
    assert.ok(r.error.includes("join link"));
    assert.ok(r.error.includes("not a personal invite"));
  });

  it("rejects /m/ meet link", () => {
    const r = expectUrlError(normalizeInviteUrl("http://localhost:3000/m/someone"));
    assert.ok(r.error.includes("meet link"));
  });

  it("rejects /v/ vendor link", () => {
    const r = expectUrlError(normalizeInviteUrl("http://localhost:3000/v/sometoken12345678901"));
    assert.ok(r.error.includes("vendor link"));
  });

  it("rejects non-/i/ paths", () => {
    const r = expectUrlError(normalizeInviteUrl("http://localhost:3000/api/something"));
    assert.ok(r.error.includes("does not match"));
  });

  it("rejects invalid token", () => {
    const r = expectUrlError(normalizeInviteUrl("http://localhost:3000/i/short"));
    assert.ok(r.error.includes("Token does not look valid"));
  });

  it("rejects non-http protocols", () => {
    const r = expectUrlError(normalizeInviteUrl("ftp://localhost/i/TESTTOKEN_abc123def456"));
    assert.ok(r.error.includes("http or https"));
  });

  it("rejects garbage input", () => {
    const r = expectUrlError(normalizeInviteUrl("not a url at all"));
    assert.ok(r.error.includes("Not a valid URL"));
  });
});

describe("looksLikeToken", () => {
  it("accepts valid tokens (20-40 base64url chars)", () => {
    assert.ok(looksLikeToken("TESTTOKEN_abc123def456")); // 22 chars
    assert.ok(looksLikeToken("a".repeat(20)));
    assert.ok(looksLikeToken("A-_z0".repeat(8))); // 40 chars
  });

  it("rejects short tokens", () => {
    assert.ok(!looksLikeToken("short"));
    assert.ok(!looksLikeToken("a".repeat(19)));
  });

  it("rejects long tokens", () => {
    assert.ok(!looksLikeToken("a".repeat(41)));
  });

  it("rejects tokens with invalid chars", () => {
    assert.ok(!looksLikeToken("a".repeat(19) + "!"));
    assert.ok(!looksLikeToken("a".repeat(19) + " "));
  });
});

// ---------- format.ts (pure, no server) ----------

describe("formatInvite", () => {
  let basicInvite: Invite;
  let locationInvite: Invite;
  let datesPollInvite: Invite;

  before(async () => {
    basicInvite = JSON.parse(await loadFixture("invite.json")) as Invite;
    locationInvite = JSON.parse(await loadFixture("invite-with-location.json")) as Invite;
    datesPollInvite = JSON.parse(await loadFixture("dates-invite.json")) as Invite;
  });

  it("includes the party title", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(output.includes("Maya's 6th Birthday"));
  });

  it("shows time in the party timezone, not the process TZ", () => {
    // 2026-10-20T18:30:00.000Z in Asia/Calcutta (UTC+5:30) is Oct 21, 12:00 AM.
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(output.includes("Asia/Calcutta"), `Expected Asia/Calcutta in: ${output}`);
    // Should show Oct 21 (the date in IST), not Oct 20 (the date in UTC).
    assert.ok(output.includes("21"), `Expected day 21 in: ${output}`);
    assert.ok(output.includes("12:00"), `Expected 12:00 in: ${output}`);
  });

  it("shows RSVP status", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(output.includes("pending"));
  });

  it("shows 'none open' for polls when absent", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(output.includes("none open"), `Expected 'none open' in: ${output}`);
  });

  it("shows guest name and party size", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(output.includes("leo"));
    assert.ok(output.includes("up to 1 person"));
  });

  it("shows actions", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(output.includes("rsvp (POST)"));
    assert.ok(output.includes("message_host (POST)"));
    assert.ok(output.includes("calendar (GET)"));
  });

  it("shows location when present", () => {
    const output = formatInvite(locationInvite, "http://localhost:3000");
    assert.ok(output.includes("123 Main St"));
  });

  it("omits location line when absent", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(!output.includes("Where:"));
  });

  it("shows ends_at when present", () => {
    const output = formatInvite(locationInvite, "http://localhost:3000");
    // ends_at is 2026-11-15T21:00:00.000Z in America/New_York = 4:00 PM
    assert.ok(output.includes("4:00 PM"), `Expected ends_at time in: ${output}`);
  });

  it("shows filled RSVP details", () => {
    const output = formatInvite(locationInvite, "http://localhost:3000");
    assert.ok(output.includes("yes"));
    assert.ok(output.includes("party size: 2"));
    assert.ok(output.includes("vegetarian"));
    assert.ok(output.includes("gluten-free"));
    assert.ok(output.includes("Looking forward to it!"));
    assert.ok(output.includes("agent"));
    assert.ok(output.includes("Claude"));
  });

  it("shows polls with date options formatted one per line, numbered, with party timezone name", () => {
    const output = formatInvite(datesPollInvite, "http://localhost:3000");
    assert.ok(output.includes("Which date works best for you?"), `Expected poll question in: ${output}`);
    assert.ok(output.includes("dates"), `Expected poll kind in: ${output}`);
    assert.ok(output.includes("231ad161-4501-4161-8902-6da99c0f7a5b"), `Expected poll id in: ${output}`);
    assert.ok(output.includes("    Options:\n      1. "), `Expected numbered option 1 on its own line in: ${output}`);
    assert.ok(output.includes("\n      2. "), `Expected numbered option 2 on its own line in: ${output}`);
    assert.ok(output.includes("\n      3. "), `Expected numbered option 3 on its own line in: ${output}`);
    assert.ok(output.includes("(Asia/Calcutta)"), `Expected party timezone name in poll options: ${output}`);
    assert.ok(output.includes("Oct"), `Expected formatted date month in: ${output}`);
    assert.ok(output.includes("Not answered yet"), `Expected unanswered status in: ${output}`);
  });

  it("shows Date TBD when starts_at is absent", () => {
    const output = formatInvite(datesPollInvite, "http://localhost:3000");
    assert.ok(output.includes("TBD"), `Expected TBD in: ${output}`);
  });

  it("shows server hint when present", () => {
    const output = formatInvite(datesPollInvite, "http://localhost:3000");
    assert.ok(output.includes("Hint:"), `Expected Hint: line in: ${output}`);
    assert.ok(
      output.includes("The date isn't set yet. Rank the dates you can make"),
      `Expected hint text in: ${output}`,
    );
  });

  it("warns on cross-origin action URLs", () => {
    // The fixture actions point to localhost:3000 but we say the invite origin is different.
    const output = formatInvite(basicInvite, "http://example.com");
    assert.ok(output.includes("⚠"), `Expected cross-origin warning in: ${output}`);
    assert.ok(
      output.includes(
        "Server action URLs use http://localhost:3000, not http://example.com (rsvp, message_host, calendar)",
      ),
      `Expected specific warning text in: ${output}`,
    );
  });

  it("no cross-origin warning when origins match", () => {
    const output = formatInvite(basicInvite, "http://localhost:3000");
    assert.ok(!output.includes("⚠"), `Unexpected cross-origin warning in: ${output}`);
  });
});

describe("formatTime", () => {
  it("formats in the given timezone", () => {
    const [formatted, tz] = formatTime("2026-10-20T18:30:00.000Z", "Asia/Calcutta");
    assert.equal(tz, "Asia/Calcutta");
    assert.ok(formatted.includes("21"), `Expected day 21 in: ${formatted}`);
  });

  it("falls back to UTC for undefined timezone", () => {
    const [formatted, tz] = formatTime("2026-10-20T18:30:00.000Z", undefined);
    assert.equal(tz, "UTC");
    assert.ok(formatted.includes("20"), `Expected day 20 (UTC) in: ${formatted}`);
  });

  it("falls back to UTC for invalid timezone", () => {
    const [, tz] = formatTime("2026-10-20T18:30:00.000Z", "Not/A/Zone");
    assert.equal(tz, "UTC");
  });
});

describe("parseAction", () => {
  it("parses METHOD URL strings", () => {
    const a = parseAction("rsvp", "POST http://localhost:3000/i/TOKEN/rsvp");
    assert.equal(a.method, "POST");
    assert.equal(a.url, "http://localhost:3000/i/TOKEN/rsvp");
    assert.equal(a.name, "rsvp");
  });

  it("defaults to GET when no space", () => {
    const a = parseAction("cal", "http://localhost:3000/i/TOKEN.ics");
    assert.equal(a.method, "GET");
    assert.equal(a.url, "http://localhost:3000/i/TOKEN.ics");
  });
});

describe("formatCrossOriginWarning", () => {
  it("formats a single-line warning with origins and action names", () => {
    const warning = formatCrossOriginWarning("http://localhost:3000", "http://example.com", [
      "rsvp",
      "calendar",
    ]);
    assert.equal(
      warning,
      "⚠ Server action URLs use http://localhost:3000, not http://example.com (rsvp, calendar)",
    );
  });
});

describe("getCrossOriginWarnings", () => {
  it("returns collapsed warning line when origins differ", () => {
    const warnings = getCrossOriginWarnings(
      {
        indbyagent: "0.1",
        party: { title: "Test" },
        guest: { name: "Guest", party_size_max: 1 },
        rsvp: { status: "pending" },
        actions: {
          rsvp: "POST http://localhost:3000/i/T/rsvp",
          message_host: "POST http://localhost:3000/i/T/message",
        },
        schema: {},
      },
      "http://example.com",
    );
    assert.equal(warnings.length, 1);
    assert.equal(
      warnings[0],
      "⚠ Server action URLs use http://localhost:3000, not http://example.com (rsvp, message_host)",
    );
  });

  it("returns empty array when origins match", () => {
    const warnings = getCrossOriginWarnings(
      {
        indbyagent: "0.1",
        party: { title: "Test" },
        guest: { name: "Guest", party_size_max: 1 },
        rsvp: { status: "pending" },
        actions: {
          rsvp: "POST http://localhost:3000/i/T/rsvp",
        },
        schema: {},
      },
      "http://localhost:3000",
    );
    assert.deepEqual(warnings, []);
  });
});

// ---------- client.ts + server (integration) ----------

describe("fetchInvite (with server)", () => {
  let inviteFixture: string;

  before(async () => {
    inviteFixture = await loadFixture("invite.json");
  });

  it("fetches and parses a valid invite", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(inviteFixture);
    });
    try {
      const result = expectFetchOk(await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`));
      assert.equal(result.invite.party.title, "Maya's 6th Birthday");
      assert.equal(result.invite.rsvp.status, "pending");
    } finally {
      await close();
    }
  });

  it("handles 404 with JSON error body", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    try {
      const result = expectFetchError(await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`));
      assert.equal(result.message, "not found");
    } finally {
      await close();
    }
  });

  it("handles non-JSON body", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>Not JSON</body></html>");
    });
    try {
      const result = expectFetchError(await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`));
      assert.ok(result.message.includes("Expected JSON"));
    } finally {
      await close();
    }
  });

  it("handles connection refused", async () => {
    // Connect to a port that nothing is listening on.
    const result = expectFetchError(
      await fetchInvite("http://127.0.0.1:1/i/TESTTOKEN_abc123def456.json"),
    );
    assert.ok(
      result.message.includes("error") || result.message.includes("Error") || result.message.includes("refused"),
      `Expected error message, got: ${result.message}`,
    );
  });

  it("rejects a response with no guest object", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ party: { title: "test" } }));
    });
    try {
      const result = expectFetchError(await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`));
      assert.ok(result.message.includes("does not look like a personal invite"));
    } finally {
      await close();
    }
  });

  it("rejects a response with no rsvp action", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ guest: { name: "x" }, actions: {} }));
    });
    try {
      const result = expectFetchError(await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`));
      assert.ok(result.message.includes("does not look like a personal invite"));
    } finally {
      await close();
    }
  });

  it("returns raw JSON for --json passthrough", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(inviteFixture);
    });
    try {
      const result = expectFetchOk(await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`));
      // raw should be the original JSON string.
      const reparsed = JSON.parse(result.raw);
      assert.equal(reparsed.party.title, "Maya's 6th Birthday");
    } finally {
      await close();
    }
  });

  it("sends correct headers", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    let receivedMethod = "";
    const { url, close } = await startServer((req, res) => {
      receivedHeaders = req.headers;
      receivedMethod = req.method ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(inviteFixture);
    });
    try {
      await fetchInvite(`${url}/i/TESTTOKEN_abc123def456.json`);
      assert.equal(receivedMethod, "GET");
      assert.ok(receivedHeaders.accept?.includes("application/json"));
      assert.ok(receivedHeaders["user-agent"]?.includes("indby-guest/0.1"));
    } finally {
      await close();
    }
  });
});

// ---------- timezone correctness ----------

describe("timezone correctness", () => {
  it("shows Asia/Calcutta local time regardless of process TZ", async () => {
    // Even if we're in America/Los_Angeles, the output should show IST times.
    // This test verifies that formatInvite uses the party timezone, not process.env.TZ.
    const invite = JSON.parse(await loadFixture("invite.json")) as Invite;
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const output = formatInvite(invite, "http://localhost:3000");
      // 2026-10-20T18:30:00.000Z in Asia/Calcutta = Oct 21, 12:00 AM IST
      assert.ok(output.includes("21"), `Expected day 21 (IST) not affected by TZ=LA, got: ${output}`);
      assert.ok(output.includes("12:00"), `Expected 12:00 (IST) not affected by TZ=LA, got: ${output}`);
      assert.ok(output.includes("Asia/Calcutta"), `Expected timezone label in: ${output}`);
    } finally {
      if (originalTZ !== undefined) {
        process.env.TZ = originalTZ;
      } else {
        delete process.env.TZ;
      }
    }
  });
});

// ---------- rsvp_by: the date-only contract ----------

describe("rsvp_by is a bare calendar date, not an instant", () => {
  // The server only ever accepts rsvp_by as YYYY-MM-DD (src/lib/host.ts), so this
  // field must never be moved through a timezone.
  //
  // Regression: it used to be run through formatTime(), which parses a bare date
  // as UTC midnight. In any timezone behind UTC that printed the *previous* day
  // plus a clock time ("Tue, Oct 20, 2026, 5:00 PM PDT" for a Oct 21 deadline),
  // i.e. the one number a guest acts on, wrong by a day, on every command.
  const DEADLINE = "2026-10-21"; // a Wednesday
  const EXPECTED = "RSVP by: Wed, Oct 21, 2026";

  function rsvpByLine(output: string): string {
    const line = output.split("\n").find((l) => l.startsWith("RSVP by:"));
    assert.ok(line, `Expected an "RSVP by:" line in:\n${output}`);
    return line;
  }

  function inviteFor(timezone: string, rsvp_by: string): Invite {
    return {
      indbyagent: "0.1",
      party: { title: "Deadline Party", timezone, rsvp_by },
      guest: { name: "leo", party_size_max: 1 },
      rsvp: { status: "pending" },
      actions: { rsvp: "POST http://localhost:3000/i/TESTTOKEN_abc123def456/rsvp" },
      schema: {},
    };
  }

  it("reads the server's own document without shifting the deadline", async () => {
    // Shape captured from the real server: a bare date, US party timezone.
    const invite = JSON.parse(await loadFixture("invite-us-deadline.json")) as Invite;
    assert.equal(rsvpByLine(formatInvite(invite, "http://localhost:3000")), EXPECTED);
  });

  // Every timezone where the old instant-based formatting printed the day before.
  // America/Los_Angeles is the server's own default party timezone.
  for (const tz of [
    "America/Los_Angeles",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Anchorage",
    "Pacific/Honolulu",
  ]) {
    it(`does not move ${DEADLINE} a day back in ${tz}`, () => {
      const line = rsvpByLine(formatInvite(inviteFor(tz, DEADLINE), "http://localhost:3000"));
      assert.equal(line, EXPECTED, `Wrong deadline for ${tz}`);
      assert.ok(!line.includes("Oct 20"), `Printed the previous day in ${tz}: ${line}`);
      assert.ok(
        !/\d{1,2}:\d{2}/.test(line),
        `A calendar date must not gain a clock time in ${tz}: ${line}`,
      );
    });
  }

  it("is unchanged for UTC and timezones east of it", () => {
    for (const tz of ["UTC", "Asia/Calcutta", "Asia/Tokyo", "Australia/Sydney"]) {
      assert.equal(
        rsvpByLine(formatInvite(inviteFor(tz, DEADLINE), "http://localhost:3000")),
        EXPECTED,
        `Wrong deadline for ${tz}`,
      );
    }
  });

  it("rejects the exact output the buggy version produced", () => {
    const line = rsvpByLine(
      formatInvite(inviteFor("America/Los_Angeles", DEADLINE), "http://localhost:3000"),
    );
    assert.ok(
      !line.includes("Tue, Oct 20, 2026, 5:00 PM PDT"),
      `The pre-fix rendering came back: ${line}`,
    );
  });

  it("omits the line entirely when the host set no deadline", () => {
    const invite = inviteFor("America/Los_Angeles", DEADLINE);
    delete invite.party.rsvp_by;
    assert.ok(!formatInvite(invite, "http://localhost:3000").includes("RSVP by:"));
  });
});

describe("formatDateOnly", () => {
  it("keeps the calendar day for a bare date in every timezone", () => {
    for (const tz of [
      "America/Los_Angeles",
      "America/New_York",
      "Pacific/Honolulu",
      "Asia/Calcutta",
      "UTC",
    ]) {
      assert.equal(formatDateOnly("2026-10-21", tz), "Wed, Oct 21, 2026", `Wrong for ${tz}`);
    }
  });

  it("falls back to the party timezone for a full ISO instant", () => {
    // 2026-10-21T23:00:00.000Z is Oct 21, 4:00 PM in America/Los_Angeles.
    const formatted = formatDateOnly("2026-10-21T23:00:00.000Z", "America/Los_Angeles");
    assert.ok(formatted.includes("Oct 21"), `Expected Oct 21 in: ${formatted}`);
    assert.ok(formatted.includes("4:00"), `Expected 4:00 PM in: ${formatted}`);
  });

  it("never invents a date the host did not write", () => {
    // "2026-02-30" passes the server's regex; Date would silently roll it to Mar 2.
    assert.equal(formatDateOnly("2026-02-30", "America/Los_Angeles"), "2026-02-30");
  });

  it("handles a leap day", () => {
    assert.equal(formatDateOnly("2028-02-29", "America/Los_Angeles"), "Tue, Feb 29, 2028");
  });
});

// ---------- end-to-end with server ----------

describe("read command end-to-end", () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  let inviteFixture: string;

  before(async () => {
    inviteFixture = await loadFixture("invite.json");
    const s = await startServer((req, res) => {
      const url = req.url ?? "";
      if (url.includes("TESTTOKEN_abc123def456.json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(inviteFixture);
      } else if (url.includes("NOTFOUND_token_1234567890.json")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
      }
    });
    serverUrl = s.url;
    closeServer = s.close;
  });

  after(async () => {
    await closeServer();
  });

  it("read command produces expected summary", async () => {
    const { readCommand } = await import("../src/commands/read.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await readCommand([`${serverUrl}/i/TESTTOKEN_abc123def456`]);
      assert.equal(code, 0);
      const output = logs.join("\n");
      assert.ok(output.includes("Maya's 6th Birthday"));
      assert.ok(output.includes("pending"));
      assert.ok(output.includes("leo"));
    } finally {
      console.log = origLog;
    }
  });

  it("read --json prints raw JSON", async () => {
    const { readCommand } = await import("../src/commands/read.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await readCommand([`${serverUrl}/i/TESTTOKEN_abc123def456`, "--json"]);
      assert.equal(code, 0);
      const output = logs.join("\n");
      const parsed = JSON.parse(output);
      assert.equal(parsed.party.title, "Maya's 6th Birthday");
    } finally {
      console.log = origLog;
    }
  });

  it("read rejects /j/ link with join message", async () => {
    const { readCommand } = await import("../src/commands/read.js");
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    try {
      const code = await readCommand([`${serverUrl}/j/somecode`]);
      assert.equal(code, 2);
      const output = errs.join("\n");
      assert.ok(output.includes("join link"), `Expected join message in: ${output}`);
    } finally {
      console.error = origErr;
    }
  });

  it("read reports 404 error from server", async () => {
    const { readCommand } = await import("../src/commands/read.js");
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    try {
      const code = await readCommand([`${serverUrl}/i/NOTFOUND_token_1234567890`]);
      assert.equal(code, 1);
      const output = errs.join("\n");
      assert.ok(
        output.includes("Invite not found (the token in the URL may be wrong or revoked)"),
        `Expected 'Invite not found (the token in the URL may be wrong or revoked)' in: ${output}`,
      );
    } finally {
      console.error = origErr;
    }
  });

  it("read with missing URL returns exit code 2", async () => {
    const { readCommand } = await import("../src/commands/read.js");
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    try {
      const code = await readCommand([]);
      assert.equal(code, 2);
    } finally {
      console.error = origErr;
    }
  });

  it("read --timeout times out with compiling message when server is slow", async () => {
    const slow = await startServer((_req, _res) => {
      // Never respond so request times out
    });
    const { readCommand } = await import("../src/commands/read.js");
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    try {
      const code = await readCommand([
        `${slow.url}/i/TESTTOKEN_abc123def456`,
        "--timeout",
        "0.05",
      ]);
      assert.equal(code, 1);
      const output = errs.join("\n");
      assert.ok(output.includes("Request timed out"), `Expected timeout message in: ${output}`);
      assert.ok(
        output.includes("starting or compiling"),
        `Expected starting or compiling hint in: ${output}`,
      );
    } finally {
      console.error = origErr;
      await slow.close();
    }
  });
});
