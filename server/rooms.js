const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;
const MAX_PLAYERS = 24;

function avatarUrl(name) {
  return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(name)}`;
}

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

  createRoom(hostSocketId, playerName, persistentPlayerId) {
    const code = this.generateCode();
    const room = {
      code,
      hostId: hostSocketId,
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
    room.players.set(hostSocketId, {
      id: hostSocketId,
      name: playerName,
      playerId: persistentPlayerId,
      connected: true,
    });
    room.scores.set(hostSocketId, 0);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  joinRoom(code, socketId, playerName, persistentPlayerId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.state !== 'lobby') return { error: 'Game already in progress' };
    if (room.players.size >= MAX_PLAYERS) return { error: 'Room is full (max 24 players)' };

    // Check if this persistent player is already in the room
    for (const p of room.players.values()) {
      if (p.playerId === persistentPlayerId) {
        return { error: 'You are already in this room' };
      }
    }

    room.players.set(socketId, {
      id: socketId,
      name: playerName,
      playerId: persistentPlayerId,
      connected: true,
    });
    room.scores.set(socketId, 0);
    return { room };
  }

  removePlayer(socketId) {
    for (const [code, room] of this.rooms) {
      if (room.players.has(socketId)) {
        room.players.delete(socketId);
        room.scores.delete(socketId);
        room.guesses.delete(socketId);

        if (room.players.size === 0) {
          if (room.roundTimer) clearTimeout(room.roundTimer);
          this.rooms.delete(code);
          return { room, wasHost: room.hostId === socketId, roomDeleted: true };
        }

        if (room.hostId === socketId) {
          room.hostId = room.players.keys().next().value;
          return { room, wasHost: true, newHostId: room.hostId, roomDeleted: false };
        }

        return { room, wasHost: false, roomDeleted: false };
      }
    }
    return null;
  }

  getRoomByPlayer(socketId) {
    for (const room of this.rooms.values()) {
      if (room.players.has(socketId)) return room;
    }
    return null;
  }

  getPlayerList(room) {
    return [...room.players.values()].map(p => ({
      id: p.id,
      playerId: p.playerId,
      name: p.name,
      avatarUrl: avatarUrl(p.name),
      isHost: p.id === room.hostId,
      score: room.scores.get(p.id) || 0,
    }));
  }

  deleteRoom(code) {
    const room = this.rooms.get(code);
    if (room?.roundTimer) clearTimeout(room.roundTimer);
    this.rooms.delete(code);
  }
}

module.exports = { RoomManager };
