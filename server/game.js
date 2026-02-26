const fs = require('fs');
const path = require('path');
const { stmts } = require('./db');

const QUESTIONS_DIR = path.join(__dirname, '..', 'questions');

const IRC_COLORS = ['#ff5555', '#5555ff', '#55ff55', '#ff55ff', '#55ffff', '#ffaa00', '#ff7777', '#77aaff', '#aaffaa', '#ffaaff', '#aaffff', '#ffcc55'];

function assignColor(index) {
  return IRC_COLORS[index % IRC_COLORS.length];
}

function loadQuestionFile(filename) {
  const filePath = path.join(QUESTIONS_DIR, filename);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function listQuestionFiles() {
  return fs.readdirSync(QUESTIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = loadQuestionFile(f);
        return { filename: f, title: data.title || f, count: data.questions?.length || 0 };
      } catch {
        return { filename: f, title: f, count: 0 };
      }
    });
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeAnswer(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function checkAnswer(question, playerAnswer) {
  if (question.type === 'abcd') {
    return normalizeAnswer(playerAnswer) === normalizeAnswer(question.answer);
  }
  const answers = Array.isArray(question.answer) ? question.answer : [question.answer];
  const norm = normalizeAnswer(playerAnswer);
  return answers.some(a => normalizeAnswer(a) === norm);
}

function generateHint(answer, revealPercent) {
  if (Array.isArray(answer)) answer = answer[0];
  return answer.split('').map((ch, i) => {
    if (ch === ' ') return ' ';
    if (Math.random() < revealPercent) return ch;
    return '_';
  }).join(' ');
}

function calculatePoints(timeElapsedMs, totalTimeMs, difficulty = 1) {
  const basePoints = 100;
  const timeRatio = Math.max(0, 1 - (timeElapsedMs / totalTimeMs));
  const speedMultiplier = 1 + (timeRatio * 0.5);
  const difficultyMultiplier = 1 + ((difficulty - 1) * 0.25);
  return Math.round(basePoints * speedMultiplier * difficultyMultiplier);
}

function shuffleOptions(options) {
  const keys = Object.keys(options);
  const values = shuffleArray(keys.map(k => options[k]));
  const shuffled = {};
  const mapping = {};
  keys.forEach((key, i) => {
    shuffled[key] = values[i];
    const origKey = keys.find(k => options[k] === values[i]);
    mapping[key] = origKey;
  });
  return { shuffled, mapping };
}

class GameSession {
  constructor(code, questionData, settings = {}) {
    this.code = code;
    this.title = questionData.title || 'Kvizko Game';
    this.status = 'waiting';
    this.players = new Map();
    this.spectators = new Set();

    const qs = questionData.settings || {};
    this.timePerQuestion = (settings.timePerQuestion || qs.timePerQuestion || 30) * 1000;
    this.hintsEnabled = settings.hintsEnabled ?? qs.hintsEnabled ?? true;
    this.shuffleQuestions = settings.shuffleQuestions ?? qs.shuffleQuestions ?? true;
    this.shuffleOptions = settings.shuffleOptions ?? qs.shuffleOptions ?? true;
    this.theme = settings.theme || 'default';

    let questions = questionData.questions || [];
    if (this.shuffleQuestions) questions = shuffleArray(questions);
    this.questions = questions;

    this.currentIndex = -1;
    this.currentQuestion = null;
    this.questionStartTime = null;
    this.roundTimer = null;
    this.hintTimers = [];
    this.roundAnswers = new Map();
    this.isPaused = false;

    this.onEvent = null;
  }

  addPlayer(socketId, nickname, email, playerId) {
    const colorIndex = this.players.size;
    const player = {
      socketId,
      nickname,
      email,
      playerId,
      color: assignColor(colorIndex),
      points: 0,
      correctAnswers: 0,
      totalAnswers: 0,
      streak: 0,
      bestStreak: 0,
      connected: true
    };
    this.players.set(socketId, player);
    return player;
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (player) {
      player.connected = false;
    }
    return player;
  }

  reconnectPlayer(socketId, playerId) {
    for (const [oldId, p] of this.players) {
      if (p.playerId === playerId) {
        this.players.delete(oldId);
        p.socketId = socketId;
        p.connected = true;
        this.players.set(socketId, p);
        return p;
      }
    }
    return null;
  }

  getConnectedPlayers() {
    return [...this.players.values()].filter(p => p.connected);
  }

  getScoreboard() {
    return [...this.players.values()]
      .sort((a, b) => b.points - a.points)
      .map((p, i) => ({
        rank: i + 1,
        nickname: p.nickname,
        points: p.points,
        correct: p.correctAnswers,
        streak: p.bestStreak,
        color: p.color
      }));
  }

  emit(event, data) {
    if (this.onEvent) this.onEvent(event, data);
  }

  start() {
    if (this.status !== 'waiting') return false;
    this.status = 'active';
    this.emit('game:countdown', { seconds: 3 });
    setTimeout(() => this.nextQuestion(), 4000);
    return true;
  }

  pause() {
    if (this.status !== 'active' || this.isPaused) return false;
    this.isPaused = true;
    this._clearTimers();
    this.emit('game:paused', {});
    return true;
  }

  resume() {
    if (!this.isPaused) return false;
    this.isPaused = false;
    this.emit('game:resumed', {});
    this.nextQuestion();
    return true;
  }

  stop() {
    this._clearTimers();
    this.status = 'ended';
    this._saveAllScores();
    this.emit('game:ended', { scoreboard: this.getScoreboard() });
    return true;
  }

  skip() {
    if (this.status !== 'active') return false;
    this._clearTimers();
    this.emit('round:skipped', {
      answer: this._getCorrectAnswerText(),
      questionIndex: this.currentIndex
    });
    setTimeout(() => this.nextQuestion(), 2000);
    return true;
  }

  forceHint() {
    if (!this.currentQuestion || this.currentQuestion.type !== 'free') return;
    const hint = generateHint(this.currentQuestion.answer, 0.5);
    this.emit('round:hint', { hint, questionIndex: this.currentIndex });
  }

  nextQuestion() {
    if (this.isPaused) return;
    this._clearTimers();

    this.currentIndex++;
    if (this.currentIndex >= this.questions.length) {
      this.stop();
      return;
    }

    this.currentQuestion = this.questions[this.currentIndex];
    this.questionStartTime = Date.now();
    this.roundAnswers = new Map();

    const qData = {
      index: this.currentIndex,
      total: this.questions.length,
      question: this.currentQuestion.question,
      type: this.currentQuestion.type || 'free',
      category: this.currentQuestion.category,
      difficulty: this.currentQuestion.difficulty || 1,
      timeMs: this.timePerQuestion
    };

    if (qData.type === 'abcd') {
      if (this.shuffleOptions) {
        const { shuffled } = shuffleOptions(this.currentQuestion.options);
        qData.options = shuffled;
        this._currentShuffledOptions = shuffled;
      } else {
        qData.options = this.currentQuestion.options;
        this._currentShuffledOptions = this.currentQuestion.options;
      }
    }

    this.emit('round:question', qData);

    if (this.hintsEnabled && qData.type === 'free') {
      const hint1Time = this.timePerQuestion * 0.33;
      const hint2Time = this.timePerQuestion * 0.66;

      this.hintTimers.push(setTimeout(() => {
        if (this.currentIndex === qData.index && !this.isPaused) {
          const hint = this.currentQuestion.hint || generateHint(this.currentQuestion.answer, 0.3);
          this.emit('round:hint', { hint, questionIndex: this.currentIndex });
        }
      }, hint1Time));

      this.hintTimers.push(setTimeout(() => {
        if (this.currentIndex === qData.index && !this.isPaused) {
          const hint = generateHint(this.currentQuestion.answer, 0.6);
          this.emit('round:hint', { hint, questionIndex: this.currentIndex });
        }
      }, hint2Time));
    }

    this.roundTimer = setTimeout(() => {
      this._endRound(false);
    }, this.timePerQuestion);
  }

  submitAnswer(socketId, answer) {
    if (this.status !== 'active' || !this.currentQuestion || this.isPaused) return null;

    const player = this.players.get(socketId);
    if (!player) return null;

    if (this.roundAnswers.has(socketId)) return { alreadyAnswered: true };

    const timeElapsed = Date.now() - this.questionStartTime;
    const isCorrect = checkAnswer(this.currentQuestion, answer);
    const difficulty = this.currentQuestion.difficulty || 1;
    const pointsAwarded = isCorrect ? calculatePoints(timeElapsed, this.timePerQuestion, difficulty) : 0;

    this.roundAnswers.set(socketId, {
      answer,
      isCorrect,
      timeElapsed,
      pointsAwarded
    });

    player.totalAnswers++;
    if (isCorrect) {
      player.correctAnswers++;
      player.streak++;
      if (player.streak > player.bestStreak) player.bestStreak = player.streak;

      let streakBonus = 0;
      if (player.streak >= 3) {
        streakBonus = Math.round(pointsAwarded * 0.1 * Math.min(player.streak - 2, 5));
      }
      player.points += pointsAwarded + streakBonus;

      stmts.logAnswer.run(
        this._getGameDbId(), player.playerId, this.currentIndex,
        answer, 1, timeElapsed, pointsAwarded + streakBonus
      );

      if (this.currentQuestion.type === 'free') {
        this._clearTimers();
        this.emit('round:correct', {
          nickname: player.nickname,
          color: player.color,
          points: pointsAwarded + streakBonus,
          timeMs: timeElapsed,
          streak: player.streak,
          questionIndex: this.currentIndex,
          answer: this._getCorrectAnswerText()
        });
        setTimeout(() => this.nextQuestion(), 3000);
        return { isCorrect: true, points: pointsAwarded + streakBonus, timeMs: timeElapsed };
      }
    } else {
      player.streak = 0;
      stmts.logAnswer.run(
        this._getGameDbId(), player.playerId, this.currentIndex,
        answer, 0, timeElapsed, 0
      );
    }

    if (this.currentQuestion.type === 'abcd') {
      this.emit('round:playerAnswered', {
        nickname: player.nickname,
        color: player.color,
        questionIndex: this.currentIndex,
        totalAnswered: this.roundAnswers.size,
        totalPlayers: this.getConnectedPlayers().length
      });

      if (this.roundAnswers.size >= this.getConnectedPlayers().length) {
        this._endRound(true);
      }

      return { isCorrect, points: pointsAwarded, timeMs: timeElapsed, revealed: false };
    }

    this.emit('round:wrong', {
      nickname: player.nickname,
      color: player.color,
      answer,
      questionIndex: this.currentIndex
    });
    return { isCorrect: false };
  }

  _endRound(allAnswered) {
    this._clearTimers();

    const correctAnswer = this._getCorrectAnswerText();
    const results = [];
    let correctCount = 0;

    for (const [sid, data] of this.roundAnswers) {
      const player = this.players.get(sid);
      if (data.isCorrect) correctCount++;
      results.push({
        nickname: player?.nickname,
        color: player?.color,
        isCorrect: data.isCorrect,
        points: data.pointsAwarded,
        timeMs: data.timeElapsed
      });
    }

    this.emit('round:ended', {
      questionIndex: this.currentIndex,
      answer: correctAnswer,
      correctCount,
      totalPlayers: this.getConnectedPlayers().length,
      results,
      allAnswered,
      scoreboard: this.getScoreboard().slice(0, 5)
    });

    setTimeout(() => this.nextQuestion(), 4000);
  }

  _getCorrectAnswerText() {
    if (!this.currentQuestion) return '';
    if (this.currentQuestion.type === 'abcd') {
      const key = this.currentQuestion.answer;
      return `${key}) ${this.currentQuestion.options[key]}`;
    }
    const ans = this.currentQuestion.answer;
    return Array.isArray(ans) ? ans[0] : ans;
  }

  _getGameDbId() {
    const game = stmts.getGame.get(this.code);
    return game?.id;
  }

  _saveAllScores() {
    const gameId = this._getGameDbId();
    if (!gameId) return;
    for (const player of this.players.values()) {
      stmts.upsertScore.run(
        gameId, player.playerId, player.points,
        player.correctAnswers, player.totalAnswers,
        player.streak, player.bestStreak
      );
    }
  }

  _clearTimers() {
    if (this.roundTimer) { clearTimeout(this.roundTimer); this.roundTimer = null; }
    this.hintTimers.forEach(t => clearTimeout(t));
    this.hintTimers = [];
  }
}

module.exports = { GameSession, loadQuestionFile, listQuestionFiles };
