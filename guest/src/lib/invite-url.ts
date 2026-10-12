/**
 * URL handling for invite links.
 *
 * Accepts http(s)://host[:port]/i/<token> with or without ".json",
 * trailing slash, query or hash. Normalises to the .json URL, keeping
 * the origin the user typed.
 */

// Reimplementation of the server's looksLikeToken (src/lib/token.ts:11-13).
// Rule: 20–40 chars of base64url alphabet ([A-Za-z0-9_-]).
export function looksLikeToken(t: string): boolean {
  return /^[A-Za-z0-9_-]{20,40}$/.test(t);
}

export interface NormalizedInviteUrl {
  /** The full .json URL to fetch. */
  jsonUrl: string;
  /** The origin (scheme + host + port) the user typed. */
  origin: string;
  /** The bare token extracted from the path. */
  token: string;
}

export interface InviteUrlError {
  error: string;
}

/**
 * Parse and normalise an invite URL.
 *
 * Returns either a NormalizedInviteUrl or an InviteUrlError with a
 * user-facing message.
 */
export function normalizeInviteUrl(raw: string): NormalizedInviteUrl | InviteUrlError {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Not a valid URL: ${raw}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `URL must use http or https (got ${url.protocol.replace(":", "")})` };
  }

  const pathname = url.pathname;

  // Reject known non-invite paths with specific messages.
  if (/^\/j\//.test(pathname)) {
    return {
      error:
        "This is a party join link, not a personal invite; join first to get your invite URL.",
    };
  }
  if (/^\/m\//.test(pathname)) {
    return { error: "This is a meet link, not an invite link." };
  }
  if (/^\/v\//.test(pathname)) {
    return { error: "This is a vendor link, not an invite link." };
  }

  // Match /i/<token> with optional .json/.txt/.ics suffix and optional trailing slash.
  const match = pathname.match(/^\/i\/([^/]+?)(?:\.(json|txt|ics))?\/?\s*$/);
  if (!match) {
    return { error: `URL path does not match /i/<token>: ${pathname}` };
  }

  const token = match[1];
  if (!looksLikeToken(token)) {
    return { error: `Token does not look valid: "${token}" (expected 20-40 base64url characters)` };
  }

  const origin = url.origin;
  const jsonUrl = `${origin}/i/${token}.json`;

  return { jsonUrl, origin, token };
}

/**
 * Type guard: is it a successful normalisation?
 */
export function isNormalized(r: NormalizedInviteUrl | InviteUrlError): r is NormalizedInviteUrl {
  return "jsonUrl" in r;
}
