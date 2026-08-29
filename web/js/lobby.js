// VAMIOS BINGO — Lobby logic
// This file only ever READS game_state / games via Supabase, and
// calls the join_game RPC to join. It never writes game state directly.

let currentUser = null;
let selectedStake = null;
let selectedBoard = null;
let currentGameId = null;

async function init() {
  // In production: verify `token` server-side (e.g. via a small edge
  // function) and resolve it to a Supabase user_id + session.
  // For this scaffold we assume a resolved user_id is available.
  currentUser = await resolveCurrentUser();
  await refreshBalance();
}

async function resolveCurrentUser() {
  const userId = await verifyAndResolveUser();
  if (!userId) {
    document.body.innerHTML =
      '<p style="padding:24px;text-align:center;color:#e63946;">' +
      'Session expired or invalid. Please reopen the game from the Telegram bot.</p>';
    throw new Error('No valid session');
  }
  return userId;
}

async function refreshBalance() {
  const wallet = await fetchWallet();
  document.getElementById('balance').textContent = `${wallet.balance} credits`;
}

document.querySelectorAll('.stake-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    selectedStake = parseInt(btn.dataset.stake, 10);
    document.getElementById('stakeSelect').classList.add('hidden');
    document.getElementById('boardSelect').classList.remove('hidden');
    await loadTakenBoards();
  });
});

async function loadTakenBoards() {
  // Find (or the controller will create) the current waiting game for this stake
  const { data: game } = await supabaseClient
    .from('games')
    .select('id')
    .eq('stake', selectedStake)
    .eq('status', 'waiting')
    .maybeSingle();

  currentGameId = game?.id || null;

  let taken = [];
  if (currentGameId) {
    const { data: players } = await supabaseClient
      .from('game_players')
      .select('board_number')
      .eq('game_id', currentGameId);
    taken = (players || []).map(p => p.board_number);
  }

  renderBoardGrid(taken);
}

function renderBoardGrid(taken) {
  const grid = document.getElementById('boardGrid');
  grid.innerHTML = '';
  for (let i = 1; i <= 100; i++) {
    const cell = document.createElement('button');
    cell.textContent = i;
    cell.className = 'board-cell' + (taken.includes(i) ? ' taken' : '');
    cell.disabled = taken.includes(i);
    cell.addEventListener('click', () => {
      document.querySelectorAll('.board-cell.selected').forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');
      selectedBoard = i;
      document.getElementById('joinBtn').disabled = false;
    });
    grid.appendChild(cell);
  }
}

document.getElementById('joinBtn').addEventListener('click', async () => {
  // Generate the 25-cell board content client-side, but it gets
  // permanently RECORDED server-side via the join_game RPC —
  // the client can't change it after this point.
  const boardCells = generateBingoBoard();

  const { error } = await supabaseClient.rpc('join_game', {
    p_user_id: currentUser,
    p_game_id: currentGameId,
    p_board_number: selectedBoard,
    p_board_cells: boardCells,
  });

  if (error) {
    alert('Could not join: ' + error.message);
    return;
  }

  sessionStorage.setItem('vamios_game_id', currentGameId);
  sessionStorage.setItem('vamios_board_cells', JSON.stringify(boardCells));
  window.location.href = `game.html?game=${currentGameId}`;
});

// Standard 5x5 bingo board: B(1-15) I(16-30) N(31-45, center free) G(46-60) O(61-75)
function generateBingoBoard() {
  const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
  const columns = ranges.map(([min, max]) => {
    const pool = [];
    for (let n = min; n <= max; n++) pool.push(n);
    return shuffle(pool).slice(0, 5);
  });

  const board = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      if (row === 2 && col === 2) {
        board.push(0); // free space
      } else {
        board.push(columns[col][row]);
      }
    }
  }
  return board;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

init();
