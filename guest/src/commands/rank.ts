/**
 * `indby-guest rank <invite-url> --ics <file> [options]`
 *
 * Reads a local .ics calendar, drops options that clash with existing events,
 * ranks remaining options soonest first, and idempotently POSTs to the poll rank endpoint.
 */
import { parseArgs } from "node:util";
import * as fs from "node:fs";
import { normalizeInviteUrl, isNormalized } from "../lib/invite-url.js";
import { fetchInvite, postRank, parseTimeoutMs } from "../lib/client.js";
import { formatInvite, formatTime } from "../lib/format.js";
import { parseIcs, isValidIanaTimeZone, type ParseIcsResult } from "../lib/ics.js";
import {
  evaluatePollOptions,
  rankingMatches,
  type RankingResult,
} from "../lib/ranking.js";
import { deriveIdempotencyKey } from "../lib/idempotency.js";
import { printServerError } from "../lib/errors.js";
import type { InvitePoll } from "../types.js";

/**
 * Describe a filesystem read error in plain words without raw Node error text.
 */
function describeFileReadError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "not found";
  if (code === "EACCES" || code === "EPERM") return "not readable";
  if (code === "EISDIR") return "not readable (is a directory)";
  return "not readable";
}

/**
 * Format the calendar and ranking summary before any POST or dry run.
 */
function printRankingReport(
  icsFile: string,
  parseResult: ParseIcsResult,
  rankingResult: RankingResult,
  partyTz: string,
): void {
  console.log(
    `Calendar: ${icsFile} (${parseResult.totalEventsChecked} events checked, ${parseResult.recurringExpanded} recurring expanded, ${parseResult.warnings.length} warnings)`,
  );
  if (parseResult.totalEventsChecked === 0) {
    console.log(
      "Warning: calendar yielded 0 events (nothing parsed — do not confuse with no clashes)",
    );
  }
  for (const w of parseResult.warnings) {
    console.log(`Warning: ${w}`);
  }

  if (rankingResult.dropped.length === 0) {
    console.log("Dropped:  none");
  } else {
    for (let i = 0; i < rankingResult.dropped.length; i++) {
      const d = rankingResult.dropped[i];
      const [optFormatted, effTz] = formatTime(d.option, partyTz);
      const prefix = i === 0 ? "Dropped:  " : "          ";
      console.log(`${prefix}${optFormatted} (${effTz}) — ${d.reason}`);
    }
  }

  if (rankingResult.truncated) {
    console.log(
      `Notice: Server accepts at most 8 ranked options; keeping first 8 of ${rankingResult.totalKept}.`,
    );
  }

  if (rankingResult.kept.length === 0) {
    console.log("Ranking:  none");
  } else {
    for (let i = 0; i < rankingResult.kept.length; i++) {
      const opt = rankingResult.kept[i];
      const [optFormatted, effTz] = formatTime(opt, partyTz);
      const prefix = i === 0 ? "Ranking:  " : "          ";
      console.log(`${prefix}${i + 1}. ${optFormatted} (${effTz})`);
    }
  }
}

