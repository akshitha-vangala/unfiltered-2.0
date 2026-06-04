/* ─────────────────────────────────────────────────────────────────────────────
   client.js — Unfiltered 2.0
   Handles: login → lobby → question → voting → results
───────────────────────────────────────────────────────────────────────────── */

const socket = io();

// ─── Sound Engine (Web Audio API — no libraries needed) ───────────────────────

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let muted = false;

function getCtx() {
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

/**
 * Plays a synthesised sound.
 * @param {Array}  notes - array of { freq, time, dur } objects (time & dur in seconds)
 * @param {string} type  - oscillator type: 'sine' | 'square' | 'triangle' | 'sawtooth'
 * @param {number} gain  - master volume 0–1
 */
function playSound(notes, type = "sine", gain = 0.25) {
  if (muted) return;
  const ctx = getCtx();
  notes.forEach(({ freq, time = 0, dur = 0.15 }) => {
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.connect(vol);
    vol.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + time);
    vol.gain.setValueAtTime(gain, ctx.currentTime + time);
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + time + dur);
    osc.start(ctx.currentTime + time);
    osc.stop(ctx.currentTime + time + dur + 0.05);
  });
}

const SFX = {
  // Entering the lobby
  join:       () => playSound([
    { freq: 440, dur: 0.1 },
    { freq: 660, time: 0.11, dur: 0.15 },
  ], "sine"),

  // Another player joined notification
  playerJoin: () => playSound([
    { freq: 523, dur: 0.08 },
    { freq: 659, time: 0.09, dur: 0.08 },
  ], "triangle", 0.15),

  // Player left notification
  playerLeave: () => playSound([
    { freq: 440, dur: 0.08 },
    { freq: 330, time: 0.1, dur: 0.12 },
  ], "triangle", 0.12),

  // Game starting — punchy ascending fanfare
  gameStart:  () => playSound([
    { freq: 330, time: 0,    dur: 0.1  },
    { freq: 440, time: 0.11, dur: 0.1  },
    { freq: 550, time: 0.22, dur: 0.1  },
    { freq: 660, time: 0.33, dur: 0.28 },
  ], "square", 0.2),

  // New question reveal — dramatic rising sting
  question:   () => playSound([
    { freq: 200, time: 0,    dur: 0.08 },
    { freq: 400, time: 0.1,  dur: 0.1  },
    { freq: 600, time: 0.22, dur: 0.18 },
  ], "sawtooth", 0.15),

  // Answer submitted — satisfying double-click
  submit:     () => playSound([
    { freq: 880,  dur: 0.06 },
    { freq: 1100, time: 0.08, dur: 0.09 },
  ], "sine", 0.2),

  // Voting phase — tense low pulse
  voteStart:  () => playSound([
    { freq: 150, time: 0,    dur: 0.2  },
    { freq: 150, time: 0.27, dur: 0.2  },
    { freq: 220, time: 0.54, dur: 0.3  },
  ], "square", 0.2),

  // Tapping a vote button
  votePick:   () => playSound([
    { freq: 660, dur: 0.05 },
  ], "sine", 0.15),

  // Error / validation fail
  error:      () => playSound([
    { freq: 220, dur: 0.1  },
    { freq: 165, time: 0.12, dur: 0.15 },
  ], "sawtooth", 0.2),

  // Results reveal — triumphant chord roll
  results:    () => playSound([
    { freq: 440, time: 0,    dur: 0.12 },
    { freq: 554, time: 0.13, dur: 0.12 },
    { freq: 659, time: 0.26, dur: 0.22 },
  ], "triangle", 0.2),

  // Final leaderboard — full victory fanfare
  gameOver:   () => playSound([
    { freq: 523,  time: 0,    dur: 0.12 },
    { freq: 659,  time: 0.14, dur: 0.12 },
    { freq: 784,  time: 0.28, dur: 0.12 },
    { freq: 1046, time: 0.42, dur: 0.38 },
  ], "square", 0.22),

  // Countdown tick (used while waiting)
  tick:       () => playSound([
    { freq: 800, dur: 0.04 },
  ], "sine", 0.1),
};

