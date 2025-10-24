// Ranked Work application logic (multi‑user edition)
// This script implements a productivity tracker with ranked progression, placement
// matches, LP system and analytics. It has been extended to support multiple
// user profiles with login and registration, basic password storage, and a
// lightweight friends system. User data is persisted in localStorage.

// Helper for selecting elements by id
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------
// Global state
// ------------------------------------------------------------
// A map of all users keyed by username. Each user object stores
// persistent fields: password, totalXp, placementsPlayed, placementsScores,
// lp, rankIndex, history (array), and friends (array of usernames).
// When using Supabase for persistence, this object is unused but retained for backward compatibility.
let users = {};
// The name of the currently logged‑in user (null if no user logged in)
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

// Helper to convert a simple username into an email address used by Supabase.
function toEmail(name) {
  return `${name.trim()}@rankedwork.local`;
}

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

// Populate rank and hour tables on DOM load
function populateTables() {
  // Populate rank table
  const rankBody = document.querySelector('#rankTable tbody');
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
    // Min XP cell
    const tdMin = document.createElement('td');
    // Display the baseline XP value instead of the old minimum XP threshold.
    // Baselines correspond by index to the ranks array.
    const baseline = rankBaselines[index];
    tdMin.textContent = baseline.toLocaleString();
    tr.appendChild(tdIcon);
    tr.appendChild(tdName);
    tr.appendChild(tdMin);
    rankBody.appendChild(tr);
  });
  // Populate XP per hour table (1 to 8 hours)
  const hourBody = document.querySelector('#hourTable tbody');
  hourBody.innerHTML = '';
  for (let hours = 1; hours <= 8; hours++) {
    const tr = document.createElement('tr');
    const thours = document.createElement('td');
    thours.textContent = hours;
    // Determine outcome. For simplicity, consider hours 1–4 as wins and 5–8 as losses.
    const outcomeCell = document.createElement('td');
    if (hours <= 4) {
      outcomeCell.textContent = 'Win';
      outcomeCell.style.color = '#8cdf6c'; // greenish for wins
    } else {
      outcomeCell.textContent = 'Loss';
      outcomeCell.style.color = '#e88c8c'; // reddish for losses
    }
    tr.appendChild(thours);
    tr.appendChild(outcomeCell);
    hourBody.appendChild(tr);
  }

  // After tables are populated, highlight the current rank row
  highlightRank();
}

// Determine rank name based on total XP
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
    // Name cell is at index 1 because index 0 is emblem
    const nameCell = tr.children[1];
    if (nameCell && nameCell.textContent === currentRank) {
      tr.classList.add('active-rank');
    } else {
      tr.classList.remove('active-rank');
    }
  });
}

// ------------------------------------------------------------
// Multi‑user management functions
// ------------------------------------------------------------

// Load users from localStorage into the global users object
function loadUsers() {
  // When using Supabase for persistence, there is no need to load local users.
  // This function intentionally left blank.
}

