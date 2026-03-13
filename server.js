require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 30 * 60 * 1000;           // 30 min room expiry
const RATE_LIMIT_WINDOW = 60 * 1000;           // 1 min
const RATE_LIMIT_MAX = 15;                      // max connections per IP per window
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'p2p-fileshare-default-secret-key';

// ── State ───────────────────────────────────────────────────────────────
const rooms = {};          // { code: { clients: [ws], createdAt, lastActivity } }
const ipHits = new Map();  // rate-limit tracker

// ── Helpers ─────────────────────────────────────────────────────────────
function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char hex
}

/** Encode room code into a URL-safe token */
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

/** Decode a room token back to a room code */
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

// ── HTTP server (health check + upgrade) ────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS headers for all HTTP requests
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

  // Decode-token endpoint (for debugging / verification)
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
  if (isRateLimited(ip)) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Rate limited. Try again later.' } }));
    ws.close();
    return;
  }

  ws.roomCode = null;
  ws.isAlive = true;

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
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        ws.roomCode = code;
        ws.send(JSON.stringify({ type: 'created', payload: { code, token } }));
        break;
      }

      case 'join': {
        // Support joining by code or by token
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
        touchRoom(code);
        ws.send(JSON.stringify({ type: 'joined', payload: { code } }));
        // Notify the sender that a peer joined
        rooms[code].clients[0].send(JSON.stringify({ type: 'peer-joined' }));
        break;
      }

      case 'leave': {
        removeClientFromRoom(ws, true);
        ws.send(JSON.stringify({ type: 'left' }));
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
    }
  });

  ws.on('close', () => {
    removeClientFromRoom(ws, true);
  });
});

// ── Heartbeat (detect dead connections) ─────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

// ── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`⚡ P2P Signaling Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
