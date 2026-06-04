console.log("1. Script starting...");

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const path = require('path');
const questions = require('./data/questions.json');

// ---------------------------------------------------------------------------
// Redis clients
// Two separate clients are required by the Socket.io Redis adapter:
//   pubClient  – publishes events to other server instances
//   subClient  – subscribes and receives events from other instances
// ---------------------------------------------------------------------------
const pubClient = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
const subClient = pubClient.duplicate();

pubClient.on("error", (err) => console.error("Redis pubClient error:", err));
subClient.on("error", (err) => console.error("Redis subClient error:", err));

// ---------------------------------------------------------------------------
// Redis key helpers – centralise all key shapes in one place
// ---------------------------------------------------------------------------
const KEYS = {
  room:    (r) => `room:${r}`,           // Hash  – config & scalar state
  players: (r) => `room:${r}:players`,   // List  – ordered socket id list
  answers: (r) => `room:${r}:answers`,   // List  – JSON-serialised answer objects
  votes:   (r) => `room:${r}:votes`,     // List  – voter names (dedup check)
  user:    (id) => `user:${id}`,         // Hash  – name, room, score
};

// ---------------------------------------------------------------------------
// Redis helper utilities (thin async wrappers)
// ---------------------------------------------------------------------------

/** Read a room's scalar Hash fields as a plain object (all values are strings). */
async function getRoomConfig(redisClient, room) {
  return redisClient.hGetAll(KEYS.room(room));
}

/** Write one or more scalar fields to the room Hash. */
async function setRoomFields(redisClient, room, fields) {
  // hSet accepts an object of field→value pairs in node-redis v4+
  return redisClient.hSet(KEYS.room(room), fields);
}

/** Read all players in a room (Redis List → JS array of socket ids). */
async function getPlayers(redisClient, room) {
  return redisClient.lRange(KEYS.players(room), 0, -1);
}

/** Append a player id to the room's player list. */
async function addPlayer(redisClient, room, socketId) {
  return redisClient.rPush(KEYS.players(room), socketId);
}

/** Remove a specific socket id from the player list. */
async function removePlayer(redisClient, room, socketId) {
  return redisClient.lRem(KEYS.players(room), 0, socketId);
}

/** Read all answers (deserialise from JSON strings). */
async function getAnswers(redisClient, room) {
  const raw = await redisClient.lRange(KEYS.answers(room), 0, -1);
  return raw.map(JSON.parse);
}

/** Append one answer (serialise to JSON). */
async function pushAnswer(redisClient, room, answerObj) {
  return redisClient.rPush(KEYS.answers(room), JSON.stringify(answerObj));
}

/** Read all vote-tracker entries (voter names). */
async function getVotes(redisClient, room) {
  return redisClient.lRange(KEYS.votes(room), 0, -1);
}

/** Append a voter name to the vote-tracker list. */
async function pushVote(redisClient, room, voterName) {
  return redisClient.rPush(KEYS.votes(room), voterName);
}

/** Atomically overwrite the answers list with a new array. */
async function setAnswers(redisClient, room, answersArray) {
  const multi = redisClient.multi();
  multi.del(KEYS.answers(room));
  for (const a of answersArray) {
    multi.rPush(KEYS.answers(room), JSON.stringify(a));
  }
  return multi.exec();
}

/** Clear answers and votes lists (between rounds). */
async function resetRoundData(redisClient, room) {
  return redisClient.multi()
    .del(KEYS.answers(room))
    .del(KEYS.votes(room))
    .exec();
}

/** Delete every Redis key that belongs to a room. */
async function deleteRoom(redisClient, room) {
  return redisClient.multi()
    .del(KEYS.room(room))
    .del(KEYS.players(room))
    .del(KEYS.answers(room))
    .del(KEYS.votes(room))
    .exec();
}

/**
 * Fetch every player profile in a room and compile final stats.
 * Returns an array sorted by score descending, with funnyPoints included.
 * Safe to call before deleteRoom — reads user Hashes by player list order.
 */