// Persist all users and current user state to localStorage
async function saveUsers() {
  // Persist the current user's state to Supabase. When no user is logged in,
  // nothing is saved.
  if (!currentUserName) return;
  await sb.from('profiles').upsert({
    username: currentUserName,
    total_xp: totalXp,
    placements_played: placementsPlayed,
    lp: lp,
    rank_index: rankIndex
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
  // Show friend section if user has any friends (always visible after login)
  const friendSection = $('friendSection');
  if (friendSection) friendSection.style.display = 'block';
}

// Initialize global state from the logged in user's data
function loadUserState(username) {
  const user = users[username];
  // Initialize user fields if they don't exist
  if (!user) return;
  currentUserName = username;
  // Assign global variables
  totalXp = user.totalXp || 0;
  placementsPlayed = user.placementsPlayed || 0;
  placementsScores = Array.isArray(user.placementsScores) ? user.placementsScores : [];
  lp = user.lp || 0;
  rankIndex = user.rankIndex || 0;
  history = Array.isArray(user.history) ? user.history : [];
  tasks = [];
  startedAt = null;
  pausedDuration = 0;
  isPaused = false;
  pauseStartedAt = null;
  dailyXp = 0;
  // Determine placements state
  isInPlacements = placementsPlayed < placementsCount;
  // Set isPaused and timer as not running
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  // Update UI to reflect loaded state
  $('timerDisplay').textContent = 'Not started';
  renderTasks();
  updateTotals();
  updateAnalytics();
  renderFriends();
  // Clear any previous completion message
  $('dailyXp').textContent = '0';
}

// Register a new user and log them in. Returns true on success.
function registerUser(username, password) {
  // Synchronous registration is no longer supported. Use registerUserAsync instead.
  return false;
}

// Log in an existing user. Returns true on success.
function loginUser(username, password) {
  // Synchronous login is no longer supported. Use loginUserAsync instead.
  return false;
}

// Log out the current user and reset state
async function logoutUser() {
  // Persist current user state
  await saveUsers();
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
  // Hide app and show login
  showLogin();
}

// --------------------------------------------------------------------
// Supabase-based user management
// --------------------------------------------------------------------

// Register a new user using Supabase and log them in. Returns true on success.
async function registerUserAsync(username, password) {
  const name = username.trim();
  if (!name) return false;
  const email = toEmail(name);
  // Sign up the user in Supabase auth
  const { error: authError } = await sb.auth.signUp({ email, password });
  if (authError) {
    return false;
  }
  // Create a corresponding profile row
  const { error: profileError } = await sb.from('profiles').insert({ username: email });
  if (profileError) {
    return false;
  }
  currentUserName = email;
  await loadUserStateAsync(email);
  return true;
}

// Log in an existing user via Supabase. Returns true on success.
async function loginUserAsync(username, password) {
  const name = username.trim();
  if (!name) return false;
  const email = toEmail(name);
  const { error: signInError } = await sb.auth.signInWithPassword({ email, password });
  if (signInError) {
    return false;
  }
  currentUserName = email;
  await loadUserStateAsync(email);
  return true;
}

// Load user state from Supabase and populate globals and UI.
async function loadUserStateAsync(username) {
  const { data: profile } = await sb.from('profiles').select('*').eq('username', username).maybeSingle();
  if (!profile) return;
  currentUserName = username;
  totalXp = profile.total_xp || 0;
  placementsPlayed = profile.placements_played || 0;
  lp = profile.lp || 0;
  rankIndex = profile.rank_index || 0;
  tasks = [];
  startedAt = null;
  pausedDuration = 0;
  isPaused = false;
  pauseStartedAt = null;
  dailyXp = 0;
  isInPlacements = placementsPlayed < placementsCount;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  $('timerDisplay').textContent = 'Not started';
  // Load history
  const { data: rows } = await sb.from('histories').select('*').eq('username', username).order('id', { ascending: true });
  history = rows || [];
  // Refresh UI
  renderTasks();
  updateTotals();
  updateAnalytics();
  await renderFriendsAsync();
  $('dailyXp').textContent = '0';
}

// Render friends by querying Supabase.
async function renderFriendsAsync() {
  const tableBody = document.querySelector('#friendTable tbody');
  if (!tableBody) return;
  tableBody.innerHTML = '';
  if (!currentUserName) return;
  const { data: friendRows } = await sb.from('friends').select('friend').eq('owner', currentUserName);
  const list = friendRows || [];
  for (const fr of list) {
    const friendEmail = fr.friend;
    const { data: prof } = await sb.from('profiles').select('total_xp, rank_index').eq('username', friendEmail).maybeSingle();
    const tr = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.textContent = friendEmail.split('@')[0];
    const rankCell = document.createElement('td');
    const rankName = ranks[prof?.rank_index || 0]?.name || 'Bronze';
    rankCell.textContent = rankName;
    const xpCell = document.createElement('td');
    xpCell.textContent = prof?.total_xp || 0;
    tr.appendChild(nameCell);
    tr.appendChild(rankCell);
    tr.appendChild(xpCell);
    tableBody.appendChild(tr);
  }
}

// Add a friend via Supabase by username.
async function addFriendAsync() {
  if (!currentUserName) return;
  const input = $('friendInput');
  if (!input) return;
  const friendName = input.value.trim();
  if (!friendName) return;
  const friendEmail = `${friendName}@rankedwork.local`;
  if (friendEmail === currentUserName) {
    alert('You cannot add yourself.');
    return;
  }
  const { data: exists } = await sb.from('profiles').select('username').eq('username', friendEmail).maybeSingle();
  if (!exists) {
    alert('User not found.');
    return;
  }
  const { error: insertError } = await sb.from('friends').insert({ owner: currentUserName, friend: friendEmail });
  if (insertError) {
    alert('Failed to add friend.');
    return;
  }
  input.value = '';
  await renderFriendsAsync();
  alert(`${friendName} added`);
}

// Render the current user's friend list and their stats
function renderFriends() {
  const tableBody = document.querySelector('#friendTable tbody');
  if (!tableBody) return;
  tableBody.innerHTML = '';
  if (!currentUserName) return;
  const u = users[currentUserName];
  if (!u || !Array.isArray(u.friends)) return;
  u.friends.forEach((fname) => {
    const friend = users[fname];
    if (!friend) return;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = fname;
    const tdRank = document.createElement('td');
    // Determine friend rank from their rankIndex or totalXp
    let fRankName = '';
    if (typeof friend.rankIndex === 'number' && ranks[friend.rankIndex]) {
      fRankName = ranks[friend.rankIndex].name;
    } else {
      // fallback: compute rank from totalXp using getRank
      fRankName = getRank(friend.totalXp || 0);
    }
    tdRank.textContent = fRankName;
    const tdXp = document.createElement('td');
    tdXp.textContent = friend.totalXp || 0;
    tr.appendChild(tdName);
    tr.appendChild(tdRank);
    tr.appendChild(tdXp);
    tableBody.appendChild(tr);
  });
}

// Add a friend to the current user's friend list
function addFriend() {
  if (!currentUserName) return;
  const input = $('friendInput');
  if (!input) return;
  const friendName = input.value.trim();
  if (!friendName) return;
  if (friendName === currentUserName) {
    alert('You cannot add yourself as a friend.');
    return;
  }
  if (!users[friendName]) {
    alert('User not found.');
    return;
  }
  const u = users[currentUserName];
  if (!u.friends) u.friends = [];
  if (u.friends.includes(friendName)) {
    alert('Friend already added.');
    input.value = '';
    return;
  }
  u.friends.push(friendName);
  input.value = '';
  renderFriends();
  saveUsers();
  alert(`${friendName} added to your friends list.`);
}

// Update total XP and rank display
function updateTotals() {
  // Update total XP display even though XP no longer determines rank
  $('totalXp').textContent = totalXp;
  // Determine the current rank name based on rankIndex
  const rankName = ranks[rankIndex]?.name || ranks[0].name;
  $('rank').textContent = rankName;
  // Update progress bar and icons
  updateProgressBar();
  highlightRank();
  // Update current rank emblem
  const rankIcon = document.getElementById('currentRankIcon');
  if (rankIcon) {
    rankIcon.src = `emblems/${rankName.toLowerCase()}.png`;
    rankIcon.alt = `${rankName} emblem`;
  }
  // Update progress bar icons: current and next rank, or placement indicator
  const curImg = document.getElementById('progressCurrentIcon');
  const nextImg = document.getElementById('progressNextIcon');
  if (isInPlacements) {
    // During placements, show Bronze as current and a placeholder next icon
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
  // Show or hide placement and LP information
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

// Update the progress bar width based on current total XP
function updateProgressBar() {
  const progressBar = $('progressBar');
  if (!progressBar) return;
  let pct;
  if (isInPlacements) {
    // During placements, progress is based on the number of placement games played
    pct = (placementsPlayed / placementsCount) * 100;
    progressBar.title = `${Math.floor(pct)}% of placements completed`;
  } else {
    // After placements, progress is based on LP toward next rank
    pct = (lp / 100) * 100;
    const nextName = rankIndex < ranks.length - 1 ? ranks[rankIndex + 1].name : ranks[rankIndex].name;
    progressBar.title = `${Math.floor(pct)}% toward ${nextName}`;
  }
  progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// Reset progress handler
function resetProgress() {
  if (!confirm('Reset your total XP, rank progress and analytics history?')) {
    return;
  }
  // Reset XP and rank
  totalXp = 0;
  dailyXp = 0;
  $('dailyXp').textContent = '0';
  // Reset placement and LP state
  placementsPlayed = 0;
  placementsScores = [];
  isInPlacements = true;
  lp = 0;
  rankIndex = 0;
  $('timerDisplay').textContent = 'Not started';
  updateTotals();
  // Clear analytics history
  history = [];
  // Reset pagination index
  historyPageIndex = 0;
  updateAnalytics();

  // Reset timer and pause state
  if (timerInterval) clearInterval(timerInterval);
  startedAt = null;
  isPaused = false;
  pauseStartedAt = null;
  pausedDuration = 0;
  const pauseBtn = $('pauseBtn');
  if (pauseBtn) {
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pause';
  }
  // Persist reset to user profile
  saveUsers();
}

// Render the tasks list to the DOM
function renderTasks() {
  const list = $('taskList');
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
      // Prompt user for new title
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
      // Remove task from array
      const idx = tasks.indexOf(task);
      if (idx !== -1) {
        tasks.splice(idx, 1);
        renderTasks();
        checkCompletion();
        // If day hasn't started, update the planned tasks message
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
  // Enable stop only if the day has started and all planned tasks are complete
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
  if (startedAt) return; // Already running
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
  // Enable the pause button and set its label
  const pauseBtn = $('pauseBtn');
  if (pauseBtn) {
    pauseBtn.disabled = false;
    pauseBtn.textContent = 'Pause';
  }
  $('stopBtn').disabled = true;
  $('timerDisplay').textContent = '00:00:00';
  checkCompletion();
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
  // XP formula: inverse time curve K/(hours + b)
  const K = 1200;
  const b = 0.25;
  // Compute base XP from hours
  const baseXp = Math.round(K / (hours + b));
  // Determine bonus based on start and end times. Encourage earlier work: starting before 8am and ending before noon awards small bonuses.
  const startDate = new Date(startedAt);
  const endDate = new Date(end);
  const startHour = startDate.getHours();
  const endHour = endDate.getHours();
  let bonus = 0;
  // Starting before 8:00 awards 10% bonus
  if (startHour < 8) bonus += 0.1;
  // Ending before 12:00 awards another 10% bonus
  if (endHour < 12) bonus += 0.1;
  if (bonus > 0.2) bonus = 0.2;
  dailyXp = Math.round(baseXp * (1 + bonus));
  // Always show daily XP value
  $('dailyXp').textContent = dailyXp;
  // During placements, accumulate scores and determine starting rank at the end
  if (isInPlacements) {
    placementsScores.push(dailyXp);
    placementsPlayed++;
    if (placementsPlayed >= placementsCount) {
      // Compute average XP across placements
      const sum = placementsScores.reduce((acc, val) => acc + val, 0);
      const avg = sum / placementsScores.length;
      rankIndex = getStartingRankIndex(avg);
      lp = 0;
      isInPlacements = false;
      alert(`Placements complete! Your starting rank is ${ranks[rankIndex].name}.`);
    } else {
      alert(`Placement match recorded. ${placementsPlayed} / ${placementsCount} completed.`);
    }
    // Accumulate total XP for analytics
    totalXp += dailyXp;
    updateTotals();
  } else {
    // After placements, determine LP gain or loss
    const baseline = rankBaselines[rankIndex] || 200;
    const lpChange = calculateLpChange(dailyXp, baseline);
    const oldLp = lp;
    lp += lpChange;
    let promoted = false;
    let demoted = false;
    // Handle promotion
    if (lp >= 100) {
      lp -= 100;
      if (rankIndex < ranks.length - 1) {
        rankIndex++;
        promoted = true;
      } else {
        // Clamp at max rank
        lp = 100;
      }
    }
    // Handle demotion
    if (lp < 0) {
      lp += 100;
      if (rankIndex > 0) {
        rankIndex--;
        demoted = true;
      } else {
        lp = 0;
      }
    }
    // Accumulate total XP for analytics (still tracked for curiosity)
    totalXp += dailyXp;
    // Inform user of result
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
  // Record analytics entry before resetting tasks. We also include LP change
  const completedTasks = tasks.length;
  // Format start and end times as HH:MM using the user's locale
  const startStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endStr = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Determine day of week from the start date
  const dayOfWeek = startDate.toLocaleDateString([], { weekday: 'short' });
  const historyEntry = {
    date: new Date().toISOString().split('T')[0],
    day: dayOfWeek,
    start: startStr,
    end: endStr,
    hours: parseFloat(hours.toFixed(2)),
    tasks: completedTasks,
    xp: dailyXp,
    timePerTask: completedTasks > 0 ? parseFloat((hours / completedTasks).toFixed(2)) : hours
  };
  // Optionally record LP change and current LP for non-placement games
  if (!isInPlacements) {
    const baselineForEntry = rankBaselines[rankIndex] || 200;
    const lpChangeForEntry = calculateLpChange(dailyXp, baselineForEntry);
    historyEntry.lpChange = lpChangeForEntry;
    historyEntry.lpAfter = lp;
  } else {
    historyEntry.lpChange = null;
    historyEntry.lpAfter = null;
  }
  // Persist history entry to Supabase before updating local copy
  try {
    await sb.from('histories').insert({
      username: currentUserName,
      date: historyEntry.date,
      day: historyEntry.day,
      start: historyEntry.start,
      end: historyEntry.end,
      hours: historyEntry.hours,
      tasks: historyEntry.tasks,
      xp: historyEntry.xp,
      time_per_task: historyEntry.timePerTask,
      lp_change: historyEntry.lpChange ?? null,
      lp_after: historyEntry.lpAfter ?? null
    });
  } catch {
    // ignore insertion errors
  }
  history.push(historyEntry);
  // Persist user data after updating history
  await saveUsers();
  updateAnalytics();
  // Reset state for next day
  startedAt = null;
  tasks = [];
  renderTasks();
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  // Disable the pause button and reset its label
  const pauseButton = $('pauseBtn');
  if (pauseButton) {
    pauseButton.disabled = true;
    pauseButton.textContent = 'Pause';
  }
  $('timerDisplay').textContent = `Completed in ${formatDuration(elapsedMs)}`;
}

// Toggle pause/resume for the current day. When the day is paused, timer updates stop
// and the pause start time is recorded. When resumed, the time spent paused is
// accumulated into pausedDuration.
function togglePause() {
  // Ignore if no day has started
  if (!startedAt) return;
  const pauseBtn = $('pauseBtn');
  if (!isPaused) {
    // Pausing: record the start time and stop the timer
    pauseStartedAt = Date.now();
    clearInterval(timerInterval);
    isPaused = true;
    if (pauseBtn) pauseBtn.textContent = 'Resume';
  } else {
    // Resuming: accumulate the time spent paused and restart the timer
    if (pauseStartedAt) {
      pausedDuration += Date.now() - pauseStartedAt;
    }
    pauseStartedAt = null;
    timerInterval = setInterval(updateTimer, 500);
    isPaused = false;
    if (pauseBtn) pauseBtn.textContent = 'Pause';
  }
  // Keep stop button state in sync with tasks completion
  checkCompletion();
}

// Add a new task
function addTask() {
  const title = $('taskInput').value.trim();
  if (!title) return;
  tasks.push({ title, done: false });
  $('taskInput').value = '';
  renderTasks();
  // If the day hasn’t started, show the number of planned tasks
  if (!startedAt) {
    $('timerDisplay').textContent = `Planned tasks: ${tasks.length}`;
  }
}

// Change the current page in the analytics table. Positive delta moves
// forward to older entries (higher page index), negative delta moves
// back to more recent entries. The page index is clamped within valid range.
function changeHistoryPage(delta) {
  const pageCount = Math.ceil(history.length / historyPageSize);
  if (pageCount <= 0) return;
  historyPageIndex += delta;
  if (historyPageIndex < 0) historyPageIndex = 0;
  if (historyPageIndex >= pageCount) historyPageIndex = pageCount - 1;
  updateAnalytics();
}

// Export the full analytics history to a CSV file. Creates a CSV
// string with headers and data, then triggers a download in the browser.
function exportCsv() {
  if (!history || history.length === 0) {
    alert('No history to export.');
    return;
  }
  const headers = ['Date','Day','Start','End','Hours','Tasks','XP','TimePerTask','LPChange','LPAfter'];
  const lines = [];
  lines.push(headers.join(','));
  history.forEach((entry) => {
    const row = [
      entry.date,
      entry.day || '',
      entry.start || '',
      entry.end || '',
      entry.hours,
      entry.tasks,
      entry.xp,
      entry.timePerTask,
      entry.lpChange != null ? entry.lpChange : '',
      entry.lpAfter != null ? entry.lpAfter : ''
    ];
    lines.push(row.join(','));
  });
  const csvContent = lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ranked_work_history.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Update analytics table and summary statistics
function updateAnalytics() {
  const tableBody = document.querySelector('#historyTable tbody');
  if (!tableBody) return;
  tableBody.innerHTML = '';
  // Calculate pagination information
  const pageCount = Math.ceil(history.length / historyPageSize);
  if (historyPageIndex < 0) historyPageIndex = 0;
  if (historyPageIndex >= pageCount) historyPageIndex = pageCount - 1;
  // Determine the slice of history to display for the current page (newest entries first)
  const end = history.length - historyPageIndex * historyPageSize;
  const start = Math.max(0, end - historyPageSize);
  const pageEntries = history.slice(start, end).reverse();
  // Render only the entries for this page
  pageEntries.forEach((entry) => {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = entry.date;
    // Day of week cell
    const tdDay = document.createElement('td');
    tdDay.textContent = entry.day || '';
    // Start and end time cells
    const tdStart = document.createElement('td');
    tdStart.textContent = entry.start || '';
    const tdEnd = document.createElement('td');
    tdEnd.textContent = entry.end || '';
    const tdHours = document.createElement('td');
    tdHours.textContent = entry.hours.toString();
    const tdTasks = document.createElement('td');
    tdTasks.textContent = entry.tasks.toString();
    const tdXp = document.createElement('td');
    tdXp.textContent = entry.xp.toString();
    const tdTPT = document.createElement('td');
    tdTPT.textContent = entry.timePerTask.toString();
    tr.appendChild(tdDate);
    tr.appendChild(tdDay);
    tr.appendChild(tdStart);
    tr.appendChild(tdEnd);
    tr.appendChild(tdHours);
    tr.appendChild(tdTasks);
    tr.appendChild(tdXp);
    tr.appendChild(tdTPT);
    tableBody.appendChild(tr);
  });
  // Compute averages across all history
  let totalHours = 0;
  let totalTasks = 0;
  history.forEach((entry) => {
    totalHours += entry.hours;
    totalTasks += entry.tasks;
  });
  const count = history.length;
  const avgHours = count > 0 ? (totalHours / count).toFixed(2) : '0';
  const avgTasks = count > 0 ? (totalTasks / count).toFixed(2) : '0';
  const avgTimePerTask = totalTasks > 0 ? (totalHours / totalTasks).toFixed(2) : '0';
  // Update summary
  const avgHoursEl = document.getElementById('avgHours');
  const avgTasksEl = document.getElementById('avgTasks');
  const avgTimeEl = document.getElementById('avgTimePerTask');
  if (avgHoursEl) avgHoursEl.textContent = avgHours;
  if (avgTasksEl) avgTasksEl.textContent = avgTasks;
  if (avgTimeEl) avgTimeEl.textContent = avgTimePerTask;
  // Update navigation controls: page indicator and button states
  const pageInfoEl = $('historyPageInfo');
  const prevBtn = $('prevHistoryPage');
  const nextBtn = $('nextHistoryPage');
  if (pageInfoEl) {
    // Page numbers are 1-based for display
    pageInfoEl.textContent = pageCount > 0 ? `Page ${historyPageIndex + 1} / ${pageCount}` : '';
  }
  if (prevBtn) {
    prevBtn.disabled = historyPageIndex >= pageCount - 1;
  }
  if (nextBtn) {
    nextBtn.disabled = historyPageIndex <= 0;
  }
}

// Bind event listeners once the DOM has loaded
window.addEventListener('DOMContentLoaded', async () => {
  // Populate static tables
  populateTables();
  updateTotals();
  updateAnalytics();
  // Attempt to restore session via Supabase auth
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (user && user.email) {
      currentUserName = user.email;
      await loadUserStateAsync(user.email);
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
  // Task controls
  $('addTaskBtn').addEventListener('click', addTask);
  // Allow pressing Enter in the task input to add a new task
  const taskInputEl = $('taskInput');
  if (taskInputEl) {
    taskInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addTask();
      }
    });
  }
  $('startBtn').addEventListener('click', startDay);
  $('stopBtn').addEventListener('click', stopDay);
  const pauseBtnEl = $('pauseBtn');
  if (pauseBtnEl) {
    pauseBtnEl.addEventListener('click', togglePause);
  }
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
      const success = await loginUserAsync(username, password);
      const errorEl = $('loginError');
      if (success) {
        $('usernameInput').value = '';
        $('passwordInput').value = '';
        if (errorEl) errorEl.style.display = 'none';
        showApp();
        updateTotals();
        updateAnalytics();
        await renderFriendsAsync();
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
      const success = await registerUserAsync(username, password);
      const errorEl = $('loginError');
      if (success) {
        $('usernameInput').value = '';
        $('passwordInput').value = '';
        if (errorEl) errorEl.style.display = 'none';
        alert('Account created! You are now logged in.');
        showApp();
        updateTotals();
        updateAnalytics();
        await renderFriendsAsync();
      } else {
        if (errorEl) {
          errorEl.textContent = 'Username already exists or invalid.';
          errorEl.style.display = 'block';
        }
      }
    });
  }
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      try {
        await sb.auth.signOut();
      } catch {
        // ignore sign out errors
      }
      await logoutUser();
    });
  }
  if (addFriendBtn) {
    addFriendBtn.addEventListener('click', async () => {
      await addFriendAsync();
    });
  }
});