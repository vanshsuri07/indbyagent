// Execute each naive agent's literal requests against the real server and score them.
// For each trial we mint a fresh guest on the SAME party, so the poll ids and option
// strings the agents saw stay valid while every trial starts from a clean invite.
import { readFileSync } from "node:fs";
import { call, save, BASE } from "../lib/harness.mjs";

const meta = JSON.parse(readFileSync("audit/experiment/meta.json", "utf-8"));
const trialFile = JSON.parse(readFileSync("audit/experiment/trials.json", "utf-8"));
const trials = trialFile.trials;

// The agents answered against the document captured on the first run. A re-run of
// setup.mjs mints a new party, guest token and poll id, so rewrite those two values
// onto their requests. Nothing else about their answers may change.
const ORIGINAL_TOKEN = trialFile.originalToken;
const ORIGINAL_POLL_ID = trialFile.originalPollId;
const D1 = meta.options.d1, D2 = meta.options.d2, D3 = meta.options.d3;

if (!meta.options || !ORIGINAL_TOKEN) {
  throw new Error("run `node audit/experiment/setup.mjs` first, in the same server session");
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const outcomes = [];

for (const trial of trials) {
  // Fresh guest on the same party -> same polls, clean RSVP state.
  const g = await call("POST", `/api/host/parties/${meta.partyId}/guests`, {
    body: { guests: [{ name: `Trial ${trial.id}`, party_size_max: 2 }] },
  });
  const token = g.json.guests[0].token;

  const rewrote = (u) =>
    String(u).split(ORIGINAL_TOKEN).join(token).split(ORIGINAL_POLL_ID).join(meta.datePollId);

  const executed = [];
  for (const step of trial.steps) {
    const url = rewrote(step.url);
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url.replace(/^https?:\/\/[^/]+/, "");
    if (String(step.method).toUpperCase() === "GET") {
      const r = await call("GET", path);
      executed.push({ ...step, url, status: r.status, ok: r.status === 200 });
      continue;
    }
    const r = await call("POST", path, { body: step.body, headers: step.headers || {} });
    executed.push({ ...step, url, status: r.status, ok: r.status >= 200 && r.status < 300, error: r.json?.error, issues: r.json?.issues });
  }

  // Ground truth after the agent's own requests.
  const after = await call("GET", `/i/${token}.json`);
  const doc = after.json;

  const rsvpStep = executed.find((s) => /\/rsvp$/.test(s.url));
  const rankStep = executed.find((s) => /\/rank$/.test(s.url));

  const checks = {
    rsvp_accepted: rsvpStep ? rsvpStep.ok : false,
    rank_accepted: rankStep ? rankStep.ok : false,
    rank_url_used_real_poll_id: rankStep ? rankStep.url.includes(meta.datePollId) : false,
    rsvp_status_correct: doc.rsvp?.status === "yes",
    party_size_correct: doc.rsvp?.party_size === 2,
    dietary_correct: (doc.rsvp?.dietary ?? []).some((d) => /nut/i.test(d)),
    // the substantive judgement: exclude the clashing date, soonest first
    ranking_correct: eq(rankStep?.body?.ranking, [D1, D3]),
    clash_excluded: !(rankStep?.body?.ranking ?? []).includes(D2),
    soonest_first: rankStep?.body?.ranking?.[0] === D1,
    left_template_placeholder_in_by_name: /YOUR_AGENT/i.test(JSON.stringify(rsvpStep?.body?.by ?? {})),
    invented_a_host_message: executed.some((s) => /\/message$/.test(s.url)),
  };

  outcomes.push({
    id: trial.id,
    arm: trial.arm,
    agentReportedConfidence: trial.confidence,
    agentReportedRanking: trial.understanding?.ranked_dates_best_first,
    agentReportedExcluded: trial.understanding?.dates_excluded,
    checks,
    passed: checks.rsvp_status_correct && checks.party_size_correct && checks.ranking_correct && checks.rank_accepted,
    executed,
    serverStateAfter: { rsvp: doc.rsvp, your_ranking: doc.polls?.find((p) => p.kind === "dates")?.your_ranking },
  });
}

const byArm = (arm) => outcomes.filter((o) => o.arm === arm);
const summary = { generatedAt: new Date().toISOString(), n: outcomes.length, byArm: {}, overall: {} };

for (const arm of ["txt", "json"]) {
  const rows = byArm(arm);
  if (!rows.length) continue;
  const yes = (fn) => rows.filter(fn).length;
  summary.byArm[arm] = {
    n: rows.length,
    task_completed_correctly: yes((r) => r.passed),
    ranking_correct: yes((r) => r.checks.ranking_correct),
    clash_excluded: yes((r) => r.checks.clash_excluded),
    rsvp_accepted: yes((r) => r.checks.rsvp_accepted),
    rank_accepted: yes((r) => r.checks.rank_accepted),
    substituted_a_real_poll_id: yes((r) => r.checks.rank_url_used_real_poll_id),
    shipped_YOUR_AGENT_placeholder: yes((r) => r.checks.left_template_placeholder_in_by_name),
    sent_an_unrequested_host_message: yes((r) => r.checks.invented_a_host_message),
    self_reported_high_confidence: yes((r) => r.agentReportedConfidence === "high"),
    self_reported_high_confidence_but_wrong_ranking: yes((r) => r.agentReportedConfidence === "high" && !r.checks.ranking_correct),
  };
}
summary.overall = {
  n: outcomes.length,
  task_completed_correctly: outcomes.filter((r) => r.passed).length,
  ranking_correct: outcomes.filter((r) => r.checks.ranking_correct).length,
  clash_excluded: outcomes.filter((r) => r.checks.clash_excluded).length,
  substituted_a_real_poll_id: outcomes.filter((r) => r.checks.rank_url_used_real_poll_id).length,
  shipped_YOUR_AGENT_placeholder: outcomes.filter((r) => r.checks.left_template_placeholder_in_by_name).length,
  sent_an_unrequested_host_message: outcomes.filter((r) => r.checks.invented_a_host_message).length,
};

await save("audit/out/agent-experiment.json", JSON.stringify({ summary, outcomes }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log("\nPer-trial (only the substantive checks):");
for (const o of outcomes) {
  const bad = [];
  if (!o.checks.ranking_correct) bad.push("WRONG RANKING");
  if (!o.checks.rank_url_used_real_poll_id) bad.push("LEFT {id} IN URL");
  if (o.checks.left_template_placeholder_in_by_name) bad.push("by.name=YOUR_AGENT");
  if (o.checks.invented_a_host_message) bad.push("unrequested /message");
  for (const s of o.executed) if (s.method === "POST" && !s.ok) bad.push(`HTTP ${s.status} on ${s.url.replace(BASE, "")}`);
  console.log(`  ${o.id.padEnd(3)} ${o.arm.padEnd(5)} conf=${String(o.agentReportedConfidence).padEnd(6)} ${bad.length ? bad.join("; ") : "clean"}`);
}
