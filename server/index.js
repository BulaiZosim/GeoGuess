require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./rooms');
const { handleSocket } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Inject API key into client
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.GOOGLE_MAPS_API_KEY = "${process.env.GOOGLE_MAPS_API_KEY || ''}";`);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new RoomManager();

io.on('connection', (socket) => {
  handleSocket(io, socket, rooms);
});

server.listen(PORT, () => {
  console.log(`GeoGuess server running on http://localhost:${PORT}`);
});
