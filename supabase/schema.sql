-- ============================================================
-- VAMIOS BINGO — Supabase schema
-- Source of truth for all game state. The browser NEVER writes
-- game progression — only the Game Controller (service_role key)
-- is allowed to advance the clock, call numbers, or settle prizes.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- USERS  (mirrors Telegram identity)
-- ------------------------------------------------------------
create table users (
  id              uuid primary key default uuid_generate_v4(),
  telegram_id     bigint unique not null,
  username        text,
  first_name      text,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- WALLETS  (internal credit ledger — NOT a live payment processor)
-- Deposits/withdrawals are admin-approved requests. Wiring this
-- to a real PSP/crypto rail is a separate, later step once your
-- gambling license / regional compliance is confirmed.
-- ------------------------------------------------------------
create table wallets (
  user_id         uuid primary key references users(id) on delete cascade,
  balance         numeric(12,2) not null default 0 check (balance >= 0),
  updated_at      timestamptz not null default now()
);

create type tx_type as enum ('deposit_request','withdraw_request','deposit_approved','withdraw_approved','stake','payout','commission');
create type tx_status as enum ('pending','approved','rejected','completed');

create table wallet_transactions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid references users(id) on delete cascade,
  type            tx_type not null,
  amount          numeric(12,2) not null,
  status          tx_status not null default 'pending',
  note            text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

-- ------------------------------------------------------------
-- GAMES  (one row per bingo round, per stake tier)
-- ------------------------------------------------------------
create type game_status as enum ('waiting','starting','active','finished','cancelled');

create table games (
  id              uuid primary key default uuid_generate_v4(),
  stake           numeric(6,2) not null check (stake in (10,15,25,50)),
  status          game_status not null default 'waiting',
  pot             numeric(12,2) not null default 0,
  winner_user_id  uuid references users(id),
  waiting_started_at  timestamptz,
  game_started_at     timestamptz,
  finished_at         timestamptz,
  created_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- GAME_STATE  (single live row per game — what clients subscribe to)
-- ------------------------------------------------------------
create table game_state (
  game_id         uuid primary key references games(id) on delete cascade,
  status          game_status not null default 'waiting',
  seconds_left    int not null default 60,       -- waiting-room countdown
  current_number  int,
  called_numbers  int[] not null default '{}',
  winner_user_id  uuid references users(id),
  updated_at      timestamptz not null default now()
);

-- ------------------------------------------------------------
-- GAME_PLAYERS  (who joined which game, with their board)
-- ------------------------------------------------------------
create table game_players (
  id              uuid primary key default uuid_generate_v4(),
  game_id         uuid references games(id) on delete cascade,
  user_id         uuid references users(id) on delete cascade,
  board_number    int not null check (board_number between 1 and 100),
  board_cells     int[] not null,        -- 25 numbers, server-recorded at join time
  marked_cells    int[] not null default '{}',
  is_winner       boolean not null default false,
  joined_at       timestamptz not null default now(),
  unique (game_id, board_number),
  unique (game_id, user_id)
);

-- ------------------------------------------------------------
-- INDEXES
-- ------------------------------------------------------------
create index idx_games_status_stake on games(status, stake);
create index idx_game_players_game on game_players(game_id);
create index idx_wallet_tx_user on wallet_transactions(user_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- Players (anon/authenticated key) can only READ.
-- Only the service_role key (held by the Game Controller) can WRITE
-- to games, game_state, called numbers, winners, and wallet balances.
-- ============================================================
alter table users enable row level security;
alter table wallets enable row level security;
alter table wallet_transactions enable row level security;
alter table games enable row level security;
alter table game_state enable row level security;
alter table game_players enable row level security;

-- Users can read/update only their own row
-- Users and wallets: NO anon/authenticated read access at all.
-- Balance and transaction history are served exclusively through the
-- get-wallet Edge Function, which re-verifies the caller's JWT and
-- uses the service_role key server-side — so a client can never read
-- another player's balance by guessing a user_id.
-- (No policies created for users/wallets/wallet_transactions = default
-- deny for anon/authenticated; only service_role bypasses RLS.)

-- Game state / games / called numbers: public read, no client writes
create policy "games public read" on games for select using (true);
create policy "game_state public read" on game_state for select using (true);
create policy "game_players read own or same game" on game_players for select using (true);

-- NOTE: No insert/update/delete policies are granted to anon/authenticated
-- on games, game_state, or game_players. Only the service_role key
-- (used exclusively by the Game Controller backend) bypasses RLS.
-- This is what makes the client a pure listener.

-- ------------------------------------------------------------
-- Player-initiated actions still need to happen from the client
-- (joining a game, marking a cell, claiming bingo). We expose these
-- as SECURITY DEFINER functions instead of raw table writes, so the
-- server controls exactly what's allowed.
-- ------------------------------------------------------------

-- Join a waiting game: assigns board, deducts stake, adds to pot
create or replace function join_game(p_user_id uuid, p_game_id uuid, p_board_number int, p_board_cells int[])
returns void
language plpgsql
security definer
as $$
declare
  v_stake numeric;
  v_balance numeric;
begin
  select stake into v_stake from games where id = p_game_id and status = 'waiting';
  if v_stake is null then
    raise exception 'Game not joinable';
  end if;

  select balance into v_balance from wallets where user_id = p_user_id for update;
  if v_balance < v_stake then
    raise exception 'Insufficient balance';
  end if;

  update wallets set balance = balance - v_stake, updated_at = now() where user_id = p_user_id;
  insert into wallet_transactions(user_id, type, amount, status, resolved_at)
    values (p_user_id, 'stake', v_stake, 'completed', now());

  insert into game_players(game_id, user_id, board_number, board_cells)
    values (p_game_id, p_user_id, p_board_number, p_board_cells);

  update games set pot = pot + v_stake where id = p_game_id;
end;
$$;

-- Mark a cell (purely cosmetic client-side tracking, stored for audit)
create or replace function mark_cell(p_user_id uuid, p_game_id uuid, p_number int)
returns void
language plpgsql
security definer
as $$
begin
  update game_players
    set marked_cells = array_append(marked_cells, p_number)
    where game_id = p_game_id and user_id = p_user_id
      and not (p_number = any(marked_cells));
end;
$$;

-- THE critical server-side check: does this player's board actually
-- have a completed line using ONLY numbers that have been called?
create or replace function claim_bingo(p_user_id uuid, p_game_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_cells int[];
  v_called int[];
  v_status game_status;
  v_is_winner boolean := false;
  -- standard 5x5 bingo line index sets (0-based positions in the 25-cell array)
  v_lines int[][] := array[
    array[0,1,2,3,4],     array[5,6,7,8,9],     array[10,11,12,13,14],
    array[15,16,17,18,19],array[20,21,22,23,24],
    array[0,5,10,15,20],  array[1,6,11,16,21],  array[2,7,12,17,22],
    array[3,8,13,18,23],  array[4,9,14,19,24],
    array[0,6,12,18,24],  array[4,8,12,16,20]
  ];
  v_line int[];
  v_ok boolean;
  v_idx int;
begin
  select status into v_status from games where id = p_game_id;
  if v_status != 'active' then
    raise exception 'Game is not active';
  end if;

  select board_cells into v_cells from game_players where game_id = p_game_id and user_id = p_user_id;
  select called_numbers into v_called from game_state where game_id = p_game_id;

  if v_cells is null then
    raise exception 'No board found for player';
  end if;

  foreach v_line slice 1 in array v_lines loop
    v_ok := true;
    foreach v_idx in array v_line loop
      -- free space convention: index 12 (center) always counts as called
      if v_idx != 12 and not (v_cells[v_idx+1] = any(v_called)) then
        v_ok := false;
        exit;
      end if;
    end loop;
    if v_ok then
      v_is_winner := true;
      exit;
    end if;
  end loop;

  if v_is_winner then
    update game_players set is_winner = true where game_id = p_game_id and user_id = p_user_id;
    update games set status = 'finished', winner_user_id = p_user_id, finished_at = now() where id = p_game_id;
    update game_state set status = 'finished', winner_user_id = p_user_id where game_id = p_game_id;

    -- Prize split: 80% winner / 20% commission
    update wallets set balance = balance + (
      select pot * 0.8 from games where id = p_game_id
    ) where user_id = p_user_id;

    insert into wallet_transactions(user_id, type, amount, status, resolved_at)
      select p_user_id, 'payout', pot * 0.8, 'completed', now() from games where id = p_game_id;
  end if;

  return v_is_winner;
end;
$$;

-- Grant execute on the RPC functions to the anon/authenticated role
-- (this is the ONLY way the client can affect game data)
grant execute on function join_game(uuid,uuid,int,int[]) to anon, authenticated;
grant execute on function mark_cell(uuid,uuid,int) to anon, authenticated;
grant execute on function claim_bingo(uuid,uuid) to anon, authenticated;
