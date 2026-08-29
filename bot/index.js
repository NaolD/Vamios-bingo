/**
 * VAMIOS BINGO — Telegram Bot
 *
 * Handles: registration, deposit/withdraw REQUESTS (admin-approved,
 * not live payment processing — see README), and launching the
 * GitHub Pages web app with a signed auth token.
 */

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const WEBAPP_URL = process.env.WEBAPP_URL; // e.g. https://yourname.github.io/vamios-bingo
const JWT_SECRET = process.env.JWT_SECRET;

async function getOrCreateUser(ctx) {
  const telegramId = ctx.from.id;
  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', telegramId).maybeSingle();

  if (!user) {
    const { data: newUser } = await supabase.from('users').insert({
      telegram_id: telegramId,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
    }).select().single();

    await supabase.from('wallets').insert({ user_id: newUser.id, balance: 0 });
    user = newUser;
  }
  return user;
}

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx);
  ctx.reply(
    `Welcome to VAMIOS Bingo, ${ctx.from.first_name}! 🎱`,
    Markup.keyboard([
      ['🎮 Open Game', '💰 Wallet'],
      ['⬆️ Deposit', '⬇️ Withdraw'],
    ]).resize()
  );
});

bot.hears('🎮 Open Game', async (ctx) => {
  const user = await getOrCreateUser(ctx);
  // Short-lived signed token — the web app verifies this to know
  // which Supabase user_id the session belongs to.
  const token = jwt.sign({ user_id: user.id, telegram_id: user.telegram_id }, JWT_SECRET, { expiresIn: '10m' });
  const url = `${WEBAPP_URL}/?token=${token}`;

  ctx.reply(
    'Tap below to open the game:',
    Markup.inlineKeyboard([Markup.button.webApp('Open VAMIOS Bingo', url)])
  );
});

bot.hears('💰 Wallet', async (ctx) => {
  const user = await getOrCreateUser(ctx);
  const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', user.id).single();
  ctx.reply(`Your balance: ${wallet.balance} credits`);
});

bot.hears('⬆️ Deposit', async (ctx) => {
  ctx.reply('How many credits would you like to deposit? Reply with a number.');
  ctx.session ??= {};
  pendingAction.set(ctx.from.id, 'deposit');
});

bot.hears('⬇️ Withdraw', async (ctx) => {
  ctx.reply('How many credits would you like to withdraw? Reply with a number.');
  pendingAction.set(ctx.from.id, 'withdraw');
});

// Simple in-memory pending-action map (swap for real session storage in production)
const pendingAction = new Map();

bot.on('text', async (ctx) => {
  const action = pendingAction.get(ctx.from.id);
  if (!action) return;

  const amount = parseFloat(ctx.message.text);
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('Please enter a valid positive number.');
  }

  const user = await getOrCreateUser(ctx);

  const { data: tx } = await supabase.from('wallet_transactions').insert({
    user_id: user.id,
    type: action === 'deposit' ? 'deposit_request' : 'withdraw_request',
    amount,
    status: 'pending',
  }).select().single();

  pendingAction.delete(ctx.from.id);

  ctx.reply(
    `Your ${action} request for ${amount} credits has been submitted and is pending admin approval. ` +
    `You'll be notified once it's processed.`
  );

  // Notify admin channel/chat with ready-to-tap approve/reject commands
  if (process.env.ADMIN_CHAT_ID && tx) {
    bot.telegram.sendMessage(
      process.env.ADMIN_CHAT_ID,
      `New ${action} request: ${amount} credits from @${ctx.from.username || ctx.from.id}\n\n` +
      `/approve ${tx.id}\n/reject ${tx.id}`
    );
  }
});

// ------------------------------------------------------------
// ADMIN APPROVAL FLOW — deposits/withdrawals
// Only usable from ADMIN_CHAT_ID. This is the only place that
// actually moves wallet balances for deposit/withdraw requests.
// ------------------------------------------------------------

function isAdmin(ctx) {
  return String(ctx.chat.id) === String(process.env.ADMIN_CHAT_ID);
}

async function getTransaction(txId) {
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('*, users(telegram_id, username, first_name)')
    .eq('id', txId)
    .single();
  return error ? null : data;
}

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const { data: txs } = await supabase
    .from('wallet_transactions')
    .select('id, type, amount, created_at, users(username, first_name, telegram_id)')
    .in('type', ['deposit_request', 'withdraw_request'])
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (!txs || txs.length === 0) {
    return ctx.reply('No pending requests.');
  }

  const lines = txs.map(tx =>
    `#${tx.id.slice(0, 8)} — ${tx.type.replace('_request', '')} ${tx.amount} — ` +
    `@${tx.users?.username || tx.users?.telegram_id}\n` +
    `  /approve ${tx.id}  |  /reject ${tx.id}`
  );
  ctx.reply(lines.join('\n\n'));
});

