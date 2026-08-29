# VAMIOS Bingo

Telegram-launched, Supabase-authoritative multiplayer bingo.

## Architecture

```
TELEGRAM BOT ──opens──▶ WEB APP (GitHub Pages, static, listen-only)
                              │
                              │ subscribes to game_state (Realtime)
                              │ calls join_game / mark_cell / claim_bingo (RPC)
                              ▼
                       SUPABASE (Postgres)
                              ▲
                              │ writes state (service_role key)
                              │
                     GAME CONTROLLER (Node, runs on a server you host)
                       - 60s waiting-room timer
                       - calls a number every 5s
                       - the only writer of games/game_state
```

**The browser never controls the clock or the number sequence.** GitHub
Pages can only serve static files — it has no persistent process, so it
*can't* be the authority even if we wanted it to be. The Game Controller
is a small Node service that must run somewhere with a persistent
process (a $5/mo VPS, Render, Railway, Fly.io, etc.). It holds the
Supabase **service_role** key, which is the only credential allowed to
write to `games` / `game_state` / wallets — enforced by Postgres Row
Level Security (see `supabase/schema.sql`).

## ⚠️ Money handling — read this first

This scaffold treats the wallet as an **internal credit ledger**, not
live payment processing. Deposit/withdraw requests go through the
Telegram bot to an admin chat for manual approval — no card, bank, or
crypto rails are wired up. Real-money gambling is regulated in
essentially every jurisdiction; wiring this to an actual payment
processor is a separate step you should only take once you've
confirmed the licensing/compliance requirements for wherever your
players are.

## Setup

### 1. Supabase
1. Create a project at supabase.com
2. Run `supabase/schema.sql` in the SQL editor
3. Copy your Project URL, `anon` public key, and `service_role` secret key

### 2. Game Controller (deploying on Railway)
1. In Railway: **New Project → Deploy from GitHub repo** (can be the same project as the bot, added as a second service, or its own project — your call)
2. If `controller/` is a subfolder of a bigger repo: Service Settings → **Root Directory** → set to `controller`
3. Railway auto-detects Node.js and reads `controller/railway.json` for the start command
4. Service → **Variables** → add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `controller/.env.example`. Leave `PORT` unset.
5. Deploy. Check logs for `Health-check server listening on port ...` and `Game Controller started — polling every 3s`

This service has no public-facing purpose — you don't need to enable a domain for it. The bundled health-check server exists only so Railway's own health checks (if you ever turn them on) have something to hit, and so restarts are detected cleanly.

**Local development:**
```bash
cd controller
cp .env.example .env
npm install
npm start
```

