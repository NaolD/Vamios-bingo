// VAMIOS BINGO — verify-token Edge Function
//
// The bot signs a short-lived JWT ({ user_id, telegram_id }) when a
// player taps "Open Game". This function is the ONLY place that
// trusts that token — it checks the signature against JWT_SECRET
// (same secret the bot uses) and, only if valid, returns the
// user_id. The frontend calls this once on load instead of trusting
// the token's contents directly.
//
// Deploy with:
//   supabase functions deploy verify-token
//   supabase secrets set JWT_SECRET=your-long-random-string

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const JWT_SECRET = Deno.env.get("JWT_SECRET")!;

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
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing token" }), { status: 400, headers: cors });
    }

    const key = await getKey();
    // Throws if signature is invalid or token is expired
    const payload = await verify(token, key);

    return new Response(
      JSON.stringify({ user_id: payload.user_id, telegram_id: payload.telegram_id }),
      { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Invalid or expired token" }),
      { status: 401, headers: { ...cors, "Content-Type": "application/json" } }
    );
  }
});
