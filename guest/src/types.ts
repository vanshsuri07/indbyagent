/**
 * Invite document types for indby-guest CLI.
 *
 * These mirror the JSON shape produced by the IndbyAgent server (see
 * src/lib/invite.ts inviteJson()). Every field except those in the minimum
 * set (indbyagent, party.title, guest.name, guest.party_size_max,
 * rsvp.status, actions.rsvp) is optional because the server's strip()
 * removes empty/null/undefined values before serialisation.
 */

// ---------- top-level invite document ----------

export interface Invite {
  indbyagent: string;
  party: InviteParty;
  guest: InviteGuest;
  rsvp: InviteRsvp;
  polls_after_yes?: number;
  polls?: InvitePoll[];
  actions: InviteActions;
  schema: Record<string, unknown>;
  hint?: string;
}

// ---------- party ----------

export interface InviteParty {
  title: string;
  kind?: string;
  starts_at?: string;   // ISO 8601 UTC
  ends_at?: string;     // ISO 8601 UTC
  timezone?: string;    // IANA timezone, e.g. "Asia/Calcutta"
  location?: string;
  details?: string;
  rsvp_by?: string;
  date?: "tbd";         // present instead of starts_at when date is not set
}

// ---------- guest ----------

export interface InviteGuest {
  name: string;
  party_size_max: number;
}

// ---------- RSVP ----------

export interface InviteRsvp {
  status: "pending" | "yes" | "no" | "maybe" | "needs_human";
  party_size?: number;
  dietary?: string[];
  note?: string;
  by?: { kind: "agent" | "human"; name?: string };
}

// ---------- polls ----------

export interface InvitePoll {
  id: string;
  kind: "preference" | "dates";
  q: string;
  options: string[];
  timezone?: string;     // set on dates polls to party.timezone
  closes_at?: string;    // ISO 8601 UTC
  your_answer?: string;  // preference polls only
  your_ranking?: string[]; // dates polls only
}

// ---------- actions ----------

/** Action values are strings like "POST http://host/i/TOKEN/rsvp". */
export interface InviteActions {
  rsvp: string;
  rank_poll?: string;
  answer_poll?: string;
  message_host?: string;
  calendar?: string;
  [key: string]: string | undefined;
}

// ---------- parsed action ----------

export interface ParsedAction {
  name: string;
  method: string;
  url: string;
}