### 3. Telegram Bot (deploying on Railway)
1. Create a bot with [@BotFather](https://t.me/BotFather), grab the token
2. Push the whole `vamios-bingo` repo to GitHub (or just the `bot/` folder to its own repo)
3. In Railway: **New Project → Deploy from GitHub repo**
4. If `bot/` is a subfolder of a bigger repo: Service Settings → **Root Directory** → set to `bot`
5. Railway auto-detects Node.js via Nixpacks and reads `bot/railway.json` for the start command — no extra config needed there
6. Service → **Variables** → add everything from `bot/.env.example` (`BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBAPP_URL`, `JWT_SECRET`, `ADMIN_CHAT_ID`). Leave `PORT` unset — Railway injects it automatically.
7. Deploy. Check the logs for `Health-check server listening on port ...` and `VAMIOS Bingo bot running in POLLING mode...`

**Polling vs webhook mode**: polling (the default, `USE_WEBHOOK=false`) works out of the box with zero extra setup and is fine to start with. For better reliability at scale, flip `USE_WEBHOOK=true`, enable **public networking** on the Railway service (Settings → Networking → Generate Domain), and redeploy — the bot will automatically register a webhook against Railway's own public domain (`RAILWAY_PUBLIC_DOMAIN`), no manual URL needed unless you want a custom one via `WEBHOOK_DOMAIN`.

A tiny Express server is bundled in `bot/index.js` purely so Railway's health checks have something to hit at `/` and `/health` — it doesn't replace or interfere with the bot logic.

**Local development** (before pushing to Railway):
```bash
cd bot
cp .env.example .env   # fill in the values, leave PORT/USE_WEBHOOK as defaults
npm install
npm start
```

### 4. Web App (GitHub Pages)
1. Edit `web/js/supabaseClient.js` with your Supabase URL + **anon** key (never the service_role key)
2. Push the `web/` folder to a GitHub repo, enable Pages on it (Settings → Pages → deploy from branch, root = `/web` or move contents to repo root)
3. Point the bot's `WEBAPP_URL` at the published Pages URL

## Token verification & admin approval — now wired up

### Deploy the verify-token Edge Function
```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set JWT_SECRET=the-same-value-as-in-bot/.env
supabase functions deploy verify-token
```
The web app calls this automatically on load (`web/js/supabaseClient.js` →
`verifyAndResolveUser()`) — it exchanges the bot's signed token for a
verified `user_id`. No more dev-mode prompt.

### Admin approval flow (deposits/withdrawals)
From the chat set as `ADMIN_CHAT_ID` in `bot/.env`:
- `/pending` — lists all pending deposit/withdraw requests with ready-to-tap commands
- `/approve <transaction_id>` — credits/debits the wallet and notifies the player
- `/reject <transaction_id>` — marks rejected and notifies the player

Every new request also posts directly to the admin chat with its
`/approve` / `/reject` commands pre-filled, so you don't need `/pending`
unless you want to review the backlog.

### RLS lockdown (wallets/users)
`wallets`, `wallet_transactions`, and `users` now have **no** read
policies for anon/authenticated — a client can no longer query any
user's balance or transactions directly, even by guessing a UUID.
Balance/history are served instead by the new `get-wallet` function,
which re-verifies the JWT itself before returning anything:
```bash
supabase functions deploy get-wallet
supabase secrets set SUPABASE_URL=https://YOUR-PROJECT.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```
(`JWT_SECRET` is already set from the verify-token step above — both
functions share it.)

> **If you already ran the old `schema.sql`** on a live project, the
> permissive `"users read own"` / `"wallets read own"` policies won't
> disappear on their own — run this once in the SQL editor:
> ```sql
> drop policy if exists "users read own" on users;
> drop policy if exists "wallets read own" on wallets;
> ```

## What's still a stub / needs finishing before production

- **Multiple concurrent games per stake** once player volume needs it (schema already supports it — the controller's `ensureWaitingGames` just needs to allow >1 waiting game per stake when the current one fills a max player count).
- **Admin identity check** on `/approve`/`/reject` currently just checks the chat ID — fine for a private admin chat, but if you ever open that chat to multiple admins, anyone in it can approve. Fine for now, worth knowing.

## Final recommendations before real players/money touch this

- **Rate-limit the RPCs.** `join_game`, `mark_cell`, and `claim_bingo` have no throttling — a bad actor could hammer `claim_bingo` in a loop. Add Supabase's built-in rate limiting on the Edge Functions, or a simple `pg_bouncer`/API-gateway limit in front of PostgREST.
- **Audit logging.** Every wallet balance change should be reconstructable from `wallet_transactions` alone — it already is, but double check nothing ever updates `wallets.balance` outside a function that also inserts a matching transaction row. This matters if the regulator ever asks for records.
- **Separate staging and production Supabase projects.** Test schema changes and new features on staging first — a bad migration on production directly risks live player funds.
- **Rotate `JWT_SECRET` and `SERVICE_ROLE_KEY` immediately if either ever leaks** (committed to git by accident, pasted in a support chat, etc.) — both grant full trust.
- **Back up the database on a schedule.** Supabase does daily backups on paid tiers; confirm your plan includes this and that you know how to restore.
- **Add basic monitoring/alerting** on the Game Controller process (e.g. a simple uptime check or `pm2`/systemd auto-restart) — if it crashes mid-round, games freeze with player stakes already deducted.
- **Consider responsible-gambling guardrails**: daily deposit caps, a cool-down after big losses, self-exclusion via the bot. Not required by this codebase, but worth checking against Ethiopia's specific licensing conditions.
- **Load-test the waiting room** before a real launch — the current `ensureWaitingGames` polls every 3s and assumes low concurrency; if you expect many simultaneous games per stake, revisit the "one waiting game per stake" assumption noted above.
- **Never commit `.env` files.** Double check `.gitignore` includes them in both the `bot/` and `controller/` repos before your first push.

## File map

```
supabase/schema.sql       Tables, RLS policies, join_game/mark_cell/claim_bingo RPCs
controller/gameController.js   Authoritative timer + number caller
bot/index.js               Telegram bot: register, deposit/withdraw requests, launch web app
web/index.html + lobby.js  Stake + board selection, join waiting game
web/game.html + game.js    Realtime listener, marking, bingo claim
web/wallet.html + wallet.js  Balance + transaction history (read-only)
```
