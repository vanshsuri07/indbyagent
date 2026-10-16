import { fmtWhen, inviteText, SPEC_VERSION, type InviteCtx } from "./invite";
import { siteUrl } from "./token";
import { computeInitialRanks } from "./poll-ranking";

const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
:root{color-scheme:dark;--bg:#0b0a0b;--fg:#f4f2f3;--mut:#9a9396;--line:#2a2527;--rose:#f43f5e;--ok:#34d399;--card:#141214}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:40px 16px 64px;display:grid;gap:22px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
h1{margin:0;font-size:clamp(28px,6vw,40px);line-height:1.1;letter-spacing:-.02em}
.meta{display:grid;gap:4px;color:#d9d4d6}.meta b{color:var(--mut);font-weight:500;display:inline-block;width:5.5em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.row{display:flex;flex-wrap:wrap;gap:10px}
button,.btn{appearance:none;border:1px solid var(--line);background:#1d191b;color:var(--fg);padding:10px 16px;border-radius:8px;font:inherit;cursor:pointer}
button.primary{background:var(--rose);border-color:var(--rose);color:#fff}
button:focus-visible,a:focus-visible{outline:2px solid var(--rose);outline-offset:2px}
input,textarea{width:100%;background:#0f0e0f;border:1px solid var(--line);color:var(--fg);padding:9px 11px;border-radius:8px;font:inherit}
label{display:grid;gap:5px;font-size:13px;color:var(--mut)}
.status{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:#1d191b;font-size:14px}
.status.yes{color:var(--ok)}.status.no{color:#f87171}.status.maybe,.status.needs_human{color:#fbbf24}
pre{margin:0;overflow-x:auto;background:#0f0e0f;border:1px solid var(--line);border-radius:8px;padding:12px;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre}
.agent h2{margin:0 0 6px;font-size:15px}.agent p{margin:0 0 12px;color:var(--mut);font-size:14px}
.small{font-size:13px;color:var(--mut)}a{color:var(--fg);text-decoration-color:var(--rose);text-underline-offset:3px}
`;

const SCRIPT = `
(function() {
  function initDatePollRankings() {
    var forms = document.querySelectorAll('form[action*="/polls/"][action$="/rank"]');
    forms.forEach(function(form) {
      var selects = Array.from(form.querySelectorAll('select[name^="rank_"]'));
      if (!selects.length) return;

      selects.forEach(function(select) {
        if (!select.dataset.prev) {
          select.dataset.prev = select.value;
        }

        select.addEventListener('focus', function() {
          this.dataset.prev = this.value;
        });

        select.addEventListener('change', function() {
          var newRank = this.value;
          var oldRank = this.dataset.prev;
          if (newRank === oldRank) return;

          if (newRank) {
            var other = selects.find(function(s) {
              return s !== select && s.value === newRank;
            });

            if (other) {
              other.value = oldRank;
              other.dataset.prev = oldRank;
            }
          }
          this.dataset.prev = newRank;
        });
      });

      form.addEventListener('submit', function() {
        var rows = selects
          .filter(function(s) { return s.value !== ''; })
          .map(function(s) {
            return { select: s, row: s.closest('label'), rank: Number(s.value) };
          });
        rows.sort(function(a, b) { return a.rank - b.rank; });
        var submitRow = form.querySelector('.row');
        rows.forEach(function(item) {
          if (item.row && submitRow) {
            form.insertBefore(item.row, submitRow);
          }
        });
      });
    });
  }

  if (typeof window !== 'undefined') {
    window.__initDatePollRankings = initDatePollRankings;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDatePollRankings);
  } else {
    initDatePollRankings();
  }
})();
`;

export function renderInvitePage(ctx: InviteCtx | null, token: string): string {
  if (!ctx) {
    return page("Invite not found", `<div class="wrap"><div class="eyebrow">IndbyAgent</div><h1>This invite link isn't valid.</h1><p class="small">It may have been revoked or mistyped. Ask the host for a fresh link.</p></div>`);
  }
  const { party, guest, state, polls, answers } = ctx;
  const base = `${siteUrl()}/i/${token}`;
  const status = state.status ?? "pending";
  const byLine = state.by_kind ? ` · answered by ${state.by_kind === "agent" ? `${esc(state.by_name) || "an agent"} (agent)` : "you"}` : "";

  const fmtOpt = (o: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: party.timezone }).format(new Date(o));
  const pollsHtml = polls.map((p) => {
    const a = answers.find((x) => x.poll_id === p.id);
    if (p.kind === "dates") {
      const mine = a?.ranking ?? (a?.choice ? [a.choice] : []);
      const initialRanks = computeInitialRanks(p.options, mine);
      return `<form class="card date-poll-form" method="post" action="${base}/polls/${p.id}/rank">
      <div class="small">Date poll · rank the ones you can make, 1 = best</div><div style="font-weight:600;margin:2px 0 10px">${esc(p.question)}</div>
      ${p.options.map((o, idx) => {
        const rank = initialRanks[idx];
        return `<label style="display:flex;gap:10px;align-items:center;margin:6px 0"><select name="rank_${idx}" data-prev="${rank === 0 ? '' : String(rank)}" style="width:5em"><option value="">–</option>${p.options.map((_, i) => `<option value="${i + 1}" ${i + 1 === rank ? "selected" : ""}>${i + 1}</option>`).join("")}</select><span>${esc(fmtOpt(o))}</span></label>`;
      }).join("")}
      <div class="row" style="margin-top:8px"><button class="primary">Save my ranking</button></div>
      ${mine.length ? `<div class="small" style="margin-top:8px">Your ranking: ${mine.map(fmtOpt).map(esc).join(" › ")}${a?.by_kind === "agent" ? " (by your agent)" : ""}</div>` : ""}
    </form>`;
    }
    return `<form class="card" method="post" action="${base}/polls/${p.id}">
      <div class="small">Poll</div><div style="font-weight:600;margin:2px 0 10px">${esc(p.question)}</div>
      <div class="row">${p.options.map((o) => `<button name="choice" value="${esc(o)}" class="${a?.choice === o ? "primary" : ""}">${esc(o)}</button>`).join("")}</div>
      ${a ? `<div class="small" style="margin-top:8px">Your answer: ${esc(a.choice)}${a.by_kind === "agent" ? " (by your agent)" : ""}</div>` : ""}
    </form>`;
  }).join("");

  const body = `
<div class="wrap">
  <div class="eyebrow">You're invited</div>
  <h1>${esc(party.title)}</h1>
  <div class="meta">
    <div><b>When</b> ${esc(fmtWhen(party))}</div>
    ${party.location ? `<div><b>Where</b> ${esc(party.location)}</div>` : ""}
    ${party.rsvp_by ? `<div><b>RSVP by</b> ${esc(party.rsvp_by)}</div>` : ""}
    <div><b>Guest</b> ${esc(guest.name)}${guest.party_size_max > 1 ? ` (up to ${guest.party_size_max})` : ""}</div>
  </div>
  ${party.details ? `<p style="margin:0">${esc(party.details)}</p>` : ""}

  <form class="card" method="post" action="${base}/rsvp">
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
      <strong>Your RSVP</strong>
      <span class="status ${status}">${status.replace("_", " ")}${byLine}</span>
    </div>
    <div class="row" style="margin-bottom:12px">
      <button name="status" value="yes" class="${status === "yes" ? "primary" : ""}">Yes</button>
      <button name="status" value="maybe" class="${status === "maybe" ? "primary" : ""}">Maybe</button>
      <button name="status" value="no" class="${status === "no" ? "primary" : ""}">No</button>
    </div>
    <div class="row">
      ${guest.party_size_max > 1 ? `<label style="flex:1 1 120px">Party size<input name="party_size" type="number" min="1" max="${guest.party_size_max}" value="${state.party_size ?? 1}"></label>` : ""}
      <label style="flex:2 1 220px">Dietary needs (comma-separated)<input name="dietary" value="${esc((state.dietary ?? []).join(", "))}"></label>
    </div>
    <label style="margin-top:10px">Note to the host<input name="note" value="${esc(state.note)}"></label>
  </form>

  ${pollsHtml}

  <form class="card" method="post" action="${base}/message">
    <label>Ask the host something<textarea name="text" rows="2" placeholder="Can siblings come?"></textarea></label>
    <div class="row" style="margin-top:10px"><button>Send</button><a class="btn" href="${base}.ics">Add to calendar</a></div>
  </form>

  <section class="card agent">
    <h2>For your agent</h2>
    <p>Have a personal agent? Paste this to it, or give it the link. It can read the invite and RSVP for you. <code>${base}.json</code> is the same invite as JSON.</p>
    <pre id="agent">${esc(inviteText(ctx, token))}</pre>
    <div class="row" style="margin-top:10px"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('agent').textContent).then(()=>{this.textContent='Copied'})">Copy</button></div>
  </section>
  <div class="small">IndbyAgent v${SPEC_VERSION}. This link is yours alone: it only changes your RSVP.</div>
</div>`;
  return page(`${party.title} · invite`, body, base);
}

function page(title: string, body: string, base?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
${base ? `<link rel="alternate" type="application/json" href="${base}.json"><link rel="alternate" type="text/plain" href="${base}.txt">` : ""}
<style>${CSS}</style></head><body>${body}<script>${SCRIPT}</script></body></html>`;
}
