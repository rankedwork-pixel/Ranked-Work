// Ranked Work application logic (Supabase edition)
// This script implements a productivity tracker with ranked progression,
// placement matches, LP system and analytics. It uses Supabase for
// persistent storage of profiles, histories and friends. Users can
// register with either a real email or a simple username; behind the
// scenes a synthetic email of the form <username>@rankedwork.local is
// generated when no @ is present. Friends and history data are stored
// centrally, allowing access across devices and sessions.

// Helper for selecting elements by id
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------
// Global state
// ------------------------------------------------------------
// The name of the currently logged‑in user (email string) or null
let currentUserName = null;
// Application state for the current session. These variables mirror fields
// stored for each user and are loaded when a user logs in.
let tasks = [];
let startedAt = null;
let timerInterval = null;
let pausedDuration = 0;
let isPaused = false;
let pauseStartedAt = null;
let dailyXp = 0;
let totalXp = 0;
let placementsPlayed = 0;
let placementsScores = [];
let lp = 0;
let rankIndex = 0;
let history = [];
// When placements are complete, isInPlacements becomes false
let isInPlacements = true;

// Number of placement games required before rank is determined
const placementsCount = 10;

// Rank thresholds (eight tiers). Adjust these values to control how much XP is
// required for each tier. Tiers must be sorted by increasing `min` value.
const ranks = [
  { name: 'Bronze',      min: 0 },
  { name: 'Silver',      min: 3000 },
  { name: 'Gold',        min: 8000 },
  { name: 'Platinum',    min: 15000 },
  { name: 'Diamond',     min: 25000 },
  { name: 'Master',      min: 40000 },
  { name: 'Grandmaster', min: 60000 },
  { name: 'Challenger',  min: 85000 }
];

// Baseline XP values used to evaluate wins and losses for each rank. The
// daily XP of a day is compared against the baseline for the current
// rank to determine whether the day is considered a win (above the
// baseline) or a loss (below the baseline). These values roughly map
// longer work days (low XP) to lower ranks and faster days (high XP) to
// higher ranks. Feel free to adjust these values to fine‑tune difficulty.
const rankBaselines = [200, 350, 500, 650, 800, 900, 950, 1000];

// Determine a starting rank index based on the average XP earned during
// placement matches. Higher average XP yields a higher starting tier.
function getStartingRankIndex(avgXp) {
  if (avgXp >= 920) return 7;        // Challenger
  if (avgXp >= 850) return 6;        // Grandmaster
  if (avgXp >= 750) return 5;        // Master
  if (avgXp >= 650) return 4;        // Diamond
  if (avgXp >= 500) return 3;        // Platinum
  if (avgXp >= 350) return 2;        // Gold
  if (avgXp >= 200) return 1;        // Silver
  return 0;                          // Bronze
}

// Calculate LP change based on daily performance relative to the baseline.
// A positive value indicates a win; a negative value indicates a loss.
// Gains and losses are capped between 10 and 30 LP to simulate the
// variability of LP adjustments in competitive games. The ratio scales
// rewards for exceptionally good or bad days.
function calculateLpChange(dailyXpValue, baseline) {
  // Prevent division by zero and extremely small numbers
  const safeXp = Math.max(1, dailyXpValue);
  if (safeXp >= baseline) {
    const ratio = safeXp / baseline;
    const rawGain = Math.round(20 * ratio);
    return Math.max(10, Math.min(30, rawGain));
  } else {
    const ratio = baseline / safeXp;
    const rawLoss = Math.round(20 * ratio);
    return -Math.max(10, Math.min(30, rawLoss));
  }
}

// Constants used for XP calculation
const K_VALUE = 1200;
const B_VALUE = 0.25;

// Pagination settings for analytics. Show a limited number of rows at once.
const historyPageSize = 5;
let historyPageIndex = 0;

// ------------------------------------------------------------
// Supabase helpers and normalisation
// ------------------------------------------------------------
// Convert a user input into a valid identifier. If the input already
// looks like an email (contains '@'), it is returned unchanged. Otherwise
// a synthetic email in the rankedwork.local domain is produced.
function normalizeId(input) {
  const s = (input || '').trim().toLowerCase();
  if (!s) return '';
  return s.includes('@') ? s : `${s.replace(/[^a-z0-9._-]/g, '')}@rankedwork.local`;
}