export async function rankCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ics: { type: "string" },
      poll: { type: "string" },
      duration: { type: "string" },
      "calendar-tz": { type: "string" },
      note: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "idempotency-key": { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: indby-guest rank <invite-url> --ics <file> [options]

Rank dates poll options using calendar clash detection.

Options:
  --ics <file>            Path to .ics calendar file [required]
  --poll <id>             Specific dates poll ID (required if invite has multiple)
  --duration <minutes>    Event duration in minutes for clash checks (default: 120)
  --calendar-tz <IANA>    Timezone for interpreting floating/all-day events (default: poll/party timezone)
  --note <note>           Note for the host
  --dry-run               Check clashes and show ranking without sending POST
  --idempotency-key <key> Custom idempotency key
  --timeout <seconds>     Request timeout in seconds (default: 30)
  --json                  Print JSON output
  --help                  Show this help`);
    return 0;
  }

  if (positionals.length === 0) {
    console.error(
      "Missing invite URL.\nUsage: indby-guest rank <invite-url> --ics <file> [options]",
    );
    return 2;
  }
  if (positionals.length > 1) {
    console.error("Too many arguments. Expected exactly one invite URL.");
    return 2;
  }

  if (!values.ics) {
    console.error("Missing required option --ics <file>.");
    return 2;
  }

  const timeoutMs = parseTimeoutMs(values.timeout);
  if (timeoutMs === null) {
    console.error("Invalid --timeout: must be a positive number of seconds.");
    return 2;
  }

  let durationMinutes = 120;
  if (values.duration !== undefined) {
    if (!/^\d+$/.test(values.duration) || parseInt(values.duration, 10) <= 0) {
      console.error("Invalid --duration: must be a positive integer.");
      return 2;
    }
    durationMinutes = parseInt(values.duration, 10);
  }

  const userCalendarTz = values["calendar-tz"];
  if (userCalendarTz !== undefined && !isValidIanaTimeZone(userCalendarTz)) {
    console.error(
      `Invalid --calendar-tz: "${userCalendarTz}". Must be a valid IANA timezone (e.g. "Asia/Calcutta", "America/New_York").`,
    );
    return 2;
  }

  // Read .ics file
  let icsContent: string;
  try {
    icsContent = fs.readFileSync(values.ics, "utf-8");
  } catch (err: unknown) {
    console.error(
      `Cannot read calendar file ${values.ics}: ${describeFileReadError(err)}`,
    );
    return 2;
  }

  // Parse invite URL
  const parsed = normalizeInviteUrl(positionals[0]);
  if (!isNormalized(parsed)) {
    console.error(parsed.error);
    return 2;
  }

  // Fetch current invite document
  const getRes = await fetchInvite(parsed.jsonUrl, timeoutMs);
  if (!getRes.ok) {
    printServerError({
      command: "rank",
      status: getRes.status,
      body: getRes.body ?? { error: getRes.message },
      networkError: getRes.status ? undefined : getRes.message,
      json: values.json,
    });
    return 1;
  }
  const currentInvite = getRes.invite;

  // Find target dates poll
  const datePolls = (currentInvite.polls ?? []).filter((p) => p.kind === "dates");
  if (datePolls.length === 0) {
    console.error("No dates poll open for this invite.");
    return 1;
  }

  let targetPoll: InvitePoll;
  if (values.poll) {
    const found = (currentInvite.polls ?? []).find((p) => p.id === values.poll);
    if (!found) {
      console.error(`Unknown poll id: ${values.poll}`);
      console.error("Valid polls:");
      for (const p of currentInvite.polls ?? []) {
        console.error(`  ${p.id}: ${p.q}`);
      }
      return 2;
    }
    if (found.kind !== "dates") {
      console.error(
        `Poll ${values.poll} is a "${found.kind}" poll, not a dates poll.`,
      );
      console.error("Valid dates polls:");
      for (const p of datePolls) {
        console.error(`  ${p.id}: ${p.q}`);
      }
      return 2;
    }
    targetPoll = found;
  } else if (datePolls.length === 1) {
    targetPoll = datePolls[0];
  } else {
    console.error("Multiple dates polls open. Specify one with --poll <id>:");
    for (const p of datePolls) {
      console.error(`  ${p.id}: ${p.q}`);
    }
    return 1;
  }

  const partyTz = targetPoll.timezone || currentInvite.party.timezone || "UTC";
  const effectiveCalendarTz = userCalendarTz || partyTz;

  // Determine evaluation window for unbounded recurrence safety
  const optTimes = targetPoll.options
    .map((o) => Date.parse(o))
    .filter((t) => !isNaN(t));
  const minOptMs =
    optTimes.length > 0 ? Math.min(...optTimes) - 24 * 3600 * 1000 : undefined;
  const maxOptMs =
    optTimes.length > 0
      ? Math.max(...optTimes) + durationMinutes * 60 * 1000 + 24 * 3600 * 1000
      : undefined;

  // Parse .ics busy intervals
  let parseResult: ParseIcsResult;
  try {
    parseResult = parseIcs({
      icsContent,
      calendarTz: effectiveCalendarTz,
      windowStartMs: minOptMs,
      windowEndMs: maxOptMs,
    });
  } catch (err: unknown) {
    console.error(
      `Error parsing calendar: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // Evaluate options
  const rankingResult = evaluatePollOptions(
    targetPoll.options,
    durationMinutes,
    partyTz,
    parseResult.intervals,
  );

  // Always print the calendar, dropped, and ranking summary before any POST or dry run (when not --json)
  if (!values.json) {
    printRankingReport(values.ics, parseResult, rankingResult, partyTz);
  }

  // If every option clashes, send nothing and exit 1
  if (rankingResult.kept.length === 0) {
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            error: "all options clash with existing calendar events",
            dropped: rankingResult.dropped,
          },
          null,
          2,
        ),
      );
      return 1;
    }
    console.error(
      "All options clash with existing events on your calendar; no options can be ranked. You can message the host to propose alternatives (POST /i/<token>/message).",
    );
    return 1;
  }

  // Prepare request body and URL
  const postUrl = `${parsed.origin}/i/${parsed.token}/polls/${targetPoll.id}/rank`;
  const body: Record<string, unknown> = {
    ranking: rankingResult.kept,
    by: { kind: "agent", name: "indby-guest" },
  };
  if (values.note !== undefined) {
    body.note = values.note;
  }

  const idempotencyKey =
    values["idempotency-key"] ||
    deriveIdempotencyKey(parsed.token, body, targetPoll.your_ranking);

  // Dry-run mode
  if (values["dry-run"]) {
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            dry_run: true,
            post_url: postUrl,
            idempotency_key: idempotencyKey,
            body,
            ranking: rankingResult.kept,
            dropped: rankingResult.dropped,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    console.log(`Dry run: would POST to ${postUrl}`);
    console.log(`Idempotency-Key: ${idempotencyKey}`);
    console.log(`Payload: ${JSON.stringify(body, null, 2)}`);
    return 0;
  }

  // Already set check: if --note is given, always send because poll notes are not echoed back in invite doc
  if (values.note === undefined && rankingMatches(targetPoll.your_ranking, rankingResult.kept)) {
    if (values.json) {
      console.log(getRes.raw);
      return 0;
    }
    console.log("Already set, nothing sent");
    console.log(formatInvite(currentInvite, parsed.origin));
    return 0;
  }

  // POST ranking to server
  const postRes = await postRank(postUrl, body, idempotencyKey, timeoutMs);
  if (!postRes.ok) {
    if (postRes.kind === "http") {
      printServerError({
        command: "rank",
        status: postRes.status,
        body: postRes.body,
        schema: currentInvite.schema,
        request: body,
        json: values.json,
      });
      return 1;
    }
    printServerError({
      command: "rank",
      networkError: postRes.message,
      schema: currentInvite.schema,
      request: body,
      json: values.json,
    });
    return 1;
  }

  const freshInvite = postRes.invite;
  const freshPoll = (freshInvite.polls ?? []).find((p) => p.id === targetPoll.id);

  // Verify returned ranking matches requested
  if (!rankingMatches(freshPoll?.your_ranking, rankingResult.kept)) {
    const formatOrderedList = (opts: string[] | undefined): string => {
      if (!opts || opts.length === 0) return "none";
      return opts
        .map((o, i) => {
          const [formatted, effTz] = formatTime(o, partyTz);
          return `${i + 1}. ${formatted} (${effTz})`;
        })
        .join(", ");
    };
    console.error(
      "Error: The server returned a different ranking than the one sent.",
    );
    console.error(`Requested: ${formatOrderedList(rankingResult.kept)}`);
    console.error(`Server has: ${formatOrderedList(freshPoll?.your_ranking)}`);
    console.error(`Idempotency-Key: ${idempotencyKey}`);
    console.error(
      "Most likely cause: a reused --idempotency-key caused the server to ignore the request.",
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
