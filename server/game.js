const { generateRandomPoint } = require('./locations');
const { getCountryName } = require('./geo');

// How long a disconnected player's slot is held before they're fully evicted.
const DISCONNECT_GRACE_MS = 60_000;
// Server-driven auto-advance durations. These match the client-side countdown
// label so the UI and server stay in sync; the server is the source of truth.
const RESULTS_AUTO_ADVANCE_MS = 15_000;
const GAMEOVER_AUTO_ADVANCE_MS = 15_000;
// Max number of candidate batches we ask the host to search before giving up
// on the round. The initial batch is attempt 1.
const MAX_PANO_SEARCH_ATTEMPTS = 3;

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

// Helpers to resolve the caller's player identity from the socket.
// socket.data.playerId is set on create_room / join_room / resume_session.
function getCallerPlayerId(socket) {
  return socket.data?.playerId ?? null;
}
function getCallerRoom(socket, rooms) {
  const pid = getCallerPlayerId(socket);
  return pid != null ? rooms.getRoomByPlayerId(pid) : null;
}
function isCallerHost(socket, room) {
  return room && room.hostPlayerId === getCallerPlayerId(socket);
}

// Build the gameState payload sent to (re)joining clients so the UI can
// restore itself mid-round without waiting for the next event.
function buildGameState(room) {
  if (room.state === 'playing' && room.currentPanoId && room.roundStartedAt) {
    const elapsed = Math.floor((Date.now() - room.roundStartedAt) / 1000);
    const timeRemaining = Math.max(0, room.roundTime - elapsed);
    return {
      state: 'playing',
      round: room.currentRound,
      totalRounds: room.totalRounds,
      timeLimit: timeRemaining,
      panoId: room.currentPanoId,
    };
  }
  if (room.state !== 'lobby') {
    return { state: room.state, round: room.currentRound, totalRounds: room.totalRounds };
  }
  return null;
}