// Convert an email-like identifier into a display name by stripping the domain.
const displayName = (emailLike) => (emailLike || '').split('@')[0];

// ------------------------------------------------------------
// UI helper functions
// ------------------------------------------------------------

// Populate rank and hour tables on DOM load
function populateTables() {
  // Populate rank table
  const rankBody = document.querySelector('#rankTable tbody');
  if (rankBody) {
    rankBody.innerHTML = '';
    ranks.forEach((rank, index) => {
      const tr = document.createElement('tr');
      // Emblem cell
      const tdIcon = document.createElement('td');
      const img = document.createElement('img');
      img.src = `emblems/${rank.name.toLowerCase()}.png`;
      img.alt = `${rank.name} emblem`;
      img.className = 'rank-icon';
      tdIcon.appendChild(img);
      // Name cell
      const tdName = document.createElement('td');
      tdName.textContent = rank.name;
      // Min XP cell: display baseline XP instead of static threshold
      const tdMin = document.createElement('td');
      const baseline = rankBaselines[index];
      tdMin.textContent = baseline.toLocaleString();
      tr.appendChild(tdIcon);
      tr.appendChild(tdName);
      tr.appendChild(tdMin);
      rankBody.appendChild(tr);
    });
    // Highlight the current rank row
    highlightRank();
  }
  // Populate XP per hour table (1 to 8 hours)
  const hourBody = document.querySelector('#hourTable tbody');
  if (hourBody) {
    hourBody.innerHTML = '';
    for (let hours = 1; hours <= 8; hours++) {
      const tr = document.createElement('tr');
      const thours = document.createElement('td');
      thours.textContent = hours;
      // Outcome: hours 1–4 are wins, 5–8 are losses
      const outcomeCell = document.createElement('td');
      if (hours <= 4) {
        outcomeCell.textContent = 'Win';
        outcomeCell.style.color = '#8cdf6c';
      } else {
        outcomeCell.textContent = 'Loss';
        outcomeCell.style.color = '#e88c8c';
      }
      tr.appendChild(thours);
      tr.appendChild(outcomeCell);
      hourBody.appendChild(tr);
    }
  }
}

// Determine rank name based on total XP (fallback when rankIndex undefined)
function getRank(total) {
  for (let i = ranks.length - 1; i >= 0; i--) {
    if (total >= ranks[i].min) return ranks[i].name;
  }
  return ranks[0].name;
}

// Highlight the current rank row in the rank table
function highlightRank() {
  // Highlight the current rank row using the rankIndex. During
  // placements, highlight Bronze because the rank is not yet assigned.
  const currentRank = ranks[rankIndex]?.name || ranks[0].name;
  const rows = document.querySelectorAll('#rankTable tbody tr');
  rows.forEach((tr) => {
    const nameCell = tr.children[1];
    if (nameCell && nameCell.textContent === currentRank) {
      tr.classList.add('active-rank');
    } else {
      tr.classList.remove('active-rank');
    }
  });
}

// Show login form and hide the app
function showLogin() {
  const loginContainer = $('loginContainer');
  const appContainer = $('appContainer');
  const signOutBtn = $('signOutBtn');
  if (loginContainer) loginContainer.style.display = 'block';
  if (appContainer) appContainer.style.display = 'none';
  if (signOutBtn) signOutBtn.style.display = 'none';
}

// Show the app interface and hide login form
function showApp() {
  const loginContainer = $('loginContainer');
  const appContainer = $('appContainer');
  const signOutBtn = $('signOutBtn');
  if (loginContainer) loginContainer.style.display = 'none';
  if (appContainer) appContainer.style.display = 'block';
  if (signOutBtn) signOutBtn.style.display = 'inline-block';
  const friendSection = $('friendSection');
  if (friendSection) friendSection.style.display = 'block';
}

// ------------------------------------------------------------
// Supabase-backed user management
// ------------------------------------------------------------

