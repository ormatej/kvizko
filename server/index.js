require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { db, stmts } = require('./db');
const { GameSession, loadQuestionFile, listQuestionFiles } = require('./game');
const { parseCommand, HELP_TEXT } = require('./commands');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Kvizko2026!';
const RAILWAY_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const BASE_URL = process.env.BASE_URL
  || (RAILWAY_DOMAIN ? `https://${RAILWAY_DOMAIN}` : `http://localhost:${PORT}`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 120000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

const games = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// --- REST API ---

app.post('/api/admin/auth', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ ok: true });
});

app.get('/api/questions', (req, res) => {
  res.json(listQuestionFiles());
});

app.get('/api/questions/template', (req, res) => {
  const filePath = path.join(__dirname, '..', 'questions', '_template.json');
  res.download(filePath, 'kvizko-template.json');
});

app.get('/api/questions/:filename', (req, res) => {
  try {
    const data = loadQuestionFile(req.params.filename);
    res.json(data);
  } catch {
    res.status(404).json({ error: 'Question file not found' });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.json')) {
      return cb(new Error('Only .json files are allowed'));
    }
    cb(null, true);
  }
});

app.post('/api/questions/upload', upload.single('file'), (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const content = req.file.buffer.toString('utf-8');
    const data = JSON.parse(content);

    if (!data.questions || !Array.isArray(data.questions) || data.questions.length === 0) {
      return res.status(400).json({ error: 'Invalid question file: must contain a non-empty "questions" array' });
    }

    const filename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(__dirname, '..', 'questions', filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    res.json({
      ok: true,
      filename,
      title: data.title || filename,
      count: data.questions.length
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      return res.status(400).json({ error: 'Invalid JSON format' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/questions/:filename', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const filePath = path.join(__dirname, '..', 'questions', req.params.filename);
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/questions/:filename', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const filePath = path.join(__dirname, '..', 'questions', req.params.filename);
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/games', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { questionFile, settings } = req.body;
  try {
    const questionData = loadQuestionFile(questionFile);
    const code = generateCode();
    stmts.createGame.run(code, questionData.title, questionFile);
    const session = new GameSession(code, questionData, settings || {});
    games.set(code, session);
    wireGameEvents(session);
    const joinUrl = `${BASE_URL}/?game=${code}`;
    res.json({ code, title: questionData.title, joinUrl, questionCount: questionData.questions.length, theme: session.theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:code/qr', async (req, res) => {
  const joinUrl = `${BASE_URL}/?game=${req.params.code}`;
  try {
    const svg = await QRCode.toString(joinUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: '#00ff41', light: '#00000000' }
    });
    res.type('svg').send(svg);
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/games/:code', (req, res) => {
  const session = games.get(req.params.code);
  if (!session) return res.status(404).json({ error: 'Game not found' });
  res.json({
    code: session.code,
    title: session.title,
    status: session.status,
    theme: session.theme,
    players: session.getConnectedPlayers().map(p => ({ nickname: p.nickname, color: p.color })),
    scoreboard: session.getScoreboard(),
    currentIndex: session.currentIndex,
    totalQuestions: session.questions.length
  });
});

app.get('/api/leaderboard', (req, res) => {
  res.json(stmts.getLeaderboard.all());
});

app.get('/api/last-game', (req, res) => {
  const lastGame = stmts.getLastEndedGame.get();
  if (!lastGame) return res.json({ lastGame: null, scores: [] });
  const scores = stmts.getLastGameScores.all(lastGame.id);
  res.json({ lastGame: { code: lastGame.code, title: lastGame.title, ended_at: lastGame.ended_at }, scores });
});

app.get('/api/global-stats', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const overview = stmts.getGlobalStats.get();
    const leaderboard = stmts.getGlobalLeaderboard.all();
    const lastGame = stmts.getLastEndedGame.get();
    let lastGameScores = [];
    if (lastGame) {
      lastGameScores = stmts.getLastGameScores.all(lastGame.id);
    }
    res.json({ overview, leaderboard, lastGame, lastGameScores });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    res.json(stmts.getGlobalLeads.all());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/leads/csv', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const leads = stmts.getGlobalLeads.all();
    const header = 'Nickname,Email,Games Played,Total Points,Total Correct,Best Streak,First Seen,Last Played,Last Game';
    const rows = leads.map(l =>
      `"${(l.nickname || '').replace(/"/g, '""')}","${(l.email || '').replace(/"/g, '""')}",${l.games_played},${l.total_points},${l.total_correct},${l.best_streak || 0},"${l.first_seen || ''}","${l.last_played || ''}","${(l.last_game_title || '').replace(/"/g, '""')}"`
    );
    const csv = [header, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="kvizko-global-leads.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/leaderboard', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    stmts.resetLeaderboard();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/games', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const activeGames = [];
  for (const [code, session] of games) {
    activeGames.push({
      code,
      title: session.title,
      status: session.status,
      theme: session.theme,
      playerCount: session.getConnectedPlayers().length,
      totalQuestions: session.questions.length,
      currentIndex: session.currentIndex
    });
  }
  res.json(activeGames);
});

// --- Socket.IO ---

function wireGameEvents(session) {
  session.onEvent = (event, data) => {
    io.to(`game:${session.code}`).emit(event, data);

    if (event === 'game:ended') {
      stmts.endGame.run(session.code);
    }
    if (event === 'game:restarting') {
      stmts.updateGameStatus.run('waiting', session.code);
    }
  };
}

io.on('connection', (socket) => {
  let currentGame = null;
  let isAdmin = false;

  socket.on('join', ({ gameCode, nickname, email }, cb) => {
    const session = games.get(gameCode);
    if (!session) return cb?.({ error: 'Game not found' });
    if (session.status === 'ended' && !session._restartTimer) return cb?.({ error: 'Game has already ended' });

    let dbPlayer = stmts.findPlayerByNickAndEmail.get(nickname, email || '');
    if (!dbPlayer) {
      const result = stmts.createPlayer.run(nickname, email || '');
      dbPlayer = { id: result.lastInsertRowid, nickname, email };
    }

    const existing = session.reconnectPlayer(socket.id, dbPlayer.id);
    const player = existing || session.addPlayer(socket.id, nickname, email, dbPlayer.id);

    socket.join(`game:${gameCode}`);
    currentGame = gameCode;

    const gameDbId = stmts.getGame.get(gameCode)?.id;
    if (gameDbId) {
      stmts.upsertScore.run(gameDbId, dbPlayer.id, player.points,
        player.correctAnswers, player.totalAnswers, player.streak, player.bestStreak);
    }

    cb?.({
      ok: true,
      player: { nickname: player.nickname, color: player.color },
      gameTitle: session.title,
      status: session.status,
      theme: session.theme,
      players: session.getConnectedPlayers().map(p => ({ nickname: p.nickname, color: p.color })),
      scoreboard: session.getScoreboard()
    });

    socket.to(`game:${gameCode}`).emit('player:joined', {
      nickname: player.nickname,
      color: player.color,
      playerCount: session.getConnectedPlayers().length
    });
  });

  socket.on('admin:auth', ({ gameCode, password }, cb) => {
    if (password !== ADMIN_PASSWORD) return cb?.({ error: 'Wrong password' });
    const session = games.get(gameCode);
    if (!session) return cb?.({ error: 'Game not found' });
    isAdmin = true;
    currentGame = gameCode;
    socket.join(`game:${gameCode}`);
    socket.join(`admin:${gameCode}`);
    cb?.({
      ok: true,
      gameTitle: session.title,
      status: session.status,
      theme: session.theme,
      players: session.getConnectedPlayers().map(p => ({ nickname: p.nickname, color: p.color })),
      scoreboard: session.getScoreboard(),
      totalQuestions: session.questions.length
    });
  });

  socket.on('answer', ({ answer }, cb) => {
    if (!currentGame) return;
    const session = games.get(currentGame);
    if (!session) return;
    const result = session.submitAnswer(socket.id, answer);
    cb?.(result);
  });

  socket.on('chat', ({ message }) => {
    if (!currentGame) return;
    const session = games.get(currentGame);
    if (!session) return;

    if (isAdmin) {
      const cmd = parseCommand(message);
      if (cmd) {
        handleAdminCommand(session, cmd, socket);
        return;
      }
    }

    const player = session.players.get(socket.id);
    if (!player) return;

    io.to(`game:${currentGame}`).emit('chat:message', {
      nickname: player.nickname,
      color: player.color,
      message,
      timestamp: Date.now()
    });
  });

  socket.on('admin:command', ({ command }) => {
    if (!isAdmin || !currentGame) return;
    const session = games.get(currentGame);
    if (!session) return;
    const cmd = parseCommand(command);
    if (cmd) handleAdminCommand(session, cmd, socket);
  });

  socket.on('disconnect', () => {
    if (!currentGame) return;
    const session = games.get(currentGame);
    if (!session) return;
    const player = session.removePlayer(socket.id);
    if (player) {
      io.to(`game:${currentGame}`).emit('player:left', {
        nickname: player.nickname,
        playerCount: session.getConnectedPlayers().length
      });
    }
  });
});

function handleAdminCommand(session, cmd, socket) {
  const room = `game:${session.code}`;
  switch (cmd.action) {
    case 'start':
      if (session.start()) {
        stmts.startGame.run(session.code);
      } else {
        socket.emit('admin:error', { message: 'Cannot start game (wrong state)' });
      }
      break;
    case 'stop':
      session.stop();
      break;
    case 'pause':
      session.pause();
      break;
    case 'resume':
      session.resume();
      break;
    case 'skip':
      session.skip();
      break;
    case 'hint':
      session.forceHint();
      break;
    case 'scores':
      io.to(room).emit('scoreboard:update', { scoreboard: session.getScoreboard() });
      break;
    case 'kick':
      if (cmd.target) {
        for (const [sid, p] of session.players) {
          if (p.nickname.toLowerCase() === cmd.target.toLowerCase()) {
            io.to(sid).emit('kicked', { reason: 'Kicked by admin' });
            const kickedSocket = io.sockets.sockets.get(sid);
            if (kickedSocket) kickedSocket.disconnect(true);
            io.to(room).emit('chat:bot', { message: `${p.nickname} has been kicked.` });
            break;
          }
        }
      }
      break;
    case 'say':
      if (cmd.message) {
        io.to(room).emit('chat:bot', { message: cmd.message });
      }
      break;
    case 'help':
      socket.emit('admin:help', { commands: HELP_TEXT });
      break;
  }
}

server.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   KVIZKO - mIRC Quiz Game Server      ║`);
  console.log(`  ║   by Tenzor d.o.o.                    ║`);
  console.log(`  ╠═══════════════════════════════════════╣`);
  console.log(`  ║   Running on: ${BASE_URL.padEnd(23)}║`);
  console.log(`  ║   Admin password: ${ADMIN_PASSWORD.padEnd(19)}║`);
  console.log(`  ╚═══════════════════════════════════════╝\n`);
});
