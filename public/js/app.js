// ===== STATE =====
const state = {
  socket: null,
  roomCode: null,
  isHost: false,
  myId: null,
  selectedPlayerId: null,
  selectedPlayerName: null,
  guessMarker: null,
  guessMap: null,
  resultsMap: null,
  panorama: null,
  timerInterval: null,
  countdownInterval: null,
  googleMapsReady: false,
};

// ===== SCREENS =====
function showScreen(id) {
  // Clear countdowns on any screen transition
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

// ===== LOAD GOOGLE MAPS EAGERLY =====
function loadGoogleMaps() {
  if (document.getElementById('google-maps-script')) return;
  const script = document.createElement('script');
  script.id = 'google-maps-script';
  script.src = `https://maps.googleapis.com/maps/api/js?key=${window.GOOGLE_MAPS_API_KEY}&callback=onGoogleMapsLoaded`;
  script.async = true;
  document.head.appendChild(script);
}

window.onGoogleMapsLoaded = function () {
  state.googleMapsReady = true;
};

loadGoogleMaps();

// ===== AVATAR GRID =====
async function loadPlayerGrid() {
  const grid = document.getElementById('avatar-grid');
  try {
    const players = await fetch('/api/players').then(r => r.json());

    if (players.length === 0) {
      grid.innerHTML = '<p class="empty-grid-msg">No players yet. Ask an admin to add players at <a href="/admin">/admin</a></p>';
      return;
    }

    grid.innerHTML = players.map(p => `
      <div class="avatar-card" data-player-id="${p.id}" data-player-name="${escapeHtml(p.name)}">
        <img src="${p.avatarUrl}" class="avatar-img" alt="${escapeHtml(p.name)}" />
        <span class="avatar-name">${escapeHtml(p.name)}</span>
      </div>
    `).join('');

    grid.querySelectorAll('.avatar-card').forEach(card => {
      card.addEventListener('click', () => {
        const clickedId = parseInt(card.dataset.playerId);

        grid.querySelectorAll('.avatar-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.selectedPlayerId = clickedId;
        state.selectedPlayerName = card.dataset.playerName;

        document.getElementById('btn-create').disabled = false;
        document.getElementById('btn-join').disabled = false;
        document.querySelectorAll('.btn-join-room').forEach(b => b.disabled = false);

        // Load stats in side panel
        showPlayerStats(clickedId);
      });
    });
  } catch (e) {
    grid.innerHTML = '<p class="empty-grid-msg">Failed to load players</p>';
  }
}

loadPlayerGrid();

// ===== ACTIVE ROOMS =====
async function loadActiveRooms() {
  try {
    const rooms = await fetch('/api/rooms').then(r => r.json());
    const section = document.getElementById('active-rooms-section');
    const container = document.getElementById('active-rooms');

    if (rooms.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';
    container.innerHTML = rooms.map(room => {
      const stateLabel = room.state === 'lobby' ? 'In Lobby' :
        room.state === 'game_over' ? 'Game Over' :
        `Round ${room.currentRound}/${room.totalRounds}`;
      const avatars = room.players.slice(0, 6).map(p =>
        `<img src="${p.avatarUrl}" class="active-room-avatar" title="${escapeHtml(p.name)}" />`
      ).join('');
      const extra = room.playerCount > 6 ? `<span class="active-room-extra">+${room.playerCount - 6}</span>` : '';

      return `
        <div class="active-room-card">
          <div class="active-room-info">
            <div class="active-room-players">${avatars}${extra}</div>
            <span class="active-room-state">${stateLabel}</span>
          </div>
          <button class="btn btn-primary btn-small btn-join-room" data-code="${room.code}" ${!state.selectedPlayerId ? 'disabled' : ''}>Join</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-join-room').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!state.selectedPlayerId) return showError('Select your player first');
        if (!state.socket) initSocket();

        state.socket.emit('join_room', { code: btn.dataset.code, playerId: state.selectedPlayerId }, (res) => {
          if (res.error) return showError(res.error);
          state.roomCode = res.code;
          state.isHost = false;
          if (res.gameState) {
            enterLobby(res);
            handleMidGameJoin(res.gameState);
          } else {
            enterLobby(res);
          }
        });
      });
    });
  } catch (e) {
    // silently ignore
  }
}

loadActiveRooms();
// Refresh active rooms every 5 seconds while on landing page
setInterval(() => {
  const landing = document.getElementById('screen-landing');
  if (landing.classList.contains('active')) {
    loadActiveRooms();
  }
}, 5000);

// ===== SOCKET SETUP =====
function initSocket() {
  const socket = io();
  state.socket = socket;
  state.myId = null;

  socket.on('connect', () => {
    state.myId = socket.id;
  });

  socket.on('player_joined', ({ players }) => {
    renderLobbyPlayers(players);
  });

  socket.on('player_left', ({ players, newHostId }) => {
    if (newHostId === state.myId) {
      state.isHost = true;
    }
    renderLobbyPlayers(players);
    updateHostControls();
  });

  socket.on('round_searching', ({ round, totalRounds }) => {
    showScreen('game');
    document.getElementById('game-round').textContent = `Round ${round}/${totalRounds}`;
    document.getElementById('game-timer').textContent = '...';
    document.getElementById('game-guessed').textContent = 'Finding location...';
    document.getElementById('panorama').innerHTML = '<p style="color:#fff;text-align:center;padding-top:40%;">Searching for a Street View location...</p>';
  });

  socket.on('find_panorama', ({ candidates }) => {
    findValidPanorama(candidates);
  });

  socket.on('round_start_confirmed', (data) => {
    startGameRound(data);
  });

  socket.on('player_guessed', ({ totalGuesses, totalPlayers }) => {
    document.getElementById('game-guessed').textContent = `${totalGuesses}/${totalPlayers} guessed`;
  });

  socket.on('round_end', (data) => {
    showRoundResults(data);
  });

  socket.on('game_over', (data) => {
    showGameOver(data);
  });

  socket.on('back_to_lobby', ({ players }) => {
    // Go back to landing page (avatar selection) — game session is over
    showScreen('landing');
    // Refresh active rooms and player grid
    loadActiveRooms();
  });

  return socket;
}

// ===== PANORAMA SEARCH (host only) =====
function findValidPanorama(candidates) {
  if (!state.googleMapsReady) {
    setTimeout(() => findValidPanorama(candidates), 500);
    return;
  }

  const sv = new google.maps.StreetViewService();
  let index = 0;

  function tryNext() {
    if (index >= candidates.length) {
      console.warn('All candidates failed');
      return;
    }

    const candidate = candidates[index];
    index++;

    sv.getPanorama({
      location: { lat: candidate.lat, lng: candidate.lng },
      radius: 50000,
      preference: google.maps.StreetViewPreference.NEAREST,
      source: google.maps.StreetViewSource.OUTDOOR,
    }, (data, status) => {
      if (status === google.maps.StreetViewStatus.OK) {
        const actualLat = data.location.latLng.lat();
        const actualLng = data.location.latLng.lng();
        state.socket.emit('location_found', {
          lat: actualLat,
          lng: actualLng,
          panoId: data.location.pano,
        });
      } else {
        tryNext();
      }
    });
  }

  tryNext();
}

// ===== LANDING =====
document.getElementById('btn-create').addEventListener('click', () => {
  if (!state.selectedPlayerId) return showError('Select your player first');

  if (!state.socket) initSocket();

  state.socket.emit('create_room', { playerId: state.selectedPlayerId }, (res) => {
    if (res.error) return showError(res.error);
    state.roomCode = res.code;
    state.isHost = true;
    enterLobby(res);
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  if (!state.selectedPlayerId) return showError('Select your player first');
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) return showError('Enter a room code');

  if (!state.socket) initSocket();

  state.socket.emit('join_room', { code, playerId: state.selectedPlayerId }, (res) => {
    if (res.error) return showError(res.error);
    state.roomCode = res.code;
    state.isHost = false;

    if (res.gameState) {
      // Joined mid-game — show waiting screen until next round
      enterLobby(res);
      handleMidGameJoin(res.gameState);
    } else {
      enterLobby(res);
    }
  });
});

document.getElementById('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

function showError(msg) {
  const el = document.getElementById('landing-error');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 4000);
}

// ===== MID-GAME JOIN =====
function handleMidGameJoin(gameState) {
  if (gameState.state === 'playing' && gameState.panoId) {
    // Jump straight into the round with remaining time
    startGameRound({
      round: gameState.round,
      totalRounds: gameState.totalRounds,
      timeLimit: gameState.timeLimit,
      panoId: gameState.panoId,
    });
  } else {
    // Searching or between rounds — show lobby with waiting message
    document.getElementById('btn-start').style.display = 'none';
    document.getElementById('lobby-waiting').textContent = `Game in progress (Round ${gameState.round}/${gameState.totalRounds}). Waiting for next round...`;
    document.getElementById('lobby-waiting').style.display = '';
  }
}

// ===== LOBBY =====
function enterLobby(res) {
  document.getElementById('lobby-code').textContent = res.code;
  renderLobbyPlayers(res.players);
  updateHostControls();
  showScreen('lobby');
}

function renderLobbyPlayers(players) {
  const el = document.getElementById('lobby-players');
  el.innerHTML = players.map(p => `
    <div class="player-card ${p.isHost ? 'host' : ''}">
      <img src="${p.avatarUrl}" class="player-avatar" alt="${escapeHtml(p.name)}" />
      <span class="player-name">${escapeHtml(p.name)}</span>
      ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
    </div>
  `).join('');
}

function updateHostControls() {
  document.getElementById('btn-start').style.display = state.isHost ? '' : 'none';
  document.getElementById('lobby-waiting').style.display = state.isHost ? 'none' : '';
}

document.getElementById('btn-start').addEventListener('click', () => {
  state.socket.emit('start_game', null, (res) => {
    if (res?.error) alert(res.error);
  });
});

// ===== GAME ROUND =====
function startGameRound({ round, totalRounds, timeLimit, panoId }) {
  showScreen('game');
  document.getElementById('game-round').textContent = `Round ${round}/${totalRounds}`;
  document.getElementById('game-guessed').textContent = `0/? guessed`;

  state.guessMarker = null;
  const submitBtn = document.getElementById('btn-submit-guess');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Place your guess on the map';
  submitBtn.classList.remove('submitted');

  let timeLeft = timeLimit;
  const timerEl = document.getElementById('game-timer');
  timerEl.textContent = timeLeft;
  timerEl.classList.remove('urgent');
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    timeLeft--;
    timerEl.textContent = timeLeft;
    if (timeLeft <= 10) timerEl.classList.add('urgent');
    if (timeLeft <= 0) clearInterval(state.timerInterval);
  }, 1000);

  showPanorama(panoId);
  initGuessMap();
}

function showPanorama(panoId) {
  const container = document.getElementById('panorama');
  container.innerHTML = '';

  state.panorama = new google.maps.StreetViewPanorama(container, {
    pano: panoId,
    pov: { heading: Math.random() * 360, pitch: 0 },
    zoom: 1,
    disableDefaultUI: true,
    showRoadLabels: false,
    linksControl: false,
    panControl: true,
    zoomControl: true,
    addressControl: false,
    fullscreenControl: false,
    motionTracking: false,
    motionTrackingControl: false,
    clickToGo: false,
  });
}

function initGuessMap() {
  const mapContainer = document.getElementById('map');

  if (state.guessMap) {
    state.guessMap.remove();
  }

  state.guessMap = L.map('map', {
    center: [20, 0],
    zoom: 2,
    minZoom: 2,
    worldCopyJump: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(state.guessMap);

  let submitted = false;

  state.guessMap.on('click', (e) => {
    if (submitted) return;

    if (state.guessMarker) {
      state.guessMarker.setLatLng(e.latlng);
    } else {
      state.guessMarker = L.marker(e.latlng, { draggable: true }).addTo(state.guessMap);
    }

    const btn = document.getElementById('btn-submit-guess');
    btn.disabled = false;
    btn.textContent = 'Submit Guess';
  });

  document.getElementById('btn-submit-guess').onclick = () => {
    if (!state.guessMarker || submitted) return;
    submitted = true;

    const pos = state.guessMarker.getLatLng();
    state.socket.emit('submit_guess', { lat: pos.lat, lng: pos.lng });

    const btn = document.getElementById('btn-submit-guess');
    btn.textContent = 'Guess submitted!';
    btn.classList.add('submitted');
    btn.disabled = true;

    state.guessMarker.dragging.disable();
  };
}

// ===== ROUND RESULTS =====
function showRoundResults({ round, totalRounds, actual, results, isLastRound }) {
  if (state.timerInterval) clearInterval(state.timerInterval);
  showScreen('results');

  document.getElementById('results-title').textContent = `Round ${round}/${totalRounds} Results`;
  document.getElementById('results-country').textContent = '';

  const mapContainer = document.getElementById('results-map');
  mapContainer.innerHTML = '';
  const mapDiv = document.createElement('div');
  mapDiv.style.width = '100%';
  mapDiv.style.height = '100%';
  mapContainer.appendChild(mapDiv);

  const rMap = L.map(mapDiv, { worldCopyJump: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19,
  }).addTo(rMap);

  const actualIcon = L.divIcon({ className: 'marker-actual', html: '<div class="marker-dot actual"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  L.marker([actual.lat, actual.lng], { icon: actualIcon }).addTo(rMap)
    .bindPopup('Actual location');

  const bounds = L.latLngBounds([[actual.lat, actual.lng]]);

  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#e84393',
    '#00cec9', '#6c5ce7', '#fd79a8', '#ffeaa7', '#dfe6e9', '#636e72', '#d63031', '#0984e3',
    '#00b894', '#fdcb6e', '#b2bec3', '#2d3436', '#ff7675', '#74b9ff', '#55efc4', '#fab1a0'];

  results.forEach((r, i) => {
    if (!r.guess) return;
    const color = colors[i % colors.length];
    const icon = L.divIcon({
      className: 'marker-guess',
      html: `<div class="marker-dot guess" style="background:${color}"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    L.marker([r.guess.lat, r.guess.lng], { icon }).addTo(rMap)
      .bindPopup(`${escapeHtml(r.name)}: ${r.distance} km (${r.points} pts)`);
    L.polyline([[actual.lat, actual.lng], [r.guess.lat, r.guess.lng]], {
      color, weight: 2, opacity: 0.6, dashArray: '5,5',
    }).addTo(rMap);
    bounds.extend([r.guess.lat, r.guess.lng]);
  });

  setTimeout(() => {
    rMap.invalidateSize();
    rMap.fitBounds(bounds, { padding: [40, 40] });
  }, 100);

  const table = document.getElementById('results-table');
  table.innerHTML = `
    <div class="results-header">
      <span class="rh-rank">#</span>
      <span class="rh-name">Player</span>
      <span class="rh-dist">Distance</span>
      <span class="rh-pts">Points</span>
      <span class="rh-total">Total</span>
    </div>
    ${results.map((r, i) => `
      <div class="results-row ${r.id === state.myId ? 'is-me' : ''}">
        <span class="rr-rank">${i + 1}</span>
        <span class="rr-name">
          <img src="${r.avatarUrl}" class="player-avatar-sm" alt="" />
          ${escapeHtml(r.name)}
        </span>
        <span class="rr-dist">${r.distance !== null ? r.distance + ' km' : 'No guess'}</span>
        <span class="rr-pts">+${r.points}</span>
        <span class="rr-total">${r.totalScore}</span>
      </div>
    `).join('')}
  `;

  // Auto-continue countdown
  const btn = document.getElementById('btn-next-round');
  document.getElementById('results-waiting').style.display = 'none';

  if (state.countdownInterval) clearInterval(state.countdownInterval);

  let countdown = 15;
  const label = isLastRound ? 'Final Results' : 'Next Round';
  btn.style.display = '';
  btn.textContent = `${label} in ${countdown}...`;

  state.countdownInterval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
      if (state.isHost) {
        state.socket.emit('next_round');
      }
    } else {
      btn.textContent = `${label} in ${countdown}...`;
    }
  }, 1000);

  // Allow host to skip the countdown
  btn.onclick = () => {
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
    }
    if (state.isHost) {
      state.socket.emit('next_round');
    }
  };
}

