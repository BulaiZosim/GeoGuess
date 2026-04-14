const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
const CODE_LENGTH = 6;
const MAX_PLAYERS = 24;

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

  createRoom(hostId, hostName) {
    const code = this.generateCode();
    const room = {
      code,
      hostId,
      players: new Map(),
      state: 'lobby', // lobby | playing | round_results | game_over
      currentRound: 0,
      totalRounds: 3,
      roundTime: 90, // seconds
      usedLocations: [],
      currentLocation: null,
      guesses: new Map(),
      scores: new Map(),
      roundTimer: null,
    };
    room.players.set(hostId, { id: hostId, name: hostName, connected: true });
    room.scores.set(hostId, 0);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code?.toUpperCase());
  }

  joinRoom(code, playerId, playerName) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room not found' };
    if (room.state !== 'lobby') return { error: 'Game already in progress' };
    if (room.players.size >= MAX_PLAYERS) return { error: 'Room is full (max 24 players)' };

    const existingNames = [...room.players.values()].map(p => p.name.toLowerCase());
    if (existingNames.includes(playerName.toLowerCase())) {
      return { error: 'Name already taken in this room' };
    }

    room.players.set(playerId, { id: playerId, name: playerName, connected: true });
    room.scores.set(playerId, 0);
    return { room };
  }

  removePlayer(playerId) {
    for (const [code, room] of this.rooms) {
      if (room.players.has(playerId)) {
        room.players.delete(playerId);
        room.scores.delete(playerId);
        room.guesses.delete(playerId);

        // If room is empty, clean up
        if (room.players.size === 0) {
          if (room.roundTimer) clearTimeout(room.roundTimer);
          this.rooms.delete(code);
          return { room, wasHost: room.hostId === playerId, roomDeleted: true };
        }

        // If host left, assign new host
        if (room.hostId === playerId) {
          room.hostId = room.players.keys().next().value;
          return { room, wasHost: true, newHostId: room.hostId, roomDeleted: false };
        }

        return { room, wasHost: false, roomDeleted: false };
      }
    }
    return null;
  }

  getRoomByPlayer(playerId) {
    for (const room of this.rooms.values()) {
      if (room.players.has(playerId)) return room;
    }
    return null;
  }

  getPlayerList(room) {
    return [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
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
