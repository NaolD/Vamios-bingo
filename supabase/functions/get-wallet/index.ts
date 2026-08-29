// VAMIOS BINGO — get-wallet Edge Function
//
// Replaces direct client reads of `wallets` / `wallet_transactions`.
// The anon key has NO read access to those tables anymore (see the
// updated RLS policies in schema.sql). This function re-verifies the
// bot-issued JWT itself, then uses the service_role key to fetch
// balance + recent transactions for THAT user only — never an
// arbitrary user_id supplied by the client.
//
// Deploy with:
//   supabase functions deploy get-wallet
//   (reuses the JWT_SECRET secret already set for verify-token)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function getKey() {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { token } = await req.json();
    if (!token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers: cors });

    const key = await getKey();
    const payload = await verify(token, key); // throws if invalid/expired
    const userId = payload.user_id as string;

    const { data: wallet } = await supabase.from("wallets").select("balance").eq("user_id", userId).single();
    const { data: txs } = await supabase
      .from("wallet_transactions")
      .select("id, type, amount, status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);

    return new Response(
      JSON.stringify({ balance: wallet?.balance ?? 0, transactions: txs ?? [] }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
