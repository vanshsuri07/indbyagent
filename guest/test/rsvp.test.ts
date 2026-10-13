/**
 * Tests for indby-guest rsvp command.
 *
 * Uses node:test and node:assert. Runs an in-process HTTP fake server
 * with stateful RSVP semantics (idempotency tracking, party_size_max validation).
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";

import { canonicalJson } from "../src/lib/canonical-json.js";
import { deriveIdempotencyKey } from "../src/lib/idempotency.js";
import { rsvpMatches, rsvpCommand } from "../src/commands/rsvp.js";
import { printServerError } from "../src/lib/errors.js";

// ---------- helpers ----------

interface FakeServerState {
  token: string;
  partySizeMax: number;
  currentRsvp: Record<string, unknown>;
  postCount: number;
  usedKeys: Set<string>;
  lastPostBody?: Record<string, unknown>;
  lastPostHeaders?: http.IncomingHttpHeaders;
  actionRsvpOrigin?: string;
}

function createFakeServer(options: {
  token?: string;
  partySizeMax?: number;
  initialRsvp?: Record<string, unknown>;
  actionRsvpOrigin?: string;
  schema?: Record<string, unknown> | null;
  postStatus?: number;
  postResponseBody?: unknown;
} = {}): Promise<{
  url: string;
  state: FakeServerState;
  close: () => Promise<void>;
}> {
  const token = options.token ?? "TESTTOKEN_abc123def456";
  const state: FakeServerState = {
    token,
    partySizeMax: options.partySizeMax ?? 2,
    currentRsvp: options.initialRsvp ?? { status: "pending" },
    postCount: 0,
    usedKeys: new Set<string>(),
    actionRsvpOrigin: options.actionRsvpOrigin,
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const pathname = parsedUrl.pathname;

      const buildInvite = (origin: string) => {
        const actionOrigin = state.actionRsvpOrigin ?? origin;
        const schemaObj =
          options.schema === null
            ? undefined
            : (options.schema ?? {
                rsvp: {
                  status: "yes|no|maybe|needs_human",
                  party_size: `int<=${state.partySizeMax}`,
                },
              });
        return {
          indbyagent: "0.1",
          party: {
            title: "Maya's 6th Birthday",
            starts_at: "2026-10-20T18:30:00.000Z",
            timezone: "Asia/Calcutta",
          },
          guest: {
            name: "leo",
            party_size_max: state.partySizeMax,
          },
          rsvp: state.currentRsvp,
          actions: {
            rsvp: `POST ${actionOrigin}/i/${state.token}/rsvp`,
            message_host: `POST ${actionOrigin}/i/${state.token}/message`,
            calendar: `GET ${actionOrigin}/i/${state.token}.ics`,
          },
          schema: schemaObj,
        };
      };

      if (req.method === "GET" && pathname === `/i/${state.token}.json`) {
        const origin = `http://${req.headers.host}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(buildInvite(origin)));
        return;
      }

      if (req.method === "POST" && pathname === `/i/${state.token}/rsvp`) {
        state.postCount++;
        state.lastPostHeaders = req.headers;

        let bodyRaw = "";
        req.on("data", (chunk) => {
          bodyRaw += chunk;
        });

        req.on("end", () => {
          const body = JSON.parse(bodyRaw) as Record<string, unknown>;
          state.lastPostBody = body;

          if (options.postStatus !== undefined) {
            res.writeHead(options.postStatus, { "content-type": "application/json" });
            res.end(JSON.stringify(options.postResponseBody ?? { error: "error" }));
            return;
          }

          const idemKey = req.headers["idempotency-key"] as string | undefined;

          // If idempotency key was already seen: simulate Postgres 23505 duplicate key
          // The server silently ignores the write and returns the current (unmodified) invite.
          if (idemKey && state.usedKeys.has(idemKey)) {
            const origin = `http://${req.headers.host}`;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(buildInvite(origin)));
            return;
          }

          if (idemKey) {
            state.usedKeys.add(idemKey);
          }

          // Validate party_size
          if (typeof body.party_size === "number" && body.party_size > state.partySizeMax) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: `party_size exceeds max of ${state.partySizeMax}`,
              }),
            );
            return;
          }

          // Update state
          const updated: Record<string, unknown> = {
            status: body.status,
          };
          if (body.party_size !== undefined) updated.party_size = body.party_size;
          if (body.dietary !== undefined) updated.dietary = body.dietary;
          if (body.note !== undefined) updated.note = body.note;
          if (body.by !== undefined) updated.by = body.by;

          state.currentRsvp = updated;

          const origin = `http://${req.headers.host}`;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(buildInvite(origin)));
        });
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------- unit tests: canonicalJson & rsvpMatches ----------

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
    assert.equal(
      canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
      '{"a":{"x":3,"y":2},"z":1}',
    );
  });

  it("omits undefined properties", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it("preserves arrays and primitives", () => {
    assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
    assert.equal(canonicalJson("hello"), '"hello"');
    assert.equal(canonicalJson(42), "42");
    assert.equal(canonicalJson(null), "null");
  });
});

describe("deriveIdempotencyKey", () => {
  it("produces a 32-character hex string", () => {
    const key = deriveIdempotencyKey("TOKEN", { status: "yes" }, { status: "pending" });
    assert.equal(key.length, 32);
    assert.match(key, /^[0-9a-f]{32}$/);
  });

  it("produces different keys when state changes (yes -> no -> yes works)", () => {
    const key1 = deriveIdempotencyKey("TOKEN", { status: "yes" }, { status: "pending" });
    const key2 = deriveIdempotencyKey("TOKEN", { status: "no" }, { status: "yes" });
    const key3 = deriveIdempotencyKey("TOKEN", { status: "yes" }, { status: "no" });
    assert.notEqual(key1, key2);
    assert.notEqual(key1, key3);
    assert.notEqual(key2, key3);
  });
});

describe("rsvpMatches", () => {
  it("matches status only when other fields not requested", () => {
    assert.ok(rsvpMatches({ status: "yes", party_size: 2 }, "yes"));
    assert.ok(!rsvpMatches({ status: "no" }, "yes"));
  });

  it("matches requested party_size, note, and dietary", () => {
    assert.ok(
      rsvpMatches(
        { status: "yes", party_size: 2, note: "hello", dietary: ["vegan"] },
        "yes",
        2,
        ["vegan"],
        "hello",
      ),
    );
    assert.ok(
      !rsvpMatches(
        { status: "yes", party_size: 1 },
        "yes",
        2,
      ),
    );
  });
});

describe("printServerError", () => {
  it("prints verbatim error and issues", () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    try {
      printServerError("/test", 400, {
        error: "invalid",
        issues: ["status: required", "party_size: too large"],
      });
      assert.equal(errs.length, 3);
      assert.equal(errs[0], "invalid");
      assert.equal(errs[1], "status: required");
      assert.equal(errs[2], "party_size: too large");
    } finally {
      console.error = origErr;
    }
  });
});

// ---------- command integration tests ----------

describe("rsvp command", () => {
  it("first rsvp sends exactly one POST with Idempotency-Key and by.kind agent", async () => {
    const fake = await createFakeServer();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code, 0);
      assert.equal(fake.state.postCount, 1);

      const idemKey = fake.state.lastPostHeaders?.["idempotency-key"];
      assert.ok(typeof idemKey === "string" && idemKey.length === 32, `Expected 32-char key, got: ${idemKey}`);
      assert.match(idemKey, /^[0-9a-f]{32}$/);

      assert.equal(fake.state.lastPostBody?.status, "yes");
      assert.deepEqual(fake.state.lastPostBody?.by, {
        kind: "agent",
        name: "indby-guest",
      });
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("running the same command again sends ZERO POSTs and prints 'Already set'", async () => {
    const fake = await createFakeServer({
      initialRsvp: {
        status: "yes",
        by: { kind: "agent", name: "indby-guest" },
      },
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code, 0);
      assert.equal(fake.state.postCount, 0, "Expected 0 POSTs when already set");
      const out = logs.join("\n");
      assert.ok(out.includes("Already set"), `Expected 'Already set' in: ${out}`);
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("yes -> no -> yes: all three actually POST, and final server state is yes", async () => {
    const fake = await createFakeServer();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const code1 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code1, 0);
      assert.equal(fake.state.postCount, 1);
      assert.equal(fake.state.currentRsvp.status, "yes");

      const code2 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "no",
      ]);
      assert.equal(code2, 0);
      assert.equal(fake.state.postCount, 2);
      assert.equal(fake.state.currentRsvp.status, "no");

      const code3 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code3, 0);
      assert.equal(fake.state.postCount, 3);
      assert.equal(fake.state.currentRsvp.status, "yes");
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("--idempotency-key reuse with a changed body: output warns about the mismatch and exits 1", async () => {
    const fake = await createFakeServer();
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      // First call with explicit key
      const code1 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--idempotency-key",
        "fixed-reused-key-12345",
      ]);
      assert.equal(code1, 0);
      assert.equal(fake.state.currentRsvp.status, "yes");

      // Second call reuses same key with changed body (--status no)
      const code2 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "no",
        "--idempotency-key",
        "fixed-reused-key-12345",
      ]);
      assert.equal(code2, 1);
      const outErr = errs.join("\n");
      assert.ok(
        outErr.includes("different RSVP than requested") || outErr.includes("ignored"),
        `Expected warning in: ${outErr}`,
      );
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });

  it("--idempotency-key is sent verbatim", async () => {
    const fake = await createFakeServer();
    const origLog = console.log;
    console.log = () => {};
    try {
      const customKey = "custom-key-verbatim-abc-987";
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--idempotency-key",
        customKey,
      ]);
      assert.equal(code, 0);
      assert.equal(fake.state.lastPostHeaders?.["idempotency-key"], customKey);
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("party above max: server message printed, exit 1", async () => {
    const fake = await createFakeServer({ partySizeMax: 1 });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--party",
        "3",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(out.includes("party_size exceeds max of 1"), `Expected error text in: ${out}`);
      assert.ok(out.includes("Expected for rsvp:"), `Expected schema header in: ${out}`);
      assert.ok(out.includes("party_size:"), `Expected party_size in schema: ${out}`);
      assert.ok(out.includes("Your request:"), `Expected Your request in: ${out}`);
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });

  it("/j/ link rejected; invalid --status exits 2; missing --status exits 2", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const codeJ = await rsvpCommand([
        "http://localhost:3000/j/abc123",
        "--status",
        "yes",
      ]);
      assert.equal(codeJ, 2);
      assert.ok(errs.join("\n").includes("join link"));

      errs.length = 0;
      const codeInvalid = await rsvpCommand([
        "http://localhost:3000/i/TESTTOKEN_abc123def456",
        "--status",
        "definitely",
      ]);
      assert.equal(codeInvalid, 2);

      errs.length = 0;
      const codeMissing = await rsvpCommand([
        "http://localhost:3000/i/TESTTOKEN_abc123def456",
      ]);
      assert.equal(codeMissing, 2);
    } finally {
      console.error = origErr;
    }
  });

  it("the POST goes to user-typed origin even when actions.rsvp points elsewhere", async () => {
    // Fake server simulates server whose configured siteUrl is configured-origin.com
    const fake = await createFakeServer({
      actionRsvpOrigin: "http://configured-origin.com",
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      // User types fake.url (http://127.0.0.1:port)
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code, 0);

      // Assert fake server actually received the POST on typed origin
      assert.equal(fake.state.postCount, 1);

      // Assert warning was printed
      const out = logs.join("\n");
      assert.ok(
        out.includes("⚠ Server action URLs use http://configured-origin.com"),
        `Expected warning in: ${out}`,
      );
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("optional fields are omitted from body when not provided", async () => {
    const fake = await createFakeServer();
    const origLog = console.log;
    console.log = () => {};
    try {
      // Call with only status
      const code1 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code1, 0);
      assert.ok(!("party_size" in (fake.state.lastPostBody ?? {})));
      assert.ok(!("dietary" in (fake.state.lastPostBody ?? {})));
      assert.ok(!("note" in (fake.state.lastPostBody ?? {})));

      // Call with party, note, dietary
      const code2 = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "maybe",
        "--party",
        "2",
        "--note",
        "Might bring a plus one",
        "--dietary",
        "vegan, gluten-free",
      ]);
      assert.equal(code2, 0);
      assert.equal(fake.state.lastPostBody?.party_size, 2);
      assert.equal(fake.state.lastPostBody?.note, "Might bring a plus one");
      assert.deepEqual(fake.state.lastPostBody?.dietary, ["vegan", "gluten-free"]);
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("--json outputs raw invite JSON only", async () => {
    const fake = await createFakeServer();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--json",
      ]);
      assert.equal(code, 0);
      const parsed = JSON.parse(logs.join("\n"));
      assert.equal(parsed.rsvp.status, "yes");
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("timed-out POST explains server may be starting/compiling and retrying is safe when idempotency key is unchanged", async () => {
    const token = "TESTTOKEN_abc123def456";
    const server = http.createServer((req, res) => {
      if (req.method === "GET") {
        const origin = `http://${req.headers.host}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            indbyagent: "0.1",
            party: { title: "Timeout Party", timezone: "UTC" },
            guest: { name: "leo", party_size_max: 1 },
            rsvp: { status: "pending" },
            actions: { rsvp: `POST ${origin}/i/${token}/rsvp` },
            schema: {},
          }),
        );
        return;
      }
      // Hang on POST
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `http://127.0.0.1:${port}/i/${token}`,
        "--status",
        "yes",
        "--timeout",
        "0.05",
      ]);
      assert.equal(code, 1);
      const outErr = errs.join("\n");
      assert.ok(outErr.includes("starting or compiling"), `Expected compiling message in: ${outErr}`);
      assert.ok(
        outErr.includes("Retrying is safe when the idempotency key is unchanged"),
        `Expected idempotency retry safety message in: ${outErr}`,
      );
      assert.ok(!outErr.includes(".."), `Must not contain doubled period in timeout message: ${outErr}`);
    } finally {
      console.error = origErr;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("business-rule 400 with option list prints options one per line", async () => {
    const fake = await createFakeServer({
      postStatus: 400,
      postResponseBody: {
        error: "ranking entries must be options: optA, optB, optC",
      },
    });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(out.includes("Options:"), `Expected Options: in: ${out}`);
      assert.ok(out.includes("- optA"), `Expected optA in: ${out}`);
      assert.ok(out.includes("- optB"), `Expected optB in: ${out}`);
      assert.ok(out.includes("- optC"), `Expected optC in: ${out}`);
      assert.ok(out.includes("Expected for rsvp:"), `Expected schema in: ${out}`);
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });

  it("Zod 400 with issues prints each issue and matching keys under Fields to fix", async () => {
    const fake = await createFakeServer({
      postStatus: 400,
      postResponseBody: {
        error: "invalid",
        issues: [
          "party_size: Expected number, received string",
          "note: String must contain at most 500 character(s)",
        ],
      },
    });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--party",
        "2",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(out.includes("Server rejected the request (400): invalid"), `Expected 400 invalid in: ${out}`);
      assert.ok(out.includes("Fields to fix:"), `Expected Fields to fix in: ${out}`);
      assert.ok(out.includes("party_size:"), `Expected party_size under Fields to fix in: ${out}`);
      assert.ok(out.includes("Issues:"), `Expected Issues: in: ${out}`);
      assert.ok(out.includes("party_size: Expected number, received string"), `Expected party_size issue in: ${out}`);
      assert.ok(out.includes("note: String must contain at most 500 character(s)"), `Expected note issue in: ${out}`);
      assert.ok(out.includes("Your request:"), `Expected Your request in: ${out}`);
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });

  it("404 says the token is wrong or revoked with no schema and never prints the token", async () => {
    const fake = await createFakeServer();
    const badToken = "NONEXISTENT_REVOKED_TOKEN_1234";
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${badToken}`,
        "--status",
        "yes",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(
        out.includes("The invite token is wrong or revoked"),
        `Expected revoked message in: ${out}`,
      );
      assert.ok(!out.includes(badToken), "Must never print the invite token");
      assert.ok(!out.includes("Expected for rsvp:"), "Must not print schema on 404");
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });

  it("500 prints cause and retrying hint with no schema", async () => {
    const fake = await createFakeServer({
      postStatus: 500,
      postResponseBody: { error: "internal database connection failure" },
    });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(out.includes("Server error (500)"), `Expected 500 error in: ${out}`);
      assert.ok(out.includes("Retrying may help"), `Expected retrying hint in: ${out}`);
      assert.ok(!out.includes("Expected for rsvp:"), "Must not print schema on 500");
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });

  it("network failure prints cause and retrying hint with no schema", async () => {
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        "http://127.0.0.1:59999/i/TESTTOKEN_abc123def456",
        "--status",
        "yes",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(out.includes("127.0.0.1:59999"), `Expected host:port in: ${out}`);
      assert.ok(out.includes("ECONNREFUSED"), `Expected ECONNREFUSED in: ${out}`);
      assert.ok(out.includes("Retrying may help"), `Expected retrying hint in: ${out}`);
      assert.ok(!out.includes("Expected for rsvp:"), "Must not print schema on network error");
    } finally {
      console.error = origErr;
    }
  });

  it("--json outputs single JSON object with status, error, schema_piece, request on 400", async () => {
    const fake = await createFakeServer({
      postStatus: 400,
      postResponseBody: { error: "party_size exceeds max of 1" },
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--party",
        "3",
        "--json",
      ]);
      assert.equal(code, 1);
      const out = logs.join("\n");
      const parsed = JSON.parse(out);
      assert.equal(parsed.status, 400);
      assert.equal(parsed.error, "party_size exceeds max of 1");
      assert.ok(parsed.schema_piece, "Expected schema_piece in JSON");
      assert.equal(parsed.request.status, "yes");
      assert.equal(parsed.request.party_size, 3);
    } finally {
      console.log = origLog;
      await fake.close();
    }
  });

  it("missing schema block prints server error and states schema piece was omitted", async () => {
    const fake = await createFakeServer({
      schema: null,
      postStatus: 400,
      postResponseBody: { error: "party_size exceeds max of 1" },
    });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));

    try {
      const code = await rsvpCommand([
        `${fake.url}/i/${fake.state.token}`,
        "--status",
        "yes",
        "--party",
        "3",
      ]);
      assert.equal(code, 1);
      const out = errs.join("\n");
      assert.ok(out.includes("party_size exceeds max of 1"), `Expected error in: ${out}`);
      assert.ok(
        out.includes("omitted by the server"),
        `Expected omitted schema note in: ${out}`,
      );
      assert.ok(!out.includes("Expected for rsvp:"), "Must not print schema piece lines");
    } finally {
      console.error = origErr;
      await fake.close();
    }
  });
});
