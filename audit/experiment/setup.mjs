// Build the fixture for the naive-agent conformance experiment, and capture
// exactly the two documents a stranger's agent can obtain from the product:
//   - the .txt block the invite page tells a human to paste to their agent
//   - the .json an agent gets when it fetches the link
import { call, seed, save, BASE } from "../lib/harness.mjs";

// Frozen option instants. These MUST stay fixed: the twelve agents in trials.json
// answered against exactly these strings, so the scoring step can only re-run
// against an identical document. The server validates poll options as ISO
// datetimes, not as future dates, so frozen values are fine.
const d1 = "2026-10-24T18:00:00.000Z"; // Sat Oct 24, 11:00 AM PDT
const d2 = "2026-10-29T01:00:00.000Z"; // Wed Oct 28,  6:00 PM PDT  <-- the clash
const d3 = "2026-11-03T02:00:00.000Z"; // Mon Nov  2,  6:00 PM PST

const S = await seed({
  title: "Leo's 30th",
  backupDates: [d1, d2, d3],
  partySizeMax: 2,
  extraPreferencePoll: {},
});

const txt = await call("GET", `/i/${S.token}.txt`);
const json = await call("GET", `/i/${S.token}.json`);
const html = await call("GET", `/i/${S.token}`, { headers: { accept: "text/html" } });

// The exact block the invite page renders under "For your agent".
const m = html.text.match(/<pre id="agent">([\s\S]*?)<\/pre>/);
const pastedBlock = (m ? m[1] : txt.text)
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

await save("audit/experiment/doc.txt", pastedBlock);
await save("audit/experiment/doc.json", json.text + "\n");
await save("audit/experiment/meta.json", JSON.stringify({
  base: BASE,
  token: S.token,
  inviteUrl: `${BASE}/i/${S.token}`,
  partyId: S.party.id,
  datePollId: S.datePoll.id,
  preferencePollId: S.prefPoll?.id ?? null,
  options: { d1, d2, d3 },
  clashOption: d2,
  expectedRanking: [d1, d3],
}, null, 2) + "\n");

console.log("token:", S.token);
console.log("inviteUrl:", `${BASE}/i/${S.token}`);
console.log("datePollId:", S.datePoll.id);
console.log("--- doc.txt ---");
console.log(pastedBlock);
console.log("--- doc.json ---");
console.log(json.text);