// Load user state from Supabase into global variables and refresh UI
async function loadUserState(username) {
  try {
    const { data: p } = await sb.from('profiles').select('*').eq('username', username).single();
    if (!p) return;
    currentUserName = username;
    totalXp = p.total_xp || 0;
    placementsPlayed = p.placements_played || 0;
    lp = p.lp || 0;
    rankIndex = p.rank_index || 0;
    // Reset session-specific variables
    tasks = [];
    startedAt = null;
    pausedDuration = 0;
    isPaused = false;
    pauseStartedAt = null;
    dailyXp = 0;
    // Determine placements state
    isInPlacements = placementsPlayed < placementsCount;
    // Reset any running timer
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    // Load history entries
    const { data: rows } = await sb.from('histories').select('*').eq('username', username).order('id', { ascending: true });
    history = rows || [];
    // Update UI
    $('timerDisplay').textContent = 'Not started';
    renderTasks();
    updateTotals();
    updateAnalytics();
    await renderFriends();
    $('dailyXp').textContent = '0';
  } catch (err) {
    console.error('loadUserState error:', err);
  }
}

// Persist current user's state to Supabase
async function saveUsers() {
  if (!currentUserName) return;
  try {
    await sb.from('profiles').upsert({
      username: currentUserName,
      total_xp: totalXp,
      placements_played: placementsPlayed,
      lp: lp,
      rank_index: rankIndex
    });
  } catch (err) {
    console.error('saveUsers error:', err);
  }
}

// Register a new user or log in if already registered. Accepts either
// real emails or plain usernames. Returns true on success.
async function registerUser(username, password) {
  const email = normalizeId(username);
  if (!email || (password || '').length < 6) return false;
  try {
    // Attempt sign-up
    const { error: e1 } = await sb.auth.signUp({ email, password });
    // If there's an error other than "registered" fail
    if (e1 && !/registered/i.test(e1.message)) {
      console.error('signUp error:', e1);
      return false;
    }
    // Ensure a profile row exists
    const { data: exists } = await sb.from('profiles').select('username').eq('username', email).maybeSingle();
    if (!exists) {
      const { error: e2 } = await sb.from('profiles').insert({ username: email });
      if (e2 && e2.code !== '23505') {
        console.error('profiles insert error:', e2);
        return false;
      }
    }
    // If user already registered, sign them in
    if (e1 && /registered/i.test(e1.message)) {
      const { error: e3 } = await sb.auth.signInWithPassword({ email, password });
      if (e3) {
        console.error('signIn after registered error:', e3);
        return false;
      }
    }
    // At this point we should have a session
    const { data: { user } } = await sb.auth.getUser();
    currentUserName = user?.email || email;
    await loadUserState(currentUserName);
    return true;
  } catch (err) {
    console.error('registerUser error:', err);
    return false;
  }
}

// Log in an existing user. Accepts either emails or usernames.
async function loginUser(username, password) {
  const email = normalizeId(username);
  if (!email || (password || '').length < 6) return false;
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      console.error('signIn error:', error);
      return false;
    }
    const { data: { user } } = await sb.auth.getUser();
    currentUserName = user?.email || email;
    await loadUserState(currentUserName);
    return true;
  } catch (err) {
    console.error('loginUser error:', err);
    return false;
  }
}

// Log out the current user and reset state
async function logoutUser() {
  await saveUsers();
  try {
    await sb.auth.signOut();
  } catch (err) {
    console.error('signOut error:', err);
  }
  // Reset global state
  currentUserName = null;
  tasks = [];
  startedAt = null;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  pausedDuration = 0;
  isPaused = false;
  pauseStartedAt = null;
  dailyXp = 0;
  totalXp = 0;
  placementsPlayed = 0;
  placementsScores = [];
  lp = 0;
  rankIndex = 0;
  history = [];
  isInPlacements = true;
  $('timerDisplay').textContent = 'Not started';
  renderTasks();
  updateTotals();
  updateAnalytics();
  showLogin();
}