// ===== GAME OVER =====
function showGameOver({ standings }) {
  showScreen('gameover');

  const podium = document.getElementById('gameover-podium');
  const top3 = standings.slice(0, 3);
  const podiumOrder = [1, 0, 2];
  podium.innerHTML = podiumOrder.map(idx => {
    const p = top3[idx];
    if (!p) return '<div class="podium-slot empty"></div>';
    const heights = ['160px', '120px', '90px'];
    const labels = ['1st', '2nd', '3rd'];
    const medals = ['gold', 'silver', 'bronze'];
    return `
      <div class="podium-slot">
        <img src="${p.avatarUrl}" class="podium-avatar" alt="${escapeHtml(p.name)}" />
        <div class="podium-name">${escapeHtml(p.name)}</div>
        <div class="podium-score">${p.totalScore} pts</div>
        <div class="podium-bar ${medals[idx]}" style="height:${heights[idx]}">
          <span>${labels[idx]}</span>
        </div>
      </div>
    `;
  }).join('');

  const el = document.getElementById('gameover-standings');
  el.innerHTML = standings.map((s, i) => `
    <div class="standing-row ${s.id === state.myId ? 'is-me' : ''}">
      <span class="sr-rank">${i + 1}</span>
      <img src="${s.avatarUrl}" class="player-avatar-sm" alt="" />
      <span class="sr-name">${escapeHtml(s.name)}</span>
      <span class="sr-score">${s.totalScore} pts</span>
    </div>
  `).join('');

  // Auto-countdown back to lobby
  const lobbyBtn = document.getElementById('btn-back-lobby');
  document.getElementById('gameover-waiting').style.display = 'none';

  if (state.countdownInterval) clearInterval(state.countdownInterval);

  let countdown = 15;
  lobbyBtn.style.display = '';
  lobbyBtn.textContent = `Back to Lobby in ${countdown}...`;

  state.countdownInterval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
      if (state.isHost) {
        state.socket.emit('back_to_lobby');
      }
    } else {
      lobbyBtn.textContent = `Back to Lobby in ${countdown}...`;
    }
  }, 1000);

  lobbyBtn.onclick = () => {
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = null;
    }
    if (state.isHost) {
      state.socket.emit('back_to_lobby');
    }
  };
}

