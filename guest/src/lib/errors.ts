/**
 * Error printing and formatting for server responses.
 *
 * Implements self-correcting error output for agents:
 * - 400 business rules: prints server message, option lists if present, full schema piece, and request.
 * - 400 Zod failures: prints issues, highlights matching schema keys under "Fields to fix", and request.
 * - 404: token wrong or revoked; no schema; never prints token.
 * - 5xx / timeouts / network errors: prints cause and retrying hint; no schema.
 * - --json: prints single JSON object { status, error, issues?, schema_piece?, request }.
 * - Exit code 1 for all of these.
 */
import { canonicalJson } from "./canonical-json.js";

export const COMMAND_SCHEMA_KEY_MAP: Record<string, string> = {
  rsvp: "rsvp",
  rank: "rank_poll",
  answer_poll: "answer_poll",
  message_host: "message_host",
};

export interface ServerErrorOptions {
  command: string;
  status?: number;
  body?: unknown;
  schema?: Record<string, unknown>;
  request?: unknown;
  json?: boolean;
  networkError?: string;
}

export function extractOptions(errorText: string): string[] | null {
  const match = errorText.match(/(?:must be (?:one of|options):?|options:)\s*(.*)/i);
  if (match && match[1]) {
    const rawList = match[1].trim();
    if (rawList.length > 0) {
      const parts = rawList.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts;
    }
  }
  return null;
}

export function formatSchemaLines(schemaPiece: Record<string, unknown>): string[] {
  const keys = Object.keys(schemaPiece);
  const maxLen = Math.max(...keys.map((k) => (k + ":").length), 0);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(schemaPiece)) {
    const valStr = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    lines.push(`  ${(k + ":").padEnd(maxLen + 2)} ${valStr}`);
  }
  return lines;
}

