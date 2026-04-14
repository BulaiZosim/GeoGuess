// ===== STATE =====
const state = {
  socket: null,
  roomCode: null,
  isHost: false,
  myId: null,
  guessMarker: null,
  guessMap: null,
  resultsMap: null,
  panorama: null,
  timerInterval: null,
  googleMapsReady: false,
};

// ===== SCREENS =====
function showScreen(id) {
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
  console.log('Google Maps API loaded');
};

// Load immediately so it's ready when the game starts
loadGoogleMaps();

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

  // Server is searching for a location — show loading screen
  socket.on('round_searching', ({ round, totalRounds }) => {
    showScreen('game');
    document.getElementById('game-round').textContent = `Round ${round}/${totalRounds}`;
    document.getElementById('game-timer').textContent = '...';
    document.getElementById('game-guessed').textContent = 'Finding location...';
    document.getElementById('panorama').innerHTML = '<p style="color:#fff;text-align:center;padding-top:40%;">Searching for a Street View location...</p>';
  });

  // Host only: server sends candidate points to try
  socket.on('find_panorama', ({ candidates }) => {
    findValidPanorama(candidates);
  });

  // All players: confirmed panorama found, start playing
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
    showScreen('lobby');
    renderLobbyPlayers(players);
    updateHostControls();
  });

  return socket;
}

// ===== PANORAMA SEARCH (host only) =====
function findValidPanorama(candidates) {
  if (!state.googleMapsReady) {
    // Wait for Google Maps to load, then retry
    setTimeout(() => findValidPanorama(candidates), 500);
    return;
  }

  const sv = new google.maps.StreetViewService();
  let index = 0;

  function tryNext() {
    if (index >= candidates.length) {
      // All candidates failed — ask server for more (shouldn't happen often)
      console.warn('All candidates failed, this should be rare');
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
        // Found one! Tell the server the actual panorama location
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
  const name = document.getElementById('input-name').value.trim();
  if (!name) return showError('Enter a display name');

  if (!state.socket) initSocket();

  state.socket.emit('create_room', { playerName: name }, (res) => {
    if (res.error) return showError(res.error);
    state.roomCode = res.code;
    state.isHost = true;
    enterLobby(res);
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!name) return showError('Enter a display name');
  if (!code) return showError('Enter a room code');

  if (!state.socket) initSocket();

  state.socket.emit('join_room', { code, playerName: name }, (res) => {
    if (res.error) return showError(res.error);
    state.roomCode = res.code;
    state.isHost = false;
    enterLobby(res);
  });
});

// Allow Enter key
document.getElementById('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});
document.getElementById('input-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const code = document.getElementById('input-code').value.trim();
    if (code) {
      document.getElementById('btn-join').click();
    } else {
      document.getElementById('btn-create').click();
    }
  }
});

function showError(msg) {
  const el = document.getElementById('landing-error');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 4000);
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

  // Reset guess state
  state.guessMarker = null;
  const submitBtn = document.getElementById('btn-submit-guess');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Place your guess on the map';
  submitBtn.classList.remove('submitted');

  // Timer
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

  // Show the panorama using the confirmed panoId
  showPanorama(panoId);

  // Initialize guess map
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
  document.getElementById('results-country').textContent = ``;

  // Results map
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

  // Actual location marker (green)
  const actualIcon = L.divIcon({ className: 'marker-actual', html: '<div class="marker-dot actual"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  L.marker([actual.lat, actual.lng], { icon: actualIcon }).addTo(rMap)
    .bindPopup('Actual location');

  const bounds = L.latLngBounds([[actual.lat, actual.lng]]);

  // Player guess markers + lines
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

  // Results table
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
        <span class="rr-name">${escapeHtml(r.name)}</span>
        <span class="rr-dist">${r.distance !== null ? r.distance + ' km' : 'No guess'}</span>
        <span class="rr-pts">+${r.points}</span>
        <span class="rr-total">${r.totalScore}</span>
      </div>
    `).join('')}
  `;

  // Host controls
  if (state.isHost) {
    const btn = document.getElementById('btn-next-round');
    btn.style.display = '';
    btn.textContent = isLastRound ? 'Show Final Results' : 'Next Round';
    document.getElementById('results-waiting').style.display = 'none';
  } else {
    document.getElementById('btn-next-round').style.display = 'none';
    document.getElementById('results-waiting').style.display = '';
  }
}

document.getElementById('btn-next-round').addEventListener('click', () => {
  state.socket.emit('next_round');
});

// ===== GAME OVER =====
function showGameOver({ standings }) {
  showScreen('gameover');

  // Podium (top 3)
  const podium = document.getElementById('gameover-podium');
  const top3 = standings.slice(0, 3);
  const podiumOrder = [1, 0, 2]; // silver, gold, bronze visual order
  podium.innerHTML = podiumOrder.map(idx => {
    const p = top3[idx];
    if (!p) return '<div class="podium-slot empty"></div>';
    const heights = ['160px', '120px', '90px'];
    const labels = ['1st', '2nd', '3rd'];
    const medals = ['gold', 'silver', 'bronze'];
    return `
      <div class="podium-slot">
        <div class="podium-name">${escapeHtml(p.name)}</div>
        <div class="podium-score">${p.totalScore} pts</div>
        <div class="podium-bar ${medals[idx]}" style="height:${heights[idx]}">
          <span>${labels[idx]}</span>
        </div>
      </div>
    `;
  }).join('');

  // Full standings
  const el = document.getElementById('gameover-standings');
  el.innerHTML = standings.map((s, i) => `
    <div class="standing-row ${s.id === state.myId ? 'is-me' : ''}">
      <span class="sr-rank">${i + 1}</span>
      <span class="sr-name">${escapeHtml(s.name)}</span>
      <span class="sr-score">${s.totalScore} pts</span>
    </div>
  `).join('');

  // Host controls
  if (state.isHost) {
    document.getElementById('btn-back-lobby').style.display = '';
    document.getElementById('gameover-waiting').style.display = 'none';
  } else {
    document.getElementById('btn-back-lobby').style.display = 'none';
    document.getElementById('gameover-waiting').style.display = '';
  }
}

document.getElementById('btn-back-lobby').addEventListener('click', () => {
  state.socket.emit('back_to_lobby');
});

// ===== HELPERS =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
