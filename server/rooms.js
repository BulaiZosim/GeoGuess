const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;
const MAX_PLAYERS = 24;

function avatarUrl(name) {
  return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(name)}`;
}

// Room state is keyed by the persistent playerId (from the DB), not by socket.id.
// This lets a player reconnect with a fresh socket and resume their slot.
//
// Each player entry: { socketId, playerId, name, connected, graceTimer }
//   socketId     — the CURRENT socket id (changes on reconnect)
//   connected    — true while the websocket is live; false during grace period
//   graceTimer   — Node timeout id; if it fires, the player is fully evicted
//
// hostPlayerId points at the persistent id of the host.
class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  generateCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(socketId, playerName, playerId) {
    const code = this.generateCode();
    const room = {
      code,
      hostPlayerId: playerId,
      players: new Map(),
      state: 'lobby',
      currentRound: 0,
      totalRounds: 3,
      roundTime: 90,
      usedLocations: [],
      currentLocation: null,
      guesses: new Map(),
      scores: new Map(),
      roundTimer: null,
    };
    room.players.set(playerId, {
      socketId,
      playerId,
      name: playerName,
      connected: true,
      graceTimer: null,
    });
    room.scores.set(playerId, 0);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  joinRoom(code, socketId, playerName, playerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.state === 'game_over') return { error: 'Game is over, wait for host to return to lobby' };

    const existing = room.players.get(playerId);
    if (existing) {
      if (existing.connected) return { error: 'You are already in this room' };
      // Disconnected slot: treat this as a resume. Cancel grace, rebind socket.
      this._cancelGrace(existing);
      existing.socketId = socketId;
      existing.connected = true;
      return { room, resumed: true };
    }

    if (room.players.size >= MAX_PLAYERS) return { error: 'Room is full (max 24 players)' };

    room.players.set(playerId, {
      socketId,
      playerId,
      name: playerName,
      connected: true,
      graceTimer: null,
    });
    room.scores.set(playerId, 0);
    return { room };
  }

  // Mark a player as disconnected but DO NOT remove them yet.
  // Returns the room + player entry so the caller can schedule a grace timer.
  markDisconnected(socketId) {
    for (const room of this.rooms.values()) {
      for (const player of room.players.values()) {
        if (player.socketId === socketId && player.connected) {
          player.connected = false;
          return { room, player };
        }
      }
    }
    return null;
  }

  // Called when a reconnecting client identifies itself with playerId + roomCode.
  // Rebinds the new socketId to the existing player entry.
  resumeSession(code, playerId, newSocketId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    const player = room.players.get(playerId);
    if (!player) return { error: 'Player not in room' };
    this._cancelGrace(player);
    player.socketId = newSocketId;
    player.connected = true;
    return { room, player };
  }

  // Fully remove a player from the room. Transfers host if needed.
  evictPlayer(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players.get(playerId);
    if (!player) return null;
    this._cancelGrace(player);
    room.players.delete(playerId);
    room.scores.delete(playerId);
    room.guesses.delete(playerId);
    const wasHost = room.hostPlayerId === playerId;

    if (room.players.size === 0) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      this.rooms.delete(code);
      return { room, wasHost, roomDeleted: true };
    }

    if (wasHost) {
      // Prefer a still-connected player as new host, fall back to any.
      const newHost = [...room.players.values()].find(p => p.connected)
                   || [...room.players.values()][0];
      room.hostPlayerId = newHost.playerId;
      return {
        room, wasHost: true, roomDeleted: false,
        newHostSocketId: newHost.socketId,
        newHostPlayerId: newHost.playerId,
      };
    }

    return { room, wasHost: false, roomDeleted: false };
  }

  _cancelGrace(player) {
    if (player.graceTimer) {
      clearTimeout(player.graceTimer);
      player.graceTimer = null;
    }
  }

  getRoomByPlayerId(playerId) {
    if (playerId == null) return null;
    for (const room of this.rooms.values()) {
      if (room.players.has(playerId)) return room;
    }
    return null;
  }

  // Used to enforce the one-game-at-a-time rule. Kept tiny + synchronous so
  // the create_room handler can check + createRoom atomically on Node's
  // single-threaded event loop.
  hasAnyRoom() {
    return this.rooms.size > 0;
  }

  anyRoomCode() {
    return this.rooms.keys().next().value || null;
  }

  getActiveRooms() {
    const active = [];
    for (const room of this.rooms.values()) {
      active.push({
        code: room.code,
        state: room.state,
        currentRound: room.currentRound,
        totalRounds: room.totalRounds,
        playerCount: room.players.size,
        players: [...room.players.values()].map(p => ({
          name: p.name,
          avatarUrl: avatarUrl(p.name),
        })),
      });
    }
    return active;
  }

  getPlayerList(room) {
    return [...room.players.values()].map(p => ({
      id: p.socketId,
      playerId: p.playerId,
      name: p.name,
      avatarUrl: avatarUrl(p.name),
      isHost: p.playerId === room.hostPlayerId,
      connected: p.connected,
      score: room.scores.get(p.playerId) || 0,
    }));
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    if (room.roundTimer) clearTimeout(room.roundTimer);
    for (const p of room.players.values()) this._cancelGrace(p);
    this.rooms.delete(code);
  }
}

module.exports = { RoomManager };
