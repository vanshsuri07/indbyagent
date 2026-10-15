import { NextRequest, NextResponse } from "next/server";
import { loadInvite, PollBody, writePollAnswer } from "@/lib/invite";
import { notFound, parseBody, respondWithInvite, idem } from "@/lib/http";
import { failStatus } from "@/lib/idempotency";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; pollId: string }> }) {
  const { token, pollId } = await params;
  const ctx = await loadInvite(token);
  if (!ctx) return notFound();
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    const f = await req.formData();
    const body = PollBody.safeParse({ choice: f.get("choice"), note: String(f.get("note") ?? ""), by: { kind: "human" } });
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const r = await writePollAnswer(ctx, pollId, body.data, { channel: "web", defaultKind: "human" });
    if ("error" in r) return NextResponse.json(r, { status: 400 });
    return NextResponse.redirect(new URL(`/i/${token}?saved=1`, req.url), 303);
  }
  const p = await parseBody(req, PollBody);
  if ("res" in p) return p.res;
  const r = await writePollAnswer(ctx, pollId, p.data, { channel: "api", idempotency_key: idem(req), defaultKind: "agent" });
  if ("error" in r) return NextResponse.json(r, { status: failStatus(r) });
  return respondWithInvite(token);
}
