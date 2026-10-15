import { NextRequest, NextResponse } from "next/server";
import { ZodSchema } from "zod";
import { loadInvite, inviteJson, type InviteCtx } from "./invite";

export const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });

export function wantsJson(req: NextRequest): boolean {
  const a = req.headers.get("accept") ?? "";
  return a.includes("application/json") && !a.includes("text/html");
}

// Parse + validate a JSON body against a schema. Returns a 400 with a specific,
// self-correctable message (the guest's agent reads it and fixes its request).
export async function parseBody<T>(req: NextRequest, schema: ZodSchema<T>): Promise<{ data: T } | { res: NextResponse }> {
  let raw: unknown;
  try { raw = await req.json(); } catch { return { res: NextResponse.json({ error: "body must be JSON" }, { status: 400 }) }; }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return { res: NextResponse.json({ error: "invalid", issues }, { status: 400 }) };
  }
  return { data: r.data };
}

// Every write returns the fresh invite document so the agent has new state.
export async function respondWithInvite(token: string, status = 200) {
  const ctx = (await loadInvite(token)) as InviteCtx;
  return NextResponse.json(inviteJson(ctx, token), { status, headers: { "cache-control": "no-store" } });
}

export function idem(req: NextRequest): string | null {
  return req.headers.get("idempotency-key")?.trim() || null;
}
