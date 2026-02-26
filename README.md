# Kvizko

Retro mIRC-styled real-time quiz game built for job fairs and events.
Players join from their phones and compete in a nostalgic IRC chat interface, answering questions with free-type or A/B/C/D multiple choice.

Built by **Tenzor d.o.o.**

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` in your browser.

## How It Works

1. **Admin** goes to `/admin.html`, enters the admin password, selects a question set, and creates a game
2. A **game code** and **QR code** are generated
3. **Players** scan the QR code or visit the URL on their phones, enter a nickname + email
4. Players land in a retro mIRC chat room with KvizkoBot
5. Admin clicks **Start** -- the quiz begins
6. Questions appear one by one with a timer
7. **Free-type questions**: players type their answer, first correct wins
8. **ABCD questions**: players tap A/B/C/D buttons, everyone scores if correct
9. After all questions: final leaderboard and podium

## Pages

| URL | Purpose |
|-----|---------|
| `/` | Player join page |
| `/game.html?game=CODE` | Player game view (mIRC chat) |
| `/admin.html` | Admin dashboard |
| `/leaderboard.html?game=CODE` | Live leaderboard (for big screen) |
| `/leaderboard.html?mode=alltime` | All-time leaderboard |

## Question Format

Questions are stored as JSON files in the `questions/` folder. Each question has a `type`:

```json
{
  "type": "free",
  "question": "What does HTML stand for?",
  "answer": ["HyperText Markup Language"],
  "hint": "H____ T___ M_____ L_______",
  "category": "Web Development",
  "difficulty": 1
}
```

```json
{
  "type": "abcd",
  "question": "Which is NOT a JS framework?",
  "options": { "A": "React", "B": "Django", "C": "Vue", "D": "Angular" },
  "answer": "B",
  "category": "Programming",
  "difficulty": 2
}
```

## Admin Chat Commands

Type these in the admin command line or in-game chat:

- `!start` - Start the quiz
- `!stop` - End the quiz
- `!pause` / `!resume` - Pause/resume
- `!skip` - Skip current question
- `!hint` - Force show a hint
- `!scores` - Show scoreboard
- `!kick <nick>` - Kick a player
- `!say <message>` - Bot announcement

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ADMIN_PASSWORD` | `admin` | Admin panel password |
| `BASE_URL` | `http://localhost:3000` | Public URL (for QR codes) |

## Deploy

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app)

Connect your GitHub repo and set environment variables. Auto-deploys on push.

### Docker

```bash
docker build -t kvizko .
docker run -p 3000:3000 -e ADMIN_PASSWORD=secret kvizko
```

### Any Node.js Host

```bash
git clone <repo>
cd kvizko
npm install
PORT=3000 ADMIN_PASSWORD=secret BASE_URL=https://your-domain.com node server/index.js
```

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO, better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JS (zero build step)
- **Database**: SQLite (single file)
- **Realtime**: WebSockets via Socket.IO

## License

MIT