// ===== LEADERBOARD =====
document.getElementById('btn-leaderboard').addEventListener('click', () => {
  showLeaderboard();
});

document.getElementById('btn-leaderboard-back').addEventListener('click', () => {
  showScreen('landing');
});

async function showLeaderboard() {
  showScreen('leaderboard');
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '<p style="text-align:center;color:#888;">Loading...</p>';

  try {
    const data = await fetch('/api/leaderboard').then(r => r.json());

    if (data.length === 0 || data.every(d => d.gamesPlayed === 0)) {
      list.innerHTML = '<p style="text-align:center;color:#888;">No games played yet!</p>';
      return;
    }

    list.innerHTML = `
      <div class="lb-header">
        <span class="lb-rank">#</span>
        <span class="lb-name">Player</span>
        <span class="lb-games">Games</span>
        <span class="lb-score">Total Score</span>
      </div>
      ${data.map((d, i) => `
        <div class="lb-row ${i < 3 && d.gamesPlayed > 0 ? 'lb-top' + (i + 1) : ''}">
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-name">
            <img src="${d.avatarUrl}" class="player-avatar-sm" alt="" />
            ${escapeHtml(d.name)}
          </span>
          <span class="lb-games">${d.gamesPlayed}</span>
          <span class="lb-score">${d.totalScore}</span>
        </div>
      `).join('')}
    `;
  } catch (e) {
    list.innerHTML = '<p style="text-align:center;color:#888;">Failed to load leaderboard</p>';
  }
}

