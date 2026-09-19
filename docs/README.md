# VoteWeb — AI Agent Code Map

**Live:** `https://made-a.tech` -> `Render` (`voteweb-backend.onrender.com` + `voteweb-frontend.onrender.com`)
**Repo:** `who07512-wq/voteweb-backend` (`main` auto-deploy) + `who07512-wq/voteweb-frontend`
**Stack:** `Node 20 + Express 4 + Postgres 16` (backend `127.0.0.1:5434` local, `Render` internal), `Next.js 16 + Clerk + Appwrite Storage` (frontend `127.0.0.1:3001`)

This `docs/` is the single source for AI agents. Read this first, then the specific map.

| Doc | What |
|-----|------|
| `BACKEND.md` | `voteweb-backend/src/` every folder/file purpose + key lines |
| `FRONTEND.md` | `voteweb-frontend/src/` app routes + lib/api mapping |
| `DATABASE.md` | `migrations/` tables, indexes, constraints, `038` club removal |
| `API.md` | Every `ROUTE` -> `Controller -> Service -> DB` chain |
| `AGENT_GUIDE.md` | Where to edit for each task, anti-patterns, `Render` pipeline |

**Quick start (Render-only):**
```bash
cd voteweb-backend && npm install && npm run migrate && npm run dev # 3000
cd voteweb-frontend && npm install && npm run dev # 3001
# .env: DATABASE_URL=postgres://voteweb:voteweb@127.0.0.1:5434/voteweb, DB_SSL=false
```

**Render pipeline:** `git push origin/main` -> `Render` `preDeployCommand: npm run migrate` (`src/server.js:20` `spawnSync node migrate.js up`) -> `healthCheckPath: /api/health`.
