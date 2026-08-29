// VAMIOS BINGO — frontend Supabase client
// This uses the PUBLIC anon key only. RLS policies (see schema.sql)
// mean this key can read game state but cannot write to games,
// game_state, or wallets directly — all writes go through the
// join_game / mark_cell / claim_bingo RPC functions.

const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Parse ?token= from the Telegram WebApp launch URL and decode
// (verification of the signature happens server-side on first RPC
// call in a production build — for now we trust Telegram's WebApp
// context + this token to identify the session).
function getSessionToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || sessionStorage.getItem('vamios_token');
}

function saveSessionToken(token) {
  sessionStorage.setItem('vamios_token', token);
}

const token = getSessionToken();
if (token) saveSessionToken(token);

// Exchanges the bot-issued JWT for a verified user_id by calling the
// verify-token Edge Function. This is the ONLY path that should ever
// set vamios_user_id — never trust the token's contents client-side.
async function verifyAndResolveUser() {
  const cached = sessionStorage.getItem('vamios_user_id');
  if (cached) return cached;

  const t = getSessionToken();
  if (!t) return null;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ token: t }),
  });

  if (!res.ok) {
    console.error('Token verification failed');
    return null;
  }

  const data = await res.json();
  sessionStorage.setItem('vamios_user_id', data.user_id);
  return data.user_id;
}

// Fetches balance + transaction history via the get-wallet Edge
// Function, which re-verifies the JWT itself. The anon key has no
// direct read access to wallets/wallet_transactions (see schema.sql).
async function fetchWallet() {
  const t = getSessionToken();
  if (!t) return { balance: 0, transactions: [] };

  const res = await fetch(`${SUPABASE_URL}/functions/v1/get-wallet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ token: t }),
  });

  if (!res.ok) return { balance: 0, transactions: [] };
  return res.json();
}
