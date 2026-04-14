const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getContinent } = require('./geo');

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

  CREATE TABLE IF NOT EXISTS round_guesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    round_num INTEGER NOT NULL,
    guess_lat REAL,
    guess_lng REAL,
    actual_lat REAL NOT NULL,
    actual_lng REAL NOT NULL,
    actual_country TEXT,
    distance_km INTEGER,
    score INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_game_scores_player ON game_scores(player_id);
  CREATE INDEX IF NOT EXISTS idx_game_scores_game ON game_scores(game_id);
  CREATE INDEX IF NOT EXISTS idx_round_guesses_player ON round_guesses(player_id);
  CREATE INDEX IF NOT EXISTS idx_round_guesses_game ON round_guesses(game_id);
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

// ===== GAME SAVING =====
const saveGameStmt = db.prepare('INSERT INTO games (room_code, rounds) VALUES (?, ?)');
const saveScoreStmt = db.prepare('INSERT INTO game_scores (game_id, player_id, score) VALUES (?, ?, ?)');
const saveRoundGuessStmt = db.prepare(`
  INSERT INTO round_guesses (game_id, player_id, round_num, guess_lat, guess_lng, actual_lat, actual_lng, actual_country, distance_km, score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const saveFullGameResult = db.transaction((roomCode, rounds, playerScores, roundData) => {
  const gameResult = saveGameStmt.run(roomCode, rounds);
  const gameId = gameResult.lastInsertRowid;

  for (const { playerId, score } of playerScores) {
    saveScoreStmt.run(gameId, playerId, score);
  }

  for (const rd of roundData) {
    saveRoundGuessStmt.run(
      gameId, rd.playerId, rd.roundNum,
      rd.guessLat, rd.guessLng,
      rd.actualLat, rd.actualLng, rd.actualCountry,
      rd.distanceKm, rd.score
    );
  }

  return gameId;
});

// ===== LEADERBOARD =====
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

// ===== PLAYER STATS =====
function getPlayerStats(playerId) {
  const player = getPlayerById(playerId);
  if (!player) return null;

  // Games played
  const gamesPlayed = db.prepare(
    'SELECT COUNT(DISTINCT game_id) AS count FROM game_scores WHERE player_id = ?'
  ).get(playerId).count;

  if (gamesPlayed === 0) {
    return {
      player,
      gamesPlayed: 0,
      wins: 0,
      bestGuess: null,
      worstGuess: null,
      favoriteWrongContinent: null,
      luckyCountry: null,
      cursedCountry: null,
    };
  }

  // Win rate — games where this player had the highest score
  const wins = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT game_id, MAX(score) AS max_score
      FROM game_scores
      GROUP BY game_id
    ) AS winners
    JOIN game_scores gs ON gs.game_id = winners.game_id AND gs.score = winners.max_score
    WHERE gs.player_id = ?
  `).get(playerId).count;

  // Best guess ever (smallest distance)
  const bestGuess = db.prepare(
    'SELECT MIN(distance_km) AS distance FROM round_guesses WHERE player_id = ? AND distance_km IS NOT NULL'
  ).get(playerId);

  // Worst guess ever (largest distance)
  const worstGuess = db.prepare(
    'SELECT MAX(distance_km) AS distance FROM round_guesses WHERE player_id = ? AND distance_km IS NOT NULL'
  ).get(playerId);

  // Favorite wrong continent
  // Get all guesses where guess continent != actual continent
  const allGuesses = db.prepare(
    'SELECT guess_lat, guess_lng, actual_lat, actual_lng FROM round_guesses WHERE player_id = ? AND guess_lat IS NOT NULL'
  ).all(playerId);

  const wrongContinentCounts = {};
  for (const g of allGuesses) {
    const guessContinent = getContinent(g.guess_lat, g.guess_lng);
    const actualContinent = getContinent(g.actual_lat, g.actual_lng);
    if (guessContinent !== actualContinent) {
      wrongContinentCounts[guessContinent] = (wrongContinentCounts[guessContinent] || 0) + 1;
    }
  }
  let favoriteWrongContinent = null;
  let maxWrongCount = 0;
  for (const [continent, count] of Object.entries(wrongContinentCounts)) {
    if (count > maxWrongCount) {
      maxWrongCount = count;
      favoriteWrongContinent = continent;
    }
  }

  // Lucky country — highest avg score per actual country (min 2 rounds in that country)
  const luckyCountry = db.prepare(`
    SELECT actual_country AS country, AVG(score) AS avgScore, COUNT(*) AS rounds
    FROM round_guesses
    WHERE player_id = ? AND actual_country IS NOT NULL AND guess_lat IS NOT NULL
    GROUP BY actual_country
    HAVING rounds >= 2
    ORDER BY avgScore DESC
    LIMIT 1
  `).get(playerId);

  // Cursed country — lowest avg score per actual country (min 2 rounds)
  const cursedCountry = db.prepare(`
    SELECT actual_country AS country, AVG(score) AS avgScore, COUNT(*) AS rounds
    FROM round_guesses
    WHERE player_id = ? AND actual_country IS NOT NULL AND guess_lat IS NOT NULL
    GROUP BY actual_country
    HAVING rounds >= 2
    ORDER BY avgScore ASC
    LIMIT 1
  `).get(playerId);

  return {
    player,
    gamesPlayed,
    wins,
    bestGuess: bestGuess?.distance ?? null,
    worstGuess: worstGuess?.distance ?? null,
    favoriteWrongContinent,
    favoriteWrongContinentCount: maxWrongCount,
    luckyCountry: luckyCountry?.country ?? null,
    luckyCountryAvgScore: luckyCountry ? Math.round(luckyCountry.avgScore) : null,
    cursedCountry: cursedCountry?.country ?? null,
    cursedCountryAvgScore: cursedCountry ? Math.round(cursedCountry.avgScore) : null,
  };
}

function resetAllScores() {
  db.exec('DELETE FROM round_guesses');
  db.exec('DELETE FROM game_scores');
  db.exec('DELETE FROM games');
}

module.exports = {
  getAllPlayers,
  getPlayerById,
  addPlayer,
  removePlayer,
  saveFullGameResult,
  getLeaderboard,
  getPlayerStats,
  resetAllScores,
  avatarUrl,
};
