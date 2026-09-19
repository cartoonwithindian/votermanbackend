# AI Agent Guide — Where to Edit, How Not to Waste Time

## Golden Rules (Render-only)
- Only `voteweb-backend` + `voteweb-frontend` are live. `vote/_archive` is dead (`appwrite-backend-function`, `voteapp`, `data/*.xlsx`). Do not read `oracle-vps` (deleted `2026-09-19`).
- `git push origin/main` = auto-deploy. `Render` `preDeployCommand: npm run migrate` runs `migrate.js up`. Never `psql` direct (IP allowlist blocks); ship a migration `migrations/0xx_*.sql` via push.
- Frontend `NEXT_PUBLIC_API_URL=/api/v1` proxied `nginx -> frontend:3001 -> backend:3000` keep cookies first-party. Always send `credentials: include` + `X-CSRF-Token` (from `GET /api/v1/auth/csrf`) + `X-Session-Binding` (`session-binding.ts`).

## Task -> Files (exclusive ownership)

| Task | Edit | Read-only |
|------|------|-----------|
| Candidate apply submit `nomination_club` error | `voteweb-backend/src/services/candidateApplicationService.js:12` `INSERT` + `migrations/038` | `voteweb-frontend/src/app/candidate/apply/page.tsx:324` |
| Add card to student dashboard | `voteweb-frontend/src/app/student/dashboard/page.tsx:60` | `src/lib/api/v1.ts` |
| Add link to student login | `voteweb-frontend/src/components/auth/UnifiedAuth.tsx:111` `lockPortal` branch | `src/app/student/login/page.tsx:1` |
| Elections CRUD | `voteweb-backend/src/services/electionService.js` + `src/controllers/electionController.js` + `src/routes/adminElections.js` | `migrations/001` |
| Constituencies/Positions | `src/services/constituencyService.js` auto-creates `positions (Boys/Girls)` `031`, `src/services/positionService.js:1` | `src/routes/constituencies.js` |
| Voting / receipts | `src/services/voteService.js:1` `castVote` `ALREADY_VOTED`, `src/services/receiptService.js:1` | `src/routes/votes.js` |
| OTP not working | `src/services/brevoService.js:19` needs `BREVO_API_KEY` in `Render` env `production`, `src/services/otpService.js:1` `expires_at 5m` | `src/routes/auth.js:495` |
| Brevo check | `GET /api/v1/auth/debug/brevo-status` `auth.js:35` -> `{configured}` | |
| Admin lists | `src/services/candidateApplicationService.js:158` `listForAdmin`, `src/services/studentService.js:1` | `src/routes/adminStudents.js:13` |
| Wasted time trap | Do not search `lib/candidate-data.ts` (legacy mock) — real data is `GET /api/v1/candidates` via `candidateService.findApproved` from `candidate_applications status=approved`. Grep `nomination_club` returns only `038` and `027` — do not re-add column. |

## Check Before Commit
```bash
cd voteweb-backend && npm test # 56 tests, all must pass (see 2026-09-19 run)
cd voteweb-frontend && npx tsc --noEmit # must be clean
grep -r "nomination_club" --include="*.js" --include="*.ts" # should be only migrations/027/038
```

## Common Errors & Fixes
- `column "nomination_club" does not exist` -> `candidateApplicationService.js` still `INSERT nomination_club` while `DB` `038` dropped it. Fix service, not DB. Pushed `719a8c0`.
- `Test Student BBA A1 CR Approved` + `Election #2 testcase1` appear -> leftover `TEST-*` seed. Delete via migration `039`/`040` pushed `9b10517`/`b4ebe87`, not manual `DELETE`.
- `OTP configured:false` -> add `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` in `Render Dashboard -> voteweb-backend -> Environment` then `Manual Deploy`.
- `getaddrinfo ENOTFOUND dpg-...` -> `Render` `DATABASE_URL` from `voteweb-db` internal host, not external. Must use `DB_SSL=true` on Render, `false` local `127.0.0.1:5434`.

## Docs Index
- `docs/README.md` overview
- `docs/BACKEND.md` backend file map
- `docs/FRONTEND.md` frontend app/lib map
- `docs/DATABASE.md` schema + migration order
- `docs/API.md` route -> controller -> service chain
- This file `AGENT_GUIDE.md` edit locations

**For next agent:** Start at `docs/README.md`, then this guide. Do not `grep` entire repo for `clubs` — `038` removed `clubs` table; use `constituencies` instead.
