/**
 * Integration tests against the real running IndbyAgent server.
 *
 * Requirements:
 * - Talks to a real dev server at INDBY_BASE_URL (default http://localhost:3000)
 * - If server is unreachable, SKIPS cleanly with:
 *   "start the app with `npm run dev` in the repo root, then re-run"
 * - Spawns the built CLI (node dist/cli.js) as a child process
 * - Each test seeds its own party so runs do not interfere
 */
import { describe, it, before } from "node:test";
import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { seedParty } from "./seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../../../dist/cli.js");
const baseUrl = (process.env.INDBY_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const SKIP_MESSAGE = "start the app with `npm run dev` in the repo root, then re-run";

let serverAvailable = false;

function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliEntry, ...args],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({
          code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

function toIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

describe("Integration tests against local app", () => {
  before(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/host/parties`, {
        signal: AbortSignal.timeout(3000),
      });
      serverAvailable = res.ok;
    } catch {
      serverAvailable = false;
    }
  });

  it("1. read: output contains party title, party-timezone time, and open poll", async (t) => {
    if (!serverAvailable) {
      t.skip(SKIP_MESSAGE);
      return;
    }

    const { party, poll, inviteUrl } = await seedParty(baseUrl);
    const res = await runCli(["read", inviteUrl]);

    assert.equal(res.code, 0, `Expected exit 0, got ${res.code}: ${res.stderr}`);
    assert.ok(res.stdout.includes(party.title), `Output missing party title: ${res.stdout}`);
    assert.ok(res.stdout.includes(party.timezone), `Output missing party timezone: ${res.stdout}`);
    assert.ok(res.stdout.includes(poll.id), `Output missing poll ID: ${res.stdout}`);
  });

  it("2. rsvp idempotency: first sends, second says 'Already set', yes->no->yes, key mismatch warning, party above max prints schema", async (t) => {
    if (!serverAvailable) {
      t.skip(SKIP_MESSAGE);
      return;
    }

    const { inviteUrl } = await seedParty(baseUrl);

    // 2a: First run sends RSVP
    const run1 = await runCli(["rsvp", inviteUrl, "--status", "yes"]);
    assert.equal(run1.code, 0, `First RSVP failed: ${run1.stderr}`);

    // 2b: Second run says "Already set"
    const run2 = await runCli(["rsvp", inviteUrl, "--status", "yes"]);
    assert.equal(run2.code, 0);
    assert.ok(run2.stdout.includes("Already set"), `Expected 'Already set' in: ${run2.stdout}`);

    // 2c: yes -> no -> yes ends as yes
    const runNo = await runCli(["rsvp", inviteUrl, "--status", "no"]);
    assert.equal(runNo.code, 0, `RSVP no failed: ${runNo.stderr}`);
    const runYesAgain = await runCli(["rsvp", inviteUrl, "--status", "yes"]);
    assert.equal(runYesAgain.code, 0, `RSVP yes again failed: ${runYesAgain.stderr}`);

    const readCheck = await runCli(["read", inviteUrl, "--json"]);
    assert.equal(readCheck.code, 0);
    const parsedDoc = JSON.parse(readCheck.stdout);
    assert.equal(parsedDoc.rsvp.status, "yes");

    // 2d: Same --idempotency-key with changed status prints mismatch warning and exits 1
    const fixedKey = `integ-idem-${Date.now()}`;
    const runKey1 = await runCli([
      "rsvp",
      inviteUrl,
      "--status",
      "no",
      "--idempotency-key",
      fixedKey,
    ]);
    assert.equal(runKey1.code, 0);

    const runKey2 = await runCli([
      "rsvp",
      inviteUrl,
      "--status",
      "yes",
      "--idempotency-key",
      fixedKey,
    ]);
    assert.equal(runKey2.code, 1, "Expected exit 1 on key reuse mismatch");
    assert.ok(
      runKey2.stderr.includes("different RSVP than requested") ||
        runKey2.stderr.includes("ignored"),
      `Expected mismatch warning in stderr: ${runKey2.stderr}`,
    );

    // 2e: --party above party_size_max (max is 1) prints server message AND schema piece
    const runAboveMax = await runCli([
      "rsvp",
      inviteUrl,
      "--status",
      "yes",
      "--party",
      "3",
    ]);
    assert.equal(runAboveMax.code, 1, "Expected exit 1 when party exceeds max");
    assert.ok(
      runAboveMax.stderr.includes("party_size exceeds max of 1"),
      `Expected server message in: ${runAboveMax.stderr}`,
    );
    assert.ok(
      runAboveMax.stderr.includes("Expected for rsvp:"),
      `Expected schema piece in: ${runAboveMax.stderr}`,
    );
    assert.ok(
      runAboveMax.stderr.includes("party_size:"),
      `Expected party_size field in: ${runAboveMax.stderr}`,
    );
  });

  it("3. rank with a clash: drops clashing option, ranks rest soonest first, server stores ranking, rerun says 'Already set'", async (t) => {
    if (!serverAvailable) {
      t.skip(SKIP_MESSAGE);
      return;
    }

    const { poll, inviteUrl } = await seedParty(baseUrl);
    const sortedOptions = [...poll.options].sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    const clashingOption = sortedOptions[0];
    const clashingDate = new Date(clashingOption);
    const eventEnd = new Date(clashingDate.getTime() + 120 * 60 * 1000);

    const icsContent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//IndbyAgent Integration//EN",
      "BEGIN:VEVENT",
      `UID:integ-clash-${Date.now()}@example.com`,
      `DTSTAMP:${toIcsUtc(new Date())}`,
      `DTSTART:${toIcsUtc(clashingDate)}`,
      `DTEND:${toIcsUtc(eventEnd)}`,
      "SUMMARY:Dentist Conflict",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "indby-integ-"));
    const icsPath = path.join(tmpDir, "clash.ics");
    fs.writeFileSync(icsPath, icsContent, "utf-8");

    try {
      const rankRes = await runCli(["rank", inviteUrl, "--ics", icsPath]);
      assert.equal(rankRes.code, 0, `Rank command failed: ${rankRes.stderr}`);
      assert.ok(rankRes.stdout.includes("Dropped:"), `Expected Dropped in output: ${rankRes.stdout}`);
      assert.ok(
        rankRes.stdout.includes("Dentist Conflict") ||
          rankRes.stdout.includes("calendar clash"),
        `Expected conflict reason in output: ${rankRes.stdout}`,
      );
      assert.ok(rankRes.stdout.includes("Ranking:"), `Expected Ranking in output: ${rankRes.stdout}`);

      // Verify server stored that ranking
      const readDoc = await runCli(["read", inviteUrl, "--json"]);
      assert.equal(readDoc.code, 0);
      const parsedDoc = JSON.parse(readDoc.stdout);
      const storedPoll = parsedDoc.polls.find((p: { id: string }) => p.id === poll.id);
      assert.ok(storedPoll, "Poll not found in invite document");
      assert.deepEqual(storedPoll.your_ranking, [sortedOptions[1], sortedOptions[2]]);

      // Second run says "Already set"
      const rerunRes = await runCli(["rank", inviteUrl, "--ics", icsPath]);
      assert.equal(rerunRes.code, 0);
      assert.ok(
        rerunRes.stdout.includes("Already set"),
        `Expected 'Already set' in rerun: ${rerunRes.stdout}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("4. a /j/ join link and a token with a bad shape are rejected without any request being sent", async () => {
    // Both are client-side validation checks; no server request is ever sent
    const joinRes = await runCli(["read", `${baseUrl}/j/samplecode`]);
    assert.equal(joinRes.code, 2, "Expected exit 2 for join link");
    assert.ok(joinRes.stderr.includes("join link"), `Expected join link error: ${joinRes.stderr}`);

    const badTokenRes = await runCli(["read", `${baseUrl}/i/bad`]);
    assert.equal(badTokenRes.code, 2, "Expected exit 2 for invalid token shape");
    assert.ok(
      badTokenRes.stderr.includes("Token does not look valid") ||
        badTokenRes.stderr.includes("Invalid invite URL"),
      `Expected bad token error: ${badTokenRes.stderr}`,
    );
  });
});