function handleSocket(io, socket, rooms, db) {
  console.log(`Connected: ${socket.id}`);

  socket.on('create_room', ({ playerId }, callback) => {
    if (!playerId) return callback({ error: 'Select a player' });

    const player = db.getPlayerById(playerId);
    if (!player) return callback({ error: 'Player not found' });

    const room = rooms.createRoom(socket.id, player.name, player.id);
    socket.data.playerId = player.id;
    socket.data.roomCode = room.code;
    socket.join(room.code);
    callback({
      code: room.code,
      playerId: player.id,
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
    socket.data.playerId = player.id;
    socket.data.roomCode = room.code;
    socket.join(room.code);

    io.to(room.code).emit('player_joined', {
      players: rooms.getPlayerList(room),
    });

    callback({
      code: room.code,
      playerId: player.id,
      players: rooms.getPlayerList(room),
      isHost: room.hostPlayerId === player.id,
      gameState: buildGameState(room),
    });
  });

  // Called by a reconnecting client with its persistent playerId + room code.
  // Rebinds the new socket to the existing player slot, cancels the grace timer.
  socket.on('resume_session', ({ code, playerId }, callback) => {
    if (!code || playerId == null) return callback?.({ error: 'Missing code or playerId' });

    const result = rooms.resumeSession(code, playerId, socket.id);
    if (result.error) return callback?.({ error: result.error });

    const room = result.room;
    socket.data.playerId = playerId;
    socket.data.roomCode = code;
    socket.join(code);

    // Tell everyone else this player is back online so lobby UI updates.
    io.to(code).emit('player_reconnected', {
      players: rooms.getPlayerList(room),
    });

    callback?.({
      ok: true,
      code,
      playerId,
      players: rooms.getPlayerList(room),
      isHost: room.hostPlayerId === playerId,
      gameState: buildGameState(room),
    });

    // If the host returns mid-search (their original find_panorama was lost
    // when they dropped), kick a fresh pano search so the round actually starts.
    if (room.state === 'searching' && room.hostPlayerId === playerId) {
      requestPanoSearchFromHost(io, room);
    }
  });

  socket.on('start_game', (_, callback) => {
    const room = getCallerRoom(socket, rooms);
    if (!room) return callback?.({ error: 'Not in a room' });
    if (!isCallerHost(socket, room)) return callback?.({ error: 'Only the host can start' });
    // Guard against double-start or starting mid-game: a stray click /
    // duplicate emit would otherwise wipe progress and restart the round loop.
    if (room.state !== 'lobby') return callback?.({ error: 'Game already in progress' });

    room.state = 'playing';
    room.currentRound = 0;
    room.usedLocations = [];
    room.roundData = []; // collect per-round guess data for stats
    for (const playerId of room.players.keys()) {
      room.scores.set(playerId, 0);
    }

    startRound(io, room, rooms);
    callback?.({ ok: true });
  });

  // Host's client tells us all 20 candidates in the latest batch had no Street
  // View coverage. We either retry with a fresh batch or, after
  // MAX_PANO_SEARCH_ATTEMPTS total batches, end the game with current scores
  // so players at least see a result screen.
  socket.on('pano_search_failed', () => {
    const room = getCallerRoom(socket, rooms);
    if (!room || !isCallerHost(socket, room)) return;
    if (room.state !== 'searching') return;

    if ((room.panoSearchAttempts || 0) >= MAX_PANO_SEARCH_ATTEMPTS) {
      console.warn(`Room ${room.code}: pano search exhausted after ${room.panoSearchAttempts} attempts; ending game`);
      endGame(io, room, rooms, db);
      return;
    }
    requestPanoSearchFromHost(io, room, { isRetry: true });
  });

  socket.on('location_found', ({ lat, lng, panoId }) => {
    const room = getCallerRoom(socket, rooms);
    if (!room || !isCallerHost(socket, room)) return;
    if (room.state !== 'searching') return;

    room.currentLocation = { lat, lng, country: null };
    room.currentPanoId = panoId;

    // Fetch country name asynchronously (doesn't block the round)
    getCountryName(lat, lng).then(country => {
      if (room.currentLocation) room.currentLocation.country = country;
    });
    room.roundStartedAt = Date.now();
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
      endRound(io, room, rooms, db);
    }, room.roundTime * 1000);
  });

  socket.on('submit_guess', ({ lat, lng } = {}) => {
    // Validate coords at the boundary so NaN / out-of-range values can't
    // corrupt scoring or DB rows.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    const room = getCallerRoom(socket, rooms);
    if (!room || room.state !== 'playing') return;
    const playerId = getCallerPlayerId(socket);
    if (playerId == null) return;
    if (room.guesses.has(playerId)) return;

    room.guesses.set(playerId, { lat, lng, time: Date.now() });

    io.to(room.code).emit('player_guessed', {
      totalGuesses: room.guesses.size,
      totalPlayers: room.players.size,
    });

    if (room.guesses.size >= room.players.size) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      endRound(io, room, rooms, db);
    }
  });

  socket.on('next_round', () => {
    const room = getCallerRoom(socket, rooms);
    if (!room || !isCallerHost(socket, room)) return;
    if (room.state !== 'round_results') return;
    cancelResultsAdvance(room);

    if (room.currentRound >= room.totalRounds) {
      endGame(io, room, rooms, db);
    } else {
      startRound(io, room, rooms);
    }
  });

  socket.on('back_to_lobby', () => {
    const room = getCallerRoom(socket, rooms);
    if (!room || !isCallerHost(socket, room)) return;
    cancelGameoverAdvance(room);
    cancelResultsAdvance(room);

    resetRoomToLobby(room);

    io.to(room.code).emit('back_to_lobby', {
      players: rooms.getPlayerList(room),
    });
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);

    const marked = rooms.markDisconnected(socket.id);
    if (!marked) return;
    const { room, player } = marked;

    // Tell others the player is offline (for UI indicator) without evicting.
    io.to(room.code).emit('player_disconnected', {
      playerId: player.playerId,
      players: rooms.getPlayerList(room),
    });

    // Schedule eviction after the grace window.
    player.graceTimer = setTimeout(() => {
      // Only evict if they haven't reconnected.
      if (player.connected) return;

      const result = rooms.evictPlayer(room.code, player.playerId);
      if (!result) return;
      if (result.roomDeleted) return;

      io.to(room.code).emit('player_left', {
        players: rooms.getPlayerList(result.room),
        newHostId: result.wasHost ? result.newHostSocketId : null,
        newHostPlayerId: result.wasHost ? result.newHostPlayerId : null,
      });

      // If the evicted player was the host mid pano-search, the new host
      // never received find_panorama. Re-kick the search so the round can
      // actually begin.
      if (result.wasHost && result.room.state === 'searching') {
        requestPanoSearchFromHost(io, result.room);
      }
    }, DISCONNECT_GRACE_MS);
  });
}

function startRound(io, room, rooms) {
  room.currentRound++;
  room.guesses.clear();
  room.state = 'searching';
  room.panoSearchAttempts = 0; // reset per round

  io.to(room.code).emit('round_searching', {
    round: room.currentRound,
    totalRounds: room.totalRounds,
  });

  requestPanoSearchFromHost(io, room, { isRetry: false });
}

// Send a fresh batch of candidates to whoever the current host is.
// Called at round start, on host reconnect/transfer during 'searching', and
// on pano_search_failed retries. Only bumps the attempt counter when it's
// actually a retry — recoveries after a disconnect re-use the current slot.
function requestPanoSearchFromHost(io, room, { isRetry = false } = {}) {
  const hostPlayer = room.players.get(room.hostPlayerId);
  if (!hostPlayer?.connected || !hostPlayer.socketId) return;

  if (isRetry) {
    room.panoSearchAttempts = (room.panoSearchAttempts || 0) + 1;
  } else if (!room.panoSearchAttempts) {
    room.panoSearchAttempts = 1;
  }

  const candidates = [];
  for (let i = 0; i < 20; i++) {
    candidates.push(generateRandomPoint());
  }
  io.to(hostPlayer.socketId).emit('find_panorama', {
    candidates,
    attempt: room.panoSearchAttempts,
  });
}