// Render the current user's friend list and their stats
async function renderFriends() {
  const tableBody = document.querySelector('#friendTable tbody');
  if (!tableBody) return;
  tableBody.innerHTML = '';
  if (!currentUserName) return;
  try {
    const { data: rows } = await sb.from('friends').select('friend').eq('owner', currentUserName);
    for (const r of rows || []) {
      // Fetch friend's profile
      const { data: prof } = await sb.from('profiles').select('total_xp, rank_index').eq('username', r.friend).single();
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = displayName(r.friend);
      const tdRank = document.createElement('td');
      const rankName = ranks[prof?.rank_index || 0]?.name || ranks[0].name;
      tdRank.textContent = rankName;
      const tdXp = document.createElement('td');
      tdXp.textContent = prof?.total_xp || 0;
      tr.appendChild(tdName);
      tr.appendChild(tdRank);
      tr.appendChild(tdXp);
      tableBody.appendChild(tr);
    }
  } catch (err) {
    console.error('renderFriends error:', err);
  }
}

// Add a friend to the current user's friend list
async function addFriend() {
  if (!currentUserName) return;
  const input = $('friendInput');
  if (!input) return;
  const friendNameRaw = input.value.trim();
  if (!friendNameRaw) return;
  const friendEmail = normalizeId(friendNameRaw);
  if (friendEmail === currentUserName) {
    alert('You cannot add yourself as a friend.');
    input.value = '';
    return;
  }
  try {
    // Verify the friend exists
    const { data: exists } = await sb.from('profiles').select('username').eq('username', friendEmail).maybeSingle();
    if (!exists) {
      alert('User not found.');
      input.value = '';
      return;
    }
    // Insert friend row; ignore duplicate key errors
    const { error } = await sb.from('friends').insert({ owner: currentUserName, friend: friendEmail });
    if (error && error.code !== '23505') {
      console.error('addFriend error:', error);
      alert('Could not add friend.');
      input.value = '';
      return;
    }
    input.value = '';
    await renderFriends();
    alert(`${displayName(friendEmail)} added to your friends list.`);
  } catch (err) {
    console.error('addFriend error:', err);
  }
}

// ------------------------------------------------------------
// Task management and timer functions (unchanged)
// ------------------------------------------------------------

// Render the tasks list to the DOM
function renderTasks() {
  const list = $('taskList');
  if (!list) return;
  list.innerHTML = '';
  tasks.forEach((task) => {
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked;
      checkCompletion();
    });
    const span = document.createElement('span');
    span.className = 'task-title';
    span.textContent = task.title;
    li.appendChild(checkbox);
    li.appendChild(span);
    // Actions container: reorder, edit and remove buttons
    const actions = document.createElement('div');
    actions.className = 'task-actions';
    // Move up button
    const upBtn = document.createElement('button');
    upBtn.className = 'move-up';
    upBtn.title = 'Move up';
    upBtn.textContent = '▲';
    upBtn.addEventListener('click', () => {
      const idx = tasks.indexOf(task);
      if (idx > 0) {
        const temp = tasks[idx - 1];
        tasks[idx - 1] = task;
        tasks[idx] = temp;
        renderTasks();
        checkCompletion();
        if (!startedAt) {
          $('timerDisplay').textContent = tasks.length > 0 ? `Planned tasks: ${tasks.length}` : 'Not started';
        }
      }
    });
    // Move down button
    const downBtn = document.createElement('button');
    downBtn.className = 'move-down';
    downBtn.title = 'Move down';
    downBtn.textContent = '▼';
    downBtn.addEventListener('click', () => {
      const idx = tasks.indexOf(task);
      if (idx < tasks.length - 1) {
        const temp = tasks[idx + 1];
        tasks[idx + 1] = task;
        tasks[idx] = temp;
        renderTasks();
        checkCompletion();
        if (!startedAt) {
          $('timerDisplay').textContent = tasks.length > 0 ? `Planned tasks: ${tasks.length}` : 'Not started';
        }
      }
    });
    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-task';
    editBtn.title = 'Edit task';
    editBtn.textContent = '✏';
    editBtn.addEventListener('click', () => {
      const newTitle = prompt('Edit task', task.title);
      if (newTitle !== null) {
        const trimmed = newTitle.trim();
        if (trimmed.length > 0) {
          task.title = trimmed;
        }
        renderTasks();
        checkCompletion();
      }
    });
    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-task';
    removeBtn.title = 'Remove task';
    removeBtn.textContent = '✖';
    removeBtn.addEventListener('click', () => {
      const idx = tasks.indexOf(task);
      if (idx !== -1) {
        tasks.splice(idx, 1);
        renderTasks();
        checkCompletion();
        if (!startedAt) {
          $('timerDisplay').textContent = tasks.length > 0 ? `Planned tasks: ${tasks.length}` : 'Not started';
        }
      }
    });
    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);
    li.appendChild(actions);
    list.appendChild(li);
  });
  checkCompletion();
}

