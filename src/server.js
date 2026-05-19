console.log("1. Script starting...");

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const questions = require('./questions.json'); // Validated by debugger!

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve files from the current folder
app.use(express.static(__dirname));

// Send HTML on root load
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Game State
let roomData = {}; 
// roomData[roomName] = { 
//    players: [socketid1, ...], 
//    answers: [], 
//    votes: [], 
//    host: socketid 
// }

let users = {};
// users[socketid] = { name, room, score }

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  // --- A. JOIN ROOM ---
  socket.on("join-room", (room, name) => {
    socket.join(room);
    users[socket.id] = { name, room, score: 0 };
    
    // Init Room
    if (!roomData[room]) {
      roomData[room] = { players: [], answers: [], votes: [], host: null };
    }
    
    // Add Player
    if (!roomData[room].players.includes(socket.id)) {
        roomData[room].players.push(socket.id);
    }

    // Make the first player the host
    if (roomData[room].host === null || roomData[room].players.length === 1) {
        roomData[room].host = socket.id;
        socket.emit('is-host'); // Tell client they are the boss
    }
    
    // Notify everyone
    const count = roomData[room].players.length;
    io.to(room).emit("notification", `👋 ${name} has joined the room!`);
    io.to(room).emit("wait-screen", `Waiting for players... (${count} joined)`);
    updatePlayerList(room,io);
  });

  // --- B. REQUEST START (Host Only) ---
  socket.on("request-start-game", (totalRounds) => {
    const user = users[socket.id];
    if (!user) return;
    const room = roomData[user.room];

    // Security Check: Only the host can start
    if (room && room.host === socket.id) {
        // initialize the loop
        room.maxRounds = parseInt(totalRounds)||5;
        room.currentRound = 1;

        // call the helper function
        startNewRound(room,io,user.room);}

        
       
  });

  // --- C. SUBMIT ANSWER ---
  socket.on("submit-answer", (answerText) => {
    const user = users[socket.id];
    if (!user) return; 
    const room = roomData[user.room];

    const isTruth = (room.currentSubject === socket.id);

    room.answers.push({
      id: room.answers.length,
      socketId: socket.id,
      author: user.name,
      text: answerText,
      votes: 0,
      funnyVotes: 0,
      isCorrect: isTruth
    });

    if (room.answers.length === room.players.length) {
      const shuffledAnswers = room.answers.sort(() => Math.random() - 0.5);
      io.to(user.room).emit("start-voting", shuffledAnswers);
    } else {
      socket.emit("wait-screen", "Waiting for others to answer...");
    }
  });

  // --- D. SUBMIT VOTE ---
  socket.on("submit-vote", (truthIndex, funnyIndex) => {
    const user = users[socket.id];
    if (!user) return;
    const room = roomData[user.room];

    const truthAnswer = room.answers[truthIndex];
    const funnyAnswer = room.answers[funnyIndex];

    if (truthAnswer) {
        truthAnswer.votes += 1;
        if (truthAnswer.isCorrect) {
            user.score += 10; // Voter gets points
        } else {
            // Faker gets points
            if (users[truthAnswer.socketId]) {
                users[truthAnswer.socketId].score += 10;
            }
        }
    }

    if (funnyAnswer) {
        funnyAnswer.funnyVotes += 1;
    }

    room.votes.push(user.name);

    if (room.votes.length === room.players.length) {
      const results = room.answers.map(a => ({
        author: a.author,
        text: a.text,
        score: a.votes,
        funnyScore: a.funnyVotes,
        isCorrect: a.isCorrect
      }));
      
      io.to(user.room).emit("show-results", results);
      
      
      if(room.currentRound<room.maxRounds){
        room.currentRound++;
        setTimeout(()=>{
            startNewRound(room,io,user.room);
        },5000);
      }
      else{
        setTimeout(()=>{
            io.to(user.room).emit("wait-screen","!GAME OVER!");
            room.currentRound = 0;

        },3000);
      }

      // cleanup for next step
      room.answers = [];
      room.votes = [];
    } else {
      socket.emit("wait-screen", "Waiting for others to vote...");
    }
  });

  // --- E. DISCONNECT ---
  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
        console.log(`${user.name} disconnected`);
        if (roomData[user.room]) {
            roomData[user.room].players = roomData[user.room].players.filter(id => id !== socket.id);
            updatePlayerList(user.room,io);
            // If room is empty, delete it
            if (roomData[user.room].players.length === 0) {
                io.to(user.room).emit("notification", `🏃 ${user.name} has left the room.`);
                delete roomData[user.room];
            }
        }
        delete users[socket.id];
    }
  });

}); // End of io.on('connection')
// --- HELPER: Send Player List to Room ---
function updatePlayerList(room, io) {
    if (!roomData[room]) return;
    
    // Get all players in the room
    const currentPlayers = roomData[room].players;
    
    // Map IDs to Names (check if user exists first)
    const names = currentPlayers
        .map(id => users[id] ? users[id].name : null)
        .filter(name => name !== null); // Remove nulls if any
    
    // Send list to everyone in that room
    io.to(room).emit("update-player-list", names);
}
// --- HELPER FUNCTION: START A NEW ROUND ---
function startNewRound(room, io, roomName) {
    // 1. Pick a random question
    const randomIndex = Math.floor(Math.random() * questions.length);
    let questionData = { ...questions[randomIndex] };
    let subjectId = null;

    // 2. Handle {player} tag (Replace with a real name)
    if (questionData.text && questionData.text.includes("{player}")) {
        // Get list of players in this room
        const playerIds = room.players;
        
        // Safety check: Make sure there are players
        if (playerIds.length > 0) {
            const randomPlayerId = playerIds[Math.floor(Math.random() * playerIds.length)];
            
            // Check if user still exists
            if (users[randomPlayerId]) {
                const randomPlayerName = users[randomPlayerId].name;
                questionData.text = questionData.text.replace("{player}", randomPlayerName);
                subjectId = randomPlayerId;
            }
        }
    }

    // 3. Reset Round Data (Clear answers and votes for the new round)
    room.currentSubject = subjectId;
    room.answers = [];
    room.votes = [];

    // 4. Notify clients: "Starting Round X of Y..."
    io.to(roomName).emit("wait-screen", `Starting Round ${room.currentRound} of ${room.maxRounds}...`);
    
    // 5. Send the question after a short delay (for drama)
    setTimeout(() => {
        io.to(roomName).emit("new-round", questionData.text);
    }, 2000);
}
// Using port 3001 to avoid conflicts
server.listen(3001, () => {
  console.log('----------------------------------------');
  console.log('✅ SERVER RUNNING: http://localhost:3001');
  console.log('----------------------------------------');
});