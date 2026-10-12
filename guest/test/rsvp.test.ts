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
          schema: {
            rsvp: { status: "yes|no|maybe|needs_human" },
          },
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
    } finally {
      console.error = origErr;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
