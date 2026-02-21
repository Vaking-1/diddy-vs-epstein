const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir les fichiers statiques (index.html)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ======= LOGIQUE MULTIJOUEUR =======
const rooms = {};

wss.on('connection', (ws) => {
  const playerId = uuidv4();
  let roomId = null;

  console.log(`[+] Joueur connecté: ${playerId.substring(0, 8)}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // --- CRÉER UN SERVEUR ---
    if (msg.type === 'CREATE_SERVER') {
      const id = Math.random().toString(36).substring(2, 8).toUpperCase();
      rooms[id] = {
        id,
        map: msg.map ?? 0,
        time: msg.time ?? 180,
        players: {},
        ball: { x: 0, y: 0, vx: 0, vy: 0 },
        scoreA: 0,
        scoreB: 0,
        hostId: playerId,
        started: false
      };
      rooms[id].players[playerId] = {
        id: playerId, ws, name: msg.name ?? 'Joueur', ready: false
      };
      roomId = id;
      send(ws, { type: 'SERVER_CREATED', serverId: id, playerId: playerId });
      console.log(`[ROOM] Créée: ${id} par ${msg.name}`);
    }

    // --- REJOINDRE ---
    if (msg.type === 'JOIN_SERVER') {
      const room = rooms[msg.serverId];
      if (!room) {
        send(ws, { type: 'ERROR', msg: 'Serveur introuvable' });
        return;
      }
      if (Object.keys(room.players).length >= 4) {
        send(ws, { type: 'ERROR', msg: 'Serveur plein (4/4)' });
        return;
      }
      if (room.started) {
        send(ws, { type: 'ERROR', msg: 'Partie déjà en cours' });
        return;
      }
      room.players[playerId] = {
        id: playerId, ws, name: msg.name ?? 'Joueur', ready: false
      };
      roomId = msg.serverId;
      send(ws, {
        type: 'JOINED',
        serverId: roomId,
        map: room.map,
        time: room.time,
        isHost: false,
        playerId: playerId
      });
      broadcast(room, {
        type: 'ROOM_UPDATE',
        players: getPlayerList(room),
        map: room.map,
        time: room.time
      });
      console.log(`[ROOM] ${msg.name} a rejoint ${roomId}`);
    }

    // --- LANCER LA PARTIE (hôte) ---
    if (msg.type === 'LAUNCH') {
      const room = rooms[roomId];
      if (!room || room.hostId !== playerId) return;
      room.started = true;
      // Assigner les équipes automatiquement (alternance 0,1,0,1...)
      const playerIds = Object.keys(room.players);
      playerIds.forEach((pid, i) => {
        room.players[pid].team = i % 2; // 0=A, 1=B
      });
      const playerList = playerIds.map(pid => ({
        id: pid,
        name: room.players[pid].name,
        team: room.players[pid].team
      }));
      broadcast(room, { type: 'GAME_START', map: room.map, time: room.time, players: playerList });
      console.log(`[ROOM] Partie lancée: ${roomId} avec ${playerIds.length} joueurs`);
    }

    // --- CONFIG MAP/TEMPS (hôte) ---
    if (msg.type === 'HOST_CONFIG') {
      const room = rooms[roomId];
      if (!room || room.hostId !== playerId) return;
      if (msg.map !== undefined) room.map = msg.map;
      if (msg.time !== undefined) room.time = msg.time;
      broadcast(room, {
        type: 'ROOM_UPDATE',
        players: getPlayerList(room),
        map: room.map,
        time: room.time
      });
    }

    // --- POSITION JOUEUR ---
    if (msg.type === 'PLAYER_UPDATE') {
      const room = rooms[roomId];
      if (!room) return;
      broadcastExcept(room, playerId, {
        type: 'PLAYER_UPDATE',
        id: playerId,
        x: msg.x, y: msg.y,
        angle: msg.angle,
        vx: msg.vx, vy: msg.vy,
        c1: msg.c1, c2: msg.c2,
        model: msg.model ?? 0,
        decal: msg.decal ?? 0,
        wheelStyle: msg.wheelStyle ?? 0,
        team: msg.team ?? 0,
        name: msg.name ?? 'Joueur'
      });
    }

    // --- BALLON (hôte uniquement) ---
    if (msg.type === 'BALL_UPDATE') {
      const room = rooms[roomId];
      if (!room || room.hostId !== playerId) return;
      room.ball = msg.ball;
      broadcastExcept(room, playerId, {
        type: 'BALL_UPDATE',
        ball: msg.ball
      });
    }

    // --- BUT (hôte uniquement) ---
    if (msg.type === 'GOAL') {
      const room = rooms[roomId];
      if (!room || room.hostId !== playerId) return;
      if (msg.team === 0) room.scoreA++; else room.scoreB++;
      broadcast(room, {
        type: 'GOAL',
        team: msg.team,
        scoreA: room.scoreA,
        scoreB: room.scoreB
      });
    }

    // --- FIN DE PARTIE (hôte) ---
    if (msg.type === 'GAME_OVER') {
      const room = rooms[roomId];
      if (!room || room.hostId !== playerId) return;
      broadcast(room, {
        type: 'GAME_OVER',
        scoreA: room.scoreA,
        scoreB: room.scoreB
      });
      delete rooms[roomId];
      console.log(`[ROOM] Partie terminée: ${roomId}`);
    }
  });

  ws.on('close', () => {
    console.log(`[-] Joueur déconnecté: ${playerId.substring(0, 8)}`);
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    delete room.players[playerId];

    if (Object.keys(room.players).length === 0) {
      delete rooms[roomId];
      console.log(`[ROOM] Supprimée: ${roomId}`);
    } else {
      // Si l'hôte part, transférer à un autre joueur
      if (room.hostId === playerId) {
        room.hostId = Object.keys(room.players)[0];
        send(room.players[room.hostId].ws, { type: 'YOU_ARE_HOST' });
        console.log(`[ROOM] Nouvel hôte dans ${roomId}`);
      }
      broadcast(room, {
        type: 'ROOM_UPDATE',
        players: getPlayerList(room),
        map: room.map,
        time: room.time
      });
    }
  });

  ws.on('error', (err) => {
    console.error(`[ERR] ${err.message}`);
  });
});

// Utils
function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  Object.values(room.players).forEach(p => send(p.ws, msg));
}
function broadcastExcept(room, excludeId, msg) {
  Object.values(room.players)
    .filter(p => p.id !== excludeId)
    .forEach(p => send(p.ws, msg));
}
function getPlayerList(room) {
  return Object.values(room.players).map((p, i) => ({
    id: p.id,
    name: p.name,
    team: p.team !== undefined ? p.team : i % 2
  }));
}

// Nettoyage des rooms inactives toutes les 10min
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach(id => {
    if (Object.keys(rooms[id].players).length === 0) {
      delete rooms[id];
    }
  });
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Serveur Diddy vs Epstein lancé sur port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
});
