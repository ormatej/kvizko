## Cursor Cloud specific instructions

**Kvizko** is a single-process Node.js trivia quiz game (Express + Socket.IO + SQLite). No external services or databases are required — SQLite is embedded via `better-sqlite3` and creates `kvizko.db` automatically on first run.

### Running the app

- `npm run dev` — starts the server with `node --watch` (auto-restarts on file changes), listens on port 3000
- `npm start` — production mode (no auto-restart)
- Copy `.env.example` to `.env` before first run (provides `PORT`, `ADMIN_PASSWORD`, `BASE_URL`)

### Key pages

See `README.md` for the full URL table. Admin panel is at `/admin.html` (password from `ADMIN_PASSWORD` env var, default `changeme`).

### Notes

- No build step — frontend is vanilla HTML/CSS/JS served as static files from `public/`.
- No linter or test framework is configured in this repo.
- Question sets are JSON files in `questions/`.
- The SQLite database file (`kvizko.db`) is created automatically at the project root. It is gitignored.
