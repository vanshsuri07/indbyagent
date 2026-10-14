/**
 * Integration test seeder.
 *
 * Creates a party with dynamic future backup dates (so it has an open dates poll)
 * and one guest with party_size_max 1. Returns the guest's personal invite URL.
 *
 * Local mode requires no auth because when fallback.db is active (no Supabase keys),
 * src/lib/auth.ts currentHost() automatically provisions and returns the local host record.
 */

export interface SeedResult {
  party: {
    id: string;
    slug: string;
    title: string;
    timezone: string;
    /** Bare calendar date (YYYY-MM-DD), the only shape the server accepts. */
    rsvp_by: string;
    location: string;
  };
  poll: {
    id: string;
    options: string[];
  };
  guest: {
    id: string;
    name: string;
    token: string;
    party_size_max: number;
  };
  inviteUrl: string;
}

export async function seedParty(
  baseUrl: string = process.env.INDBY_BASE_URL || "http://localhost:3000",
): Promise<SeedResult> {
  const normalizedBase = baseUrl.replace(/\/+$/, "");

  // Generate future backup dates dynamically so tests remain valid over time,
  // with a deterministic party timezone ("America/Los_Angeles").
  const now = new Date();
  const d1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 10, 18, 0, 0));
  const d2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 15, 18, 0, 0));
  const d3 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 20, 18, 0, 0));

  // A deadline and a location, so the seeded party is a *complete* document of the
  // shape the server really emits. rsvp_by must be a bare YYYY-MM-DD: the server
  // rejects anything else (src/lib/host.ts), and the CLI's date formatting depends
  // on that contract — leaving it out is how the "wrong RSVP deadline" bug shipped.
  const rsvpBy = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 3),
  ).toISOString().slice(0, 10);
  const location = "Pier 27, San Francisco";

  const partyRes = await fetch(`${normalizedBase}/api/host/parties`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Integration Party ${Date.now()}`,
      timezone: "America/Los_Angeles",
      location,
      details: "Rooftop, bring a layer.",
      rsvp_by: rsvpBy,
      backup_dates: [d1.toISOString(), d2.toISOString(), d3.toISOString()],
    }),
  });

  if (!partyRes.ok) {
    const errText = await partyRes.text();
    const hint = partyRes.status >= 500
      ? "\nHint: The app's local test mode may be broken (no in-memory db)."
      : "";
    const msg = `Failed to create party: ${partyRes.status} ${errText}${hint}`;
    console.error(msg);
    throw new Error(msg);
  }

  const partyData = (await partyRes.json()) as {
    party: { id: string; slug: string; title: string; timezone: string; rsvp_by: string; location: string };
    date_poll: { id: string; options: string[] };
  };

  const guestRes = await fetch(`${normalizedBase}/api/host/parties/${partyData.party.id}/guests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      guests: [
        {
          name: "Integration Guest",
          party_size_max: 1,
        },
      ],
    }),
  });

  if (!guestRes.ok) {
    const errText = await guestRes.text();
    const hint = guestRes.status >= 500
      ? "\nHint: The app's local test mode may be broken (no in-memory db)."
      : "";
    const msg = `Failed to create guest: ${guestRes.status} ${errText}${hint}`;
    console.error(msg);
    throw new Error(msg);
  }

  const guestData = (await guestRes.json()) as {
    guests: Array<{ id: string; name: string; token: string; invite_url: string; party_size_max?: number }>;
  };

  const guest = guestData.guests[0];
  const inviteUrl = `${normalizedBase}/i/${guest.token}`;

  return {
    party: partyData.party,
    poll: partyData.date_poll,
    guest: {
      id: guest.id,
      name: guest.name,
      token: guest.token,
      party_size_max: guest.party_size_max ?? 1,
    },
    inviteUrl,
  };
}
