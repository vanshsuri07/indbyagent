/**
 * Human-readable formatting of an invite document.
 *
 * Pure function — no I/O, no side effects. Suitable for unit testing
 * without a server.
 */
import type { Invite, ParsedAction, InvitePoll } from "../types.js";

// ---------- action parsing ----------

/**
 * Parse an action string like "POST http://host/i/TOKEN/rsvp"
 * into { name, method, url }.
 */
export function parseAction(name: string, value: string): ParsedAction {
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx === -1) {
    return { name, method: "GET", url: value };
  }
  return {
    name,
    method: value.slice(0, spaceIdx),
    url: value.slice(spaceIdx + 1),
  };
}

// ---------- time formatting ----------

/**
 * Format an ISO datetime string in a given IANA timezone.
 *
 * Falls back to UTC if the timezone is missing or invalid.
 * Returns a tuple of [formattedString, usedTimezone].
 */
export function formatTime(
  iso: string,
  timezone: string | undefined,
): [formatted: string, tz: string] {
  const effectiveTz = resolveTimezone(timezone);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: effectiveTz,
    timeZoneName: "short",
  };
  try {
    const formatted = new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
    return [formatted, effectiveTz];
  } catch {
    // If the timezone is somehow still invalid, fall back to UTC.
    const formatted = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
      new Date(iso),
    );
    return [formatted, "UTC"];
  }
}

/**
 * Format a time for a brief display (hour:minute only), e.g. for ends_at.
 */
function formatTimeBrief(iso: string, timezone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(iso));
  }
}

/**
 * Format a poll option that might be an ISO datetime.
 */
function formatPollOption(option: string, timezone: string): string {
  // Check if this looks like an ISO date string.
  if (/^\d{4}-\d{2}-\d{2}T/.test(option) && !isNaN(Date.parse(option))) {
    const [formatted] = formatTime(option, timezone);
    return formatted;
  }
  return option;
}

/**
 * Resolve a timezone string, falling back to UTC for missing or invalid values.
 */