function endRound(io, room, rooms, db) {
  // Idempotency guard: protects against the rare race where a guess submit
  // and the round timer both call endRound for the same round.
  if (room.state !== 'playing') return;
  room.state = 'round_results';
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  const actual = room.currentLocation;
  const results = [];

  for (const [playerId, player] of room.players) {
    const guess = room.guesses.get(playerId);
    let distance = null;
    let points = 0;

    if (guess) {
      distance = haversine(actual.lat, actual.lng, guess.lat, guess.lng);
      points = calculateScore(distance);
      room.scores.set(playerId, (room.scores.get(playerId) || 0) + points);
    }

    const distRounded = distance !== null ? Math.round(distance) : null;

    results.push({
      id: player.socketId,
      playerId: player.playerId,
      name: player.name,
      avatarUrl: `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(player.name)}`,
      guess: guess ? { lat: guess.lat, lng: guess.lng } : null,
      distance: distRounded,
      points,
      totalScore: room.scores.get(playerId) || 0,
    });

    if (room.roundData) {
      room.roundData.push({
        playerId: player.playerId,
        roundNum: room.currentRound,
        guessLat: guess ? guess.lat : null,
        guessLng: guess ? guess.lng : null,
        actualLat: actual.lat,
        actualLng: actual.lng,
        actualCountry: actual.country || null,
        distanceKm: distRounded,
        score: points,
      });
    }
  }

  results.sort((a, b) => b.points - a.points);

  io.to(room.code).emit('round_end', {
    round: room.currentRound,
    totalRounds: room.totalRounds,
    actual: { lat: actual.lat, lng: actual.lng },
    results,
    isLastRound: room.currentRound >= room.totalRounds,
  });

  scheduleResultsAdvance(io, room, rooms, db);
}

function endGame(io, room, rooms, db) {
  room.state = 'game_over';

  const standings = [];
  const playerScores = [];

  for (const [playerId, player] of room.players) {
    const score = room.scores.get(playerId) || 0;
    standings.push({
      id: player.socketId,
      playerId: player.playerId,
      name: player.name,
      avatarUrl: `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(player.name)}`,
      totalScore: score,
    });
    playerScores.push({ playerId: player.playerId, score });
  }

  standings.sort((a, b) => b.totalScore - a.totalScore);

  try {
    db.saveFullGameResult(room.code, room.totalRounds, playerScores, room.roundData || []);
    console.log(`Game saved: ${room.code}, ${playerScores.length} players, ${(room.roundData || []).length} round guesses`);
  } catch (e) {
    console.error('Failed to save game result:', e);
  }

  io.to(room.code).emit('game_over', { standings });

  scheduleGameoverAdvance(io, room, rooms);
}

// Auto-advance from round_results to the next round (or endGame). Runs on a
// server timer so the game progresses even if nobody with host status is
// present to click/emit.
function scheduleResultsAdvance(io, room, rooms, db) {
  cancelResultsAdvance(room);
  room.resultsAdvanceTimer = setTimeout(() => {
    room.resultsAdvanceTimer = null;
    // Guard: room was deleted, or state already moved on (e.g. host skipped).
    if (rooms.getRoom(room.code) !== room) return;
    if (room.state !== 'round_results') return;

    if (room.currentRound >= room.totalRounds) {
      endGame(io, room, rooms, db);
    } else {
      startRound(io, room, rooms);
    }
  }, RESULTS_AUTO_ADVANCE_MS);
}

function cancelResultsAdvance(room) {
  if (room.resultsAdvanceTimer) {
    clearTimeout(room.resultsAdvanceTimer);
    room.resultsAdvanceTimer = null;
  }
}

// Auto-reset from game_over back to lobby. Same pattern as results advance.
function scheduleGameoverAdvance(io, room, rooms) {
  cancelGameoverAdvance(room);
  room.gameoverAdvanceTimer = setTimeout(() => {
    room.gameoverAdvanceTimer = null;
    if (rooms.getRoom(room.code) !== room) return;
    if (room.state !== 'game_over') return;

    resetRoomToLobby(room);
    io.to(room.code).emit('back_to_lobby', {
      players: rooms.getPlayerList(room),
    });
  }, GAMEOVER_AUTO_ADVANCE_MS);
}

function cancelGameoverAdvance(room) {
  if (room.gameoverAdvanceTimer) {
    clearTimeout(room.gameoverAdvanceTimer);
    room.gameoverAdvanceTimer = null;
  }
}

function resetRoomToLobby(room) {
  room.state = 'lobby';
  room.currentRound = 0;
  room.usedLocations = [];
  room.guesses.clear();
  for (const playerId of room.players.keys()) {
    room.scores.set(playerId, 0);
  }
}

module.exports = { handleSocket };
