// VAMIOS BINGO — Game screen
//
// CRITICAL: this file never decides the clock, never decides which
// number is "next", and never decides who won. It only:
//   1. Subscribes to game_state (written exclusively by the Game
//      Controller via its service_role key)
//   2. Renders whatever that state says
//   3. Sends mark_cell / claim_bingo RPC calls, whose results are
//      verified entirely server-side (see schema.sql claim_bingo fn)

const params = new URLSearchParams(window.location.search);
const gameId = params.get('game') || sessionStorage.getItem('vamios_game_id');
const currentUser = sessionStorage.getItem('vamios_user_id');
const boardCells = JSON.parse(sessionStorage.getItem('vamios_board_cells') || '[]');

let markedCells = new Set([0]); // free space always "marked"

function renderBoard() {
  const el = document.getElementById('playerBoard');
  el.innerHTML = '';
  boardCells.forEach((num, idx) => {
    const cell = document.createElement('button');
    cell.textContent = idx === 12 ? 'FREE' : num;
    cell.className = 'bingo-cell' + (markedCells.has(num) ? ' marked' : '');
    cell.addEventListener('click', () => toggleMark(num, cell));
    el.appendChild(cell);
  });
}

async function toggleMark(num, cellEl) {
  if (num === 0) return; // free space
  markedCells.add(num);
  cellEl.classList.add('marked');

  // Recorded server-side for audit — does NOT affect win verification,
  // which re-checks against the authoritative called_numbers list.
  await supabaseClient.rpc('mark_cell', {
    p_user_id: currentUser,
    p_game_id: gameId,
    p_number: num,
  });
}

function renderState(state) {
  document.getElementById('statusBadge').textContent = state.status;
  document.getElementById('currentNumber').textContent =
    state.status === 'waiting' ? `Starts in ${state.seconds_left}s` : (state.current_number ?? '--');

  const strip = document.getElementById('calledStrip');
  strip.innerHTML = (state.called_numbers || [])
    .map(n => `<span class="called-chip">${n}</span>`)
    .join('');

  if (state.status === 'finished' && state.winner_user_id) {
    document.getElementById('winnerScreen').classList.remove('hidden');
    document.getElementById('winnerText').textContent =
      state.winner_user_id === currentUser ? '🎉 You won!' : 'Game over';
    document.getElementById('prizeText').textContent =
      state.winner_user_id === currentUser
        ? 'Your prize (80% of pot) has been credited to your wallet.'
        : 'Better luck next round!';
  }
}

async function loadInitialState() {
  const { data: state } = await supabaseClient
    .from('game_state')
    .select('*')
    .eq('game_id', gameId)
    .single();
  if (state) renderState(state);
}

function subscribeToGameState() {
  supabaseClient
    .channel(`game_state:${gameId}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'game_state', filter: `game_id=eq.${gameId}` },
      (payload) => renderState(payload.new)
    )
    .subscribe();
}

document.getElementById('bingoBtn').addEventListener('click', async () => {
  const { data: isWinner, error } = await supabaseClient.rpc('claim_bingo', {
    p_user_id: currentUser,
    p_game_id: gameId,
  });

  if (error) {
    alert('Claim rejected: ' + error.message);
    return;
  }

  if (!isWinner) {
    alert('Not a valid bingo yet — keep playing!');
  }
  // If it IS a winner, the game_state UPDATE will arrive via the
  // realtime subscription above and render the winner screen —
  // we don't trust the RPC return value alone for the UI state.
});

renderBoard();
loadInitialState();
subscribeToGameState();
