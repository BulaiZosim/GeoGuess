require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./rooms');
const { handleSocket } = require('./game');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Inject API key into client
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.GOOGLE_MAPS_API_KEY = "${process.env.GOOGLE_MAPS_API_KEY || ''}";`);
});

// ===== REST API =====

// Players
app.get('/api/players', (req, res) => {
  res.json(db.getAllPlayers());
});

app.post('/api/players', (req, res) => {
  const result = db.addPlayer(req.body.name);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result.player);
});

app.delete('/api/players/:id', (req, res) => {
  const removed = db.removePlayer(parseInt(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Player not found' });
  res.json({ ok: true });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  res.json(db.getLeaderboard());
});

// Player stats
app.get('/api/players/:id/stats', (req, res) => {
  const stats = db.getPlayerStats(parseInt(req.params.id));
  if (!stats) return res.status(404).json({ error: 'Player not found' });
  res.json(stats);
});

// Active rooms
app.get('/api/rooms', (req, res) => {
  res.json(rooms.getActiveRooms());
});

// Reset all scores
app.post('/api/reset-scores', (req, res) => {
  db.resetAllScores();
  res.json({ ok: true });
});

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Explicit route for /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

const rooms = new RoomManager();

io.on('connection', (socket) => {
  handleSocket(io, socket, rooms, db);
});

server.listen(PORT, () => {
  console.log(`GeoGuess server running on http://localhost:${PORT}`);
});