// Check if all tasks are completed; enable stop button accordingly
function checkCompletion() {
  const planned = tasks.length;
  const completed = tasks.filter((t) => t.done).length;
  $('stopBtn').disabled = !(startedAt && planned > 0 && completed === planned);
}

// Format milliseconds into HH:MM:SS
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Timer update callback
function updateTimer() {
  if (!startedAt) return;
  const now = Date.now();
  const elapsed = now - startedAt - pausedDuration;
  $('timerDisplay').textContent = formatDuration(elapsed);
}

// Start day handler
function startDay() {
  if (startedAt) return;
  if (tasks.length === 0) {
    alert('Please add at least one task before starting.');
    return;
  }
  startedAt = Date.now();
  pausedDuration = 0;
  isPaused = false;
  pauseStartedAt = null;
  timerInterval = setInterval(updateTimer, 500);
  $('startBtn').disabled = true;
  const pauseBtn = $('pauseBtn');
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.textContent = 'Pause';
  }
  $('stopBtn').disabled = true;
  $('timerDisplay').textContent = '00:00:00';
  checkCompletion();
}

// Pause/resume handler
function togglePause() {
  if (!startedAt) return;
  const pauseBtn = $('pauseBtn');
  if (isPaused) {
    if (pauseStartedAt) {
      pausedDuration += Date.now() - pauseStartedAt;
    }
    pauseStartedAt = null;
    isPaused = false;
    if (pauseBtn) pauseBtn.textContent = 'Pause';
    $('stopBtn').disabled = tasks.length === 0 || tasks.some((t) => !t.done);
  } else {
    pauseStartedAt = Date.now();
    isPaused = true;
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    $('stopBtn').disabled = true;
  }
}

