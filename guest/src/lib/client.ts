/**
 * HTTP client for fetching invite JSON.
 *
 * Uses built-in fetch (Node 22), no runtime dependencies.
 * GET only — read must never POST or modify server state.
 */
import type { Invite } from "../types.js";

const USER_AGENT = "indby-guest/0.1";
const TIMEOUT_MS = 10_000;

export interface FetchResult {
  ok: true;
  invite: Invite;
  raw: string;
}
export interface FetchError {
  ok: false;
  message: string;
}

/**
 * Fetch an invite document from the given .json URL.
 *
 * Returns the parsed Invite on success or a one-line error message
 * on failure. Never throws.
 */
export async function fetchInvite(jsonUrl: string): Promise<FetchResult | FetchError> {
  let res: Response;
  try {
    res = await fetch(jsonUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, message: `Request timed out after ${TIMEOUT_MS / 1000}s` };
    }
    if (err instanceof TypeError) {
      // fetch throws TypeError for network errors (DNS, connection refused, etc.)
      return { ok: false, message: `Network error: ${err.message}` };
    }
    return { ok: false, message: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    // Try to read a JSON error body with a "message" or "error" field.
    if (contentType.includes("application/json")) {
      try {
        const body = await res.json() as Record<string, unknown>;
        const msg = body.error ?? body.message;
        if (typeof msg === "string") {
          return { ok: false, message: msg };
        }
      } catch {
        // Fall through to generic message.
      }
    }
    return { ok: false, message: `Server returned ${res.status} ${res.statusText}` };
  }

  if (!contentType.includes("application/json")) {
    return { ok: false, message: `Expected JSON but got ${contentType || "unknown content type"}` };
  }

  let raw: string;
  let data: unknown;
  try {
    raw = await res.text();
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: "Response body is not valid JSON" };
  }

  // Basic validation: must look like a personal invite.
  if (
    typeof data !== "object" ||
    data === null ||
    !("guest" in data) ||
    typeof (data as Record<string, unknown>).guest !== "object"
  ) {
    return {
      ok: false,
      message: "This does not look like a personal invite (no guest object); it may be a join document.",
    };
  }

  const invite = data as Invite;
  if (!invite.actions?.rsvp) {
    return {
      ok: false,
      message: "This does not look like a personal invite (no rsvp action); it may be a join document.",
    };
  }

  return { ok: true, invite, raw };
}

export type PostRsvpResult =
  | { ok: true; invite: Invite; raw: string }
  | { ok: false; kind: "http"; status: number; body: unknown }
  | { ok: false; kind: "network"; message: string };

export type PostRankResult = PostRsvpResult;

/**
 * POST an RSVP to the specified RSVP endpoint.
 */
export async function postRsvp(
  rsvpUrl: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<PostRsvpResult> {
  return postJson(rsvpUrl, body, idempotencyKey);
}

/**
 * POST a poll ranking to the specified rank endpoint.
 */
export async function postRank(
  rankUrl: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<PostRankResult> {
  return postJson(rankUrl, body, idempotencyKey);
}

async function postJson(
  endpointUrl: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<PostRsvpResult> {
  let res: Response;
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  try {
    res = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, kind: "network", message: `Request timed out after ${TIMEOUT_MS / 1000}s` };
    }
    if (err instanceof TypeError) {
      return { ok: false, kind: "network", message: `Network error: ${err.message}` };
    }
    return {
      ok: false,
      kind: "network",
      message: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    let errBody: unknown;
    if (contentType.includes("application/json")) {
      try {
        errBody = await res.json();
      } catch {
        errBody = await res.text().catch(() => "");
      }
    } else {
      errBody = await res.text().catch(() => "");
    }
    return { ok: false, kind: "http", status: res.status, body: errBody };
  }

  if (!contentType.includes("application/json")) {
    return {
      ok: false,
      kind: "network",
      message: `Expected JSON but got ${contentType || "unknown content type"}`,
    };
  }

  let raw: string;
  let data: unknown;
  try {
    raw = await res.text();
    data = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "network", message: "Response body is not valid JSON" };
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("guest" in data) ||
    typeof (data as Record<string, unknown>).guest !== "object"
  ) {
    return {
      ok: false,
      kind: "network",
      message: "This does not look like a personal invite (no guest object); it may be a join document.",
    };
  }

  const invite = data as Invite;
  if (!invite.actions?.rsvp) {
    return {
      ok: false,
      kind: "network",
      message: "This does not look like a personal invite (no rsvp action); it may be a join document.",
    };
  }

  return { ok: true, invite, raw };
}
