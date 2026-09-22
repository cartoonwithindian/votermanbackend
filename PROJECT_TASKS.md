# Student Portal — Multi-Agent Task Log

> Working dir: `/home/hackersage/student/`
> Backend: `/home/hackersage/student/voteweb-backend` (Express + JS, Mongo-only mode)
> Frontend: `/home/hackersage/student/voteweb-frontend` (Next.js + TS)
> Git rule: push ONLY to `cartoonwithindian` origins (backend & frontend)
> Live sites: backend `votermanbackend.onrender.com`, frontend `student.made-a.tech`

---

## 0. Goal

Make the **admin** and **student** portal show live candidate/ballot data, let the admin **edit candidates**, fix the empty `/student/candidates` page, speed things up with **Upstash Redis**, and set up **Supabase** as a backup — then test, debug, push, and deploy.

---

## 1. Backend — Admin pages now read the live ballot (DONE)

### Problem
Admin pages (`/admin/positions`, `/admin/candidates`, `/admin/dashboard`) read from the `candidate_applications` collection, which was **empty** — so pages showed nothing.

### Fix
In `src/services/candidateApplicationService.js`, the Mongo-only path of `listForAdmin` (line ~296) now **falls back to the live ballot** when `candidate_applications` is empty:

- Reads the `candidates` collection (44 real + leftovers)
- Joins `positions` to attach `position_name`
- Joins `constituencies` + `elections` to determine each candidate's election
- **Filters to only OPEN/DRAFT/SCHEDULED elections** → removes the 9 leftover sim candidates
- Maps rows to the approved-application shape (status `approved`, category `CR`, photo from `image_url`)

**Verified locally:** `findApprovedForAdmin({})` now returns exactly **44 rows** (all real make.json candidates). BCA female count = 8. Sample: SONAKSHI BISHT, MOHAK BHATIA, ADITI JHA.

### Supporting fixes
- `candidateService.js`: new `enrichPositionNames(rows)` helper joins `positions` and attaches `position_name`; applied in `findApproved` and `findApprovedById`.
- `candidateController.js`: `update` id-check fixed to accept Mongo ObjectIds (`!isMongoOnly && isNaN(parseInt(id))`); passes `department/year/section/gender` through.
- `candidateService.update` Mongo path now persists the extra class/gender fields; `image_url`/`imageUrl` both updated.

### Cleanup
Deleted 6 TEST junk rows from `candidate_applications` (dept `TEST`, election 1):

- Abastin
- Backup WH
- Bmtashwin009
- Cartoon With Indian
- Madea Official
- Ctrlplss9

---

## 2. Live ballot = exactly the 44 real candidates (DONE)

Election-check script results (candidates by election):

| Election | Status  | Count |
|----------|---------|-------|
| 1 | CLOSED  | 4     |
| 900 | OPEN  | 44    |
| none | orphan | 5     |

The 4 leftover rows on CLOSED election-1 (Alex Chen, Jordan Lee, Taylor Kim, Morgan Patel) and 5 orphan rows (Rahul Sharma, Arjun Mehta, Vikram Singh, Priya Nair, Sneha Kulkarni) are now **excluded** from admin output by the OPEN/DRAFT election filter.

---

## 3. Frontend — Edit Candidate UI (DONE)

Admin can now edit candidate info (no new backend endpoint needed — uses existing `PATCH /api/v1/admin/candidates/:id`).

### `/admin/positions` (`src/app/admin/positions/page.tsx`)
- Added `Pencil` icon + Edit button on every candidate row
- Edit modal with: **Full Name**, **Photo URL** (with live preview), **Manifesto**
- Save calls `api.patch('/admin/candidates/{id}', {name, image_url, description})` then reloads the list
- `CRCandidate.id` widened to `number | string` (Mongo ObjectIds)

### `/admin/candidates` (`src/app/admin/candidates/page.tsx`)
- Added `Pencil` icon + **Edit** button next to Review on each table row
- Same edit modal; after save it refreshes the applications table AND the JSON override info
- Uses `PATCH` with CSRF + session-binding headers (same pattern as approve/reject)

---

## 4. `/student/candidates` empty — root cause found & fixed (DONE)

### Problem
Students saw an **empty candidates list** on `/student/candidates`.

### Root cause
**Year + section format mismatch** between students and candidates:

| Source | Year format | Section quirks |
|--------|-------------|----------------|
| Candidates (`candidates` collection) | `"3rd Year"`, `"1st Year"` | `"A1"`, `"-"`, `"?"` |
| Students (`students` collection, 1260 rows) | `"3 Sem"`, `"1 Sem"` | `"A1"`, `"?"`, `""` |

`filterMongoRows` compared `r.year === year` **raw**, so a BCA student sending `3 Sem` never matched a candidate stored as `3rd Year` → empty list. Same for section (`-` vs `?` vs empty).

### Fix
`src/services/mongoCandidateStore.js` — `filterMongoRows` now:
- Normalizes year via the existing `normalizeYear()` util (`3 Sem` → `3rd Year`) on BOTH sides
- Normalizes section by treating `-`, `?`, and empty as equivalent
- Gender/department compared case-insensitively

