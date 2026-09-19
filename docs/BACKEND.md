# Backend Map — voteweb-backend/src

## Entrypoints
- `src/server.js:17` `startServer()` runs `migrate.js up` before `app.listen(PORT)`. Never skip migration; it is idempotent via `migrations` table.
- `src/app.js:1` Express app. Mounts `health`, `students`, `elections`, `announcements`, `positions`, `candidates`, `candidateApplications`, `auth`, `votes`, `receipts`, `uploads`, `admin*`, `constituencies`.
- `migrate.js:35` creates `migrations` table, applies `migrations/*.sql` sorted.

## Config / DB
- `src/config/index.js:1` reads `DATABASE_URL`, `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`, `BREVO_API_KEY`, `CLERK_*`, `APPWRITE_*`.
- `src/config/database.js:1` `pg.Pool` with `DB_SSL`.
- `src/db/index.js:1` `db.query(sql, params)` wrapper, `db.close()`.

## Middleware `src/middleware`
- `loadSession.js:1` reads `cv_sid` cookie, loads session, sets `req.user {studentId, role, bindingToken?}`. Required for all auth routes.
- `requireAuth.js:1` `401` if no `req.user`.
- `requireAdmin.js:1` `403` if `role !== ADMIN`.
- `requireRole.js:1` generic role gate.
- `csrfProtection.js:1` `GET /api/v1/auth/csrf` -> `cv_csrf` cookie + `X-CSRF-Token` header for `POST/PATCH/DELETE`.
- `rateLimiter.js:1` `loginLimiter`, `otpLimiter`, `registerLimiter`, `mfaLimiter`.

## Lib `src/lib`
- `authDb.js:1` `recordAudit`, `findStudentByIdentifierOrEmail`, `publicUser`, `isLocked`.
- `clerkVerify.js:1` `verifyClerkSessionRequest`, `requireClerkMiddleware` for `/auth/clerk*` + `/register/clerk`.
- `cookies.js:1` `CSRF_COOKIE=cv_csrf`, `SESSION_COOKIE=cv_sid`.
- `crypto.js:1` `hashToken`, `encryptSecret/decryptSecret` for TOTP secrets.
- `password.js:1` `hashPassword`, `verifyPassword`, `validatePasswordPolicy`.
- `totp.js:1` `generateTotpSecret`, `verifyTotp`, `provisioningUri` for admin MFA.

## Services `src/services` (business logic, no `req/res`)
- `candidateApplicationService.js:12` `create(data, studentId)` `INSERT candidate_applications` (no `nomination_club` after `038`), `getByStudentId`, `getById`, `listForAdmin`, `approve(id, adminId, {electionId, constituencyId})` auto-resolves `CR` `constituency/position` by `department/year/section + gender`, `reject`, `requestChanges`, `resubmit`, `updateProfile`, `assignBallot`, `placeUnplacedForElection`, `findApprovedForAdmin`. `formatApplication:870` maps `row -> API`.
- `candidateService.js:1` `findApproved`, `findByPositionId`, `create` ballot `candidates` row, `update`, `canModify` checks election `DRAFT/SCHEDULED`.
- `electionService.js:1` `findAll {excludeDraft}`, `findById`, `create`, `updateStatus` (calls `candidateApplicationService.placeUnplacedForElection` on `OPEN`).
- `constituencyService.js:1` `findById`, `findMatching {electionId, department, year, section}`, `create` auto-creates `CR` `positions` (Boys/Girls), `findByElectionId`.
- `positionService.js:1` `findByConstituencyId`, `findById`, `create`, `update` (name dedup `LOWER`).
- `voteService.js:1` `castVote {election_id, constituency_id, position_id, candidate_id}` checks `voter_authorizations`, `ALREADY_VOTED`, creates `votes` + `vote_receipts` (hash).
- `authorizationService.js:1` `isAuthorized`, `authorizeVoter` (election-wide now, `038` dropped `club_id`), `voter_auth_unique (student_id,election_id)`.
- `otpService.js:1` `createOtpChallenge(email, purpose, role, otp)`, `verifyOtpChallenge`, `checkRateLimit`, `RESEND_COOLDOWN_MS`. `otp_challenges: email, otp_hash, purpose (LOGIN_OTP/PASSWORD_RESET/REGISTER), target_role, expires_at (5m), used`.
- `brevoService.js:1` `sendLoginOtp`, `sendPasswordResetOtp` via `https://api.brevo.com/v3/smtp/email`. If `BREVO_API_KEY` missing and `NODE_ENV=development` logs OTP to console; `production` throws.
- `sessionService.js:1` `createSession (studentId, role)` returns `{sessionId, bindingToken}`, `revokeSession`, `rotateSession`. Cookie `cv_sid` + header `X-Session-Binding`.
- `mfaService.js:1` `createMfaChallenge`, `findChallenge`.
- `studentService.js:1` `findById`, `update`, `listForAdmin`.
- `announcementService.js:1` `create`, `listPublished`.
- `notificationService.js:1` `notifyCandidates` on announcements.
- `receiptService.js:1` `findByVoteId`, `verify`.
- `photoUploadService.js:1` `uploadCandidatePhoto` to `Appwrite` `candidate-photos` bucket via `node-appwrite`.

