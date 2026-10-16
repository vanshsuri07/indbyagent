// audit/probe/idempotency-conflict.mjs
// Regression test for "Idempotency replay silently succeeds with a different request".
// Run against the running app:  node audit/probe/idempotency-conflict.mjs
import { call, seed, futureIso } from "../lib/harness.mjs";

const d1 = futureIso(10, 18),
  d2 = futureIso(15, 1);
const S = await seed({
  title: "Idempotency test",
  backupDates: [d1, d2],
  partySizeMax: 2,
  extraPreferencePoll: {},
});
const T = S.token;
const by = { kind: "agent", name: "idem-test" };
const hdr = (k) => ({ "idempotency-key": k });

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failed++;
};
const truth = async () => (await call("GET", `/i/${T}.json`)).json;

// ---- RSVP -----------------------------------------------------------------
const yes = { status: "yes", party_size: 2, dietary: ["tree nuts"], by };
let r = await call("POST", `/i/${T}/rsvp`, {
  headers: hdr("rsvp-1"),
  body: yes,
});
check("RSVP first write accepted", r.status === 200, r.status);

r = await call("POST", `/i/${T}/rsvp`, { headers: hdr("rsvp-1"), body: yes });
check("RSVP exact retry accepted (200)", r.status === 200, r.status);

r = await call("POST", `/i/${T}/rsvp`, {
  headers: hdr("rsvp-1"),
  body: { status: "no", party_size: 0, by },
});
check("RSVP same key + different body -> 422", r.status === 422, r.status);
check(
  "RSVP conflict carries code idempotency_conflict",
  r.json?.code === "idempotency_conflict",
  JSON.stringify(r.json),
);

let doc = await truth();
check(
  "RSVP state unchanged after conflict",
  doc.rsvp?.status === "yes" && doc.rsvp?.party_size === 2,
  JSON.stringify(doc.rsvp),
);

r = await call("POST", `/i/${T}/rsvp`, {
  headers: hdr("rsvp-2"),
  body: { status: "no", party_size: 0, by },
});
check("RSVP new key + new body accepted", r.status === 200, r.status);

// ---- Rank poll ------------------------------------------------------------
const rankUrl = `/i/${T}/polls/${S.datePoll.id}/rank`;
r = await call("POST", rankUrl, {
  headers: hdr("rank-1"),
  body: { ranking: [d1], by },
});
check("Rank first write accepted", r.status === 200, r.status);

r = await call("POST", rankUrl, {
  headers: hdr("rank-1"),
  body: { ranking: [d1], by },
});
check("Rank exact retry accepted (200)", r.status === 200, r.status);

r = await call("POST", rankUrl, {
  headers: hdr("rank-1"),
  body: { ranking: [d2, d1], by },
});
check("Rank same key + different ranking -> 422", r.status === 422, r.status);

doc = await truth();
const ranking = doc.polls?.find((p) => p.kind === "dates")?.your_ranking;
check(
  "Ranking unchanged after conflict",
  JSON.stringify(ranking) === JSON.stringify([d1]),
  JSON.stringify(ranking),
);

// ---- Preference poll (guest said yes earlier, so it is unlocked) ----------
await call("POST", `/i/${T}/rsvp`, {
  body: { status: "yes", party_size: 1, by },
});
doc = await truth();
const pref = doc.polls?.find((p) => p.kind !== "dates");
if (pref && pref.options?.length >= 2) {
  const url = `/i/${T}/polls/${pref.id}`;
  r = await call("POST", url, {
    headers: hdr("pref-1"),
    body: { choice: pref.options[0], by },
  });
  check("Poll first write accepted", r.status === 200, r.status);
  r = await call("POST", url, {
    headers: hdr("pref-1"),
    body: { choice: pref.options[1], by },
  });
  check("Poll same key + different choice -> 422", r.status === 422, r.status);
} else {
  console.log(
    "SKIP  preference poll checks (no 2-option preference poll in fixture)",
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
