import { NextRequest, NextResponse } from "next/server";
import { loadInvite, RankBody, writePollRanking } from "@/lib/invite";
import { notFound, parseBody, respondWithInvite, idem } from "@/lib/http";
import { failStatus } from "@/lib/idempotency";

export const dynamic = "force-dynamic";

// Ranked answer to a "dates" poll. Agents POST JSON; the invite page posts a
// form with rank_<n>=<option> fields (lower n = better).
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string; pollId: string }> }) {
  const { token, pollId } = await params;
  const ctx = await loadInvite(token);
  if (!ctx) return notFound();
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("form")) {
    const f = await req.formData();
    // form fields: rank_<optionIndex> = <rank number>; lower rank = better
    const poll = ctx.polls.find((x) => x.id === pollId);
    const ranking = [...f.entries()].filter(([k, v]) => k.startsWith("rank_") && String(v))
      .map(([k, v]) => ({ opt: poll?.options[Number(k.slice(5))], rank: Number(v) })).filter((x) => x.opt && x.rank > 0)
      .sort((a, b) => a.rank - b.rank).map((x) => x.opt as string);
    const body = RankBody.safeParse({ ranking, by: { kind: "human" } });
    if (!body.success) return NextResponse.json({ error: "pick at least one date" }, { status: 400 });
    const r = await writePollRanking(ctx, pollId, body.data, { channel: "web", defaultKind: "human" });
    if ("error" in r) return NextResponse.json(r, { status: 400 });
    return NextResponse.redirect(new URL(`/i/${token}?saved=1`, req.url), 303);
  }
  const p = await parseBody(req, RankBody);
  if ("res" in p) return p.res;
  const r = await writePollRanking(ctx, pollId, p.data, { channel: "api", idempotency_key: idem(req), defaultKind: "agent" });
  if ("error" in r) return NextResponse.json(r, { status: failStatus(r) });
  return respondWithInvite(token);
}
