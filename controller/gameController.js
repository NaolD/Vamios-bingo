/**
 * VAMIOS BINGO — Game Controller
 *
 * This is the ONLY process allowed to advance game state. It runs
 * server-side (VPS / Render / Railway / Fly.io — NOT GitHub Pages,
 * which can only serve static files). It uses the Supabase
 * SERVICE_ROLE key, which bypasses Row Level Security.
 *
 * Responsibilities:
 *  - Open a new "waiting" game per stake tier when none exists
 *  - Run the 60s waiting-room countdown, broadcast via game_state
 *  - Start the game, call a number every 5s until 1-75 exhausted
 *  - Detect a game with no winner after all numbers called -> cancel/refund
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // NEVER expose this key to the frontend
);

// ------------------------------------------------------------
// RAILWAY-COMPATIBLE HEALTH CHECK
// This service has no user-facing HTTP API — it's a background
// worker. Binding a tiny health-check server means Railway's health
// checks pass if you ever enable a public domain on this service,
// and Railway can tell "still alive" apart from "crashed".
// ------------------------------------------------------------
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('VAMIOS Bingo Game Controller is running.'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', activeGames: activeTimers.size }));
app.listen(PORT, () => console.log(`Health-check server listening on port ${PORT}`));

const STAKES = [10, 15, 25, 50];
const WAITING_SECONDS = 60;
const CALL_INTERVAL_MS = 5000;
const NUMBER_POOL = Array.from({ length: 75 }, (_, i) => i + 1); // classic 1-75 bingo

const activeTimers = new Map(); // game_id -> interval handle

async function ensureWaitingGames() {
  for (const stake of STAKES) {
    const { data: existing } = await supabase
      .from('games')
      .select('id')
      .eq('stake', stake)
      .eq('status', 'waiting')
      .maybeSingle();

    if (!existing) {
      const { data: game, error } = await supabase
        .from('games')
        .insert({ stake, status: 'waiting', waiting_started_at: new Date().toISOString() })
        .select()
        .single();

      if (error) { console.error('Failed to create game', error); continue; }

      await supabase.from('game_state').insert({
        game_id: game.id,
        status: 'waiting',
        seconds_left: WAITING_SECONDS,
      });

      console.log(`Opened new waiting game ${game.id} @ stake ${stake}`);
      startWaitingCountdown(game.id);
    }
  }
}

function startWaitingCountdown(gameId) {
  let secondsLeft = WAITING_SECONDS;

  const interval = setInterval(async () => {
    secondsLeft -= 1;

    // Cancel countdown if game already left "waiting" (e.g. manually started)
    const { data: game } = await supabase.from('games').select('status').eq('id', gameId).single();
    if (!game || game.status !== 'waiting') {
      clearInterval(interval);
      return;
    }

    await supabase.from('game_state').update({ seconds_left: secondsLeft, updated_at: new Date().toISOString() }).eq('game_id', gameId);

    if (secondsLeft <= 0) {
      clearInterval(interval);
      await startGame(gameId);
    }
  }, 1000);

  activeTimers.set(gameId, interval);
}

async function startGame(gameId) {
  const { count } = await supabase
    .from('game_players')
    .select('*', { count: 'exact', head: true })
    .eq('game_id', gameId);

  if (!count || count < 2) {
    // Not enough players — cancel and refund stakes
    await cancelAndRefund(gameId);
    return;
  }

  await supabase.from('games').update({ status: 'active', game_started_at: new Date().toISOString() }).eq('id', gameId);
  await supabase.from('game_state').update({ status: 'active', updated_at: new Date().toISOString() }).eq('game_id', gameId);

  console.log(`Game ${gameId} started with ${count} players`);
  runNumberCalling(gameId);
}

async function runNumberCalling(gameId) {
  let remaining = [...NUMBER_POOL];

  const interval = setInterval(async () => {
    const { data: game } = await supabase.from('games').select('status').eq('id', gameId).single();
    if (!game || game.status !== 'active') {
      clearInterval(interval);
      return;
    }

    if (remaining.length === 0) {
      // Nobody won with all 75 numbers called — cancel and refund
      clearInterval(interval);
      await cancelAndRefund(gameId);
      return;
    }

    const idx = Math.floor(Math.random() * remaining.length);
    const number = remaining.splice(idx, 1)[0];

    const { data: state } = await supabase.from('game_state').select('called_numbers').eq('game_id', gameId).single();
    const called = [...(state?.called_numbers || []), number];

    await supabase.from('game_state').update({
      current_number: number,
      called_numbers: called,
      updated_at: new Date().toISOString(),
    }).eq('game_id', gameId);

    console.log(`Game ${gameId}: called ${number} (${called.length}/75)`);
  }, CALL_INTERVAL_MS);

  activeTimers.set(gameId, interval);
}

async function cancelAndRefund(gameId) {
  console.log(`Cancelling game ${gameId} — refunding stakes`);

  const { data: game } = await supabase.from('games').select('stake').eq('id', gameId).single();
  const { data: players } = await supabase.from('game_players').select('user_id').eq('game_id', gameId);

  for (const p of players || []) {
    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', p.user_id).single();
    await supabase.from('wallets').update({ balance: (wallet?.balance || 0) + game.stake }).eq('user_id', p.user_id);
    await supabase.from('wallet_transactions').insert({
      user_id: p.user_id, type: 'payout', amount: game.stake, status: 'completed', note: 'refund - game cancelled', resolved_at: new Date().toISOString(),
    });
  }

  await supabase.from('games').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', gameId);
  await supabase.from('game_state').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('game_id', gameId);
}

// Watch for games that finished (winner claimed bingo via RPC) and spin up replacements
async function watchForFinishedGames() {
  const { data: finished } = await supabase
    .from('games')
    .select('id, stake, status')
    .in('status', ['finished', 'cancelled']);

  for (const g of finished || []) {
    if (activeTimers.has(g.id)) {
      clearInterval(activeTimers.get(g.id));
      activeTimers.delete(g.id);
    }
  }
}

async function mainLoop() {
  console.log('Game Controller started — polling every 3s');
  setInterval(async () => {
    await ensureWaitingGames();
    await watchForFinishedGames();
  }, 3000);
}

mainLoop();

// Railway sends SIGTERM before redeploys/restarts. We don't try to
// finish in-flight number-calling loops gracefully here — a mid-round
// restart just means the next poll tick picks games back up — but we
// exit cleanly so Railway doesn't treat it as a crash.
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