// ─── Mute button ──────────────────────────────────────────────────────────────

const btnMute = document.getElementById("btn-mute");
btnMute.addEventListener("click", () => {
  muted = !muted;
  btnMute.textContent = muted ? "🔇" : "🔊";
});

// ─────────────────────────────────────────────────────────────────────────────

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  name:       "",
  room:       "",
  isHost:     false,
  // Voting phase
  truthPick:  null,   // index of answer chosen as "truth"
  funnyPick:  null,   // index of answer chosen as "funniest"
  hasVoted:   false,
  hasAnswered: false,
};

// ─── Element refs ─────────────────────────────────────────────────────────────
const screens = {
  login:       document.getElementById("login-screen"),
  lobby:       document.getElementById("lobby-screen"),
  question:    document.getElementById("question-screen"),
  vote:        document.getElementById("vote-screen"),
  results:     document.getElementById("results-screen"),
  leaderboard: document.getElementById("final-leaderboard-screen"),
};

// Login
const inputName       = document.getElementById("input-name");
const inputRoom       = document.getElementById("input-room");
const btnJoin         = document.getElementById("btn-join");
const loginError      = document.getElementById("login-error");

// Lobby
const roomCodeDisplay = document.getElementById("room-code-display");
const btnCopyCode     = document.getElementById("btn-copy-code");
const waitMessage     = document.getElementById("wait-message");
const notificationMsg = document.getElementById("notification-msg");
const playerList      = document.getElementById("player-list");
const hostControls    = document.getElementById("host-controls");
const settingRounds   = document.getElementById("setting-rounds");
const settingQpr      = document.getElementById("setting-qpr");
const settingTheme    = document.getElementById("setting-theme");
const btnStart        = document.getElementById("btn-start");

// Question
const roundBadge      = document.getElementById("round-badge");
const questionText    = document.getElementById("question-text");
const answerInput     = document.getElementById("answer-input");
const answerCharCount = document.getElementById("answer-char-count");
const answerError     = document.getElementById("answer-error");
const btnSubmitAnswer = document.getElementById("btn-submit-answer");

// Vote
const answersContainer = document.getElementById("answers-container");
const btnSubmitVote    = document.getElementById("btn-submit-vote");
const voteError        = document.getElementById("vote-error");

// Results
const resultsContainer = document.getElementById("results-container");
const resultsWaitMsg   = document.getElementById("results-wait-msg");

// Final leaderboard
const leaderboardList  = document.getElementById("leaderboard-list");
const clownCard        = document.getElementById("clown-card");
const clownName        = document.getElementById("clown-name");
const clownSub         = document.getElementById("clown-sub");
const btnPlayAgain     = document.getElementById("btn-play-again");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Hide all screens, then show the requested one. */
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

/** Flash a transient notification in the lobby. */
let notifTimer = null;
function showNotification(msg) {
  notificationMsg.textContent = msg;
  notificationMsg.classList.add("visible");
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => {
    notificationMsg.classList.remove("visible");
  }, 3500);
}

/** Check whether both vote picks are selected and toggle the submit button. */
function refreshVoteButton() {
  btnSubmitVote.disabled = (state.truthPick === null || state.funnyPick === null);
}

// ─── Login flow ───────────────────────────────────────────────────────────────

btnJoin.addEventListener("click", () => {
  const name = inputName.value.trim();
  const room = inputRoom.value.trim().toUpperCase();

  if (!name) {
    loginError.textContent = "Please enter your name.";
    SFX.error();
    inputName.focus();
    return;
  }
  loginError.textContent = "";

  SFX.join();
  state.name = name;
  // Send room as null when blank so the server generates a code
  socket.emit("join-room", room || null, name);
});

