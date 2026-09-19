# Test Changes — Delete After Test (Render-only)

This file tracks every **test-only** change made for the `TEST_ELECTION_DELETE_ME` simulation
(`4 girls + 3 boys CR + 8 voters = 15 total` using your 15 real whitelisted emails).
After you confirm `candidate apply -> approve -> vote -> receipt -> results` works, delete/revert these and push.

## Permanent (KEEP after test)
- `voteweb-backend/migrations/038_remove_clubs.sql` club removal + `candidateApplicationService.js:12` fix `nomination_club` `719a8c0`
- `voteweb-backend/migrations/039_cleanup_test_applications.sql` + `040_cleanup_testcase1_election2.sql` old `TEST-CAND`/`testcase1` cleanup
- `voteweb-backend/migrations/041_whitelist_live_otp_google.sql` 15 whitelisted `serwinbm@gmail.com` etc `is_active` for `OTP/Google`
- `voteweb-frontend/src/app/student/dashboard/page.tsx:60` candidate nomination card `eec0794` (`TEST` not needed)
- `voteweb-frontend/src/components/auth/UnifiedAuth.tsx:111` candidate link alert `5ff1469`
- `docs/*` `README/BACKEND/FRONTEND/DATABASE/API/AGENT_GUIDE` `9a61a70`/`9e8ebc2`

## Test-Only (DELETE after test)

### Frontend
- `voteweb-frontend/src/lib/class-data.ts:13`
  - Added `TEST` to `Course` type, `Section` `T1`, `COURSES` array, `TEST_BATCHES` `T1 (1st Year)`, `BATCHES_BY_COURSE.TEST`
  - **Why:** `Candidate apply` dropdown `Course *` `Select course` must show `TEST` so `who07512@gmail.com` can pick `TEST 1st Year T1` to match `TEST_ELECTION_DELETE_ME` `constituency TEST 1st Year T1`. Without it dropdown shows `BBA/BCA/BCom/MBA/MCA` only.
  - **Revert after test:** remove `TEST` from `Course`, `Section`, `COURSES`, delete `TEST_BATCHES` constant and `TEST: TEST_BATCHES` entry. `npx tsc --noEmit` must pass. Commit `git push`.

### Backend Migrations (data only, code unchanged)
All under `voteweb-backend/migrations/` — **keep files in git history**, but their *data* will be wiped by `049` on `Render` `migrate up`. If you want to remove files themselves, `git rm` and push (optional, not required).

- `042_test_simulation_seed.sql` — created `TEST_ELECTION_DELETE_ME` `id 4` + `constituency 5` + `positions 9/10` + `7` synthetic `test-girl/boy@test.local` `approved` + `7` `test-voter@test.local` `voter_authorizations` `election_id=TEST`. Later deleted by `044`.
- `043_test_simulation_passwords.sql` — set `TestPassword123!` hash for `test-*.local` synthetic (now deleted).
- `044_test_simulation_cleanup.sql` — deletes synthetic `test-*.local` + `TEST_ELECTION` `id 4` (prepares for real-email test).
- `045_test_simulation_real_emails.sql` — recreates `TEST_ELECTION_DELETE_ME` `id 5` `OPEN` + `TEST 1st Year T1` + `positions`, authorizes `7` real voters `meryrajam` etc for test election only.
- `046_test_simulation_cleanup_real.sql` — prematurely deleted `id 5` locally (keep, will be superseded by `048`).
- `047_add_8th_voter_bmtashwin.sql` — adds `8th` voter `bmtashwin009@gmail.com` to reach `8 voters` = `15 total` (`7 candidates + 8 voters`). Combined with `045` makes `8`.
- `048_recreate_test_live_15.sql` — recreates `TEST_ELECTION_DELETE_ME` `id 6` `OPEN` `TEST 1st Year T1` + `8 voters` after `046` deleted. **Live now `election 6` `8 voters` `0 candidates` pending your live `OTP -> candidate/apply`.**
- `050_fill_class_for_15_live.sql` `24d30f6` — `UPDATE students SET department='TEST', year_or_semester='1st Year', section='T1'` for `15` whitelisted so `who07512@gmail.com` shows `Class filled` and matches `TEST` constituency. **Revert after test:** `UPDATE students SET department=NULL, year_or_semester=NULL, section=NULL WHERE LOWER(email) IN (...) AND department='TEST'` or let `049` do it (commented).

### Pending Cleanup (NOT yet pushed — push after test)
- `voteweb-backend/migrations/049_final_cleanup_after_15_test.sql` — **local** `vote/migrations/049` ready, not committed. Deletes `TEST_ELECTION_DELETE_ME` `votes/receipts/voter_authorizations/candidates/candidate_applications/positions/constituencies/elections` `WHERE name='TEST_ELECTION_DELETE_ME'` + optionally resets `15` `department` to `NULL`. **Push after test:** `cd voteweb-backend && git add migrations/049_final_cleanup_after_15_test.sql && git commit -m "chore: delete TEST_ELECTION after 15 test" && git push origin main` → `Render` `migrate up` wipes test, keeps `election #1` + `15` whitelisted.

### How to Revert Test Frontend
```bash
cd voteweb-frontend
# edit src/lib/class-data.ts: remove TEST from Course/Section/COURSES/TEST_BATCHES/BATCHES_BY_COURSE
npx tsc --noEmit
git add src/lib/class-data.ts
git commit -m "revert: remove TEST course after test"
git push origin main
# Render auto-deploys, dropdown no longer shows TEST
```

### Verification Before Delete
```bash
# local
PGPASSWORD=voteweb psql -h 127.0.0.1 -p 5434 -U voteweb -d voteweb -c "SELECT id, name, status FROM elections WHERE name='TEST_ELECTION_DELETE_ME'"
PGPASSWORD=voteweb psql -h 127.0.0.1 -p 5434 -U voteweb -d voteweb -c "SELECT COUNT(*) FROM voter_authorizations WHERE election_id=(SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME')"
PGPASSWORD=voteweb psql -h 127.0.0.1 -p 5434 -U voteweb -d voteweb -c "SELECT COUNT(*) FROM candidate_applications WHERE election_id=(SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME')"
# Render
curl -s https://made-a.tech/api/health/db | cat
# candidate apply should show TEST in Course dropdown now
```

**Do NOT delete:** `vote/_archive` (already moved waste), `pgdata`/`pgsock` (local DB), `docs/*`, `voteweb-backend/docs`, `voteweb-frontend/docs`.
