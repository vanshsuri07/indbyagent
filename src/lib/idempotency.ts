// Fixes: "Idempotency replay silently succeeds with a different request".
//
// Before: any unique-violation (23505) on insert was treated as success, so a
// reused Idempotency-Key with a DIFFERENT body returned 200 and the new write
// was dropped without a word.
//
// Now:
//   same key + same content       -> harmless retry, ok
//   same key + different content  -> conflict (route answers 422)
//   any other 23505               -> real error, never swallowed
import { db } from "./db";

export const IDEMPOTENCY_CONFLICT = "idempotency_conflict";

type Table = "rsvps" | "poll_answers";
export type WriteResult = { ok: true } | { error: string; code?: string };

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const failStatus = (r: { error?: string; code?: string }) => (r.code === IDEMPOTENCY_CONFLICT ? 422 : 400);

export async function insertOnce(
  table: Table,
  row: Record<string, unknown> & { guest_id: string; idempotency_key?: string | null },
): Promise<WriteResult> {
  const { error } = await db.from(table).insert(row);
  if (!error) return { ok: true };
  if (error.code !== "23505" || !row.idempotency_key) return { error: error.message };

  // Find the row that owns this key. The unique index is
  //   rsvps:        (guest_id, idempotency_key)
  //   poll_answers: (poll_id, guest_id, idempotency_key)
  let q = db.from(table).select("*").eq("guest_id", row.guest_id).eq("idempotency_key", row.idempotency_key);
  if (table === "poll_answers") q = q.eq("poll_id", row.poll_id);
  const { data: prior, error: lookupError } = await q.maybeSingle();
  if (lookupError) return { error: lookupError.message };

  const conflict: WriteResult = {
    error: "This Idempotency-Key was already used for a different request. Your change was NOT applied. Send it again with a new Idempotency-Key.",
    code: IDEMPOTENCY_CONFLICT,
  };
  if (!prior) return conflict;

  // Compare every field we tried to write.
  const stored = prior as Record<string, unknown>;
  for (const [field, value] of Object.entries(row)) {
    if (!sameValue(stored[field], value)) return conflict;
  }
  return { ok: true }; // exact retry
}