// ===== PLAYER STATS (inline panel) =====
async function showPlayerStats(playerId) {
  const panel = document.getElementById('stats-panel');
  const header = document.getElementById('stats-header');
  const cards = document.getElementById('stats-cards');
  panel.style.display = '';
  header.innerHTML = '<p style="text-align:center;color:#888;">Loading...</p>';
  cards.innerHTML = '';

  try {
    const stats = await fetch(`/api/players/${playerId}/stats`).then(r => r.json());
    if (stats.error) {
      header.innerHTML = `<p style="color:#e74c3c;">${stats.error}</p>`;
      return;
    }

    header.innerHTML = `
      <img src="${stats.player.avatarUrl}" class="stats-avatar" alt="" />
      <h2 class="stats-name">${escapeHtml(stats.player.name)}</h2>
    `;

    if (stats.gamesPlayed === 0) {
      cards.innerHTML = '<p class="stats-empty">No games played yet. Go play some rounds!</p>';
      return;
    }

    const statItems = [
      {
        icon: '🏆',
        label: 'Win Rate',
        value: `${stats.wins} / ${stats.gamesPlayed} games`,
        detail: stats.gamesPlayed > 0 ? `${Math.round(stats.wins / stats.gamesPlayed * 100)}% win rate` : '',
      },
      {
        icon: '🎯',
        label: 'Best Guess Ever',
        value: stats.bestGuess !== null ? `${stats.bestGuess} km` : 'N/A',
        detail: stats.bestGuess !== null && stats.bestGuess < 50 ? 'Almost smelled the place!' :
                stats.bestGuess !== null && stats.bestGuess < 500 ? 'Pretty sharp!' : '',
      },
      {
        icon: '💀',
        label: 'Worst Guess Ever',
        value: stats.worstGuess !== null ? `${stats.worstGuess.toLocaleString()} km` : 'N/A',
        detail: stats.worstGuess !== null && stats.worstGuess > 15000 ? 'Wrong side of the planet!' :
                stats.worstGuess !== null && stats.worstGuess > 5000 ? 'Completely lost!' : '',
      },
      {
        icon: '🧭',
        label: 'Favorite Wrong Continent',
        value: stats.favoriteWrongContinent || 'None yet',
        detail: stats.favoriteWrongContinent ? `Guessed there ${stats.favoriteWrongContinentCount} times when wrong` : 'Gets every continent right!',
      },
      {
        icon: '🍀',
        label: 'Lucky Country',
        value: stats.luckyCountry || 'Need more games',
        detail: stats.luckyCountry ? `Avg ${stats.luckyCountryAvgScore} pts there` : 'Play more rounds to unlock!',
      },
      {
        icon: '😈',
        label: 'Cursed Country',
        value: stats.cursedCountry || 'Need more games',
        detail: stats.cursedCountry ? `Only ${stats.cursedCountryAvgScore} pts avg... yikes` : 'Play more rounds to unlock!',
      },
    ];

    cards.innerHTML = statItems.map(s => `
      <div class="stat-card">
        <span class="stat-icon">${s.icon}</span>
        <div class="stat-content">
          <div class="stat-label">${s.label}</div>
          <div class="stat-value">${s.value}</div>
          ${s.detail ? `<div class="stat-detail">${s.detail}</div>` : ''}
        </div>
      </div>
    `).join('');
  } catch (e) {
    header.innerHTML = '<p style="color:#e74c3c;">Failed to load stats</p>';
  }
}

// ===== HELPERS =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