**Verified:** `listCandidates({department:'BCA',year:'3 Sem',section:'A1'})` returns the 2 correct candidates (Deepanshu Rawat, Fernando robin). BCOM/MBA/MCA empty-section students also now match.

---

## 5. Upstash Redis caching — IN PROGRESS (agent aborted, re-run needed)

### Plan (not yet applied to backend)
- New util `src/utils/redisCache.js` using `@upstash/redis`
- Initializes client ONLY when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set; otherwise a safe no-op (no crash)
- Cache candidates reads: key `candidates:v1:{gender}:{dept}:{year}:{section}:{limit}:{offset}`, TTL 60s, built around existing `findApproved` cohort logic
- `invalidateCandidates()` → `deleteKeysWithPrefix('candidates:v1:')`
- Invalidate on candidate create/update/delete (candidateService + candidateApplicationService ballot writes)
- Optionally cache voting read path (`votes:v1:*`, TTL 10s, invalidate on cast) if simple

### Redis identifier given by user
`6318c52a-5fe7-467f-97d4-d460d1dc8d48`

### Env vars needed (set in backend `.env` AND Render dashboard)
```
UPSTASH_REDIS_REST_TOKEN=6318c52a-5fe7-467f-97d4-d460d1dc8d48
UPSTASH_REDIS_REST_URL=<real URL from Upstash dashboard>
```
Until the real URL is set, caching stays a no-op and Mongo is used (safe).

---

## 6. Supabase — MCP + skills + env (DONE)

### MCP config
`~/.config/opencode/opencode.jsonc` (NOT `.json` — that file did not exist) — merged a `supabase` remote server into the existing `mcp` block, preserving the pre-existing `appwrite` entry:

```json
"supabase": {
  "type": "remote",
  "url": "https://mcp.supabase.com/mcp?project_ref=gbqqbzmijgdilaxppadr&features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching",
  "enabled": true
}
```

✅ JSON validated.

**ACTION REQUIRED (once, interactively):**
```
opencode mcp auth supabase
```
Opens a browser OAuth flow — cannot run headless.

### Agent skills (installed)
Inside `voteweb-frontend`:
```
.git/agents/skills/supabase/
.git/agents/skills/supabase-postgres-best-practices/
```
Both assessed Safe/low findings by the skills CLI.

### Frontend env (backup) — appended to `voteweb-frontend/.env.local` (original 14 rows untouched)
```
NEXT_PUBLIC_SUPABASE_URL=https://gbqqbzmijgdilaxppadr.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_00pSf1JodfNPve5lpNpQUw_n-oAozTA
```
**Also add these to the Render frontend dashboard.**

---

## 7. Remaining / Next steps

- [ ] Implement Upstash Redis cache util + wire into `findApproved` + invalidations (redo aborted agent task)
- [ ] Set real `UPSTASH_REDIS_REST_URL` in backend `.env` + Render
- [ ] Run `opencode mcp auth supabase` once interactively
- [ ] Add Supabase env vars to Render frontend dashboard
- [ ] Run `node -c` on all modified backend files; `npx tsc --noEmit` on frontend
- [ ] `git add` + commit + push to `cartoonwithindian` origins (backend + frontend)
- [ ] Deploy both on Render (auto-deploys on push), verify `/admin/positions`, `/admin/candidates`, `/student/candidates` live at `student.made-a.tech`
- [ ] Revert the debug `err.message` error handler in `src/app.js` (live HEAD `f9fa061`) to the isDev-gated version before final deploy

---

## Files changed

| File | Change |
|------|--------|
| `voteweb-backend/src/services/candidateApplicationService.js` | ballot fallback in `listForAdmin` (+ election filter) |
| `voteweb-backend/src/services/candidateService.js` | `enrichPositionNames`, Mongo update persists extra fields |
| `voteweb-backend/src/services/mongoCandidateStore.js` | `filterMongoRows` year/section normalization |
| `voteweb-backend/src/controllers/candidateController.js` | Mongo ObjectId id-check fix, extra fields passthrough |
| `voteweb-frontend/src/app/admin/positions/page.tsx` | Edit modal + per-row Edit button |
| `voteweb-frontend/src/app/admin/candidates/page.tsx` | Edit button + modal (PATCH + CSRF) |
| `~/.config/opencode/opencode.jsonc` | Supabase MCP remote |
| `voteweb-frontend/.env.local` | Supabase URL + publishable key |
| `voteweb-frontend/.agents/skills/supabase*` | installed agent skills |

## Key facts

- Elections: 1 = CLOSED, 2 = DRAFT, 900 = OPEN (target)
- `candidates` collection: 53 docs total → 44 real + 9 leftover (4 on election-1 CLOSED, 5 orphan)
- `candidate_applications`: 0 docs (TEST rows deleted)
- Students: 1260 rows, year in `X Sem` format, sections may be `?`/empty
- Live deployed backend HEAD `f9fa061` still has the debug error handler → revert before final deploy