async function compileEndGameStats(redisClient, room) {
  const playerIds = await getPlayers(redisClient, room);
  const profiles  = await Promise.all(
    playerIds.map(id => getUser(redisClient, id))
  );

  return profiles
    .filter(Boolean)
    .map(p => ({
      name:        p.name,
      score:       p.score       ?? 0,
      funnyPoints: p.funnyPoints ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Read a user Hash as a plain object. */
async function getUser(redisClient, socketId) {
  const data = await redisClient.hGetAll(KEYS.user(socketId));
  if (!data || Object.keys(data).length === 0) return null;
  data.score       = parseInt(data.score,       10) || 0;
  data.funnyPoints = parseInt(data.funnyPoints, 10) || 0;
  return data;
}

/** Write / overwrite a user Hash. */
async function setUser(redisClient, socketId, fields) {
  return redisClient.hSet(KEYS.user(socketId), {
    ...fields,
    score:       String(fields.score       ?? 0),
    funnyPoints: String(fields.funnyPoints ?? 0),
  });
}

/** Increment a user's score by delta. */
async function incrementScore(redisClient, socketId, delta) {
  return redisClient.hIncrBy(KEYS.user(socketId), "score", delta);
}

/** Increment the funnyPoints tally on a user's profile. */
async function incrementFunnyPoints(redisClient, socketId, delta = 1) {
  return redisClient.hIncrBy(KEYS.user(socketId), "funnyPoints", delta);
}

/**
 * Generate a random 4-letter uppercase room code.
 * Retries until it finds one that has no existing room Hash in Redis.
 */
async function generateRoomCode(redisClient) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // omit I and O (look like 1/0)
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const existing = await redisClient.exists(KEYS.room(code));
    if (!existing) return code;
  }
  // Extremely unlikely – fall back to a timestamp suffix
  return "ROOM" + Date.now().toString(36).slice(-4).toUpperCase();
}

/** Delete a user's Hash entirely. */
async function deleteUser(redisClient, socketId) {
  return redisClient.del(KEYS.user(socketId));
}

// ---------------------------------------------------------------------------
// Bootstrap: connect Redis, attach adapter, start listening
// ---------------------------------------------------------------------------
async function main() {
  await pubClient.connect();
  await subClient.connect();
  console.log("✅ Redis clients connected");

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // Attach the Redis adapter – all Socket.io events now fan out via Redis
  io.adapter(createAdapter(pubClient, subClient));
  console.log("✅ Socket.io Redis adapter attached");

  // Serve static files from the public directory
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // -------------------------------------------------------------------------
  // Socket.io event handlers
  // All handlers are async so they can await Redis calls before acting.
  // -------------------------------------------------------------------------
  io.on("connection", (socket) => {
    console.log(`User Connected: ${socket.id}`);

    // --- A. JOIN ROOM -------------------------------------------------------
    // Client may pass `null` / undefined for `room` to request a fresh code.
    socket.on("join-room", async (room, name) => {
      // Generate a unique 4-letter code when the client doesn't supply one
      const resolvedRoom = (room && typeof room === "string" && room.trim())
        ? room.trim().toUpperCase()
        : await generateRoomCode(pubClient);

      socket.join(resolvedRoom);

      // Persist user (funnyPoints starts at 0)
      await setUser(pubClient, socket.id, { name, room: resolvedRoom, score: 0, funnyPoints: 0 });

      // Init room config if it doesn't exist yet
      const existing = await getRoomConfig(pubClient, resolvedRoom);
      if (!existing || !existing.host) {
        await setRoomFields(pubClient, resolvedRoom, {
          host:            "",
          maxRounds:       "5",
          questionsPerRound: "1",
          theme:           "default",
          currentRound:    "0",
          currentSubject:  "",
        });
      }

      // Add player (avoid duplicates by checking first)
      const currentPlayers = await getPlayers(pubClient, resolvedRoom);
      if (!currentPlayers.includes(socket.id)) {
        await addPlayer(pubClient, resolvedRoom, socket.id);
      }

      // Make the first player the host
      const roomConfig = await getRoomConfig(pubClient, resolvedRoom);
      const players    = await getPlayers(pubClient, resolvedRoom);

      if (!roomConfig.host || roomConfig.host === "") {
        await setRoomFields(pubClient, resolvedRoom, { host: socket.id });
        socket.emit('is-host');
      }

      // Tell the joining client which room code was assigned
      socket.emit("room-code", resolvedRoom);

      // Notify room
      io.to(resolvedRoom).emit("notification", `👋 ${name} has joined the room!`);
      io.to(resolvedRoom).emit("wait-screen", `Waiting for players... (${players.length} joined)`);
      await updatePlayerList(resolvedRoom, io);
    });

    // --- B. REQUEST START (Host Only) --------------------------------------
    // Accepts a `settings` object: { maxRounds, questionsPerRound, theme }
    // Falls back to sane defaults for any missing field.
    socket.on("request-start-game", async (settings) => {
      const user = await getUser(pubClient, socket.id);
      if (!user) return;

      const roomConfig = await getRoomConfig(pubClient, user.room);
      if (!roomConfig || roomConfig.host !== socket.id) return; // Non-host guard

      // Normalise & validate settings
      const maxRounds        = Math.max(1, parseInt(settings?.maxRounds,        10) || 5);
      const questionsPerRound = Math.max(1, parseInt(settings?.questionsPerRound, 10) || 1);
      const theme            = (typeof settings?.theme === "string" && settings.theme.trim())
        ? settings.theme.trim()
        : "default";

      await setRoomFields(pubClient, user.room, {
        maxRounds:         String(maxRounds),
        questionsPerRound: String(questionsPerRound),
        theme,
        currentRound:      "1",
      });

      await startNewRound(pubClient, io, user.room);
    });

    // --- C. SUBMIT ANSWER --------------------------------------------------
    socket.on("submit-answer", async (answerText) => {
      const user = await getUser(pubClient, socket.id);
      if (!user) return;

      // Reject blank / whitespace-only submissions
      if (!answerText || typeof answerText !== "string" || !answerText.trim()) {
        socket.emit("answer-error", "Answer cannot be empty.");
        return;
      }
      const sanitised = answerText.trim();

      const roomConfig = await getRoomConfig(pubClient, user.room);
      if (!roomConfig) return;

      const isTruth   = (roomConfig.currentSubject === socket.id);
      const answers   = await getAnswers(pubClient, user.room);

      const newAnswer = {
        id:         answers.length,
        socketId:   socket.id,
        author:     user.name,
        text:       sanitised,
        votes:      0,
        funnyVotes: 0,
        isCorrect:  isTruth,
      };
      await pushAnswer(pubClient, user.room, newAnswer);

      const updatedAnswers = await getAnswers(pubClient, user.room);
      const players        = await getPlayers(pubClient, user.room);

      if (updatedAnswers.length === players.length) {
        const shuffled = updatedAnswers.sort(() => Math.random() - 0.5);
        // Persist the shuffled order so all instances agree on indices
        await setAnswers(pubClient, user.room, shuffled);
        io.to(user.room).emit("start-voting", shuffled);
      } else {
        socket.emit("wait-screen", "Waiting for others to answer...");
      }
    });

    // --- D. SUBMIT VOTE ----------------------------------------------------
    socket.on("submit-vote", async (truthIndex, funnyIndex) => {
      const user = await getUser(pubClient, socket.id);
      if (!user) return;

      const answers = await getAnswers(pubClient, user.room);
      const truthAnswer = answers[truthIndex];
      const funnyAnswer = answers[funnyIndex];

      // Award points
      if (truthAnswer) {
        truthAnswer.votes += 1;
        if (truthAnswer.isCorrect) {
          await incrementScore(pubClient, socket.id, 10); // Voter identified truth
        } else {
          await incrementScore(pubClient, truthAnswer.socketId, 10); // Faker fooled them
        }
      }
      if (funnyAnswer) {
        funnyAnswer.funnyVotes += 1;
        // Persist funny-points on the author's Redis user profile
        await incrementFunnyPoints(pubClient, funnyAnswer.socketId, 1);
      }

      // Persist mutated answers array
      await setAnswers(pubClient, user.room, answers);
      await pushVote(pubClient, user.room, user.name);

      const votes   = await getVotes(pubClient, user.room);
      const players = await getPlayers(pubClient, user.room);

      if (votes.length === players.length) {
        // All votes in – broadcast results
        const finalAnswers = await getAnswers(pubClient, user.room);
        const results = finalAnswers.map(a => ({
          author:     a.author,
          text:       a.text,
          score:      a.votes,
          funnyScore: a.funnyVotes,
          isCorrect:  a.isCorrect,
        }));
        io.to(user.room).emit("show-results", results);

        const roomConfig = await getRoomConfig(pubClient, user.room);
        const currentRound = parseInt(roomConfig.currentRound, 10);
        const maxRounds    = parseInt(roomConfig.maxRounds,    10);

        // Clear round data now so the next round starts clean
        await resetRoundData(pubClient, user.room);

        if (currentRound < maxRounds) {
          await setRoomFields(pubClient, user.room, {
            currentRound: String(currentRound + 1),
          });
          setTimeout(() => startNewRound(pubClient, io, user.room), 5000);
        } else {
          // ── Game over: compile stats, emit leaderboard, then purge room ──
          const stats = await compileEndGameStats(pubClient, user.room);
          const roomToDelete = user.room; // capture before any async gaps
          setTimeout(async () => {
            io.to(roomToDelete).emit("end-game-stats", stats);
            // Delete user Hashes first (before room keys, so no orphan reads)
            const playerIds = await getPlayers(pubClient, roomToDelete);
            await Promise.all(playerIds.map(id => deleteUser(pubClient, id)));
            await deleteRoom(pubClient, roomToDelete);
          }, 3000);
        }
      } else {
        socket.emit("wait-screen", "Waiting for others to vote...");
      }
    });

    // --- E. DISCONNECT -----------------------------------------------------
    socket.on("disconnect", async () => {
      const user = await getUser(pubClient, socket.id);
      if (!user) return;

      const room = user.room;
      console.log(`${user.name} disconnected from room ${room}`);

      // 1. Remove player from the list FIRST so all subsequent counts are accurate
      await removePlayer(pubClient, room, socket.id);
      await deleteUser(pubClient, socket.id);

      const remainingPlayers = await getPlayers(pubClient, room);

      if (remainingPlayers.length === 0) {
        // Last player left – clean up the room entirely
        await deleteRoom(pubClient, room);
        return;
      }

      io.to(room).emit("notification", `🏃 ${user.name} has left the room.`);
      await updatePlayerList(room, io);

      // 2. Check whether the game is now in a stuck state because the
      //    departed player was the one the game was waiting on.
      const roomConfig = await getRoomConfig(pubClient, room);
      if (!roomConfig || !roomConfig.currentRound || roomConfig.currentRound === "0") {
        // Game hasn't started yet – nothing to unblock
        return;
      }

      const [answers, votes] = await Promise.all([
        getAnswers(pubClient, room),
        getVotes(pubClient, room),
      ]);

      const playerCount = remainingPlayers.length;

      // ── Stuck in the ANSWERING phase ──────────────────────────────────────
      // The departing player hadn't answered yet; now everyone remaining has.
      const answeredIds = answers.map(a => a.socketId);
      const everyoneAnswered =
        playerCount > 0 &&
        answers.length > 0 &&
        remainingPlayers.every(id => answeredIds.includes(id));

      if (everyoneAnswered && votes.length < playerCount) {
        // Transition to voting
        const shuffled = [...answers].sort(() => Math.random() - 0.5);
        await setAnswers(pubClient, room, shuffled);
        io.to(room).emit("start-voting", shuffled);
        return;
      }

      // ── Stuck in the VOTING phase ─────────────────────────────────────────
      // The departing player hadn't voted yet; now everyone remaining has.
      const votedNames = new Set(votes);
      const everyoneVoted =
        playerCount > 0 &&
        votes.length > 0 &&
        remainingPlayers.every(async (id) => {
          const u = await getUser(pubClient, id);
          return u && votedNames.has(u.name);
        });

      // everyoneVoted above uses async inside .every() which doesn't work;
      // re-implement with an explicit async check:
      const remainingUserNames = (
        await Promise.all(remainingPlayers.map(id => getUser(pubClient, id)))
      )
        .filter(Boolean)
        .map(u => u.name);

      const allRemainingVoted =
        playerCount > 0 &&
        votes.length > 0 &&
        remainingUserNames.every(name => votedNames.has(name));

      if (allRemainingVoted) {
        const finalAnswers = await getAnswers(pubClient, room);
        const results = finalAnswers.map(a => ({
          author:     a.author,
          text:       a.text,
          score:      a.votes,
          funnyScore: a.funnyVotes,
          isCorrect:  a.isCorrect,
        }));
        io.to(room).emit("show-results", results);

        const currentRound = parseInt(roomConfig.currentRound, 10);
        const maxRounds    = parseInt(roomConfig.maxRounds,    10);
        await resetRoundData(pubClient, room);

        if (currentRound < maxRounds) {
          await setRoomFields(pubClient, room, { currentRound: String(currentRound + 1) });
          setTimeout(() => startNewRound(pubClient, io, room), 5000);
        } else {
          const stats = await compileEndGameStats(pubClient, room);
          const roomToDelete = room;
          setTimeout(async () => {
            io.to(roomToDelete).emit("end-game-stats", stats);
            const playerIds = await getPlayers(pubClient, roomToDelete);
            await Promise.all(playerIds.map(id => deleteUser(pubClient, id)));
            await deleteRoom(pubClient, roomToDelete);
          }, 3000);
        }
      }
    });

  }); // End io.on('connection')

  // -------------------------------------------------------------------------
  // Helper: send the current player name list to everyone in a room
  // -------------------------------------------------------------------------
  async function updatePlayerList(room, io) {
    const playerIds = await getPlayers(pubClient, room);
    const names = (
      await Promise.all(
        playerIds.map(async (id) => {
          const u = await getUser(pubClient, id);
          return u ? u.name : null;
        })
      )
    ).filter(Boolean);

    io.to(room).emit("update-player-list", names);
  }

  // -------------------------------------------------------------------------
  // Helper: start a new round – pick a question, reset round data, notify
  // -------------------------------------------------------------------------
  async function startNewRound(redisClient, io, roomName) {
    const roomConfig = await getRoomConfig(redisClient, roomName);
    const players    = await getPlayers(redisClient, roomName);

    // 1. Pick a random question
    const randomIndex = Math.floor(Math.random() * questions.length);
    let questionData  = { ...questions[randomIndex] };
    let subjectId     = null;

    // 2. Substitute {player} placeholder with a real player's name
    if (questionData.text && questionData.text.includes("{player}") && players.length > 0) {
      const randomPlayerId = players[Math.floor(Math.random() * players.length)];
      const subjectUser    = await getUser(redisClient, randomPlayerId);
      if (subjectUser) {
        questionData.text = questionData.text.replace("{player}", subjectUser.name);
        subjectId = randomPlayerId;
      }
    }

    // 3. Persist subject and wipe round data
    await setRoomFields(redisClient, roomName, { currentSubject: subjectId || "" });
    await resetRoundData(redisClient, roomName);

    const currentRound = roomConfig.currentRound;
    const maxRounds    = roomConfig.maxRounds;

    // 4. Notify clients
    io.to(roomName).emit("wait-screen", `Starting Round ${currentRound} of ${maxRounds}...`);

    setTimeout(() => {
      io.to(roomName).emit("new-round", questionData.text);
    }, 2000);
  }

  server.listen(3001, () => {
    console.log('----------------------------------------');
    console.log('✅ SERVER RUNNING: http://localhost:3001');
    console.log('----------------------------------------');
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});