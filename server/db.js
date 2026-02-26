const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'kvizko.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL,
    email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT,
    question_file TEXT,
    status TEXT DEFAULT 'waiting',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    ended_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    points INTEGER DEFAULT 0,
    correct_answers INTEGER DEFAULT 0,
    total_answers INTEGER DEFAULT 0,
    streak INTEGER DEFAULT 0,
    best_streak INTEGER DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (player_id) REFERENCES players(id),
    UNIQUE(game_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS answer_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    question_index INTEGER NOT NULL,
    answer TEXT,
    is_correct INTEGER DEFAULT 0,
    time_ms INTEGER,
    points_awarded INTEGER DEFAULT 0,
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (game_id) REFERENCES games(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  );
`);

const stmts = {
  createPlayer: db.prepare('INSERT INTO players (nickname, email) VALUES (?, ?)'),
  findPlayerByNickAndEmail: db.prepare('SELECT * FROM players WHERE nickname = ? AND email = ?'),
  
  createGame: db.prepare('INSERT INTO games (code, title, question_file) VALUES (?, ?, ?)'),
  getGame: db.prepare('SELECT * FROM games WHERE code = ?'),
  updateGameStatus: db.prepare('UPDATE games SET status = ? WHERE code = ?'),
  startGame: db.prepare('UPDATE games SET status = \'active\', started_at = CURRENT_TIMESTAMP WHERE code = ?'),
  endGame: db.prepare('UPDATE games SET status = \'ended\', ended_at = CURRENT_TIMESTAMP WHERE code = ?'),

  upsertScore: db.prepare(`
    INSERT INTO scores (game_id, player_id, points, correct_answers, total_answers, streak, best_streak)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id, player_id) DO UPDATE SET
      points = excluded.points,
      correct_answers = excluded.correct_answers,
      total_answers = excluded.total_answers,
      streak = excluded.streak,
      best_streak = excluded.best_streak
  `),
  getScores: db.prepare(`
    SELECT s.*, p.nickname FROM scores s
    JOIN players p ON p.id = s.player_id
    WHERE s.game_id = ?
    ORDER BY s.points DESC
  `),

  logAnswer: db.prepare(`
    INSERT INTO answer_log (game_id, player_id, question_index, answer, is_correct, time_ms, points_awarded)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  getLeaderboard: db.prepare(`
    SELECT p.nickname, p.email, SUM(s.points) as total_points,
           SUM(s.correct_answers) as total_correct,
           SUM(s.total_answers) as total_answers,
           MAX(s.best_streak) as best_streak,
           COUNT(DISTINCT s.game_id) as games_played
    FROM scores s
    JOIN players p ON p.id = s.player_id
    GROUP BY p.id
    ORDER BY total_points DESC
    LIMIT 50
  `),

  getGlobalLeaderboard: db.prepare(`
    SELECT p.id as player_id, p.nickname, p.email, p.created_at as first_seen,
           SUM(s.points) as total_points,
           SUM(s.correct_answers) as total_correct,
           SUM(s.total_answers) as total_answers,
           MAX(s.best_streak) as best_streak,
           COUNT(DISTINCT s.game_id) as games_played,
           MAX(g.ended_at) as last_played
    FROM scores s
    JOIN players p ON p.id = s.player_id
    JOIN games g ON g.id = s.game_id
    GROUP BY p.id
    ORDER BY total_points DESC
  `),

  getGlobalLeads: db.prepare(`
    SELECT DISTINCT p.id, p.nickname, p.email, p.created_at as first_seen,
           COUNT(DISTINCT s.game_id) as games_played,
           COALESCE(SUM(s.points), 0) as total_points,
           COALESCE(SUM(s.correct_answers), 0) as total_correct,
           COALESCE(MAX(s.best_streak), 0) as best_streak,
           MAX(g.ended_at) as last_played,
           MAX(g.title) as last_game_title
    FROM players p
    LEFT JOIN scores s ON s.player_id = p.id
    LEFT JOIN games g ON g.id = s.game_id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `),

  getLastEndedGame: db.prepare(`
    SELECT * FROM games
    WHERE status = 'ended' AND ended_at IS NOT NULL
    ORDER BY ended_at DESC
    LIMIT 1
  `),

  getLastGameScores: db.prepare(`
    SELECT p.nickname, p.email, s.points, s.correct_answers, s.total_answers,
           s.best_streak, s.streak
    FROM scores s
    JOIN players p ON p.id = s.player_id
    WHERE s.game_id = ?
    ORDER BY s.points DESC
  `),

  getGlobalStats: db.prepare(`
    SELECT
      COUNT(DISTINCT p.id) as total_players,
      COUNT(DISTINCT g.id) as total_games,
      COALESCE(SUM(s.points), 0) as total_points_awarded,
      COALESCE(SUM(s.correct_answers), 0) as total_correct_answers,
      COALESCE(SUM(s.total_answers), 0) as total_answers
    FROM scores s
    JOIN players p ON p.id = s.player_id
    JOIN games g ON g.id = s.game_id
  `),

  getGamePlayers: db.prepare(`
    SELECT p.nickname, p.email FROM scores s
    JOIN players p ON p.id = s.player_id
    WHERE s.game_id = ?
  `),

  resetLeaderboard: db.transaction(() => {
    db.prepare('DELETE FROM answer_log').run();
    db.prepare('DELETE FROM scores').run();
    db.prepare('DELETE FROM games').run();
  })
};

module.exports = { db, stmts };