bot.command('approve', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const txId = ctx.message.text.split(' ')[1];
  if (!txId) return ctx.reply('Usage: /approve <transaction_id>');

  const tx = await getTransaction(txId);
  if (!tx) return ctx.reply('Transaction not found.');
  if (tx.status !== 'pending') return ctx.reply(`Already ${tx.status}.`);

  if (tx.type === 'deposit_request') {
    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', tx.user_id).single();
    await supabase.from('wallets').update({
      balance: (wallet?.balance || 0) + tx.amount,
      updated_at: new Date().toISOString(),
    }).eq('user_id', tx.user_id);

    await supabase.from('wallet_transactions').update({
      status: 'approved', resolved_at: new Date().toISOString(),
    }).eq('id', tx.id);

  } else if (tx.type === 'withdraw_request') {
    const { data: wallet } = await supabase.from('wallets').select('balance').eq('user_id', tx.user_id).single();

    if ((wallet?.balance || 0) < tx.amount) {
      await supabase.from('wallet_transactions').update({
        status: 'rejected', resolved_at: new Date().toISOString(), note: 'insufficient balance at approval time',
      }).eq('id', tx.id);
      return ctx.reply('Rejected — user no longer has sufficient balance.');
    }

    await supabase.from('wallets').update({
      balance: wallet.balance - tx.amount,
      updated_at: new Date().toISOString(),
    }).eq('user_id', tx.user_id);

    await supabase.from('wallet_transactions').update({
      status: 'approved', resolved_at: new Date().toISOString(),
    }).eq('id', tx.id);
  }

  ctx.reply(`✅ Approved ${tx.type.replace('_request', '')} of ${tx.amount} for @${tx.users?.username || tx.users?.telegram_id}.`);

  // Notify the player
  if (tx.users?.telegram_id) {
    bot.telegram.sendMessage(
      tx.users.telegram_id,
      `✅ Your ${tx.type.replace('_request', '')} of ${tx.amount} credits was approved.`
    ).catch(() => {});
  }
});

bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx)) return;

  const txId = ctx.message.text.split(' ')[1];
  if (!txId) return ctx.reply('Usage: /reject <transaction_id>');

  const tx = await getTransaction(txId);
  if (!tx) return ctx.reply('Transaction not found.');
  if (tx.status !== 'pending') return ctx.reply(`Already ${tx.status}.`);

  await supabase.from('wallet_transactions').update({
    status: 'rejected', resolved_at: new Date().toISOString(),
  }).eq('id', tx.id);

  ctx.reply(`❌ Rejected ${tx.type.replace('_request', '')} of ${tx.amount} for @${tx.users?.username || tx.users?.telegram_id}.`);

  if (tx.users?.telegram_id) {
    bot.telegram.sendMessage(
      tx.users.telegram_id,
      `❌ Your ${tx.type.replace('_request', '')} of ${tx.amount} credits was rejected. Contact support if you believe this is an error.`
    ).catch(() => {});
  }
});

// ------------------------------------------------------------
// RAILWAY-COMPATIBLE STARTUP
//
// Railway can restart/health-check a service on its assigned PORT.
// This bot doesn't need an HTTP port to function (Telegram polling
// works fine headless), but we bind a tiny server anyway so that:
//   - Railway's health checks pass if you ever enable a public domain
//   - "Application failed to respond" doesn't get misread as a crash
//
// Set USE_WEBHOOK=true + let Railway provide RAILWAY_PUBLIC_DOMAIN to
// switch from polling to webhook mode, which is generally more
// reliable on platforms like Railway than long polling.
// ------------------------------------------------------------

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('VAMIOS Bingo bot is running.'));
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN;

async function start() {
  if (USE_WEBHOOK && WEBHOOK_DOMAIN) {
    const webhookPath = `/telegraf/${process.env.BOT_TOKEN}`;
    const webhookUrl = `https://${WEBHOOK_DOMAIN}${webhookPath}`;

    app.use(bot.webhookCallback(webhookPath));
    await bot.telegram.setWebhook(webhookUrl);

    app.listen(PORT, () => {
      console.log(`VAMIOS Bingo bot running in WEBHOOK mode on port ${PORT}`);
      console.log(`Webhook set to ${webhookUrl}`);
    });
  } else {
    app.listen(PORT, () => {
      console.log(`Health-check server listening on port ${PORT}`);
    });
    await bot.launch();
    console.log('VAMIOS Bingo bot running in POLLING mode...');
  }
}

start();

process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
