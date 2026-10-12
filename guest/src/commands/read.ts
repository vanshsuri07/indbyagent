/**
 * `indby-guest read <invite-url> [--json]`
 *
 * Fetches the invite JSON (GET only, never POST) and prints a
 * human-readable summary or the raw JSON.
 */
import { parseArgs } from "node:util";
import { normalizeInviteUrl, isNormalized } from "../lib/invite-url.js";
import { fetchInvite, parseTimeoutMs } from "../lib/client.js";
import { formatInvite } from "../lib/format.js";

export async function readCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: indby-guest read <invite-url> [--timeout <seconds>] [--json]

Fetch and display an invite.

Options:
  --timeout <seconds>  Request timeout in seconds (default: 30)
  --json               Print the raw invite JSON and nothing else
  --help               Show this help`);
    return 0;
  }

  if (positionals.length === 0) {
    console.error("Missing invite URL.\nUsage: indby-guest read <invite-url> [--timeout <seconds>] [--json]");
    return 2;
  }
  if (positionals.length > 1) {
    console.error("Too many arguments. Expected exactly one invite URL.");
    return 2;
  }

  const timeoutMs = parseTimeoutMs(values.timeout);
  if (timeoutMs === null) {
    console.error("Invalid --timeout: must be a positive number of seconds.");
    return 2;
  }

  const rawUrl = positionals[0];

  // Normalise URL
  const parsed = normalizeInviteUrl(rawUrl);
  if (!isNormalized(parsed)) {
    console.error(parsed.error);
    return 2;
  }

  // Fetch
  const result = await fetchInvite(parsed.jsonUrl, timeoutMs);
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }

  // --json: print raw JSON and exit
  if (values.json) {
    console.log(result.raw);
    return 0;
  }

  // Human summary
  console.log(formatInvite(result.invite, parsed.origin));
  return 0;
}
