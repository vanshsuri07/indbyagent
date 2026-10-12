/**
 * `indby-guest rsvp <invite-url> --status yes|no|maybe [options]`
 *
 * Idempotently submits an RSVP to an invite.
 */
import { parseArgs } from "node:util";
import { normalizeInviteUrl, isNormalized } from "../lib/invite-url.js";
import { fetchInvite, postRsvp } from "../lib/client.js";
import { formatInvite } from "../lib/format.js";
import { deriveIdempotencyKey } from "../lib/idempotency.js";
import { printServerError } from "../lib/errors.js";
import type { Invite } from "../types.js";

export function rsvpMatches(
  current: Invite["rsvp"],
  status: string,
  party?: number,
  dietary?: string[],
  note?: string,
): boolean {
  if (current.status !== status) return false;
  if (party !== undefined && current.party_size !== party) return false;
  if (note !== undefined && (current.note ?? "") !== note) return false;
  if (dietary !== undefined) {
    const curDietary = current.dietary ?? [];
    if (curDietary.length !== dietary.length) return false;
    for (let i = 0; i < dietary.length; i++) {
      if (curDietary[i] !== dietary[i]) return false;
    }
  }
  return true;
}

export async function rsvpCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      status: { type: "string" },
      party: { type: "string" },
      note: { type: "string" },
      dietary: { type: "string" },
      "idempotency-key": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: indby-guest rsvp <invite-url> --status yes|no|maybe [options]

Submit an RSVP to an invite.

Options:
  --status <status>       RSVP status (yes, no, maybe) [required]
  --party <count>         Party size (non-negative integer)
  --note <note>           Note for the host
  --dietary <a,b,c>       Dietary preferences (comma-separated)
  --idempotency-key <key> Custom idempotency key
  --json                  Print the raw invite JSON and nothing else
  --help                  Show this help`);
    return 0;
  }

  if (positionals.length === 0) {
    console.error("Missing invite URL.\nUsage: indby-guest rsvp <invite-url> --status yes|no|maybe [options]");
    return 2;
  }
  if (positionals.length > 1) {
    console.error("Too many arguments. Expected exactly one invite URL.");
    return 2;
  }

  if (!values.status) {
    console.error("Missing required option --status. Must be yes, no, or maybe.");
    return 2;
  }

  const requestedStatus = values.status;
  if (requestedStatus !== "yes" && requestedStatus !== "no" && requestedStatus !== "maybe") {
    console.error(`Invalid --status: "${requestedStatus}". Must be yes, no, or maybe.`);
    return 2;
  }

  let requestedParty: number | undefined;
  if (values.party !== undefined) {
    if (!/^\d+$/.test(values.party)) {
      console.error("Invalid --party: must be a non-negative integer.");
      return 2;
    }
    requestedParty = parseInt(values.party, 10);
  }

  const requestedDietary =
    values.dietary !== undefined
      ? values.dietary.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  const requestedNote = values.note;

  // Normalise URL
  const rawUrl = positionals[0];
  const parsed = normalizeInviteUrl(rawUrl);
  if (!isNormalized(parsed)) {
    console.error(parsed.error);
    return 2;
  }

  // GET current invite first
  const getRes = await fetchInvite(parsed.jsonUrl);
  if (!getRes.ok) {
    console.error(getRes.message);
    return 1;
  }
  const currentInvite = getRes.invite;

  // Already set check
  if (rsvpMatches(currentInvite.rsvp, requestedStatus, requestedParty, requestedDietary, requestedNote)) {
    if (values.json) {
      console.log(getRes.raw);
      return 0;
    }
    console.log("Already set, nothing sent");
    console.log(formatInvite(currentInvite, parsed.origin));
    return 0;
  }

  // Build POST URL from the user-typed origin
  const postUrl = `${parsed.origin}/i/${parsed.token}/rsvp`;

  // Build body with only provided optional fields
  const body: Record<string, unknown> = {
    status: requestedStatus,
    by: { kind: "agent", name: "indby-guest" },
  };
  if (requestedParty !== undefined) {
    body.party_size = requestedParty;
  }
  if (requestedDietary !== undefined) {
    body.dietary = requestedDietary;
  }
  if (requestedNote !== undefined) {
    body.note = requestedNote;
  }

  // Determine idempotency key
  const idempotencyKey =
    values["idempotency-key"] ||
    deriveIdempotencyKey(parsed.token, body, currentInvite.rsvp);

  // POST RSVP
  const postRes = await postRsvp(postUrl, body, idempotencyKey);
  if (!postRes.ok) {
    if (postRes.kind === "http") {
      printServerError(postUrl, postRes.status, postRes.body);
      return 1;
    }
    console.error(postRes.message);
    return 1;
  }

  const freshInvite = postRes.invite;

  // Compare returned invite's RSVP with what was requested
  if (!rsvpMatches(freshInvite.rsvp, requestedStatus, requestedParty, requestedDietary, requestedNote)) {
    console.error(
      "Warning: The server returned a different RSVP than requested; the request may have been ignored (for example, due to a reused idempotency key).",
    );
    return 1;
  }

  if (values.json) {
    console.log(postRes.raw);
    return 0;
  }

  console.log(formatInvite(freshInvite, parsed.origin));
  return 0;
}