## Controllers `src/controllers` (thin HTTP, call services)
- `candidateApplicationController.js:12` `apply` validates `fullName/enrollmentNumber/department/year/section/bio/manifesto/age/dateOfBirth/gender/aadharNumber` (+ `section` for `BBA/BCA`), `category must CR`, `create`. `getMyApplication`, `getAccess`, `updateProfile` (approved/changes_requested), `resubmit`, `listForAdmin`, `approve`, `reject`, `requestChanges`, `assignBallot`.
- `candidateController.js:14` `listAll` `GET /api/v1/candidates` from `candidate_applications status=approved`, `get`, `list` by `positionId`, `update` (admin, `DRAFT/SCHEDULED` only).
- `electionController.js:1` `list`, `get`, `create`, `update`, `updateStatus` (+ `patch` for `start_time/end_time`), `getReadiness`, `publishResults`, `getTurnout`.
- `constituencyController.js:1` `list`, `create`, `update`.
- `positionController.js:1` `list` by `constituencyId`, `update`.
- `voteController.js:1` `cast` `POST /api/v1/elections/:id/votes`.
- `authorizationController.js:1` `check`, `authorize`.
- `studentController.js:1` `updateProfile`, `getMe`.
- `announcementController.js:1` `listPublished`, admin `adminAnnouncementController`.
- `uploadController.js:1` `POST /api/v1/uploads/photo` `X-CSRF-Token` + `X-Session-Binding`.

## Routes `src/routes` -> `src/app.js` mount
- `auth.js:35` `GET /auth/csrf`, `POST /auth/login`, `POST /auth/otp/send-login:495`, `POST /auth/otp/verify-login:627`, `POST /auth/register/student/otp`, `POST /auth/register/candidate/otp`, `GET /auth/me:45`, `POST /auth/profile`.
- `candidateApplications.js:16` `POST /api/candidates/apply`, `GET /api/candidates/me/application`, `GET /api/candidates/me/access`, `PATCH /api/candidates/me/profile`, `POST /api/candidates/me/resubmit`.
- `candidates.js:1` `GET /api/v1/candidates`, `GET /api/v1/candidates/:id`, `GET /api/v1/positions/:positionId/candidates`.
- `elections.js:1` `GET /api/v1/elections`, `GET /api/v1/elections/:id`.
- `votes.js:1` `POST /api/v1/elections/:id/votes`.
- `constituencies.js:1` `GET /api/v1/constituencies`, `POST /api/v1/constituencies` (admin).
- `positions.js:1` `GET /api/v1/positions`, etc.
- `adminElections.js:12` `GET/POST /api/v1/admin/elections`, `PATCH /:id`, `PATCH /:id/status`, `GET /:id/turnout`.
- `adminCandidates.js:1`, `adminCandidateApplications.js:1` `GET /admin/candidate-applications`, `PATCH /:id/approve`, `PATCH /:id/reject`, `POST /:id/assign-ballot`.
- `adminStudents.js:13` `GET /admin/students?limit=5000`, `POST /admin/students`, `PATCH /:id`, `PATCH /:id/status`.
- `health.js:1` `GET /api/health`, `GET /api/health/db`, `GET /api/v1/auth/debug/brevo-status:35`, `GET /debug/otp/:email`.

## Monitoring
- `monitoring/metrics.js:1` `campusvote_*` `prom-client`, `GET /metrics` (token) + `GET /api/v1/admin/monitoring`.
