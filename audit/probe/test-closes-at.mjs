// Checks that polls respect closes_at. Run with the app already running.
//   node test-closes-at.mjs
// Optional: INDBY_BASE_URL=http://localhost:3000 node test-closes-at.mjs
const BASE = process.env.INDBY_BASE_URL || "http://localhost:3000";
const DAY = 86400_000;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const by = { kind: "agent", name: "closes-at-test" };
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`,
  );
};

// --- setup: a party, one guest who says yes (preference polls need a yes) ---
const dateOpt = new Date(Date.now() + 30 * DAY).toISOString();
const party = await call("POST", "/api/host/parties", {
  title: "closes_at test",
  kind: "birthday",
  timezone: "America/Los_Angeles",
  rsvp_by: new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10),
  backup_dates: [dateOpt],
});
if (party.status !== 201)
  throw new Error(`party failed: ${party.status} ${party.text}`);
const partyId = party.json.party.id;

const g = await call("POST", `/api/host/parties/${partyId}/guests`, {
  guests: [{ name: "Test Guest", party_size_max: 1 }],
});
const token = g.json.guests[0].token;

const rsvp = await call("POST", `/i/${token}/rsvp`, {
  status: "yes",
  party_size: 1,
  by,
});
if (rsvp.status !== 200)
  throw new Error(`rsvp failed: ${rsvp.status} ${rsvp.text}`);

// --- three polls: closed yesterday, no deadline, closes in 7 days ---
const mkPoll = async (question, closes_at) => {
  const r = await call("POST", `/api/host/parties/${partyId}/polls`, {
    kind: "preference",
    question,
    options: ["6pm", "7pm"],
    ...(closes_at ? { closes_at } : {}),
  });
  if (r.status !== 201)
    throw new Error(`poll "${question}" failed: ${r.status} ${r.text}`);
  return r.json.poll.id;
};
const pastId = await mkPoll(
  "Past deadline",
  new Date(Date.now() - DAY).toISOString(),
);
const nullId = await mkPoll("No deadline");
const futureId = await mkPoll(
  "Future deadline",
  new Date(Date.now() + 7 * DAY).toISOString(),
);

// --- 1. the invite should hide the expired poll, keep the other two ---
const invite = await call("GET", `/i/${token}.json`);
const ids = (invite.json?.polls ?? []).map((p) => p.id);
check("1a. expired poll is NOT in the invite", !ids.includes(pastId));
check("1b. no-deadline poll IS in the invite", ids.includes(nullId));
check("1c. future-deadline poll IS in the invite", ids.includes(futureId));

// --- 2. voting on the expired poll must be rejected ---
const late = await call("POST", `/i/${token}/polls/${pastId}`, {
  choice: "6pm",
  by,
});
check(
  "2. vote on expired poll is rejected",
  late.status >= 400,
  `status ${late.status}: ${late.json?.error ?? late.text}`,
);

// --- 3 and 4. the other two must still accept votes ---
const a = await call("POST", `/i/${token}/polls/${nullId}`, {
  choice: "6pm",
  by,
});
check(
  "3. vote on no-deadline poll works",
  a.status === 200,
  `status ${a.status}`,
);
const b = await call("POST", `/i/${token}/polls/${futureId}`, {
  choice: "7pm",
  by,
});
check(
  "4. vote on future-deadline poll works",
  b.status === 200,
  `status ${b.status}`,
);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
