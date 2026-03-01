require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
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

const ROOM = 'channel';
let channel = null; // current GameSession (singleton)

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

app.post('/api/channel/load', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { questionFile, settings } = req.body;
  try {
    const questionData = loadQuestionFile(questionFile);
    const code = generateCode();

    const oldPlayers = channel
      ? [...channel.players.values()].filter(p => p.connected)
      : [];

    if (channel) {
      channel.cancelRestart();
      channel._clearTimers();
      channel.onEvent = null;
    }

    stmts.createGame.run(code, questionData.title, questionFile);
    const session = new GameSession(code, questionData, settings || {});
    channel = session;
    wireGameEvents(session);

    for (const p of oldPlayers) {
      session.addPlayer(p.socketId, p.nickname, p.email, p.playerId);
    }

    io.to(ROOM).emit('channel:newgame', {
      title: questionData.title,
      theme: session.theme,
      questionCount: questionData.questions.length
    });

    res.json({ title: questionData.title, questionCount: questionData.questions.length, theme: session.theme });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/qr', async (req, res) => {
  try {
    const svg = await QRCode.toString(BASE_URL, {
      type: 'svg',
      margin: 1,
      color: { dark: '#000000', light: '#00000000' }
    });
    res.type('svg').send(svg);
  } catch {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/channel', (req, res) => {
  if (!channel) return res.json({ active: false });
  res.json({
    active: true,
    title: channel.title,
    status: channel.status,
    theme: channel.theme,
    players: channel.getConnectedPlayers().map(p => ({ nickname: p.nickname, color: p.color })),
    scoreboard: channel.getScoreboard(),
    currentIndex: channel.currentIndex,
    totalQuestions: channel.questions.length
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

app.get('/api/admin/channel', (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!channel) return res.json({ active: false });
  res.json({
    active: true,
    title: channel.title,
    status: channel.status,
    theme: channel.theme,
    playerCount: channel.getConnectedPlayers().length,
    totalQuestions: channel.questions.length,
    currentIndex: channel.currentIndex
  });
});

// --- Socket.IO ---

function wireGameEvents(session) {
  session.onEvent = (event, data) => {
    io.to(ROOM).emit(event, data);

    if (event === 'game:ended') {
      stmts.endGame.run(session.code);
    }
    if (event === 'game:restarting') {
      stmts.updateGameStatus.run('waiting', session.code);
    }

    switch (event) {
      case 'chat:bot':
        session.addToHistory({ type: 'bot', message: data.message });
        break;
      case 'game:countdown':
        session.addToHistory({ type: 'action', message: 'Game starting...' });
        break;
      case 'round:question': {
        session.addToHistory({ type: 'question', question: data.question, index: data.index, total: data.total });
        if (data.type === 'abcd' && data.options) {
          session.addToHistory({ type: 'bot', message: `A) ${data.options.A}` });
          session.addToHistory({ type: 'bot', message: `B) ${data.options.B}` });
          session.addToHistory({ type: 'bot', message: `C) ${data.options.C}` });
          session.addToHistory({ type: 'bot', message: `D) ${data.options.D}` });
        }
        break;
      }
      case 'round:hint':
        session.addToHistory({ type: 'hint', hint: data.hint });
        break;
      case 'round:correct': {
        const streakText = data.streak >= 3 ? ` \u{1F525} ${data.streak} streak!` : '';
        session.addToHistory({
          type: 'correct',
          message: `${data.nickname} got it right! +${data.points} pts (${(data.timeMs / 1000).toFixed(1)}s)${streakText}`
        });
        break;
      }
      case 'round:wrong':
        session.addToHistory({
          type: 'wrong',
          nickname: data.nickname,
          color: data.color,
          answer: data.answer
        });
        break;
      case 'round:playerAnswered':
        session.addToHistory({
          type: 'system',
          message: `${data.nickname} answered. (${data.totalAnswered}/${data.totalPlayers})`
        });
        break;
      case 'round:ended': {
        session.addToHistory({ type: 'action', message: `Answer: ${data.answer}` });
        session.addToHistory({ type: 'system', message: `${data.correctCount}/${data.totalPlayers} players got it right.` });
        if (data.scoreboard && data.scoreboard.length) {
          const top = data.scoreboard.map(s => `${s.nickname}: ${s.points}`).join(' | ');
          session.addToHistory({ type: 'bot', message: `Top scores: ${top}` });
        }
        break;
      }
      case 'round:skipped':
        session.addToHistory({ type: 'action', message: `Question skipped. Answer was: ${data.answer}` });
        break;
      case 'game:paused':
        session.addToHistory({ type: 'action', message: 'Game paused by quiz master.' });
        break;
      case 'game:resumed':
        session.addToHistory({ type: 'action', message: 'Game resumed!' });
        break;
      case 'game:ended': {
        session.addToHistory({ type: 'action', message: 'GAME OVER!' });
        if (data.scoreboard && data.scoreboard.length) {
          session.addToHistory({ type: 'bot', message: '=== FINAL SCOREBOARD ===' });
          data.scoreboard.forEach((s, i) => {
            const medal = i === 0 ? '\u{1F947}' : i === 1 ? '\u{1F948}' : i === 2 ? '\u{1F949}' : `#${s.rank}`;
            session.addToHistory({ type: 'bot', message: `${medal} ${s.nickname} \u{2014} ${s.points} pts (${s.correct} correct)` });
          });
        }
        break;
      }
      case 'game:restarting':
        session.addToHistory({ type: 'action', message: `New game starting in ${data.seconds} seconds!` });
        break;
      case 'scoreboard:update':
        if (data.scoreboard) {
          const top = data.scoreboard.map(s => `#${s.rank} ${s.nickname}: ${s.points}`).join(' | ');
          session.addToHistory({ type: 'bot', message: `Scoreboard: ${top}` });
        }
        break;
    }
  };
}

io.on('connection', (socket) => {
  let inChannel = false;
  let isAdmin = false;

  socket.on('join', ({ nickname, email }, cb) => {
    if (!channel) return cb?.({ error: 'No game loaded yet. Waiting for the quiz master...' });
    const session = channel;
    if (session.status === 'ended' && !session._restartTimer) return cb?.({ error: 'Game has already ended' });

    let dbPlayer = stmts.findPlayerByNickAndEmail.get(nickname, email || '');
    if (!dbPlayer) {
      const result = stmts.createPlayer.run(nickname, email || '');
      dbPlayer = { id: result.lastInsertRowid, nickname, email };
    }

    const existing = session.reconnectPlayer(socket.id, dbPlayer.id);
    const player = existing || session.addPlayer(socket.id, nickname, email, dbPlayer.id);

    socket.join(ROOM);
    inChannel = true;

    const gameDbId = stmts.getGame.get(session.code)?.id;
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
      scoreboard: session.getScoreboard(),
      chatHistory: session.getChatHistory()
    });

    const joinEvent = {
      nickname: player.nickname,
      color: player.color,
      playerCount: session.getConnectedPlayers().length
    };
    session.addToHistory({
      type: 'action',
      message: `${player.nickname} has joined #tenzor-kvizko (${joinEvent.playerCount} players)`
    });
    socket.to(ROOM).emit('player:joined', joinEvent);
  });

  socket.on('admin:auth', ({ password }, cb) => {
    if (password !== ADMIN_PASSWORD) return cb?.({ error: 'Wrong password' });
    isAdmin = true;
    inChannel = true;
    socket.join(ROOM);
    socket.join('admin');

    const session = channel;
    if (!session) {
      return cb?.({
        ok: true,
        active: false
      });
    }

    cb?.({
      ok: true,
      active: true,
      gameTitle: session.title,
      status: session.status,
      theme: session.theme,
      players: session.getConnectedPlayers().map(p => ({ nickname: p.nickname, color: p.color })),
      scoreboard: session.getScoreboard(),
      totalQuestions: session.questions.length
    });
  });

  socket.on('answer', ({ answer }, cb) => {
    if (!inChannel || !channel) return;
    const result = channel.submitAnswer(socket.id, answer);
    cb?.(result);
  });

  socket.on('chat', ({ message }) => {
    if (!inChannel || !channel) return;
    const session = channel;

    if (isAdmin) {
      const cmd = parseCommand(message);
      if (cmd) {
        handleAdminCommand(session, cmd, socket);
        return;
      }
    }

    const player = session.players.get(socket.id);
    if (!player) return;

    const chatEntry = {
      type: 'chat',
      nickname: player.nickname,
      color: player.color,
      message,
      timestamp: Date.now()
    };
    session.addToHistory(chatEntry);
    io.to(ROOM).emit('chat:message', chatEntry);
  });

  socket.on('admin:command', ({ command }) => {
    if (!isAdmin || !channel) return;
    const cmd = parseCommand(command);
    if (cmd) handleAdminCommand(channel, cmd, socket);
  });

  socket.on('disconnect', () => {
    if (!inChannel || !channel) return;
    const player = channel.removePlayer(socket.id);
    if (player) {
      const leftEvent = {
        nickname: player.nickname,
        playerCount: channel.getConnectedPlayers().length
      };
      channel.addToHistory({
        type: 'action',
        message: `${player.nickname} has left (${leftEvent.playerCount} players)`
      });
      io.to(ROOM).emit('player:left', leftEvent);
    }
  });
});

function handleAdminCommand(session, cmd, socket) {
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
      io.to(ROOM).emit('scoreboard:update', { scoreboard: session.getScoreboard() });
      break;
    case 'kick':
      if (cmd.target) {
        for (const [sid, p] of session.players) {
          if (p.nickname.toLowerCase() === cmd.target.toLowerCase()) {
            io.to(sid).emit('kicked', { reason: 'Kicked by admin' });
            const kickedSocket = io.sockets.sockets.get(sid);
            if (kickedSocket) kickedSocket.disconnect(true);
            io.to(ROOM).emit('chat:bot', { message: `${p.nickname} has been kicked.` });
            break;
          }
        }
      }
      break;
    case 'say':
      if (cmd.message) {
        session.addToHistory({ type: 'bot', message: cmd.message });
        io.to(ROOM).emit('chat:bot', { message: cmd.message });
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
