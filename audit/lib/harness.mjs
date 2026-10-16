// Shared helpers: drive the running app's host + guest APIs.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const BASE = process.env.INDBY_BASE_URL || "http://localhost:3000";

export async function call(method, path, { body, headers = {}, base = BASE } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (body !== undefined) {
    init.headers["content-type"] = init.headers["content-type"] || "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    location: res.headers.get("location") || null,
    text,
    json,
  };
}

export async function save(relPath, contents) {
  mkdirSync(dirname(relPath), { recursive: true });
  writeFileSync(relPath, contents);
  return relPath;
}

const DAY = 86400_000;

export function futureIso(daysFromNow, hourUtc = 18) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromNow, hourUtc, 0, 0));
  return d.toISOString();
}

/**
 * Create a party the way the host board does, with a dates poll and a
 * preference poll, plus guests. Returns everything a probe needs.
 */
export async function seed({ title, backupDates, partySizeMax = 2, extraPreferencePoll = null, startsAt = null }) {
  const partyRes = await call("POST", "/api/host/parties", {
    body: {
      title,
      kind: "birthday",
      timezone: "America/Los_Angeles",
      location: "Pier 27, San Francisco",
      details: "Rooftop, bring a layer. Cake at 8.",
      rsvp_by: new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10),
      ...(startsAt ? { starts_at: startsAt } : {}),
      backup_dates: backupDates,
    },
  });
  if (partyRes.status !== 201) throw new Error(`seed party failed: ${partyRes.status} ${partyRes.text}`);
  const party = partyRes.json.party;
  const datePoll = partyRes.json.date_poll;

  const guestsRes = await call("POST", `/api/host/parties/${party.id}/guests`, {
    body: { guests: [{ name: "Leo Chen", party_size_max: partySizeMax }] },
  });
  if (guestsRes.status !== 200 && guestsRes.status !== 201) {
    throw new Error(`seed guest failed: ${guestsRes.status} ${guestsRes.text}`);
  }
  const guest = guestsRes.json.guests[0];

  let prefPoll = null;
  if (extraPreferencePoll) {
    const prefRes = await call("POST", `/api/host/parties/${party.id}/polls`, {
      body: { kind: "preference", question: "What should we eat?", options: ["tacos", "pizza", "sushi"], ...extraPreferencePoll },
    });
    if (prefRes.status !== 201) throw new Error(`seed pref poll failed: ${prefRes.status} ${prefRes.text}`);
    prefPoll = prefRes.json.poll;
  }

  return {
    party,
    datePoll,
    prefPoll,
    guest,
    token: guest.token,
    inviteUrl: `${BASE}/i/${guest.token}`,
  };
}