// Allow Enter key on either login input
[inputName, inputRoom].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") btnJoin.click(); });
});

// ─── Copy room code ───────────────────────────────────────────────────────────

btnCopyCode.addEventListener("click", () => {
  if (!state.room) return;
  navigator.clipboard.writeText(state.room).then(() => {
    SFX.tick();
    btnCopyCode.textContent = "✓";
    setTimeout(() => (btnCopyCode.textContent = "⧉"), 1500);
  });
});

// ─── Host: start game ─────────────────────────────────────────────────────────

btnStart.addEventListener("click", () => {
  const settings = {
    maxRounds:         parseInt(settingRounds.value, 10) || 5,
    questionsPerRound: parseInt(settingQpr.value,    10) || 1,
    theme:             settingTheme.value.trim() || "default",
  };
  SFX.gameStart();
  socket.emit("request-start-game", settings);
  btnStart.disabled    = true;
  btnStart.textContent = "Starting…";
});

// ─── Answer: character counter + submit ───────────────────────────────────────

answerInput.addEventListener("input", () => {
  const remaining = 200 - answerInput.value.length;
  answerCharCount.textContent = `${remaining} character${remaining !== 1 ? "s" : ""} left`;
  answerCharCount.style.color = remaining < 20 ? "var(--accent)" : "";
});

btnSubmitAnswer.addEventListener("click", () => {
  const text = answerInput.value.trim();
  if (!text) {
    answerError.textContent = "Answer cannot be empty.";
    SFX.error();
    answerInput.focus();
    return;
  }
  answerError.textContent = "";
  SFX.submit();
  socket.emit("submit-answer", text);

  // Disable to prevent double-submit
  btnSubmitAnswer.disabled    = true;
  btnSubmitAnswer.textContent = "Submitted ✓";
  state.hasAnswered = true;
});

// ─── Vote: submit ─────────────────────────────────────────────────────────────

btnSubmitVote.addEventListener("click", () => {
  if (state.truthPick === null || state.funnyPick === null) {
    voteError.textContent = "Please pick both a Truth and a Funniest answer.";
    SFX.error();
    return;
  }
  voteError.textContent = "";
  SFX.submit();
  socket.emit("submit-vote", state.truthPick, state.funnyPick);

  btnSubmitVote.disabled    = true;
  btnSubmitVote.textContent = "Votes submitted ✓";
  state.hasVoted = true;
});

// ─────────────────────────────────────────────────────────────────────────────
// Socket event listeners
// ─────────────────────────────────────────────────────────────────────────────

// Server confirmed a room code (new or existing)
socket.on("room-code", (code) => {
  state.room           = code;
  roomCodeDisplay.textContent = code;
  showScreen("lobby");
});

// Server tells this socket it's the host
socket.on("is-host", () => {
  state.isHost = true;
  hostControls.style.display = "flex";
});

// Generic wait / status message (lobby + mid-game)
socket.on("wait-screen", (msg) => {
  // If we're in an active game screen, push back to lobby with the message
  if (
    screens.question.classList.contains("active") ||
    screens.vote.classList.contains("active")     ||
    screens.results.classList.contains("active")
  ) {
    waitMessage.textContent = msg;
    showScreen("lobby");
    return;
  }
  // Already on the lobby — just update the message
  waitMessage.textContent = msg;
  showScreen("lobby");
});

// Room-level notifications (joins / leaves)
socket.on("notification", (msg) => {
  // Play different sound for leave vs join
  if (msg.includes("left") || msg.includes("🏃")) {
    SFX.playerLeave();
  } else {
    SFX.playerJoin();
  }
  showNotification(msg);
});

// Live player list update
socket.on("update-player-list", (names) => {
  playerList.innerHTML = "";
  names.forEach(name => {
    const li = document.createElement("li");
    li.textContent = name;
    if (name === state.name) li.classList.add("me");
    playerList.appendChild(li);
  });
});

