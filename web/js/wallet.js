// VAMIOS BINGO — Wallet screen (read-only; requests are made via the bot)

async function loadWallet() {
  const wallet = await fetchWallet();
  document.getElementById('balance').textContent = `${wallet.balance} credits`;

  const list = document.getElementById('txList');
  list.innerHTML = (wallet.transactions || []).map(tx => `
    <div class="tx-row">
      <span class="tx-type">${tx.type.replace('_', ' ')}</span>
      <span class="tx-amount">${tx.amount}</span>
      <span class="tx-status ${tx.status}">${tx.status}</span>
    </div>
  `).join('') || '<p class="hint">No transactions yet.</p>';
}

loadWallet();
