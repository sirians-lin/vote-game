const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const TOTAL_OPTIONS = 20;
const RATE_LIMIT_WINDOW_MS = 2000;
const PERSIST_TO_JSON = process.env.USE_JSON_PERSISTENCE === 'true';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'votes.json');
const ADMIN_RESET_PASSWORD = process.env.RESET_PASSWORD || 'adm123';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: false
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const counts = {};
const votedUsers = new Set();
const lastVoteByIp = new Map();

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
  votedUsers.clear();
  lastVoteByIp.clear();
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

      if (Array.isArray(parsed.votedUsers)) {
        parsed.votedUsers.forEach((id) => votedUsers.add(String(id)));
      }
    }
  } catch (error) {
    console.error('無法讀取 votes.json，改用空白狀態：', error.message);
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
      votedUsers: Array.from(votedUsers)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.error('寫入 votes.json 失敗：', error.message);
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

initialiseCounts();
loadStateFromDisk();

io.on('connection', (socket) => {
  socket.emit('stats', getStatsPayload());

  socket.on('vote', (payload = {}) => {
    const { userId, choice } = payload;
    const socketIp = socket.handshake.address;

    if (typeof userId !== 'string' || !userId.trim()) {
      return;
    }

    if (hasRateLimited(socketIp)) {
      return;
    }

    const numericChoice = Number(choice);
    if (!isValidChoice(numericChoice)) {
      return;
    }

    if (votedUsers.has(userId)) {
      socket.emit('locked');
      return;
    }

    votedUsers.add(userId);
    counts[numericChoice] += 1;
    saveStateToDisk();

    io.emit('stats', getStatsPayload());
    socket.emit('locked');
  });

  // Admin-triggered reset of the vote state, protected by shared password.
  socket.on('admin-reset', (payload = {}, respond) => {
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (password !== ADMIN_RESET_PASSWORD) {
      if (typeof respond === 'function') {
        respond({ ok: false, error: 'invalid_password' });
      }
      return;
    }

    resetState();
    saveStateToDisk();

    const statsPayload = getStatsPayload();
    io.emit('stats', statsPayload);
    io.emit('reset');

    console.log('Votes reset by administrator request');

    if (typeof respond === 'function') {
      respond({ ok: true });
    }
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
  console.log(`即時投票伺服器啟動：http://${HOST}:${PORT}`);
});

// 擴充點：若需要更完整的持久化，可以改成使用資料庫或排程寫入 JSON，
// 並在 process.on('beforeExit') 事件中確保即將離開時同步狀態。
