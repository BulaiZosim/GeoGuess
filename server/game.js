const { generateRandomPoint } = require('./locations');

// Haversine distance in km
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateScore(distanceKm) {
  return Math.round(5000 * Math.exp(-distanceKm / 2000));
}

function handleSocket(io, socket, rooms, db) {
  console.log(`Connected: ${socket.id}`);

  socket.on('create_room', ({ playerId }, callback) => {
    if (!playerId) return callback({ error: 'Select a player' });

    const player = db.getPlayerById(playerId);
    if (!player) return callback({ error: 'Player not found' });

    const room = rooms.createRoom(socket.id, player.name, player.id);
    socket.join(room.code);
    callback({
      code: room.code,
      players: rooms.getPlayerList(room),
      isHost: true,
    });
  });

  socket.on('join_room', ({ code, playerId }, callback) => {
    if (!playerId) return callback({ error: 'Select a player' });
    if (!code) return callback({ error: 'Room code is required' });

    const player = db.getPlayerById(playerId);
    if (!player) return callback({ error: 'Player not found' });

    const result = rooms.joinRoom(code, socket.id, player.name, player.id);
    if (result.error) return callback({ error: result.error });

    const room = result.room;
    socket.join(room.code);

    io.to(room.code).emit('player_joined', {
      players: rooms.getPlayerList(room),
    });

    // If game is in progress, send current game state to the late joiner
    const gameState = room.state !== 'lobby' ? {
      state: room.state,
      round: room.currentRound,
      totalRounds: room.totalRounds,
      timeLimit: room.roundTime,
    } : null;

    callback({
      code: room.code,
      players: rooms.getPlayerList(room),
      isHost: false,
      gameState,
    });
  });

  socket.on('start_game', (_, callback) => {
    const room = rooms.getRoomByPlayer(socket.id);
    if (!room) return callback?.({ error: 'Not in a room' });
    if (room.hostId !== socket.id) return callback?.({ error: 'Only the host can start' });
    if (room.players.size < 1) return callback?.({ error: 'Need at least 1 player' });

    room.state = 'playing';
    room.currentRound = 0;
    room.usedLocations = [];
    for (const id of room.players.keys()) {
      room.scores.set(id, 0);
    }

    startRound(io, room, rooms);
    callback?.({ ok: true });
  });

  socket.on('location_found', ({ lat, lng, panoId }) => {
    const room = rooms.getRoomByPlayer(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'searching') return;

    room.currentLocation = { lat, lng };
    room.state = 'playing';

    io.to(room.code).emit('round_start_confirmed', {
      round: room.currentRound,
      totalRounds: room.totalRounds,
      timeLimit: room.roundTime,
      panoId,
      lat,
      lng,
    });

    room.roundTimer = setTimeout(() => {
      endRound(io, room, rooms);
    }, room.roundTime * 1000);
  });

  socket.on('submit_guess', ({ lat, lng }) => {
    const room = rooms.getRoomByPlayer(socket.id);
    if (!room || room.state !== 'playing') return;
    if (room.guesses.has(socket.id)) return;

    room.guesses.set(socket.id, { lat, lng, time: Date.now() });

    io.to(room.code).emit('player_guessed', {
      playerId: socket.id,
      totalGuesses: room.guesses.size,
      totalPlayers: room.players.size,
    });

    if (room.guesses.size >= room.players.size) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      endRound(io, room, rooms);
    }
  });

  socket.on('next_round', () => {
    const room = rooms.getRoomByPlayer(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.state !== 'round_results') return;

    if (room.currentRound >= room.totalRounds) {
      endGame(io, room, rooms, db);
    } else {
      startRound(io, room, rooms);
    }
  });

  socket.on('back_to_lobby', () => {
    const room = rooms.getRoomByPlayer(socket.id);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.state = 'lobby';
    room.currentRound = 0;
    room.usedLocations = [];
    room.guesses.clear();
    for (const id of room.players.keys()) {
      room.scores.set(id, 0);
    }

    io.to(room.code).emit('back_to_lobby', {
      players: rooms.getPlayerList(room),
    });
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    const result = rooms.removePlayer(socket.id);
    if (!result) return;

    const { room, wasHost, newHostId, roomDeleted } = result;
    if (roomDeleted) return;

    io.to(room.code).emit('player_left', {
      players: rooms.getPlayerList(room),
      newHostId: wasHost ? newHostId : null,
    });
  });
}

function startRound(io, room, rooms) {
  room.currentRound++;
  room.guesses.clear();
  room.state = 'searching';

  const candidates = [];
  for (let i = 0; i < 20; i++) {
    candidates.push(generateRandomPoint());
  }

  io.to(room.code).emit('round_searching', {
    round: room.currentRound,
    totalRounds: room.totalRounds,
  });

  const hostSocket = [...room.players.keys()].find(id => id === room.hostId);
  if (hostSocket) {
    io.to(hostSocket).emit('find_panorama', { candidates });
  }
}

function endRound(io, room, rooms) {
  room.state = 'round_results';
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  const actual = room.currentLocation;
  const results = [];

  for (const [socketId, player] of room.players) {
    const guess = room.guesses.get(socketId);
    let distance = null;
    let points = 0;

    if (guess) {
      distance = haversine(actual.lat, actual.lng, guess.lat, guess.lng);
      points = calculateScore(distance);
      room.scores.set(socketId, (room.scores.get(socketId) || 0) + points);
    }

    results.push({
      id: socketId,
      playerId: player.playerId,
      name: player.name,
      avatarUrl: `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(player.name)}`,
      guess: guess ? { lat: guess.lat, lng: guess.lng } : null,
      distance: distance !== null ? Math.round(distance) : null,
      points,
      totalScore: room.scores.get(socketId) || 0,
    });
  }

  results.sort((a, b) => b.points - a.points);

  io.to(room.code).emit('round_end', {
    round: room.currentRound,
    totalRounds: room.totalRounds,
    actual: { lat: actual.lat, lng: actual.lng },
    results,
    isLastRound: room.currentRound >= room.totalRounds,
  });
}

function endGame(io, room, rooms, db) {
  room.state = 'game_over';

  const standings = [];
  const playerScores = [];

  for (const [socketId, player] of room.players) {
    const score = room.scores.get(socketId) || 0;
    standings.push({
      id: socketId,
      playerId: player.playerId,
      name: player.name,
      avatarUrl: `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(player.name)}`,
      totalScore: score,
    });
    playerScores.push({ playerId: player.playerId, score });
  }

  standings.sort((a, b) => b.totalScore - a.totalScore);

  // Save to database
  try {
    db.saveGameResult(room.code, room.totalRounds, playerScores);
    console.log(`Game saved: ${room.code}, ${playerScores.length} players`);
  } catch (e) {
    console.error('Failed to save game result:', e);
  }

  io.to(room.code).emit('game_over', { standings });
}

module.exports = { handleSocket };
