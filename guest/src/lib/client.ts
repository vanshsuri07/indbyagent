/**
 * HTTP client for fetching invite JSON.
 *
 * Uses built-in fetch (Node 22), no runtime dependencies.
 * GET only — read must never POST or modify server state.
 */
import type { Invite } from "../types.js";

const USER_AGENT = "indby-guest/0.1";
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parse and validate a --timeout <seconds> CLI option value.
 * Returns timeout in milliseconds, or null if invalid.
 */
export function parseTimeoutMs(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

export interface FetchResult {
  ok: true;
  invite: Invite;
  raw: string;
}
export interface FetchError {
  ok: false;
  message: string;
  status?: number;
  body?: unknown;
}

/**
 * Fetch an invite document from the given .json URL.
 *
 * Returns the parsed Invite on success or a one-line error message
 * on failure. Never throws.
 */
function formatNetworkErrorMessage(targetUrl: string, err: unknown): string {
  let hostPort = "";
  try {
    const u = new URL(targetUrl);
    const defaultPort = u.protocol === "https:" ? "443" : "80";
    hostPort = u.port ? `${u.hostname}:${u.port}` : `${u.hostname}:${defaultPort}`;
  } catch {
    // fallback
  }

  let causeCode = "";
  if (err && typeof err === "object") {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") {
        causeCode = code;
      } else {
        const msg = (cause as { message?: unknown }).message;
        if (typeof msg === "string") {
          const m = msg.match(/\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/);
          if (m) causeCode = m[1];
        }
      }
    }
    if (!causeCode) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === "string") causeCode = code;
    }
  }

  const errMessage = err instanceof Error ? err.message : String(err);
  if (hostPort && causeCode) {
    return `Network error connecting to ${hostPort} (${causeCode}): ${errMessage}`;
  }
  if (hostPort) {
    return `Network error connecting to ${hostPort}: ${errMessage}`;
  }
  if (causeCode) {
    return `Network error (${causeCode}): ${errMessage}`;
  }
  return `Network error: ${errMessage}`;
}

export async function fetchInvite(
  jsonUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResult | FetchError> {
  let res: Response;
  try {
    res = await fetch(jsonUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return {
        ok: false,
        message: `Request timed out after ${timeoutMs / 1000}s (the server may still be starting or compiling)`,
      };
    }
    return { ok: false, message: formatNetworkErrorMessage(jsonUrl, err) };
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    // Try to read a JSON error body with a "message" or "error" field.
    if (contentType.includes("application/json")) {
      try {
        const body = (await res.json()) as Record<string, unknown>;
        const msg = body.error ?? body.message;
        if (typeof msg === "string") {
          return { ok: false, status: res.status, message: msg, body };
        }
      } catch {
        // Fall through to generic message.
      }
    }
    return { ok: false, status: res.status, message: `Server returned ${res.status} ${res.statusText}` };
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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PostRsvpResult> {
  return postJson(rsvpUrl, body, idempotencyKey, timeoutMs);
}

/**
 * POST a poll ranking to the specified rank endpoint.
 */
export async function postRank(
  rankUrl: string,
  body: unknown,
  idempotencyKey?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PostRankResult> {
  return postJson(rankUrl, body, idempotencyKey, timeoutMs);
}

async function postJson(
  endpointUrl: string,
  body: unknown,
  idempotencyKey?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return {
        ok: false,
        kind: "network",
        message: `Request timed out after ${timeoutMs / 1000}s (the server may still be starting or compiling). Retrying is safe when the idempotency key is unchanged${idempotencyKey ? ` (--idempotency-key ${idempotencyKey})` : ""}`,
      };
    }
    return {
      ok: false,
      kind: "network",
      message: formatNetworkErrorMessage(endpointUrl, err),
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
