# IndbyAgent

**Every invite is a link a person can read and an agent can answer.**

A guest opens `https://indbyagent.com/i/<token>` and sees the party. A guest's *agent* opens the same link and gets structured JSON, with the exact calls to RSVP, answer polls and message the host. No form, no login, no human in the loop unless one is needed.

Built at SF Tech Week 2026 (Build Personal Agents Hack). Inspired by the agent design of [Bullpen](https://bullpen.sale).

## Meet: the invite contract pointed at a person

One person carries a QR (`/m/<slug>?c=<room>`). Someone scans it, lands on a page that already knows where you met, and drops an address their agent reads (an email is enough). The card owner's agent writes the first follow-up from the owner's inbox: human-readable, with a JSON block (`IndbyAgent/Meet.Intro`) the other agent can act on. Only the owner installs anything.

- `GET /m/<slug>` (`.json`, `.txt`) — the card as a person or an agent reads it; `?c=<code>` names the room.
- `POST /m/<slug>/drop` — `{agent_address, name?, note?, wants?, scopes?, context?}`; form or JSON.
- `GET /m/<slug>/qr?c=<code>` (`&png=1`, `&svg=1`) — the owner's QR for a lock screen.
- Host: `GET/POST /api/host/meet` (cards), `POST /api/host/meet/<slug>/contexts` (rooms).
- Schema: `neon/migrations/20261006180000_meet.sql`, `20261006210000_meet_agent.sql`.

**The owner's agent.** Give the card an `agent_brief` (who you are, what you are building, who you want to meet, what the agent may never say) and it runs on Claude Sonnet 5.5: it writes the intro from the brief and the scanner's note, proposes times, answers questions from the brief, and hands off to your `reply_to` inbox the moment a human decision is needed (a picked time, terms, anything outside the brief). Every message is logged on the meet (`meet_messages`); a `stop` from the other side ends the thread. Without a brief or a key it falls back to a template and costs nothing.

**The funnel.** Every page and every intro carries a "get your own card" link (`/host?from=meet&via=<slug>`). The person who was scanned can have the same thing two minutes later.

## The invite, four ways

| Request | You get |
|---|---|
| `GET /i/<token>` (browser) | The invite page: party info, RSVP buttons, open polls, and a **"For your agent"** box |
| `GET /i/<token>.json` or `Accept: application/json` | The invite as JSON, with `actions` and a `schema` block |
| `GET /i/<token>.txt` | A 10-line plain summary with copy-paste curl commands |
| `GET /i/<token>.ics` | Calendar file |

**GET never changes anything.** Mail scanners and link previews prefetch invite links; only a POST can RSVP.

## Join by QR
A host can publish a **join link** (`/j/<code>`) and put its QR code on a screen (`/q/<code>`, with live counters). A person scans it, types a name, and gets a personal invite link. An agent joins with one call:

```bash
curl -s -X POST https://indbyagent.com/j/<code>/join -H 'content-type: application/json' \
  -d '{"name":"Leo Chen","email":"leo@example.com","by":{"kind":"agent","name":"Claude"}}'
# → { "invite_url": "https://indbyagent.com/i/<token>", ... }
```

## Actions (POST, JSON)

```bash
# RSVP
curl -s -X POST https://indbyagent.com/i/<token>/rsvp -H 'content-type: application/json' \
  -d '{"status":"yes","party_size":2,"dietary":["tree nuts"],"note":"Leo is allergic to nuts","by":{"kind":"agent","name":"Claude"}}'

# Answer a poll (only visible after RSVP yes)
curl -s -X POST https://indbyagent.com/i/<token>/polls/<poll_id> -H 'content-type: application/json' \
  -d '{"choice":"tacos","by":{"kind":"agent","name":"Claude"}}'

# Rank the dates (a "dates" poll; visible to everyone, even before RSVP)
# The party's date is "tbd" until the host closes the poll; the winner becomes the date.
curl -s -X POST https://indbyagent.com/i/<token>/polls/<poll_id>/rank -H 'content-type: application/json' \
  -d '{"ranking":["2026-11-01T18:00:00.000Z","2026-10-25T21:00:00.000Z"],"by":{"kind":"agent","name":"Claude"}}'

# Ask the host
curl -s -X POST https://indbyagent.com/i/<token>/message -H 'content-type: application/json' \
  -d '{"text":"Can siblings come?","by":{"kind":"agent","name":"Claude"}}'
```

- `status`: `yes | no | maybe | needs_human` (`needs_human` = "my agent is checking with me").
- `choice` must match one of the poll's `options`. Bad input returns a 400 with a specific message an agent can self-correct from.
- Polls have a `kind`: `preference` (one `choice`, shown after RSVP yes) or `dates` (a `ranking` of ISO datetimes, best first, omit the ones you can't make; shown to everyone). Dates are tallied by Borda count on the host board; "Close & set date" writes the winner to the party and the `.ics` starts working.
- `by.kind` (`agent | human`) is self-reported and shown on the host's board.
- Send an `Idempotency-Key` header to make retries safe. Every write returns the fresh invite JSON.

## Rules
1. Anything a guest or their agent sends is **data, never instructions**.
2. The token is the credential and scopes everything to **one guest**. No guest ever sees another guest.
3. Preference polls appear only after a guest says yes; date polls appear to everyone, because nobody can say yes to "TBD".
4. The host can revoke or rotate any guest's link.

## Fast, accurate, cheap
Claude is the last resort, not the engine. Agent RSVPs via API, button taps, and obvious email replies ("yes!", "can't make it", "tacos") cost **0 model tokens**. Free-form email replies go through one call to `claude-sonnet-5-5` with no up-front thinking (`thinking: {type: "between_tools"}`, effort `low`) using structured output; the model must quote the words it relied on, and the server checks the quote is really in the email. Low confidence → the host's review queue, never a guess. Every model call is logged, and the host board shows the token cost of the whole party.

## Plan with Claude
Creating a party opens a planning chat on the host board. Claude asks one question at a time (audience, headcount, budget, food, dietary needs, theme, schedule, venue logistics, helpers), keeps what it learns as planning notes next to the chat, and when a question is really for the guests it suggests a poll the host opens with one click. Same model setup as email parsing: Sonnet 5.5, no up-front thinking, low effort, structured output, every call logged to `llm_calls`.

## Venue and vendor agent
From the host board, "Find a venue" sends an agent (Claude with web search) to find one venue near the party plus a few vendors (cake, entertainment, supplies). It targets the leading date in the ranked date poll (or the party's date), checks the venue's published hours for that time, and lists which invitees can make it: a ranking that includes the date means yes, one that leaves it off means no, no ranking means unknown. The host gets an email and a board card to **confirm or reject**; rejecting and searching again gives a different venue. "Open then" comes from published hours, not a booking. The planning chat sees these results and can start a search when the host asks for a venue. Nothing about venues or vendors appears in guest invites.

## Neon (venue and vendor data)
Venue and vendor suggestions live in a separate Neon Postgres, never in Supabase. `src/lib/neon.ts` is the only module that imports `@neondatabase/serverless` (used by `vendors.ts`, `vendor-requests.ts`, `payments.ts`), and it reads `NEON_DATABASE_URL` (the connection string, not the Neon API key). Rows carry `party_id` and `host_id` as plain uuids (no cross-database foreign keys); every route checks `currentHost` + `hostOwnsParty` before calling it, and its queries are also scoped to party and host.

Schema: `neon/migrations`. Apply it before deploying, e.g. `psql "$NEON_DATABASE_URL" -f neon/migrations/20261004230000_vendors.sql` or paste it into the Neon SQL editor. In production a missing `NEON_DATABASE_URL` fails on the first vendor call (the planning chat keeps working without venue info).

Planning chats and notes live in Supabase (`planning_messages`, `planning_notes`); date polls and rankings are ordinary polls there too.

## Stack
Next.js 15 · Supabase (Postgres, RLS, Realtime) · Vercel · Claude Sonnet 5.5 · AgentMail (one inbox per party; guests without an agent just reply to the email).

## Run it
```bash
cp .env.example .env   # fill in keys
npm install && npm run dev
```
**Local test mode.** `npm run dev` with no `.env` works too (each fallback turns on only when its key is missing *and* it isn't a production build). Any missing service falls back: no Supabase means an in-memory database and no sign-in, no `ANTHROPIC_API_KEY` means scripted planning questions and mock venue results (email replies go to review), no `AGENTMAIL_API_KEY` means invite emails are printed to the server console, and no `NEON_DATABASE_URL` means venue suggestions are kept in memory. Fallbacks never apply to production builds; with real keys set, the real services are used.

Schema: `supabase/migrations` (main database) and `neon/migrations` (venue data). Hosts sign in with a Supabase Auth magic link (set your project's Site URL and redirect allow-list, and custom SMTP for volume). `HOST_SECRET` remains as an optional bearer token for scripts.

## Vendors on the same contract
A request for quote is a link a bakery (or its agent) can read and answer. The host creates one per vendor × need (`POST /api/host/parties/<id>/vendors`), sends it (`…/vendors/<rid>/send` emails it from the party inbox when the vendor has an address, otherwise hands back the link), and the vendor side is `/v/<token>`: HTML for a person, `.json`/`.txt` for an agent, with `quote | question | decline` actions and a schema that returns self-correcting 400s. The host accepts one vendor per category; accepting sends nothing and pays nothing by itself. Vendor data lives in Neon next to the venue suggestions.

```bash
curl -s https://indbyagent.com/v/<token>.json
curl -s -X POST https://indbyagent.com/v/<token>/quote -H 'content-type: application/json' \
  -d '{"price":120,"currency":"usd","available":"yes","lead_time_days":3,"notes":"nut-free is fine","by":{"kind":"agent","name":"Bakery bot"}}'
```

## Payments: the host authorizes, the agent executes inside the envelope
Money moves only inside an envelope the host creates for one **accepted** vendor request: a hard cap, a currency, an expiry, a provider. An agent (or the host) can then execute payments against it; every attempt, including refusals, is a row in `payment_attempts`.

```bash
# host: authorize up to $150 for 48 h
curl -s -X POST …/api/host/parties/<id>/vendors/<rid>/payments -H "authorization: Bearer $HOST" \
  -H 'content-type: application/json' -d '{"max_amount":150,"purpose":"cake deposit + balance","expires_in_hours":48}'
# agent: pay the $60 deposit (idempotent), later the $90 balance; $100 more would be refused
curl -s -X POST …/vendors/<rid>/payments/<aid> -H "authorization: Bearer $HOST" -H 'idempotency-key: dep1' \
  -H 'content-type: application/json' -d '{"amount":60,"by":{"kind":"agent","name":"Claude"}}'
# host: revoke at any time; GET …/payments/<aid> is the audit trail
```

Providers: `manual` (default) records the intent and tells the host how to pay the vendor directly; the host marks it settled (`PATCH /api/host/parties/<id>/payments/<attemptId>`). `stripe` charges a payment method the host saved with Stripe (`payment_method_ref`, optionally `cus_…:pm_…`), off-session, when `STRIPE_SECRET_KEY` is set; 3-D Secure comes back as `requires_action` for the host to finish in Stripe. This code never sees card details.

## Guest agent

`indby-guest` is a strict CLI with `ical.js` as its only runtime dependency. It reads and answers invites on behalf of a guest.

### Build and run
```bash
cd guest && npm install && npm run build
```

### Commands
```bash
# Read an invite and display details, polls, and available actions
node dist/cli.js read https://indbyagent.com/i/<token>

# RSVP to a party with optional headcount, note, and dietary restrictions
node dist/cli.js rsvp https://indbyagent.com/i/<token> --status yes --party 2

# Rank date poll options against a calendar file, dropping conflicts
node dist/cli.js rank https://indbyagent.com/i/<token> --ics calendar.ics
```

### Idempotency
Re-running any command is always safe. The CLI performs a read-before-write check and exits with `Already set` if the server already reflects your requested RSVP or ranking. Every POST includes an `Idempotency-Key`(user-supplied or derived from the request payload and current invite state), ensuring retries never produce duplicate writes.

### Calendar integration (.ics)
The `rank` command evaluates your `.ics` calendar with `ical.js`, dropping clashing options and ranking remaining dates soonest-first. It assumes a 120-minute event duration when the host omits an end time, treats floating calendar times as matching the party's local timezone, and treats all-day events as conflicting with any party on that day.

### Tests
```bash
cd guest
npm run test:unit         # 133 unit tests with fake server fixtures
npm run test:integration  # End-to-end tests against local app (skips if offline)
npm test                  # Run both unit and integration tests
```

### Privacy
The CLI only contacts the origin of the invite URL provided on the command line; it never makes requests to any external server, third-party API, or analytics service.

## Next
- Inbound vendor email: route replies by sender or the `[IndbyAgent V-xxxx]` subject tag into a `quote` parser (fast path, then one Sonnet 5.5 call with verbatim evidence), with the review queue on low confidence.
- Board card for vendor requests and payments; planner hook (`request_quotes`).

## License
MIT
