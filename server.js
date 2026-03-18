require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 30 * 60 * 1000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'p2p-fileshare-default-secret-key';
const RECONNECT_GRACE_MS = 30 * 1000; // 30 seconds grace period for reconnection

// ── State ───────────────────────────────────────────────────────────────
const rooms = {};
const lobby = new Map(); // id -> ws
const pendingReconnects = new Map(); // roomCode -> { hubId, timer, nickname }

// ── Helpers ─────────────────────────────────────────────────────────────
function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function encodeRoomToken(code) {
  // Use AES-256-GCM for secure encryption
  const key = crypto.createHash('sha256').update(TOKEN_SECRET).digest();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(code, 'utf8', 'base64url');
  encrypted += cipher.final('base64url');
  const authTag = cipher.getAuthTag();
  // Concatenate IV + AuthTag + Ciphertext
  return iv.toString('base64url') + '.' + authTag.toString('base64url') + '.' + encrypted;
}

function decodeRoomToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [ivStr, tagStr, encrypted] = parts;
    const key = crypto.createHash('sha256').update(TOKEN_SECRET).digest();
    const iv = Buffer.from(ivStr, 'base64url');
    const authTag = Buffer.from(tagStr, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'base64url', 'utf8');
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

function touchRoom(code) {
  if (rooms[code]) rooms[code].lastActivity = Date.now();
}

// Helper to safely send WebSocket messages
function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  } catch (err) {
    console.error('[WS] Send error:', err.message);
  }
}

function broadcastLobby() {
  // Create snapshots to prevent issues during iteration
  const peers = [];
  const clients = Array.from(lobby.entries());

  for (const [id, client] of clients) {
    peers.push({ id: id, nickname: client.nickname });
  }

  console.log(`[LOBBY] Broadcasting to ${clients.length} users. Peers:`, peers);

  const msg = JSON.stringify({ type: 'lobby-update', payload: { peers } });
  for (const [, client] of clients) {
    safeSend(client, msg);
  }
}

