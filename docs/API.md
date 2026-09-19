# API Routes — voteweb-backend/src/routes -> src/controllers -> src/services

Base: `https://made-a.tech/api` proxied `nginx 443 -> frontend:3001 -> backend:3000`. Local `http://127.0.0.1:3000/api` + `http://127.0.0.1:3001/api` proxy. Frontend `NEXT_PUBLIC_API_URL=/api/v1`.

## Auth `src/routes/auth.js`
- `GET /api/v1/auth/csrf` -> `mintCsrfToken` sets `cv_csrf`.
- `GET /api/v1/auth/me` `loadSession` -> `{authenticated, user {studentId, role, email, name, department, year, section, rollNumber}}`.
- `POST /api/v1/auth/login` `loginLimiter` `csrfProtection` `{userIdentifier, password}` -> `sessionService.createSession` sets `cv_sid` cookie + `bindingToken` header `X-Session-Binding`.
- `POST /api/v1/auth/otp/send-login` `otpLimiter` `csrfProtection` `{email, role}` -> `otpService.createOtpChallenge` + `brevoService.sendLoginOtp`. Needs `BREVO_API_KEY` in production.
- `POST /api/v1/auth/otp/verify-login` `{email, otp, role}` -> `verifyOtpChallenge` -> `createSession`.
- `POST /api/v1/auth/register/student/otp` + `/candidate/otp` + `POST /register/verify` -> create `students` + `otp_challenges`.
- `POST /api/v1/auth/profile` `requireAuth` `{rollNumber/mobileNumber, department, year, section}` one-time.
- `POST /api/v1/auth/logout` `revokeSession`.
- `GET /api/v1/auth/debug/brevo-status` -> `{configured: boolean}`.

## Candidate Applications `src/routes/candidateApplications.js` (`/api/candidates`)
- `POST /api/candidates/apply` `requireAuth` -> `candidateApplicationController.apply:12` -> `candidateApplicationService.create` `under_review`. Requires `fullName,enrollmentNumber,department,year,section,bio,manifesto,age,dateOfBirth,gender,aadharNumber` `category=CR`.
- `GET /api/candidates/me/application` -> `getByStudentId`.
- `GET /api/candidates/me/access` -> `{hasApplication, status, isApproved, canAccessCandidatePortal}`.
- `PATCH /api/candidates/me/profile` `approved|changes_requested` -> `updateProfile`.
- `POST /api/candidates/me/resubmit` `changes_requested` -> `resubmit`.

## Public Candidates `src/routes/candidates.js` + `src/controllers/candidateController.js`
- `GET /api/v1/candidates?gender=&department=&year=&section=` -> `candidateService.findApproved` from `candidate_applications status=approved`.
- `GET /api/v1/candidates/:id`
- `GET /api/v1/positions/:positionId/candidates`

## Elections `src/routes/elections.js` + `constituencies.js` + `positions.js`
- `GET /api/v1/elections` -> `electionService.findAll`.
- `GET /api/v1/elections/:id`
- `GET /api/v1/constituencies?election_id=1` -> `constituencyService.findByElectionId`.
- `GET /api/v1/constituencies/:id/positions` -> `positionService.findByConstituencyId`.
- `GET /api/v1/positions`
- `GET /api/v1/elections/:id/results` `results_published` check.

## Voting `src/routes/votes.js` -> `voteController.js:1` -> `voteService.js:1`
- `POST /api/v1/elections/:id/votes` `requireAuth` `csrfProtection` `X-Session-Binding` body `{election_id, constituency_id, position_id, candidate_id}` -> `ALREADY_VOTED 409` or `201 {receipt_hash}`.
- Receipts `src/routes/receipts.js` `GET /api/v1/receipts/:hash` + `GET /api/v1/receipts/student/me` (public verify).

## Admin `src/routes/admin*` all `requireAdmin`
- `GET /api/v1/admin/elections` + `POST /api/v1/admin/elections` `PATCH /:id` `PATCH /:id/status` (`DRAFT->SCHEDULED->OPEN->CLOSED->PUBLISHED`) `GET /:id/readiness` `POST /:id/publish` `GET /:id/turnout`.
- `GET /api/v1/admin/candidate-applications?status=&department=&positionId=&search=` -> `listForAdmin`.
- `PATCH /api/v1/admin/candidate-applications/:id/approve {electionId, constituencyId}` -> `approve` resolves `constituency/position` by `gender` + creates `candidates` ballot row.
- `PATCH /:id/reject {reason}` `POST /:id/assign-ballot`.
- `GET /api/v1/admin/students?limit=5000` `POST /admin/students` `PATCH /:id` `PATCH /:id/status`.
- `GET /api/v1/admin/positions` + `PATCH` positions.
- `GET /api/v1/admin/constituencies`
- `POST /api/v1/admin/announcements` `GET /announcements` public `GET /api/v1/announcements` published.
- `GET /api/v1/admin/monitoring` + `GET /metrics` `prom-client`.
- `GET /api/v1/admin/audit-logs` -> `adminAuditLogs`.
- `POST /api/v1/uploads/photo` `requireAuth` `brevo?` `Appwrite` bucket `candidate-photos`.

## Health
- `GET /api/health` `{status:ok, service:voteweb-api}`
- `GET /api/health/db` `{database:connected}`

## Frontend -> Backend mapping `src/lib`
- `api/v1.ts` `listElections -> GET /api/v1/elections`, `listAnnouncements -> GET /api/v1/announcements`.
- `candidate-api.ts` `CANDIDATE_BASE=/api/candidates` (strip `/api/v1`).
- `voting-api.ts` `castVote -> POST /api/v1/elections/:id/votes`.
- `session-binding.ts` `X-Session-Binding` from `sessionStorage campusvote_binding_token`.
