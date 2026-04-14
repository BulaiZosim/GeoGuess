const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'geoguess.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code TEXT NOT NULL,
    rounds INTEGER NOT NULL,
    played_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    score INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_game_scores_player ON game_scores(player_id);
  CREATE INDEX IF NOT EXISTS idx_game_scores_game ON game_scores(game_id);
`);

function avatarUrl(name) {
  return `https://api.dicebear.com/9.x/adventurer/svg?seed=${encodeURIComponent(name)}`;
}

function getAllPlayers() {
  const rows = db.prepare('SELECT id, name, created_at FROM players ORDER BY name').all();
  return rows.map(r => ({ ...r, avatarUrl: avatarUrl(r.name) }));
}

function getPlayerById(id) {
  const row = db.prepare('SELECT id, name, created_at FROM players WHERE id = ?').get(id);
  if (row) row.avatarUrl = avatarUrl(row.name);
  return row || null;
}

function addPlayer(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { error: 'Name is required' };
  if (trimmed.length > 20) return { error: 'Name too long (max 20 chars)' };

  try {
    const result = db.prepare('INSERT INTO players (name) VALUES (?)').run(trimmed);
    return { player: { id: result.lastInsertRowid, name: trimmed, avatarUrl: avatarUrl(trimmed) } };
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { error: 'Name already exists' };
    }
    throw e;
  }
}

function removePlayer(id) {
  const result = db.prepare('DELETE FROM players WHERE id = ?').run(id);
  return result.changes > 0;
}

const saveGameResultStmt = db.prepare('INSERT INTO games (room_code, rounds) VALUES (?, ?)');
const saveScoreStmt = db.prepare('INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, ?)');

const saveGameResult = db.transaction((roomCode, rounds, playerScores) => {
  const gameResult = saveGameResultStmt.run(roomCode, rounds);
  const gameId = gameResult.lastInsertRowid;

  for (const { playerId, score } of playerScores) {
    saveScoreStmt.run(gameId, playerId, score);
  }

  return gameId;
});

function getLeaderboard() {
  return db.prepare(`
    SELECT
      p.id AS playerId,
      p.name,
      COALESCE(SUM(gs.score), 0) AS totalScore,
      COUNT(DISTINCT gs.game_id) AS gamesPlayed
    FROM players p
    LEFT JOIN game_scores gs ON gs.player_id = p.id
    GROUP BY p.id
    ORDER BY totalScore DESC
  `).all().map(r => ({ ...r, avatarUrl: avatarUrl(r.name) }));
}

function resetAllScores() {
  db.exec('DELETE FROM game_scores');
  db.exec('DELETE FROM games');
}

module.exports = {
  getAllPlayers,
  getPlayerById,
  addPlayer,
  removePlayer,
  saveGameResult,
  getLeaderboard,
  resetAllScores,
  avatarUrl,
};
