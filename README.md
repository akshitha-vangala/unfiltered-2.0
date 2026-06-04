# Unfiltered 2.0

> **Bluff. Reveal. Judge.**
> A real-time multiplayer party game where players answer questions about each other — and everyone votes on who's telling the truth.

---

## Table of Contents

- [How the Game Works](#how-the-game-works)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running the Game](#running-the-game)
- [Environment Variables](#environment-variables)
- [Game Flow (Technical)](#game-flow-technical)
- [Socket Events Reference](#socket-events-reference)
- [Redis Data Model](#redis-data-model)
- [Scoring System](#scoring-system)
- [Adding Questions](#adding-questions)
- [Sound Effects](#sound-effects)
- [Development Tips](#development-tips)

---

## How the Game Works

1. One player creates a room and shares the 4-letter room code with friends.
2. The host configures settings (number of rounds, questions per round, theme) and starts the game.
3. Each round, a question is displayed — often targeted at a specific player, e.g. *"What is Alex's most embarrassing Google search?"*
4. **Every** player submits an answer — including Alex. Everyone else is bluffing; Alex is telling the truth.
5. All answers are shuffled anonymously and shown to the room.
6. Each player votes for:
   - 🎯 **Truth** — the answer they think is genuinely Alex's
   - 😂 **Funniest** — the answer that made them laugh most
7. Points are awarded, results are revealed, and the next round begins automatically.
8. After all rounds, a final leaderboard and a **Class Clown Award** are shown.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js + Express 5 |
| Real-time | Socket.io 4 |
| State / Persistence | Redis (via `node-redis` v4) |
| Multi-instance sync | `@socket.io/redis-adapter` |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Fonts | Google Fonts (Playfair Display + DM Sans) |
| Audio | Web Audio API (synthesised, no files needed) |

No frontend build step. No bundler. No framework. The client is plain HTML + JS served statically by Express.

---

## Project Structure

```
unfiltered-2.0/
├── package.json
├── public/
│   ├── index.html       # All 6 game screens (login, lobby, question, vote, results, leaderboard)
│   ├── client.js        # All client-side logic + sound engine
│   └── styles.css       # All styles
└── src/
    ├── server.js        # Express server + all Socket.io event handlers
    └── data/
        └── questions.json   # Question bank
```

---

## Prerequisites

- **Node.js** v18 or higher
- **Redis** v6 or higher, running locally or accessible via URL

### Installing Redis

**macOS (Homebrew):**
```bash
brew install redis
brew services start redis
```

**Ubuntu / Debian:**
```bash
sudo apt update
sudo apt install redis-server
sudo service redis start
```

**Windows:**
Use [Redis on WSL2](https://redis.io/docs/getting-started/installation/install-redis-on-windows/) or run Redis via Docker:
```bash
docker run -d -p 6379:6379 redis
```

---

## Installation

```bash
# 1. Clone or unzip the project
cd unfiltered-2.0

# 2. Install dependencies
npm install
```

Dependencies installed:
- `express` — HTTP server and static file serving
- `socket.io` — WebSocket communication
- `@socket.io/redis-adapter` — syncs Socket.io rooms across multiple server instances
- `redis` (node-redis) — Redis client for state management
- `cors` — cross-origin header support
- `nodemon` *(dev only)* — auto-restarts server on file changes

---

## Running the Game

### Production
```bash
npm start
# → Server running at http://localhost:3001
```

### Development (auto-restart on save)
```bash
npm run dev
```

Then open **http://localhost:3001** in your browser. Share the URL (or just the room code) with other players on the same network.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Full Redis connection URL |
| `PORT` | `3001` | Port the HTTP server listens on (hardcoded currently — see Development Tips to make it dynamic) |

Example with a remote Redis instance:
```bash
REDIS_URL=redis://username:password@your-redis-host:6379 npm start
```

---

## Game Flow (Technical)

The server drives all game state transitions. The client is purely reactive — it only renders what the server tells it to.

```
Client joins            → server: join-room
                        ← server emits: room-code, is-host (if first), update-player-list

Host clicks Start       → server: request-start-game
                        ← server emits: wait-screen, then new-round (after 2s delay)

Player submits answer   → server: submit-answer
  All answered?         ← server emits: start-voting (to whole room)
  Still waiting?        ← server emits: wait-screen (to submitter only)

Player submits vote     → server: submit-vote
  All voted?            ← server emits: show-results (to whole room)
                           then after 5s → next round starts (or game-over)
  Still waiting?        ← server emits: wait-screen (to voter only)

All rounds done         ← server emits: end-game-stats

Player disconnects      → server detects, removes from room
                           if game was waiting on them → auto-advances the phase
```

### Disconnect Handling

The server is resilient to mid-game disconnects. When a player leaves:
- If the game was waiting on them to **answer** — voting begins immediately with the remaining answers.
- If the game was waiting on them to **vote** — results are shown immediately and the next round begins.
- If they were the last player — the entire room is cleaned up from Redis.

---

## Socket Events Reference

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `join-room` | `(roomCode \| null, playerName)` | Join an existing room or create a new one |
| `request-start-game` | `{ maxRounds, questionsPerRound, theme }` | Host only — starts the game with settings |
| `submit-answer` | `(answerText)` | Submit the player's answer for the current round |
| `submit-vote` | `(truthIndex, funnyIndex)` | Submit votes; indices refer to the shuffled answers array |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `room-code` | `(code)` | Confirms the room code (new or existing) |
| `is-host` | — | Tells this socket it is the room host |
| `wait-screen` | `(message)` | Generic status update; pushes client to lobby |
| `notification` | `(message)` | Transient toast message (player joined/left) |
| `update-player-list` | `(namesArray)` | Current list of player names in the room |
| `new-round` | `(questionText)` | Starts the answer phase with the round's question |
| `start-voting` | `(answersArray)` | Shuffled anonymous answers; starts the voting phase |
| `show-results` | `(resultsArray)` | Per-answer results including votes and authorship |
| `end-game-stats` | `(playersArray)` | Final sorted leaderboard with scores and funny points |
| `answer-error` | `(message)` | Server-side answer validation failed |

---

## Redis Data Model

All game state lives in Redis. The server uses two connection clients (required by the Socket.io Redis adapter — one for pub, one for sub).

### Key Shapes

| Key | Type | Contents |
|---|---|---|
| `room:{code}` | Hash | `host`, `maxRounds`, `questionsPerRound`, `theme`, `currentRound`, `currentSubject` |
| `room:{code}:players` | List | Ordered list of socket IDs currently in the room |
| `room:{code}:answers` | List | JSON-serialised answer objects for the current round |
| `room:{code}:votes` | List | Player names who have voted this round (for dedup) |
| `user:{socketId}` | Hash | `name`, `room`, `score`, `funnyPoints` |

### Cleanup

- When a room is **created**, all keys are initialised.
- Between rounds, `answers` and `votes` lists are deleted and recreated.
- When the **last player** leaves, all four room keys and the user key are deleted via a single Redis multi-exec transaction.
- Individual user keys are deleted on disconnect.

---

## Scoring System

| Action | Points |
|---|---|
| Voter correctly identifies the truth answer | +10 to the **voter** |
| Voter picks a bluff as truth | +10 to the **bluffer** (the author of that answer) |
| Your answer is voted funniest | +1 funny point per vote (tracked separately) |

Funny points do **not** count toward the main score — they only determine the **Class Clown Award** shown on the final leaderboard.

---

## Adding Questions

Questions live in `src/data/questions.json`. Each entry has an `id` and a `text` field.

```json
[
  {
    "id": 11,
    "text": "If {player} could only eat one food for the rest of their life, what would it be?"
  }
]
```

Use `{player}` as a placeholder anywhere in the text. The server will replace it with a randomly chosen player's name at the start of each round. The player whose name is substituted in is the one who must answer truthfully — everyone else bluffs.

Questions without `{player}` are also valid (everyone bluffs equally).

---

## Sound Effects

The game includes a fully synthesised sound engine built on the **Web Audio API** — no audio files, no external libraries. Sounds are generated in real time using oscillators.

A **🔊 mute button** sits fixed in the top-right corner of every screen. Click it to toggle to 🔇 and silence all sounds.

| Moment | Sound character |
|---|---|
| Entering a room | Soft two-note chime |
| Player joins lobby | Bright ascending ping |
| Player leaves lobby | Descending tone |
| Host starts game | 4-note ascending fanfare |
| New question appears | Dramatic rising sting |
| Answer submitted | Satisfying double-click |
| Voting phase begins | Tense triple low pulse |
| Selecting a vote | Soft tap |
| Results revealed | Triumphant chord roll |
| Final leaderboard | Full 4-note victory fanfare |
| Any error / validation fail | Low descending buzz |

Because browsers block audio until a user gesture has occurred, the audio context is created and resumed on the very first interaction (clicking Enter Room counts). No sound will play before the player has touched the page.

---

## Development Tips

**Make the port configurable:**

In `src/server.js`, change the `server.listen` call:
```js
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`✅ SERVER RUNNING: http://localhost:${PORT}`);
});
```

**Watch for file changes during development:**
```bash
npm run dev   # uses nodemon
```

**Inspect Redis state live:**
```bash
redis-cli
> KEYS *              # list all keys
> HGETALL room:ABCD   # inspect a room's config
> LRANGE room:ABCD:players 0 -1   # list players in a room
```

**Test with multiple players locally:**
Open several browser tabs or windows to `http://localhost:3001`. Each tab gets its own socket connection and counts as a separate player.

**Deploying:**
The app needs both a Node.js host and a Redis instance. Platforms like Railway, Render, or Fly.io support both. Set `REDIS_URL` to your hosted Redis URL and you're good to go.