// Stop day handler
async function stopDay() {
  if (!startedAt) return;
  // If the day is paused when stopping, accumulate the paused time
  if (isPaused) {
    if (pauseStartedAt) {
      pausedDuration += Date.now() - pauseStartedAt;
    }
    pauseStartedAt = null;
    isPaused = false;
  }
  clearInterval(timerInterval);
  const end = Date.now();
  const elapsedMs = end - startedAt - pausedDuration;
  // Compute hours, clamped between 0.25 and 12
  const hours = Math.max(0.25, Math.min(12, elapsedMs / 3600000));
  // XP formula: inverse time curve
  const baseXp = Math.round(K_VALUE / (hours + B_VALUE));
  // Determine bonus based on start and end times
  const startDate = new Date(startedAt);
  const endDate = new Date(end);
  const startHour = startDate.getHours();
  const endHour = endDate.getHours();
  let bonus = 0;
  if (startHour < 8) bonus += 0.1;
  if (endHour < 12) bonus += 0.1;
  if (bonus > 0.2) bonus = 0.2;
  dailyXp = Math.round(baseXp * (1 + bonus));
  $('dailyXp').textContent = dailyXp;
  // Placement logic
  if (isInPlacements) {
    placementsScores.push(dailyXp);
    placementsPlayed++;
    if (placementsPlayed >= placementsCount) {
      const sum = placementsScores.reduce((acc, val) => acc + val, 0);
      const avg = sum / placementsScores.length;
      rankIndex = getStartingRankIndex(avg);
      lp = 0;
      isInPlacements = false;
      alert(`Placements complete! Your starting rank is ${ranks[rankIndex].name}.`);
    } else {
      alert(`Placement match recorded. ${placementsPlayed} / ${placementsCount} completed.`);
    }
    totalXp += dailyXp;
    updateTotals();
  } else {
    // LP logic after placements
    const baseline = rankBaselines[rankIndex] || 200;
    const lpChange = calculateLpChange(dailyXp, baseline);
    lp += lpChange;
    let promoted = false;
    let demoted = false;
    if (lp >= 100) {
      lp -= 100;
      if (rankIndex < ranks.length - 1) {
        rankIndex++;
        promoted = true;
      } else {
        lp = 100;
      }
    }
    if (lp < 0) {
      lp += 100;
      if (rankIndex > 0) {
        rankIndex--;
        demoted = true;
      } else {
        lp = 0;
      }
    }
    totalXp += dailyXp;
    const changeText = lpChange > 0 ? `gained ${lpChange} LP` : `lost ${Math.abs(lpChange)} LP`;
    let message = `Match complete: you ${changeText}.`;
    if (promoted) {
      message += ` Promoted to ${ranks[rankIndex].name}!`;
    } else if (demoted) {
      message += ` Demoted to ${ranks[rankIndex].name}.`;
    }
    alert(message);
    updateTotals();
  }
  // Record analytics entry before resetting tasks.
  const completedTasks = tasks.length;
  const startStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endStr = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayOfWeek = startDate.toLocaleDateString([], { weekday: 'short' });
  const historyEntry = {
    username: currentUserName,
    date: new Date().toISOString().split('T')[0],
    day: dayOfWeek,
    start: startStr,
    end: endStr,
    hours: parseFloat(hours.toFixed(2)),
    tasks: completedTasks,
    xp: dailyXp,
    time_per_task: completedTasks > 0 ? parseFloat((hours / completedTasks).toFixed(2)) : hours
  };
  if (!isInPlacements) {
    const baselineForEntry = rankBaselines[rankIndex] || 200;
    const lpChangeForEntry = calculateLpChange(dailyXp, baselineForEntry);
    historyEntry.lp_change = lpChangeForEntry;
    historyEntry.lp_after = lp;
  } else {
    historyEntry.lp_change = null;
    historyEntry.lp_after = null;
  }
  try {
    await sb.from('histories').insert(historyEntry);
  } catch (err) {
    console.error('insert history error:', err);
  }
  history.push(historyEntry);
  await saveUsers();
  updateAnalytics();
  // Reset state for next day
  startedAt = null;
  tasks = [];
  renderTasks();
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  const pauseButton = $('pauseBtn');
  if (pauseButton) {
    pauseButton.disabled = true;
    pauseButton.textContent = 'Pause';
  }
}

// Update total XP and rank display
function updateTotals() {
  $('totalXp').textContent = totalXp;
  const rankName = ranks[rankIndex]?.name || ranks[0].name;
  $('rank').textContent = rankName;
  updateProgressBar();
  highlightRank();
  const rankIcon = document.getElementById('currentRankIcon');
  if (rankIcon) {
    rankIcon.src = `emblems/${rankName.toLowerCase()}.png`;
    rankIcon.alt = `${rankName} emblem`;
  }
  const curImg = document.getElementById('progressCurrentIcon');
  const nextImg = document.getElementById('progressNextIcon');
  if (isInPlacements) {
    const curName = ranks[0].name.toLowerCase();
    const nextName = ranks[1].name.toLowerCase();
    if (curImg) curImg.src = `emblems/${curName}.png`;
    if (nextImg) nextImg.src = `emblems/${nextName}.png`;
  } else {
    const curName = ranks[rankIndex].name.toLowerCase();
    const nextName = rankIndex < ranks.length - 1 ? ranks[rankIndex + 1].name.toLowerCase() : ranks[rankIndex].name.toLowerCase();
    if (curImg) curImg.src = `emblems/${curName}.png`;
    if (nextImg) nextImg.src = `emblems/${nextName}.png`;
  }
  const placementsInfo = document.getElementById('placementsInfo');
  const placementsCountEl = document.getElementById('placementsCount');
  const lpInfo = document.getElementById('lpInfo');
  const lpValueEl = document.getElementById('lpValue');
  if (placementsInfo && placementsCountEl && lpInfo && lpValueEl) {
    if (isInPlacements) {
      placementsInfo.style.display = 'block';
      lpInfo.style.display = 'none';
      placementsCountEl.textContent = `${placementsPlayed} / ${placementsCount}`;
    } else {
      placementsInfo.style.display = 'none';
      lpInfo.style.display = 'block';
      lpValueEl.textContent = lp;
    }
  }
}
async function resetProgress(confirmFirst = true) {
  if (confirmFirst && !confirm('Reset everything?')) return;

  // reset state
  totalXp = 0;
  dailyXp = 0;
  placementsPlayed = 0;
  placementsScores = [];
  isInPlacements = true;
  lp = 0;
  rankIndex = 0;
  history = [];
  historyPageIndex = 0;

  // reset timer
  if (timerInterval) clearInterval(timerInterval);
  startedAt = null;
  isPaused = false;
  pauseStartedAt = null;
  pausedDuration = 0;

  // reset UI
  const p = $('pauseBtn');
  if (p) { p.disabled = true; p.textContent = 'Pause'; }
  const t = $('timerDisplay');
  if (t) t.textContent = 'Not started';

  updateTotals();
  updateAnalytics();
  await saveUsers();
}

