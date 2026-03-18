require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 30 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 15;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'p2p-fileshare-default-secret-key';

// ── State ───────────────────────────────────────────────────────────────
const rooms = {};
const lobby = new Map(); // id -> ws
const ipHits = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────
function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function encodeRoomToken(code) {
  const cipher = crypto.createCipheriv(
    'aes-128-ecb',
    crypto.createHash('md5').update(TOKEN_SECRET).digest(),
    null
  );
  let encrypted = cipher.update(code, 'utf8', 'base64url');
  encrypted += cipher.final('base64url');
  return encrypted;
}

function decodeRoomToken(token) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-128-ecb',
      crypto.createHash('md5').update(TOKEN_SECRET).digest(),
      null
    );
    let decrypted = decipher.update(token, 'base64url', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const now = Date.now();
  if (!ipHits.has(ip)) ipHits.set(ip, []);
  const hits = ipHits.get(ip).filter((t) => t > now - RATE_LIMIT_WINDOW);
  ipHits.set(ip, hits);
  if (hits.length >= RATE_LIMIT_MAX) return true;
  hits.push(now);
  return false;
}

function touchRoom(code) {
  if (rooms[code]) rooms[code].lastActivity = Date.now();
}

function broadcastLobby() {
  const peers = [];
  lobby.forEach((client, id) => {
    peers.push({ id: id, nickname: client.nickname });
  });

  console.log(`[LOBBY] Broadcasting to ${lobby.size} users. Peers:`, peers);

  const msg = JSON.stringify({ type: 'lobby-update', payload: { peers } });
  lobby.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function removeClientFromRoom(ws, notifyPeer = true) {
  const code = ws.roomCode;
  if (!code || !rooms[code]) {
    ws.roomCode = null;
    return;
  }

  rooms[code].clients = rooms[code].clients.filter((c) => c !== ws);
  touchRoom(code);

  if (notifyPeer) {
    rooms[code].clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'peer-disconnected' }));
      }
    });
  }

  if (rooms[code].clients.length === 0) {
    delete rooms[code];
  }

  ws.roomCode = null;
  // IMPORTANT: We don't automatically put them back in lobby here; 
  // the client will send 'identify' again if they want to be visible.
}

// ── Room cleanup (every 5 min) ──────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    if (now - rooms[code].lastActivity > ROOM_TTL_MS) {
      rooms[code].clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN)
          c.send(JSON.stringify({ type: 'error', payload: { message: 'Room expired' } }));
        c.close();
      });
      delete rooms[code];
    }
  }
}, 5 * 60 * 1000);

// ── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      rooms: Object.keys(rooms).length,
      uptime: Math.floor(process.uptime()),
    }));
  }

  if (req.url?.startsWith('/decode?token=')) {
    const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    const code = decodeRoomToken(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code }));
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  const hubId = crypto.randomBytes(4).toString('hex');
  ws.hubId = hubId;
  ws.nickname = 'Guest';

  ws.roomCode = null;
  ws.isAlive = true;

  if (isRateLimited(ip)) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Rate limited. Try again later.' } }));
    ws.close();
    return;
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const { type, payload } = data;

    switch (type) {
      case 'create': {
        removeClientFromRoom(ws, true);
        const code = generateCode();
        const token = encodeRoomToken(code);
        rooms[code] = {
          clients: [ws],
          creator: ws,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        ws.roomCode = code;
        lobby.delete(ws.hubId); // Remove from lobby when in room
        broadcastLobby();
        ws.send(JSON.stringify({ type: 'created', payload: { code, token } }));
        break;
      }

      case 'identify': {
        const { nickname } = payload;
        ws.nickname = nickname || 'Guest';
        console.log(`[LOBBY] User identified: ${ws.nickname} (${ws.hubId})`);
        
        if (!ws.roomCode) {
          lobby.set(ws.hubId, ws);
        }
        ws.send(JSON.stringify({ type: 'identified', payload: { hubId: ws.hubId } }));
        broadcastLobby();
        break;
      }

      case 'invite': {
        const { targetId, roomCode } = payload;
        const target = lobby.get(targetId);
        if (target && target.readyState === WebSocket.OPEN) {
          // Store the inviter's hubId on the target so they can reply directly
          target.send(JSON.stringify({
            type: 'invited',
            payload: { fromId: ws.hubId, fromNick: ws.nickname, roomCode }
          }));
        }
        break;
      }

      case 'invite-reject': {
        const { targetId } = payload;
        // targetId here is the original inviter
        const target = Array.from(wss.clients).find(c => c.hubId === targetId);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: 'invite-rejected',
            payload: { fromNick: ws.nickname }
          }));
        }
        break;
      }

      case 'invite-cancel': {
        const { targetId } = payload;
        // targetId here is the invitee
        const target = lobby.get(targetId);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: 'invite-cancelled',
            payload: { fromId: ws.hubId }
          }));
        }
        // Cleanup the room since the inviter cancelled
        removeClientFromRoom(ws, false);
        break;
      }

      case 'join': {
        let code = payload.code?.toUpperCase();
        if (payload.token) {
          const decoded = decodeRoomToken(payload.token);
          if (decoded) code = decoded;
        }

        if (!code || !rooms[code]) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room not found' } }));
          return;
        }
        if (rooms[code].clients.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Room is full' } }));
          return;
        }

        if (ws.roomCode === code) {
          ws.send(JSON.stringify({ type: 'joined', payload: { code } }));
          return;
        }

        removeClientFromRoom(ws, true);
        rooms[code].clients.push(ws);
        ws.roomCode = code;
        lobby.delete(ws.hubId); // Remove from lobby when in room
        broadcastLobby();
        touchRoom(code);
        ws.send(JSON.stringify({ type: 'joined', payload: { code } }));

        // ← fixed: use stored creator ref instead of clients[0]
        if (rooms[code].creator?.readyState === WebSocket.OPEN) {
          rooms[code].creator.send(JSON.stringify({ type: 'peer-joined' }));
        }
        break;
      }

      case 'leave': {
        removeClientFromRoom(ws, true);
        // Put back in lobby if they were identified
        if (ws.nickname) {
           lobby.set(ws.hubId, ws);
        }
        ws.send(JSON.stringify({ type: 'left' }));
        broadcastLobby();
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const code = ws.roomCode;
        if (!rooms[code]) return;
        touchRoom(code);
        rooms[code].clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type, payload }));
          }
        });
        break;
      }

      // ← NEW: pure WebSocket relay for file/chat when WebRTC ICE fails
      case 'relay': {
        const code = ws.roomCode;
        if (!rooms[code]) return;
        touchRoom(code);
        rooms[code].clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'relay', payload }));
          }
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    removeClientFromRoom(ws, true);
    lobby.delete(ws.hubId);
    broadcastLobby();
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      removeClientFromRoom(ws, true);
      lobby.delete(ws.hubId);
      broadcastLobby();
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10_000);

// ── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`⚡ P2P Signaling Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
