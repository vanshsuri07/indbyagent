import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDb } from "./local-db";
import { fallback } from "./fallback";
// Service-role client for server code only. Guest access is authorized by the
// per-guest token (checked in code), host access by HOST_SECRET. Never import
// this from a client component.

export const db: SupabaseClient = fallback
  ? (localDb as unknown as SupabaseClient)
  : createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },);

export type RsvpStatus = "pending" | "yes" | "no" | "maybe" | "needs_human";
export type ByKind = "agent" | "human" | "host";
export type Channel = "api" | "web" | "email" | "sms";

export type Party = {
  id: string; host_id: string; slug: string; title: string; kind: string | null;
  starts_at: string | null; ends_at: string | null; timezone: string; location: string | null;
  details: string | null; rsvp_by: string | null; inbox_address: string | null;
};
export type Guest = {
  id: string; party_id: string; name: string; email: string | null; phone: string | null;
  party_size_max: number; token_hash: string; token_revoked_at: string | null;
};
export type GuestState = {
  guest_id: string; party_id: string; name: string; email: string | null; party_size_max: number;
  status: RsvpStatus | null; party_size: number | null; dietary: string[] | null; note: string | null;
  by_kind: ByKind | null; by_name: string | null; channel: Channel | null; answered_at: string | null;
};
export type PollKind = "preference" | "dates";
export type Poll = { id: string; party_id: string; question: string; options: string[]; closes_at: string | null; status: "open" | "closed"; kind: PollKind };
export const pollIsOpen = (p: Poll, now = Date.now()) =>
  p.status === "open" && (!p.closes_at || Date.parse(p.closes_at) > now);
export type PollAnswer = { poll_id: string; guest_id: string; choice: string; ranking: string[] | null; note: string | null; by_kind: ByKind; by_name: string | null; channel: Channel; created_at: string };