// New round begins — show the question screen
socket.on("new-round", (questionStr) => {
  // Reset answer state
  state.hasAnswered         = false;
  answerInput.value         = "";
  answerCharCount.textContent = "200 characters left";
  answerCharCount.style.color = "";
  answerError.textContent   = "";
  btnSubmitAnswer.disabled  = false;
  btnSubmitAnswer.textContent = "Submit Answer";

  questionText.textContent = questionStr;
  showScreen("question");

  // Slight delay so the screen transition settles first
  setTimeout(() => SFX.question(), 250);
});

// Voting phase begins — build answer buttons
socket.on("start-voting", (answers) => {
  // Reset vote state
  state.truthPick   = null;
  state.funnyPick   = null;
  state.hasVoted    = false;
  voteError.textContent = "";
  btnSubmitVote.disabled    = true;
  btnSubmitVote.textContent = "Submit Votes";

  answersContainer.innerHTML = "";

  answers.forEach((answer, idx) => {
    const card = document.createElement("div");
    card.className = "answer-option";
    card.dataset.idx = idx;

    const answerBody = document.createElement("p");
    answerBody.className = "answer-option-text";
    answerBody.textContent = answer.text;

    const voteRow = document.createElement("div");
    voteRow.className = "vote-row";

    // ── Truth button ───────────────────────────────
    const btnTruth = document.createElement("button");
    btnTruth.className = "btn btn-vote btn-truth";
    btnTruth.textContent = "🎯 Truth";
    btnTruth.setAttribute("aria-label", `Mark answer ${idx + 1} as truth`);
    btnTruth.addEventListener("click", () => {
      SFX.votePick();
      state.truthPick = idx;
      // Clear previous truth selection
      document.querySelectorAll(".btn-truth").forEach(b => b.classList.remove("selected"));
      btnTruth.classList.add("selected");
      refreshVoteButton();
    });

    // ── Funny button ───────────────────────────────
    const btnFunny = document.createElement("button");
    btnFunny.className = "btn btn-vote btn-funny";
    btnFunny.textContent = "😂 Funniest";
    btnFunny.setAttribute("aria-label", `Mark answer ${idx + 1} as funniest`);
    btnFunny.addEventListener("click", () => {
      SFX.votePick();
      state.funnyPick = idx;
      document.querySelectorAll(".btn-funny").forEach(b => b.classList.remove("selected"));
      btnFunny.classList.add("selected");
      refreshVoteButton();
    });

    voteRow.appendChild(btnTruth);
    voteRow.appendChild(btnFunny);
    card.appendChild(answerBody);
    card.appendChild(voteRow);
    answersContainer.appendChild(card);
  });

  SFX.voteStart();
  showScreen("vote");
});

// Results for the round
socket.on("show-results", (results) => {
  resultsContainer.innerHTML = "";
  resultsWaitMsg.textContent  = "Next round starting soon…";

  // Sort: most truth votes first
  const sorted = [...results].sort((a, b) => b.score - a.score);

  sorted.forEach((result, rank) => {
    const card = document.createElement("div");
    card.className = "result-card" + (result.isCorrect ? " result-truth" : "");

    const header = document.createElement("div");
    header.className = "result-header";

    const authorEl = document.createElement("span");
    authorEl.className = "result-author";
    authorEl.textContent = result.author;

    const badges = document.createElement("div");
    badges.className = "result-badges";

    if (result.isCorrect) {
      const trueBadge = document.createElement("span");
      trueBadge.className = "badge badge-truth";
      trueBadge.textContent = "✓ Truth";
      badges.appendChild(trueBadge);
    }
    if (result.score > 0) {
      const voteBadge = document.createElement("span");
      voteBadge.className = "badge badge-votes";
      voteBadge.textContent = `🎯 ${result.score}`;
      badges.appendChild(voteBadge);
    }
    if (result.funnyScore > 0) {
      const funnyBadge = document.createElement("span");
      funnyBadge.className = "badge badge-funny";
      funnyBadge.textContent = `😂 ${result.funnyScore}`;
      badges.appendChild(funnyBadge);
    }

    header.appendChild(authorEl);
    header.appendChild(badges);

    const textEl = document.createElement("p");
    textEl.className = "result-text";
    textEl.textContent = result.text;

    card.appendChild(header);
    card.appendChild(textEl);

    // Stagger in
    card.style.animationDelay = `${rank * 80}ms`;
    resultsContainer.appendChild(card);
  });

  SFX.results();
  showScreen("results");
});

