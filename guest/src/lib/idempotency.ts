import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

/**
 * Derive an idempotency key as the first 32 hex characters of:
 * sha256(token + "\n" + canonicalJson(body) + "\n" + canonicalJson(state))
 */
export function deriveIdempotencyKey(
  token: string,
  body: unknown,
  state: unknown,
): string {
  const payload =
    token +
    "\n" +
    canonicalJson(body) +
    "\n" +
    canonicalJson(state);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}