export function printServerError(options: ServerErrorOptions): void;
export function printServerError(endpoint: string, status: number, body: unknown): void;
export function printServerError(
  optOrEndpoint: string | ServerErrorOptions,
  legacyStatus?: number,
  legacyBody?: unknown,
): void {
  if (typeof optOrEndpoint === "string") {
    if (typeof legacyBody === "object" && legacyBody !== null) {
      const b = legacyBody as Record<string, unknown>;
      const msg = b.error ?? b.message;
      if (typeof msg === "string") {
        console.error(msg);
      } else {
        console.error(`Server returned ${legacyStatus}`);
      }
      if (Array.isArray(b.issues)) {
        for (const issue of b.issues) {
          console.error(String(issue));
        }
      }
    } else if (typeof legacyBody === "string" && legacyBody.trim()) {
      console.error(legacyBody);
    } else {
      console.error(`Server returned ${legacyStatus}`);
    }
    return;
  }

  const opts = optOrEndpoint;

  const status = opts.status ?? (opts.networkError ? 0 : 500);
  let errorMessage = "";
  let issues: string[] | undefined = undefined;

  if (opts.networkError) {
    errorMessage = opts.networkError;
  } else if (typeof opts.body === "object" && opts.body !== null) {
    const b = opts.body as Record<string, unknown>;
    const msg = b.error ?? b.message;
    if (typeof msg === "string") {
      errorMessage = msg;
    } else {
      errorMessage = `Server returned ${status}`;
    }
    if (Array.isArray(b.issues)) {
      issues = b.issues.map(String);
    }
  } else if (typeof opts.body === "string" && opts.body.trim()) {
    errorMessage = opts.body.trim();
  } else {
    errorMessage = `Server returned ${status}`;
  }

  // 404: token wrong or revoked; no schema; never print the token
  if (status === 404) {
    const notFoundMsg = "The invite token is wrong or revoked.";
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            status: 404,
            error: notFoundMsg,
            ...(opts.request !== undefined ? { request: opts.request } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.error(`Server rejected the request (404): ${notFoundMsg}`);
    return;
  }

  // 5xx, timeouts and network errors: print cause and retrying hint; no schema
  if (status >= 500 || opts.networkError) {
    let errorWithHint = errorMessage.replace(/\.+$/, "");
    if (!errorWithHint.toLowerCase().includes("retrying may help") && !errorWithHint.toLowerCase().includes("retrying is safe")) {
      errorWithHint = `${errorWithHint}. Retrying may help.`;
    } else {
      errorWithHint = `${errorWithHint}.`;
    }
    const fullError = status >= 500 ? `Server error (${status}): ${errorWithHint}` : errorWithHint;
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            status,
            error: fullError,
            ...(opts.request !== undefined ? { request: opts.request } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.error(fullError);
    return;
  }

  // 400 errors: locate the relevant schema piece
  const schemaKey = COMMAND_SCHEMA_KEY_MAP[opts.command] ?? opts.command;
  const schemaPiece = opts.schema
    ? (opts.schema[schemaKey] as Record<string, unknown> | undefined)
    : undefined;

  // With --json: print a single JSON object { status, error, issues?, schema_piece?, request }
  if (opts.json) {
    const jsonOut: Record<string, unknown> = {
      status,
      error: errorMessage,
    };
    if (issues && issues.length > 0) {
      jsonOut.issues = issues;
    }
    if (schemaPiece !== undefined) {
      jsonOut.schema_piece = schemaPiece;
    }
    if (opts.request !== undefined) {
      jsonOut.request = opts.request;
    }
    console.log(JSON.stringify(jsonOut, null, 2));
    return;
  }

  // Non-JSON formatting for 400
  const lines: string[] = [];
  lines.push(`Server rejected the request (400): ${errorMessage}`);

  if (!schemaPiece) {
    // If the schema piece is missing from the document, say so and print only the error
    lines.push(`The schema piece for ${opts.command} was omitted by the server.`);
    if (opts.request !== undefined) {
      lines.push(`Your request: ${canonicalJson(opts.request)}`);
    }
    console.error(lines.join("\n"));
    return;
  }

  // If Zod issues exist: print each issue on its own line and "Fields to fix"
  if (issues && issues.length > 0) {
    const matchedFields: Array<{ key: string; expected: string }> = [];
    const seenKeys = new Set<string>();

    if (typeof schemaPiece === "object" && schemaPiece !== null) {
      for (const issue of issues) {
        const colonIdx = issue.indexOf(":");
        const pathPart = colonIdx !== -1 ? issue.slice(0, colonIdx).trim() : issue.trim();
        const firstSegment = pathPart.split(".")[0].trim();
        if (firstSegment in schemaPiece && !seenKeys.has(firstSegment)) {
          seenKeys.add(firstSegment);
          const val = (schemaPiece as Record<string, unknown>)[firstSegment];
          const valStr = typeof val === "object" && val !== null ? JSON.stringify(val) : String(val);
          matchedFields.push({ key: firstSegment, expected: valStr });
        }
      }
    }

    if (matchedFields.length > 0) {
      lines.push("Fields to fix:");
      const maxKeyLen = Math.max(...matchedFields.map((f) => (f.key + ":").length), 0);
      for (const f of matchedFields) {
        lines.push(`  ${(f.key + ":").padEnd(maxKeyLen + 2)} ${f.expected}`);
      }
    }

    lines.push("Issues:");
    for (const issue of issues) {
      lines.push(`  ${issue}`);
    }

    if (opts.request !== undefined) {
      lines.push(`Your request: ${canonicalJson(opts.request)}`);
    }

    console.error(lines.join("\n"));
    return;
  }

  // Business-rule errors with no field information:
  // If error text contains an option list, print options one per line
  const optionsList = extractOptions(errorMessage);
  if (optionsList && optionsList.length > 0) {
    lines.push("Options:");
    for (const opt of optionsList) {
      lines.push(`  - ${opt}`);
    }
  }

  // Print the whole schema piece
  lines.push(`Expected for ${opts.command}:`);
  if (typeof schemaPiece === "object" && schemaPiece !== null) {
    lines.push(...formatSchemaLines(schemaPiece));
  } else {
    lines.push(`  ${String(schemaPiece)}`);
  }

  if (opts.request !== undefined) {
    lines.push(`Your request: ${canonicalJson(opts.request)}`);
  }

  console.error(lines.join("\n"));
}
