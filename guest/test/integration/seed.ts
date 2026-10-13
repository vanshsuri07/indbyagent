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

  const partyRes = await fetch(`${normalizedBase}/api/host/parties`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Integration Party ${Date.now()}`,
      timezone: "America/Los_Angeles",
      backup_dates: [d1.toISOString(), d2.toISOString(), d3.toISOString()],
    }),
  });

  if (!partyRes.ok) {
    const errText = await partyRes.text();
    throw new Error(`Failed to create party: ${partyRes.status} ${errText}`);
  }

  const partyData = (await partyRes.json()) as {
    party: { id: string; slug: string; title: string; timezone: string };
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
    throw new Error(`Failed to create guest: ${guestRes.status} ${errText}`);
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