// Server-side validation error on answer submission
socket.on("answer-error", (msg) => {
  SFX.error();
  answerError.textContent   = msg;
  btnSubmitAnswer.disabled  = false;
  btnSubmitAnswer.textContent = "Submit Answer";
  state.hasAnswered = false;
});

// Final leaderboard — emitted once by server when game ends
socket.on("end-game-stats", (players) => {
  // players is already sorted by score descending from the server
  leaderboardList.innerHTML = "";
  clownCard.style.display   = "none";

  const medals = ["🥇", "🥈", "🥉"];

  players.forEach((player, idx) => {
    const li = document.createElement("li");
    li.className = "lb-row" + (player.name === state.name ? " lb-row-me" : "");
    li.style.animationDelay = `${idx * 70}ms`;

    const rank = document.createElement("span");
    rank.className   = "lb-rank";
    rank.textContent = medals[idx] ?? `${idx + 1}`;

    const name = document.createElement("span");
    name.className   = "lb-name";
    name.textContent = player.name;
    if (player.name === state.name) {
      const youTag = document.createElement("span");
      youTag.className   = "lb-you-tag";
      youTag.textContent = "you";
      name.appendChild(youTag);
    }

    const pts = document.createElement("span");
    pts.className   = "lb-score";
    pts.textContent = `${player.score} pts`;

    if (player.funnyPoints > 0) {
      const fp = document.createElement("span");
      fp.className   = "lb-funny-pts";
      fp.textContent = `😂 ${player.funnyPoints}`;
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(fp);
      li.appendChild(pts);
    } else {
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(pts);
    }

    leaderboardList.appendChild(li);
  });

  // ── Class Clown Award ───────────────────────────────────────────────────
  // Find the player with the most funnyPoints (only award if > 0)
  const clown = [...players].sort((a, b) => b.funnyPoints - a.funnyPoints)[0];
  if (clown && clown.funnyPoints > 0) {
    clownName.textContent = clown.name;
    clownSub.textContent  =
      `Earned ${clown.funnyPoints} funny vote${clown.funnyPoints !== 1 ? "s" : ""} across all rounds`;
    clownCard.style.display = "flex";
  }

  SFX.gameOver();
  showScreen("leaderboard");
});

// Play Again — send the player back to the login screen to start fresh
btnPlayAgain.addEventListener("click", () => {
  // Reset local state
  state.name        = "";
  state.room        = "";
  state.isHost      = false;
  state.truthPick   = null;
  state.funnyPick   = null;
  state.hasVoted    = false;
  state.hasAnswered = false;

  // Reset host controls so they don't bleed into a new session
  hostControls.style.display   = "none";
  btnStart.disabled             = false;
  btnStart.textContent          = "Start Game";
  inputName.value               = "";
  inputRoom.value               = "";
  roomCodeDisplay.textContent   = "????";
  waitMessage.textContent       = "";
  playerList.innerHTML          = "";

  SFX.join();
  showScreen("login");
});

// Connection error feedback
socket.on("connect_error", () => {
  loginError.textContent = "Could not connect to server. Retrying…";
});
socket.on("reconnect", () => {
  loginError.textContent = "";
});