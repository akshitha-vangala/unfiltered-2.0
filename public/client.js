const socket = io();

// --- STATE VARIABLES ---
let currentRoom = "";
let myName = "";
let voteTruthIndex = null;
let voteFunnyIndex = null;
// --- HOST LOGIC ---

// --- HOST LOGIC ---

// 1. Server tells us we are the host
socket.on('is-host', () => {
    const hostControls = document.getElementById('host-controls');
    const waitMessage = document.getElementById('wait-message');

    if (hostControls) {
        // Show the settings & start button
        hostControls.style.display = 'flex'; 
        // Update text to look like a control panel
        waitMessage.innerText = "You are the Host! Configure the game below.";
    }
});

// 2. Host clicks Start
const startBtn = document.getElementById('btn-start');
if (startBtn) {
    startBtn.addEventListener('click', () => {
        const roundsInput = document.getElementById('rounds-input');
        const totalRounds = roundsInput ? roundsInput.value : 5; // Get value
        
        // Send start request with settings
        socket.emit('request-start-game', totalRounds);
    });
}
// --- LISTEN FOR PLAYER LIST UPDATES ---
socket.on('update-player-list', (names) => {
    const list = document.getElementById('player-list');
    const myName = document.getElementById('username').value; // Get my own name

    if (list) {
        list.innerHTML = ""; // Clear the old list
        
        names.forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            
            // Highlight myself
            if (name === myName) {
                li.classList.add('me');
                li.textContent += " (You)";
            }
            
            list.appendChild(li);
        });
    }
});
// --- NOTIFICATION SYSTEM ---
socket.on("notification", (message) => {
    const container = document.getElementById('notification-area');
    if (!container) return;

    // Create the message element
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('notify-msg');
    msgDiv.innerText = message;
    
    // Add to screen
    container.appendChild(msgDiv);

    // Remove it after 3 seconds
    setTimeout(() => {
        msgDiv.style.opacity = '0';
        setTimeout(() => msgDiv.remove(), 500); // Wait for fade out
    }, 3000);
});
// --- UI HELPER: SWITCH SCREENS ---
function showScreen(screenId) {
    // Hide all screens first
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    // Show the target screen
    const screen = document.getElementById(screenId);
    if(screen) screen.classList.add('active');
}

// ==========================
// 1. JOINING LOGIC
// ==========================
const joinBtn = document.getElementById('btn-join');

if (joinBtn) {
    joinBtn.addEventListener('click', () => {
        myName = document.getElementById('username').value.trim();
        currentRoom = document.getElementById('room').value.trim();

        if (!myName || !currentRoom) {
            alert("Please enter both Name and Room!");
            return;
        }

        // Emit 'join-room' event to server
        socket.emit('join-room', currentRoom, myName);
        
        // Move to waiting screen immediately
        document.getElementById('wait-message').innerText = `Joined ${currentRoom}. Waiting for round to start...`;
        showScreen('screen-wait');
    });
}

// ==========================
// 2. ANSWERING LOGIC
// ==========================
socket.on('new-round', (question) => {
    document.getElementById('question-text').innerText = question;
    document.getElementById('my-answer').value = ""; // Clear previous answer
    showScreen('screen-answer');
});

const submitBtn = document.getElementById('btn-submit');
if (submitBtn) {
    submitBtn.addEventListener('click', () => {
        const answer = document.getElementById('my-answer').value.trim();
        if (!answer) return;

        socket.emit('submit-answer', answer);
        
        document.getElementById('wait-message').innerText = "Answer sent! Waiting for other slowpokes...";
        showScreen('screen-wait');
    });
}

// ==========================
// 3. VOTING LOGIC
// ==========================
socket.on('start-voting', (shuffledAnswers) => {
    const list = document.getElementById('answers-list');
    list.innerHTML = ""; // Clear old cards
    voteTruthIndex = null;
    voteFunnyIndex = null;

    shuffledAnswers.forEach((ans, index) => {
        const btn = document.createElement('div');
        btn.className = 'vote-card';
        btn.innerText = ans.text;

        // LEFT CLICK -> Truth Vote
        btn.onclick = () => {
            document.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected-truth'));
            btn.classList.add('selected-truth');
            voteTruthIndex = index;
        };

        // RIGHT CLICK -> Funny Vote
        btn.oncontextmenu = (e) => {
            e.preventDefault(); // Stop normal right-click menu
            document.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected-funny'));
            btn.classList.add('selected-funny');
            voteFunnyIndex = index;
        };

        list.appendChild(btn);
    });

    showScreen('screen-vote');
});

const voteBtn = document.getElementById('btn-vote');
if (voteBtn) {
    voteBtn.addEventListener('click', () => {
        if (voteTruthIndex === null) {
            alert("You must pick the TRUTH (Left Click)!");
            return;
        }
        // It's okay if they don't pick a funny one, send null
        socket.emit('submit-vote', voteTruthIndex, voteFunnyIndex);

        document.getElementById('wait-message').innerText = "Votes cast! Calculating the damage...";
        showScreen('screen-wait');
    });
}

// ==========================
// 4. RESULTS LOGIC
// ==========================
socket.on('show-results', (results) => {
    const board = document.getElementById('leaderboard');
    board.innerHTML = "";

    results.forEach(p => {
        // p contains: { author, text, score, funnyScore }
        const div = document.createElement('div');
        div.className = 'result-entry';
        div.innerHTML = `
            <strong>${p.author}</strong> wrote: "<em>${p.text}</em>"<br>
            <span style="color:#2ecc71">✅ Truth Votes: ${p.score}</span> | 
            <span style="color:#f1c40f">😂 Funny Votes: ${p.funnyScore}</span>
        `;
        board.appendChild(div);
    });

    showScreen('screen-results');
});

// ==========================
// 5. LEAVING LOGIC
// ==========================
const leaveBtn = document.getElementById('btn-leave');
if (leaveBtn) {
    leaveBtn.addEventListener('click', () => {
        socket.disconnect(); 
        location.reload(); 
    });
}

// Generic wait message handler from server
socket.on('wait-screen', (msg) => {
    document.getElementById('wait-message').innerText = msg;
    showScreen('screen-wait');
});