// Update the progress bar width based on current total XP or LP
function updateProgressBar() {
  const progressBar = $('progressBar');
  if (!progressBar) return;
  let pct;
  if (isInPlacements) {
    pct = (placementsPlayed / placementsCount) * 100;
    progressBar.title = `${Math.floor(pct)}% of placements completed`;
  } else {
    pct = (lp / 100) * 100;
    const nextName = rankIndex < ranks.length - 1 ? ranks[rankIndex + 1].name : ranks[rankIndex].name;
    progressBar.title = `${Math.floor(pct)}% toward ${nextName}`;
  }
  progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// Compute analytics summary and render history table
function updateAnalytics() {
  const tbody = document.querySelector('#historyTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  // Pagination
  const pageCount = Math.ceil(history.length / historyPageSize);
  const startIndex = history.length - (historyPageIndex + 1) * historyPageSize;
  const endIndex = startIndex + historyPageSize;
  const pageEntries = history.slice(Math.max(0, startIndex), Math.max(0, endIndex)).reverse();
  pageEntries.forEach((entry) => {
    const tr = document.createElement('tr');
    function td(text) {
      const cell = document.createElement('td');
      cell.textContent = text;
      return cell;
    }
    tr.appendChild(td(entry.date));
    tr.appendChild(td(entry.day));
    tr.appendChild(td(entry.start));
    tr.appendChild(td(entry.end));
    tr.appendChild(td(entry.hours));
    tr.appendChild(td(entry.tasks));
    tr.appendChild(td(entry.xp));
    tr.appendChild(td(entry.time_per_task));
    tbody.appendChild(tr);
  });
  // Compute summary statistics
  const totalHours = history.reduce((acc, e) => acc + (e.hours || 0), 0);
  const totalTasks = history.reduce((acc, e) => acc + (e.tasks || 0), 0);
  const totalTimePerTask = history.reduce((acc, e) => acc + (e.time_per_task || 0), 0);
  const count = history.length;
  const avgHours = count ? (totalHours / count).toFixed(2) : '0';
  const avgTasks = count ? (totalTasks / count).toFixed(2) : '0';
  const avgTimePerTask = count ? (totalTimePerTask / count).toFixed(2) : '0';
  $('avgHours').textContent = avgHours;
  $('avgTasks').textContent = avgTasks;
  $('avgTimePerTask').textContent = avgTimePerTask;
  // Update pagination controls
  const pageInfoEl = $('historyPageInfo');
  const prevBtn = $('prevHistoryPage');
  const nextBtn = $('nextHistoryPage');
  if (pageInfoEl) {
    pageInfoEl.textContent = pageCount > 0 ? `Page ${historyPageIndex + 1} / ${pageCount}` : '';
  }
  if (prevBtn) {
    prevBtn.disabled = historyPageIndex >= pageCount - 1;
  }
  if (nextBtn) {
    nextBtn.disabled = historyPageIndex <= 0;
  }
}

// Change history page; direction +1 moves backward (older), -1 forward (newer)
function changeHistoryPage(direction) {
  const pageCount = Math.ceil(history.length / historyPageSize);
  historyPageIndex = Math.min(Math.max(historyPageIndex + direction, 0), Math.max(pageCount - 1, 0));
  updateAnalytics();
}

// Export history as CSV
function exportCsv() {
  if (!history || history.length === 0) {
    alert('No history to export.');
    return;
  }
  const header = ['Date', 'Day', 'Start', 'End', 'Hours', 'Tasks', 'XP', 'Time/Task'];
  const rows = history.map((e) => [
    e.date,
    e.day,
    e.start,
    e.end,
    e.hours,
    e.tasks,
    e.xp,
    e.time_per_task
  ]);
  let csvContent = header.join(',') + '\n';
  rows.forEach((row) => {
    csvContent += row.join(',') + '\n';
  });
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'history.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------
// Event bindings and initialization
// ------------------------------------------------------------

window.addEventListener('DOMContentLoaded', async () => {
  // Populate static tables
  populateTables();
  // Attempt to restore Supabase session
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (user) {
      currentUserName = user.email;
      await loadUserState(currentUserName);
      showApp();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error('getUser error:', err);
    showLogin();
  }
  updateTotals();
  updateAnalytics();
  // Task controls
  const addTaskBtn = $('addTaskBtn');
  if (addTaskBtn) addTaskBtn.addEventListener('click', () => {
    const input = $('taskInput');
    if (!input) return;
    const title = input.value.trim();
    if (title) {
      tasks.push({ title: title, done: false });
      input.value = '';
      renderTasks();
      if (!startedAt) {
        $('timerDisplay').textContent = `Planned tasks: ${tasks.length}`;
      }
    }
  });
  const taskInputEl = $('taskInput');
  if (taskInputEl) {
    taskInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const title = taskInputEl.value.trim();
        if (title) {
          tasks.push({ title: title, done: false });
          taskInputEl.value = '';
          renderTasks();
          if (!startedAt) {
            $('timerDisplay').textContent = `Planned tasks: ${tasks.length}`;
          }
        }
      }
    });
  }
  $('startBtn').addEventListener('click', startDay);
  $('stopBtn').addEventListener('click', stopDay);
  const pauseBtnEl = $('pauseBtn');
  if (pauseBtnEl) pauseBtnEl.addEventListener('click', togglePause);
  $('resetBtn').addEventListener('click', resetProgress);
  // Pagination and export controls
  const prevBtn = $('prevHistoryPage');
  const nextBtn = $('nextHistoryPage');
  const exportBtn = $('exportCsvBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => changeHistoryPage(1));
  if (nextBtn) nextBtn.addEventListener('click', () => changeHistoryPage(-1));
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);
  // Login/register controls
  const loginBtn = $('loginBtn');
  const registerBtn = $('registerBtn');
  const signOutBtn = $('signOutBtn');
  const addFriendBtn = $('addFriendBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
      const username = $('usernameInput').value;
      const password = $('passwordInput').value;
      const success = await loginUser(username, password);
      const errorEl = $('loginError');
      if (success) {
        $('usernameInput').value = '';
        $('passwordInput').value = '';
        if (errorEl) errorEl.style.display = 'none';
        showApp();
        updateTotals();
        updateAnalytics();
        await renderFriends();
      } else {
        if (errorEl) {
          errorEl.textContent = 'Invalid username or password.';
          errorEl.style.display = 'block';
        }
      }
    });
  }
  if (registerBtn) {
    registerBtn.addEventListener('click', async () => {
      const username = $('usernameInput').value;
      const password = $('passwordInput').value;
      const success = await registerUser(username, password);
      const errorEl = $('loginError');
      if (success) {
        $('usernameInput').value = '';
        $('passwordInput').value = '';
        if (errorEl) errorEl.style.display = 'none';
        alert('Account created! You are now logged in.');
        showApp();
        updateTotals();
        updateAnalytics();
        await renderFriends();
      } else {
        if (errorEl) {
          errorEl.textContent = 'Username already exists or invalid.';
          errorEl.style.display = 'block';
        }
      }
    });
  }
  $('resetBtn')?.addEventListener('click', async () => {
  await resetProgress(true);
});
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      await logoutUser();
    });
  }
  if (addFriendBtn) {
    addFriendBtn.addEventListener('click', async () => {
      await addFriend();
    });
  }
});
