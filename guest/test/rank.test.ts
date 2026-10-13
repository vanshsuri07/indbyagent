/**
 * Tests for indby-guest rank command.
 *
 * Uses node:test and node:assert. Runs an in-process HTTP fake server
 * with stateful poll ranking semantics (idempotency tracking, dates poll validation).
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { rankCommand } from "../src/commands/rank.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "..", "test", "fixtures");
const meIcsPath = path.join(fixturesDir, "me.ics");
const clashIcsPath = path.join(fixturesDir, "clash.ics");

interface FakePoll {
  id: string;
  kind: "dates" | "preference";
  q: string;
  options: string[];
  timezone?: string;
  your_ranking?: string[];
}

interface FakeServerState {
  token: string;
  polls: FakePoll[];
  postCount: number;
  usedKeys: Set<string>;
  lastPostBody?: Record<string, unknown>;
  lastPostHeaders?: http.IncomingHttpHeaders;
  actionRankOrigin?: string;
}

function createFakeServer(options: {
  token?: string;
  polls?: FakePoll[];
  actionRankOrigin?: string;
} = {}): Promise<{
  url: string;
  state: FakeServerState;
  close: () => Promise<void>;
}> {
  const token = options.token ?? "TESTTOKEN_abc123def456_27ch";
  const defaultPolls: FakePoll[] = [
    {
      id: "231ad161-4501-4161-8902-6da99c0f7a5b",
      kind: "dates",
      q: "Which date works best for you?",
      options: [
        "2026-10-16T15:41:00.000Z",
        "2026-10-22T15:41:00.000Z",
        "2026-10-29T15:42:00.000Z",
      ],
      timezone: "Asia/Calcutta",
    },
  ];

  const state: FakeServerState = {
    token,
    polls: options.polls ?? defaultPolls,
    postCount: 0,
    usedKeys: new Set<string>(),
    actionRankOrigin: options.actionRankOrigin,
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;

      const buildInvite = (origin: string) => {
        const actionOrigin = state.actionRankOrigin ?? origin;
        return {
          indbyagent: "0.1",
          party: {
            title: "Maya's 1st Birthday",
            timezone: "Asia/Calcutta",
            location: "Carnival",
            date: "tbd",
          },
          guest: {
            name: "leo",
            party_size_max: 1,
          },
          rsvp: {
            status: "pending",
          },
          polls: state.polls,
          actions: {
            rsvp: `POST ${actionOrigin}/i/${state.token}/rsvp`,
            rank_poll: `POST ${actionOrigin}/i/${state.token}/polls/{id}/rank`,
            message_host: `POST ${actionOrigin}/i/${state.token}/message`,
          },
          schema: {
            rank_poll: {
              ranking: "options you can make, best first (omit ones you can't)",
              note: "string",
              by: "same",
            },
          },
          hint: "The date isn't set yet. Rank the dates you can make.",
        };
      };

      if (req.method === "GET" && pathname === `/i/${state.token}.json`) {
        const origin = `http://${req.headers.host}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildInvite(origin)));
        return;
      }

      const rankMatch = pathname.match(
        new RegExp(`^/i/${state.token}/polls/([^/]+)/rank$`),
      );
      if (req.method === "POST" && rankMatch) {
        const pollId = rankMatch[1];
        state.postCount++;
        state.lastPostHeaders = req.headers;

        let bodyRaw = "";
        req.on("data", (chunk) => {
          bodyRaw += chunk;
        });
        req.on("end", () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(bodyRaw);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "body must be JSON" }));
            return;
          }

          state.lastPostBody = body;

          const poll = state.polls.find((p) => p.id === pollId);
          if (!poll) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "poll not open for this guest (check the id)" }),
            );
            return;
          }

          const idemKey = req.headers["idempotency-key"] as string | undefined;
          if (idemKey && state.usedKeys.has(idemKey)) {
            // Idempotency replay: return current invite without updating state
            const origin = `http://${req.headers.host}`;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(buildInvite(origin)));
            return;
          }

          if (idemKey) {
            state.usedKeys.add(idemKey);
          }

          // Update poll ranking
          poll.your_ranking = body.ranking as string[];

          const origin = `http://${req.headers.host}`;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildInvite(origin)));
        });
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        state,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function captureOutput(): {
  getLogs: () => string;
  getErrors: () => string;
  restore: () => void;
} {
  const origLog = console.log;
  const origError = console.error;
  let logs = "";
  let errors = "";

  console.log = (...args: unknown[]) => {
    logs += args.map((a) => String(a)).join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    errors += args.map((a) => String(a)).join(" ") + "\n";
  };

  return {
    getLogs: () => logs,
    getErrors: () => errors,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

describe("indby-guest rank command", () => {
  it("shows help with --help", async () => {
    const out = captureOutput();
    try {
      const code = await rankCommand(["--help"]);
      assert.equal(code, 0);
      assert.ok(out.getLogs().includes("Usage: indby-guest rank"));
      assert.ok(out.getLogs().includes("--ics <file>"));
    } finally {
      out.restore();
    }
  });

  it("exits with 2 if invite URL is missing", async () => {
    const out = captureOutput();
    try {
      const code = await rankCommand(["--ics", meIcsPath]);
      assert.equal(code, 2);
      assert.ok(out.getErrors().includes("Missing invite URL"));
    } finally {
      out.restore();
    }
  });

  it("exits with 2 if --ics is missing", async () => {
    const out = captureOutput();
    try {
      const code = await rankCommand(["http://localhost:3000/i/TESTTOKEN_abc123def456_27ch"]);
      assert.equal(code, 2);
      assert.ok(out.getErrors().includes("Missing required option --ics"));
    } finally {
      out.restore();
    }
  });

  it("exits with 2 if .ics file does not exist with plain-words message", async () => {
    const out = captureOutput();
    try {
      const code = await rankCommand([
        "http://localhost:3000/i/TESTTOKEN_abc123def456_27ch",
        "--ics",
        "./does-not-exist.ics",
      ]);
      assert.equal(code, 2);
      assert.ok(
        out.getErrors().includes("Cannot read calendar file ./does-not-exist.ics: not found"),
        `Expected plain-words file error in: ${out.getErrors()}`,
      );
      assert.ok(!out.getErrors().includes("ENOENT"));
    } finally {
      out.restore();
    }
  });

  it("exits with 2 if --duration is invalid", async () => {
    const out = captureOutput();
    try {
      const code = await rankCommand([
        "http://localhost:3000/i/TESTTOKEN_abc123def456_27ch",
        "--ics",
        meIcsPath,
        "--duration",
        "invalid",
      ]);
      assert.equal(code, 2);
      assert.ok(out.getErrors().includes("Invalid --duration"));
    } finally {
      out.restore();
    }
  });

  it("exits with 2 if --calendar-tz is invalid", async () => {
    const out = captureOutput();
    try {
      const code = await rankCommand([
        "http://localhost:3000/i/TESTTOKEN_abc123def456_27ch",
        "--ics",
        meIcsPath,
        "--calendar-tz",
        "Invalid/Timezone",
      ]);
      assert.equal(code, 2);
      assert.ok(out.getErrors().includes("Invalid --calendar-tz"));
    } finally {
      out.restore();
    }
  });

  it("exits with 1 when invite has no dates poll", async () => {
    const server = await createFakeServer({
      polls: [
        {
          id: "pref-1",
          kind: "preference",
          q: "Food choice?",
          options: ["Pizza", "Tacos"],
        },
      ],
    });
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
      ]);
      assert.equal(code, 1);
      assert.ok(out.getErrors().includes("No dates poll open for this invite"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("exits with 1 when multiple dates polls exist and --poll is omitted", async () => {
    const server = await createFakeServer({
      polls: [
        {
          id: "poll-1",
          kind: "dates",
          q: "Round 1 dates?",
          options: ["2026-10-20T10:00:00Z"],
        },
        {
          id: "poll-2",
          kind: "dates",
          q: "Round 2 dates?",
          options: ["2026-10-22T10:00:00Z"],
        },
      ],
    });
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
      ]);
      assert.equal(code, 1);
      assert.ok(out.getErrors().includes("Multiple dates polls open"));
      assert.ok(out.getErrors().includes("poll-1"));
      assert.ok(out.getErrors().includes("poll-2"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("exits with 2 on unknown --poll <id> and lists valid poll ids with their questions", async () => {
    const server = await createFakeServer({
      polls: [
        {
          id: "poll-1",
          kind: "dates",
          q: "Round 1 dates?",
          options: ["2026-10-20T10:00:00Z"],
        },
        {
          id: "poll-2",
          kind: "dates",
          q: "Round 2 dates?",
          options: ["2026-10-22T10:00:00Z"],
        },
      ],
    });
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--poll",
        "nonexistent-poll-id",
      ]);
      assert.equal(code, 2);
      const err = out.getErrors();
      assert.ok(err.includes("nonexistent-poll-id"));
      assert.ok(err.includes("poll-1: Round 1 dates?"));
      assert.ok(err.includes("poll-2: Round 2 dates?"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("exits with 1 when all options clash (using clash.ics)", async () => {
    const server = await createFakeServer();
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        clashIcsPath,
      ]);
      assert.equal(code, 1);
      assert.equal(server.state.postCount, 0); // Sent nothing!
      assert.ok(out.getLogs().includes("Calendar:"));
      assert.ok(out.getLogs().includes("Dropped:"));
      assert.ok(out.getLogs().includes("Ranking:  none"));
      assert.ok(out.getErrors().includes("All options clash with existing events"));
      assert.ok(out.getErrors().includes("POST /i/<token>/message"));
      assert.ok(
        !out.getErrors().includes("Doctor Appointment"),
        "Reasons must not be repeated a second time in error output",
      );
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("dry run computes ranking and does not POST", async () => {
    const server = await createFakeServer();
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--dry-run",
      ]);
      assert.equal(code, 0);
      assert.equal(server.state.postCount, 0); // No request made!
      const logs = out.getLogs();
      assert.ok(logs.includes("Calendar:"));
      assert.ok(logs.includes("events checked"));
      assert.ok(logs.includes("Dropped:"));
      assert.ok(logs.includes("Doctor Appointment"));
      assert.ok(logs.includes("Ranking:  1."));
      assert.ok(logs.includes("(Asia/Calcutta)"));
      assert.ok(logs.includes("Dry run: would POST to"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("prints a warning line when the calendar parses to zero events", async () => {
    const server = await createFakeServer();
    const emptyIcsPath = path.join(os.tmpdir(), `indby-empty-${Date.now()}.ics`);
    fs.writeFileSync(
      emptyIcsPath,
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nEND:VCALENDAR\r\n",
      "utf-8",
    );
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        emptyIcsPath,
        "--dry-run",
      ]);
      assert.equal(code, 0);
      const logs = out.getLogs();
      assert.ok(
        logs.includes("(0 events checked, 0 recurring expanded, 0 warnings)"),
        `Expected 0 events summary in: ${logs}`,
      );
      assert.ok(
        logs.includes("Warning:") && logs.includes("nothing parsed"),
        `Expected zero-events warning line in: ${logs}`,
      );
      assert.ok(logs.includes("Dropped:  none"));
      assert.ok(logs.includes("Ranking:  1."));
    } finally {
      out.restore();
      fs.rmSync(emptyIcsPath, { force: true });
      await server.close();
    }
  });

  it("submits ranking successfully, drops clashing option, preserves touching boundary, and derives idempotency key", async () => {
    const server = await createFakeServer();
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--note",
        "Available on either date",
      ]);
      assert.equal(code, 0);
      assert.equal(server.state.postCount, 1);

      // Verify request body
      assert.deepEqual(server.state.lastPostBody?.ranking, [
        "2026-10-22T15:41:00.000Z",
        "2026-10-29T15:42:00.000Z",
      ]);
      assert.equal(server.state.lastPostBody?.note, "Available on either date");
      assert.deepEqual(server.state.lastPostBody?.by, {
        kind: "agent",
        name: "indby-guest",
      });

      // Verify Idempotency-Key header is 32 hex chars
      const key = server.state.lastPostHeaders?.["idempotency-key"] as string;
      assert.match(key, /^[0-9a-f]{32}$/);

      // Output should mention Calendar, Dropped, Ranking
      const logs = out.getLogs();
      assert.ok(logs.includes("Calendar:"));
      assert.ok(logs.includes("Dropped:"));
      assert.ok(logs.includes("Doctor Appointment"));
      assert.ok(logs.includes("Ranking:  1."));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("already-set check sends nothing and exits 0", async () => {
    const server = await createFakeServer({
      polls: [
        {
          id: "231ad161-4501-4161-8902-6da99c0f7a5b",
          kind: "dates",
          q: "Which date works best for you?",
          options: [
            "2026-10-16T15:41:00.000Z",
            "2026-10-22T15:41:00.000Z",
            "2026-10-29T15:42:00.000Z",
          ],
          timezone: "Asia/Calcutta",
          // Pre-populated with the exact computed ranking
          your_ranking: [
            "2026-10-22T15:41:00.000Z",
            "2026-10-29T15:42:00.000Z",
          ],
        },
      ],
    });

    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
      ]);
      assert.equal(code, 0);
      assert.equal(server.state.postCount, 0); // Nothing sent!
      assert.ok(out.getLogs().includes("Already set, nothing sent"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("same ranking + new --note sends one POST", async () => {
    const server = await createFakeServer({
      polls: [
        {
          id: "231ad161-4501-4161-8902-6da99c0f7a5b",
          kind: "dates",
          q: "Which date works best for you?",
          options: [
            "2026-10-16T15:41:00.000Z",
            "2026-10-22T15:41:00.000Z",
            "2026-10-29T15:42:00.000Z",
          ],
          timezone: "Asia/Calcutta",
          your_ranking: [
            "2026-10-22T15:41:00.000Z",
            "2026-10-29T15:42:00.000Z",
          ],
        },
      ],
    });

    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--note",
        "Free after 5pm",
      ]);
      assert.equal(code, 0);
      assert.equal(server.state.postCount, 1);
      assert.equal(server.state.lastPostBody?.note, "Free after 5pm");
      assert.ok(!out.getLogs().includes("Already set"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("same ranking and no --note sends none", async () => {
    const server = await createFakeServer({
      polls: [
        {
          id: "231ad161-4501-4161-8902-6da99c0f7a5b",
          kind: "dates",
          q: "Which date works best for you?",
          options: [
            "2026-10-16T15:41:00.000Z",
            "2026-10-22T15:41:00.000Z",
            "2026-10-29T15:42:00.000Z",
          ],
          timezone: "Asia/Calcutta",
          your_ranking: [
            "2026-10-22T15:41:00.000Z",
            "2026-10-29T15:42:00.000Z",
          ],
        },
      ],
    });

    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
      ]);
      assert.equal(code, 0);
      assert.equal(server.state.postCount, 0);
      assert.ok(out.getLogs().includes("Already set, nothing sent"));
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("passes custom --idempotency-key through to the server", async () => {
    const server = await createFakeServer();
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--idempotency-key",
        "custom-rank-key-12345",
      ]);
      assert.equal(code, 0);
      assert.equal(
        server.state.lastPostHeaders?.["idempotency-key"],
        "custom-rank-key-12345",
      );
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("when server returns a different ranking than sent (reused --idempotency-key), prints Requested, Server has, key, and cause, and exits 1", async () => {
    const server = await createFakeServer();
    // Pre-mark the idempotency key as used and set an existing server ranking
    server.state.usedKeys.add("reused-key-xyz");
    server.state.polls[0].your_ranking = ["2026-10-16T15:41:00.000Z"];

    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--idempotency-key",
        "reused-key-xyz",
      ]);
      assert.equal(code, 1);
      const err = out.getErrors();
      assert.ok(err.includes("Requested:"), `Expected 'Requested:' in: ${err}`);
      assert.ok(err.includes("Server has:"), `Expected 'Server has:' in: ${err}`);
      assert.ok(err.includes("reused-key-xyz"), `Expected key in: ${err}`);
      assert.ok(err.includes("--idempotency-key"), `Expected cause in: ${err}`);
    } finally {
      out.restore();
      await server.close();
    }
  });

  it("outputs valid JSON when --json flag is passed", async () => {
    const server = await createFakeServer();
    const out = captureOutput();
    try {
      const code = await rankCommand([
        `${server.url}/i/${server.state.token}`,
        "--ics",
        meIcsPath,
        "--json",
      ]);
      assert.equal(code, 0);
      const parsed = JSON.parse(out.getLogs().trim());
      assert.equal(parsed.indbyagent, "0.1");
      assert.equal(parsed.guest.name, "leo");
    } finally {
      out.restore();
      await server.close();
    }
  });
});
