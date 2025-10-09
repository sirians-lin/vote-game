const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const TOTAL_OPTIONS = 20;
const RATE_LIMIT_WINDOW_MS = 2000;
const SOCKET_RATE_LIMIT_WINDOW_MS = 60000;
const SOCKET_RATE_LIMIT_MAX = 10;
const PERSIST_TO_JSON = process.env.USE_JSON_PERSISTENCE === 'true';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'votes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOLDING_FILE = path.join(PUBLIC_DIR, 'holding.html');
const ADMIN_RESET_PASSWORD = process.env.RESET_PASSWORD || 'adm123';
const TOKEN_BATCH_SIZE = parseInt(process.env.TOKEN_BATCH_SIZE || '40', 10);
let isOpen = process.env.SITE_OPEN === '1';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: false
  }
});

const counts = {};
const lastVoteByIp = new Map();
const tokens = new Set();
const usedTokens = new Set();
const claimedByDevice = new Map();
const voteAttemptsBySocket = new Map();

console.log('Site initial state:', isOpen ? 'OPEN' : 'CLOSED');

app.use(express.json());
app.use((req, res, next) => {
  if (isOpen) {
    next();
    return;
  }

  if (isAdminTogglePath(req)) {
    next();
    return;
  }

  if (isAllowedWhileClosed(req)) {
    next();
    return;
  }

  if (req.path.startsWith('/socket.io/')) {
    res.status(503).json({ ok: false, error: 'site_closed' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    res.sendFile(HOLDING_FILE);
    return;
  }

  res.status(503).json({ ok: false, error: 'site_closed' });
});
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.post('/admin/open', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password !== ADMIN_RESET_PASSWORD) {
    res.status(401).json({ ok: false, error: 'invalid_password' });
    return;
  }

  if (!isOpen) {
    isOpen = true;
    io.emit('site-state', { open: true });
    console.log('Site state changed to OPEN');
  }

  res.json({ ok: true, open: true });
});

app.post('/admin/close', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password !== ADMIN_RESET_PASSWORD) {
    res.status(401).json({ ok: false, error: 'invalid_password' });
    return;
  }

  if (isOpen) {
    isOpen = false;
    io.emit('site-state', { open: false });
    console.log('Site state changed to CLOSED');
  }

  res.json({ ok: true, open: false });
});


app.post('/claim', (req, res) => {
  if (!isOpen) {
    res.status(503).json({ ok: false, error: 'site_closed' });
    return;
  }

  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  if (!deviceId) {
    res.status(400).json({ ok: false, error: 'invalid_device' });
    return;
  }

  const existingToken = claimedByDevice.get(deviceId);
  if (existingToken) {
    res.json({ ok: true, token: existingToken });
    return;
  }

  if (tokens.size === 0) {
    res.status(409).json({ ok: false, error: 'no_tokens' });
    return;
  }

  const iterator = tokens.values();
  const token = iterator.next().value;
  tokens.delete(token);
  claimedByDevice.set(deviceId, token);
  res.json({ ok: true, token });
});

function initialiseCounts() {
  for (let option = 1; option <= TOTAL_OPTIONS; option += 1) {
    counts[option] = counts[option] || 0;
  }
}

function getStatsPayload() {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts: { ...counts },
    total
  };
}

function resetState() {
  for (let option = 1; option <= TOTAL_OPTIONS; option += 1) {
    counts[option] = 0;
  }
  usedTokens.clear();
  lastVoteByIp.clear();
  voteAttemptsBySocket.clear();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStateFromDisk() {
  if (!PERSIST_TO_JSON) {
    return;
  }

  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === 'object') {
      if (parsed.counts && typeof parsed.counts === 'object') {
        for (let option = 1; option <= TOTAL_OPTIONS; option += 1) {
          const key = String(option);
          counts[option] = Number(parsed.counts[key]) || 0;
        }
      }

      if (Array.isArray(parsed.usedTokens)) {
        usedTokens.clear();
        parsed.usedTokens.forEach((token) => {
          if (typeof token === 'string' && token) {
            usedTokens.add(token);
          }
        });
      } else if (Array.isArray(parsed.votedUsers)) {
        usedTokens.clear();
        parsed.votedUsers.forEach((token) => {
          if (typeof token === 'string' && token) {
            usedTokens.add(token);
          }
        });
      }
    }
  } catch (error) {
    console.error('無法讀取 votes.json，原因為：', error.message);
  }
}