function resolveTimezone(timezone: string | undefined): string {
  if (!timezone) return "UTC";
  try {
    // Validate by attempting to use it.
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

// ---------- main formatter ----------

/**
 * Format an invite document as a human-readable summary.
 *
 * Only prints lines that have data. Returns the full multi-line string.
 *
 * @param invite     The invite document.
 * @param inviteOrigin  The origin of the URL the user provided (for
 *                      cross-origin action warnings).
 */
export function formatInvite(invite: Invite, inviteOrigin: string): string {
  const lines: string[] = [];

  // Title
  lines.push(invite.party.title);

  // When
  if (invite.party.starts_at) {
    const tz = invite.party.timezone;
    const effectiveTz = resolveTimezone(tz);
    const [startFormatted] = formatTime(invite.party.starts_at, tz);
    let whenLine = `When:    ${startFormatted}`;
    if (tz && effectiveTz !== "UTC") {
      whenLine += ` (${tz})`;
    } else if (effectiveTz === "UTC" && tz) {
      whenLine += ` (${tz} — invalid, showing UTC)`;
    } else if (effectiveTz === "UTC" && !tz) {
      whenLine += ` (UTC)`;
    }

    if (invite.party.ends_at) {
      const endBrief = formatTimeBrief(invite.party.ends_at, effectiveTz);
      whenLine += ` – ${endBrief}`;
    }
    lines.push(whenLine);
  } else if (invite.party.date === "tbd") {
    lines.push("When:    Date TBD — vote on the dates");
  }

  // Where
  if (invite.party.location) {
    lines.push(`Where:   ${invite.party.location}`);
  }

  // Details
  if (invite.party.details) {
    lines.push(`Details: ${invite.party.details}`);
  }

  // RSVP by
  if (invite.party.rsvp_by) {
    const tz = invite.party.timezone;
    const [rsvpByFormatted] = formatTime(invite.party.rsvp_by, tz);
    lines.push(`RSVP by: ${rsvpByFormatted}`);
  }

  // Guest
  const guestLine = `Guest:   ${invite.guest.name} (up to ${invite.guest.party_size_max} ${invite.guest.party_size_max === 1 ? "person" : "people"})`;
  lines.push(guestLine);

  // RSVP
  let rsvpLine = `RSVP:    ${invite.rsvp.status}`;
  const rsvpDetails: string[] = [];
  if (invite.rsvp.party_size != null) {
    rsvpDetails.push(`party size: ${invite.rsvp.party_size}`);
  }
  if (invite.rsvp.dietary && invite.rsvp.dietary.length > 0) {
    rsvpDetails.push(`dietary: ${invite.rsvp.dietary.join(", ")}`);
  }
  if (invite.rsvp.note) {
    rsvpDetails.push(`note: "${invite.rsvp.note}"`);
  }
  if (invite.rsvp.by) {
    const byStr = invite.rsvp.by.name
      ? `by ${invite.rsvp.by.kind} (${invite.rsvp.by.name})`
      : `by ${invite.rsvp.by.kind}`;
    rsvpDetails.push(byStr);
  }
  if (rsvpDetails.length > 0) {
    rsvpLine += ` — ${rsvpDetails.join(", ")}`;
  }
  lines.push(rsvpLine);

  // Polls
  const polls = invite.polls;
  if (!polls || polls.length === 0) {
    let pollLine = "Polls:   none open";
    if (invite.polls_after_yes) {
      pollLine += ` (${invite.polls_after_yes} unlock${invite.polls_after_yes > 1 ? "" : "s"} after RSVP yes)`;
    }
    lines.push(pollLine);
  } else {
    lines.push("Polls:");
    const tz = resolveTimezone(invite.party.timezone);
    for (const poll of polls) {
      lines.push(formatPoll(poll, tz));
    }
    if (invite.polls_after_yes) {
      lines.push(`  (${invite.polls_after_yes} more poll${invite.polls_after_yes > 1 ? "s unlock" : " unlocks"} after RSVP yes)`);
    }
  }

  // Hint
  if (invite.hint) {
    lines.push(`Hint:    ${invite.hint}`);
  }

  // Actions
  const actionEntries = Object.entries(invite.actions).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );
  if (actionEntries.length > 0) {
    const parsed = actionEntries.map(([name, val]) => parseAction(name, val));
    const actionNames = parsed.map((a) => `${a.name} (${a.method})`);
    lines.push(`Actions: ${actionNames.join(", ")}`);

    // Cross-origin warnings
    const crossOriginActions = new Map<string, string[]>();
    for (const action of parsed) {
      try {
        const actionOrigin = new URL(action.url).origin;
        if (actionOrigin !== inviteOrigin) {
          const actionNamesForOrigin = crossOriginActions.get(actionOrigin) ?? [];
          actionNamesForOrigin.push(action.name);
          crossOriginActions.set(actionOrigin, actionNamesForOrigin);
        }
      } catch {
        // If the URL can't be parsed (e.g. has {id} template), skip warning.
      }
    }
    for (const [actionOrigin, actionNames] of crossOriginActions) {
      lines.push(
        `⚠ Server action URLs use ${actionOrigin}, not ${inviteOrigin} (${actionNames.join(", ")})`,
      );
    }
  }

  return lines.join("\n");
}

// ---------- poll formatting ----------

function formatPoll(poll: InvitePoll, timezone: string): string {
  const parts: string[] = [];
  parts.push(`  [${poll.kind}] ${poll.q ?? "(no question)"} (id: ${poll.id})`);

  const formattedOptions = poll.options.map((o) => formatPollOption(o, timezone));
  parts.push(`    Options: ${formattedOptions.join(", ")}`);

  if (poll.kind === "dates" && poll.your_ranking && poll.your_ranking.length > 0) {
    const formattedRanking = poll.your_ranking.map((o) => formatPollOption(o, timezone));
    parts.push(`    Your ranking: ${formattedRanking.join(" > ")}`);
  } else if (poll.kind !== "dates" && poll.your_answer) {
    parts.push(`    Your answer: ${poll.your_answer}`);
  } else {
    parts.push(`    Not answered yet`);
  }

  if (poll.closes_at) {
    const [closesFormatted] = formatTime(poll.closes_at, timezone);
    parts.push(`    Closes: ${closesFormatted}`);
  }

  return parts.join("\n");
}