function removeClientFromRoom(ws, notifyPeer = true, useGracePeriod = false) {
  const code = ws.roomCode;
  if (!code || !rooms[code]) {
    ws.roomCode = null;
    return;
  }

  rooms[code].clients = rooms[code].clients.filter((c) => c !== ws);
  touchRoom(code);

  // If grace period is enabled and there's still another client in the room,
  // give the disconnecting client time to reconnect
  if (useGracePeriod && rooms[code].clients.length > 0) {
    console.log(`[ROOM ${code}] Client ${ws.hubId} disconnected - starting grace period`);

    // Notify remaining peers that user is reconnecting (not fully disconnected)
    rooms[code].clients.forEach((client) => {
      safeSend(client, { type: 'peer-reconnecting', payload: { nickname: ws.nickname } });
    });

    // Cancel any existing pending reconnect for this room
    const existing = pendingReconnects.get(code);
    if (existing) {
      clearTimeout(existing.timer);
    }

    // Store the pending reconnect info
    const timer = setTimeout(() => {
      console.log(`[ROOM ${code}] Grace period expired for ${ws.hubId}`);
      pendingReconnects.delete(code);

      // Now notify remaining clients that peer is fully disconnected
      if (rooms[code]) {
        rooms[code].clients.forEach((client) => {
          safeSend(client, { type: 'peer-disconnected' });
        });

        // Clean up empty room
        if (rooms[code].clients.length === 0) {
          delete rooms[code];
        }
      }
    }, RECONNECT_GRACE_MS);

    pendingReconnects.set(code, { hubId: ws.hubId, timer, nickname: ws.nickname });
  } else if (notifyPeer) {
    rooms[code].clients.forEach((client) => {
      safeSend(client, { type: 'peer-disconnected' });
    });
  }

  // Clean up empty room only if not using grace period
  if (rooms[code].clients.length === 0 && !useGracePeriod) {
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
    if (rooms[code] && now - rooms[code].lastActivity > ROOM_TTL_MS) {
      rooms[code].clients.forEach((c) => {
        safeSend(c, { type: 'error', payload: { message: 'Room expired' } });
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
    try {
      const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
      const code = decodeRoomToken(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid URL' }));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const hubId = crypto.randomBytes(4).toString('hex');
  ws.hubId = hubId;
  ws.nickname = 'Guest';

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
          creator: ws,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        ws.roomCode = code;
        lobby.delete(ws.hubId); // Remove from lobby when in room
        broadcastLobby();
        safeSend(ws, { type: 'created', payload: { code, token } });
        break;
      }

      case 'identify': {
        const nickname = payload?.nickname;
        ws.nickname = nickname || 'Guest';
        console.log(`[LOBBY] User identified: ${ws.nickname} (${ws.hubId})`);

        if (!ws.roomCode) {
          lobby.set(ws.hubId, ws);
        }
        safeSend(ws, { type: 'identified', payload: { hubId: ws.hubId } });
        broadcastLobby();
        break;
      }

      case 'invite': {
        if (!payload) return;
        const { targetId, roomCode } = payload;
        const target = lobby.get(targetId);
        if (target) {
          safeSend(target, {
            type: 'invited',
            payload: { fromId: ws.hubId, fromNick: ws.nickname, roomCode }
          });
        }
        break;
      }

      case 'invite-reject': {
        if (!payload) return;
        const { targetId } = payload;
        // targetId here is the original inviter
        const target = Array.from(wss.clients).find(c => c.hubId === targetId);
        if (target) {
          safeSend(target, {
            type: 'invite-rejected',
            payload: { fromNick: ws.nickname }
          });
        }
        break;
      }

      case 'invite-cancel': {
        if (!payload) return;
        const { targetId } = payload;
        // targetId here is the invitee
        const target = lobby.get(targetId);
        if (target) {
          safeSend(target, {
            type: 'invite-cancelled',
            payload: { fromId: ws.hubId }
          });
        }
        // Cleanup the room since the inviter cancelled
        removeClientFromRoom(ws, false);
        break;
      }

      case 'join': {
        if (!payload) return;
        let code = payload.code?.toUpperCase();
        if (payload.token) {
          const decoded = decodeRoomToken(payload.token);
          if (decoded) code = decoded;
        }

        if (!code || !rooms[code]) {
          safeSend(ws, { type: 'error', payload: { message: 'Room not found' } });
          return;
        }
        if (rooms[code].clients.length >= 2) {
          safeSend(ws, { type: 'error', payload: { message: 'Room is full' } });
          return;
        }

        if (ws.roomCode === code) {
          safeSend(ws, { type: 'joined', payload: { code } });
          return;
        }

        removeClientFromRoom(ws, true);

        // Re-check room exists (could have been cleaned up during removeClientFromRoom)
        if (!rooms[code]) {
          safeSend(ws, { type: 'error', payload: { message: 'Room no longer exists' } });
          return;
        }

        // Re-check capacity (defensive check)
        if (rooms[code].clients.length >= 2) {
          safeSend(ws, { type: 'error', payload: { message: 'Room is full' } });
          return;
        }

        // Check if this is a reconnection (during grace period)
        const pendingReconnect = pendingReconnects.get(code);
        const isReconnecting = !!pendingReconnect;

        if (isReconnecting) {
          // Cancel the grace period timer
          clearTimeout(pendingReconnect.timer);
          pendingReconnects.delete(code);
          console.log(`[ROOM ${code}] User reconnected within grace period`);
        }

        rooms[code].clients.push(ws);
        ws.roomCode = code;
        lobby.delete(ws.hubId); // Remove from lobby when in room
        broadcastLobby();
        touchRoom(code);
        safeSend(ws, { type: 'joined', payload: { code, isReconnect: isReconnecting } });

        // Notify all other clients in the room that a peer joined/reconnected
        rooms[code].clients.forEach((client) => {
          if (client !== ws) {
            safeSend(client, {
              type: isReconnecting ? 'peer-reconnected' : 'peer-joined',
              payload: { nickname: ws.nickname }
            });
          }
        });
        break;
      }

      case 'leave': {
        removeClientFromRoom(ws, true);
        // Put back in lobby (nickname always has a value since default is 'Guest')
        lobby.set(ws.hubId, ws);
        safeSend(ws, { type: 'left' });
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
          if (client !== ws) {
            safeSend(client, { type, payload });
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
          if (client !== ws) {
            safeSend(client, { type: 'relay', payload });
          }
        });
        break;
      }

      default:
        // Unknown message type - ignore
        break;
    }
  });

  ws.on('close', () => {
    // Use grace period for rooms with another client (page refresh case)
    const shouldUseGrace = ws.roomCode && rooms[ws.roomCode]?.clients?.length > 1;
    removeClientFromRoom(ws, true, shouldUseGrace);
    lobby.delete(ws.hubId);
    broadcastLobby();
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      // Use grace period if in a room with other clients
      const shouldUseGrace = ws.roomCode && rooms[ws.roomCode]?.clients?.length > 1;
      removeClientFromRoom(ws, true, shouldUseGrace);
      lobby.delete(ws.hubId);
      broadcastLobby();
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10_000);

// ── Start ───────────────────────────────────────────────────────────────
server.on('error', (err) => {
  console.error('[SERVER] Error:', err.message);
});

server.listen(PORT, () => {
  console.log(`⚡ P2P Signaling Server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