function saveStateToDisk() {
  if (!PERSIST_TO_JSON) {
    return;
  }

  try {
    ensureDataDir();
    const payload = {
      counts,
      usedTokens: Array.from(usedTokens)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.error('寫入 votes.json 時發生錯誤：', error.message);
  }
}

function isValidChoice(choice) {
  return Number.isInteger(choice) && choice >= 1 && choice <= TOTAL_OPTIONS;
}

function hasRateLimited(ip) {
  const now = Date.now();
  const lastSeen = lastVoteByIp.get(ip) || 0;
  if (now - lastSeen < RATE_LIMIT_WINDOW_MS) {
    return true;
  }
  lastVoteByIp.set(ip, now);
  return false;
}

function recordSocketVoteAttempt(socketId) {
  const now = Date.now();
  const timestamps = voteAttemptsBySocket.get(socketId) || [];
  const recent = timestamps.filter((time) => now - time < SOCKET_RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  voteAttemptsBySocket.set(socketId, recent);
  return recent.length > SOCKET_RATE_LIMIT_MAX;
}

function genToken() {
  const size = 8 + Math.floor(Math.random() * 9);
  return crypto.randomBytes(size).toString('hex');
}

function startRound(n = TOKEN_BATCH_SIZE) {
  const totalTokens = Number.isFinite(n) && n > 0 ? Math.floor(n) : TOKEN_BATCH_SIZE;
  tokens.clear();
  usedTokens.clear();
  claimedByDevice.clear();

  while (tokens.size < totalTokens) {
    tokens.add(genToken());
  }
}

function isTokenClaimed(token) {
  for (const issuedToken of claimedByDevice.values()) {
    if (issuedToken === token) {
      return true;
    }
  }
  return false;
}

function isAdminTogglePath(req) {
  const pathname = typeof req.path === 'string' ? req.path : '';
  return pathname === '/admin/open' || pathname === '/admin/close';
}

function isAllowedWhileClosed(req) {
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  const pathname = typeof req.path === 'string' ? req.path : '';
  if (pathname === '/holding.html' || pathname === '/styles.css') {
    return true;
  }
  if (pathname.startsWith('/images/')) {
    return true;
  }
  if (pathname.startsWith('/public/')) {
    return true;
  }
  if (pathname.startsWith('/favicon')) {
    return true;
  }
  return false;
}

initialiseCounts();
loadStateFromDisk();

io.use((socket, next) => {
  if (!isOpen) {
    const error = new Error('site_closed');
    error.data = { error: 'site_closed' };
    next(error);
    return;
  }
  next();
});

io.on('connection', (socket) => {
  socket.emit('site-state', { open: isOpen });
  socket.emit('stats', getStatsPayload());

  socket.on('vote', (payload = {}, respond) => {
    const ack = typeof respond === 'function' ? respond : () => {};
    const token = typeof payload.token === 'string' ? payload.token.trim() : '';
    const numericChoice = Number(payload.choice);
    const socketIp = socket.handshake.address;

    if (!isOpen) {
      ack({ ok: false, error: 'site_closed' });
      return;
    }

    if (recordSocketVoteAttempt(socket.id)) {
      ack({ ok: false, error: 'rate_limited' });
      return;
    }

    if (hasRateLimited(socketIp)) {
      ack({ ok: false, error: 'rate_limited' });
      return;
    }

    if (!isValidChoice(numericChoice)) {
      ack({ ok: false, error: 'invalid_choice' });
      return;
    }

    if (!token) {
      ack({ ok: false, error: 'invalid_token' });
      return;
    }

    if (usedTokens.has(token) || !isTokenClaimed(token)) {
      ack({ ok: false, error: 'invalid_token' });
      return;
    }

    usedTokens.add(token);
    counts[numericChoice] += 1;
    saveStateToDisk();

    io.emit('stats', getStatsPayload());
    socket.emit('locked');
    ack({ ok: true });
  });

  socket.on('admin-reset', (payload = {}, respond) => {
    const password = typeof payload.password === 'string' ? payload.password : '';
    const ack = typeof respond === 'function' ? respond : () => {};

    if (password !== ADMIN_RESET_PASSWORD) {
      ack({ ok: false, error: 'invalid_password' });
      return;
    }

    startRound();
    resetState();
    saveStateToDisk();

    const statsPayload = getStatsPayload();
    io.emit('stats', statsPayload);
    io.emit('reset', { at: Date.now(), tokens: tokens.size });

    console.log('Votes reset by administrator request');

    ack({ ok: true, tokens: tokens.size });
  });

  socket.on('disconnect', () => {
    voteAttemptsBySocket.delete(socket.id);
  });
});

process.on('SIGINT', () => {
  saveStateToDisk();
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveStateToDisk();
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  console.log('現在伺服器啟動，請瀏覽：http://' + HOST + ':' + PORT);
});

// 提示：若需要簡易的資料永續化，可搭配 USE_JSON_PERSISTENCE 環境變數
// 並在 process.on('beforeExit') 等出入口確保狀態已寫入。
