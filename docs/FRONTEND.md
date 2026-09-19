# Frontend Map — voteweb-frontend/src

## Config
- `src/lib/api/client.ts:1` `API_BASE = NEXT_PUBLIC_API_URL (/api/v1 proxy via nginx 80/443 -> backend:3000)`. All `api.get/post/patch` add `credentials: include` + `X-CSRF-Token` + `X-Session-Binding` (`session-binding.ts`).
- `src/lib/session-binding.ts:1` `setBindingToken(token)` stores `campusvote_binding_token` in `sessionStorage`; `client.ts` adds `X-Session-Binding` for `POST/PATCH/DELETE`.
- `src/proxy.ts:1` Next.js proxy `/api/*` -> `BACKEND_API_ORIGIN=http://backend:3000` (first-party cookies, fixes ITP).

## App Router `src/app`
- `layout.tsx:1` `ClerkProvider` (if `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), global fonts.
- `page.tsx:1` landing `/` (marketing).
- `student/login/page.tsx:1` `UnifiedAuthPage initialPortal="student" lockPortal` -> `components/auth/UnifiedAuth.tsx:111`.
- `candidate/login/page.tsx:1` `UnifiedAuthPage initialPortal="candidate" lockPortal`.
- `login/[[...rest]]/page.tsx:1` catch-all redirects to `/student/login` or `/candidate/login`.
- `auth/clerk-callback/page.tsx:1` exchanges `Clerk` session for `backend` session (`/auth/clerk-session`), sets `bindingToken`, redirects via `dashboard-route.ts`.
- `student/dashboard/page.tsx:60` `Hello, {firstName}` + `active election` (`OPEN` else `SCHEDULED` via `pickActiveElection:42`), `Vote` `/student/vote`, `Candidates` `/student/candidates`, `Candidate Nomination` `/candidate/login` (`eec0794` amber card). Loads `getMe`, `listElections`, `listAnnouncements` `Promise.allSettled`.
- `student/vote/page.tsx` Ballot: `lib/voting-api.ts` `GET /api/v1/elections/:id/ballot`, `POST /api/v1/elections/:id/votes` via `VotingContext`.
- `student/vote/review/page.tsx` + `success/page.tsx` + `receipt/page.tsx` voting flow.
- `student/candidates/page.tsx` + `[id]/page.tsx` + `compare/page.tsx` via `lib/candidates-api.ts` (`GET /api/v1/candidates` enriched).
- `candidate/apply/page.tsx:1` 3-step form `Verified Information` (name, enrollment/phone, course/batch, age/DOB/gender/aadhar) -> `Contact` (email/phone) -> `Candidate Content` (photo via `downscaleImageToDataUrl:92` + `uploadCandidatePhoto:141` -> `POST /api/v1/uploads/photo`, bio/manifesto, `CONFIRM`). `handleSubmit:324` `submitApplication({fullName, enrollmentNumber, department, year, section, category:"CR", email, phone, profilePhotoUrl, bio, manifesto, age, dateOfBirth, gender, aadharNumber})` -> `lib/candidate-api.ts:259` `POST /api/candidates/apply`. Locked if `status submitted/under_review/approved`.
- `candidate/status/page.tsx` `GET /api/candidates/me/application`.
- `candidate/profile/page.tsx` `PATCH /api/candidates/me/profile`.
- `candidate/campaign`, `manifesto`, `preview` read `GET /api/candidates/me/application`.
- `admin/*` `admin/dashboard/page.tsx:1` aggregates `admin/students`, `admin/candidate-applications`, `admin/elections/status`, `admin/announcements`, `supportsMetrics`.
  - `admin/students/page.tsx:152` `GET /admin/students?limit=5000`
  - `admin/candidates/page.tsx` `GET /admin/candidate-applications` + `PATCH /:id/approve|reject|request-changes` + `POST /:id/assign-ballot`
  - `admin/election/page.tsx` `GET /api/v1/admin/elections`, `PATCH /:id/status`
  - `admin/positions/page.tsx` `GET /api/v1/positions` + `GET /api/v1/constituencies`
  - `admin/announcements/page.tsx` CRUD `/admin/announcements`
  - `admin/voter-turnout/page.tsx:1` `GET /api/v1/admin/elections/:id/turnout` per-class `authorized/voted/pending`.
  - `admin/activity/page.tsx` `GET /api/v1/admin/audit-logs`
  - `admin/monitoring/page.tsx` `GET /metrics` / `GET /api/v1/admin/monitoring`.

## Lib `src/lib`
- `candidate-api.ts:1` Real backend client `CANDIDATE_BASE = /api/candidates` (strip `/api/v1`). `getMyApplication:210` `GET /me/application`, `getCandidateAccess:224` `GET /me/access`, `submitApplication:259` `POST /apply`, `updateMyProfile:276` `PATCH /me/profile`, `resubmitApplication:285` `POST /me/resubmit`, `listPositions:294` `GET /api/v1/positions`. `mapApplication:306` backend -> `CandidateApplicationData`.
- `api/client.ts:1` typed `api.get/post/patch` handles `bindingToken`, `csrf`.
- `api/v1.ts:1` `getMe`, `listElections {GET /api/v1/elections}`, `listAnnouncements`, `getPositions`, `listConstituencies`.
- `api/admin.ts:153` `getStudents`, `createStudent`, `updateStudent`, `updateStudentStatus`, `listApplications`, `approveApplication`.
- `voting-api.ts:1` `getBallot`, `castVote`, `getReceipt`, `verifyReceipt`.
- `candidates-api.ts:1` `GET /api/v1/candidates` list/detail/compare.
- `results-api.ts:1` `GET /api/v1/elections/:id/results`.
- `class-data.ts:1` `COURSES=[BBA,BCA,BCom,MBA,MCA]`, `SECTIONLESS_COURSES=[MBA,MCA,BCom]`, `getBatchesForCourse`, `seatLabel(department,year,section)`.
- `roll-number.ts:1` `getRollNumber` `localStorage` fallback for `1st Year` phone flow.
- `dashboard-route.ts:1` `destinationForPortal(portal, role)` -> `/student/dashboard`, `/candidate/dashboard`, `/admin/dashboard`.
- `election-voting-data.ts:1` `VotingPosition[]` mock type, now replaced by `voting-api`.

## Components `src/components`
- `auth/UnifiedAuth.tsx:111` `UnifiedAuthPage` `lockPortal` fixed toggle, `loginMethod password|code`, `GoogleSignInButton`, `ClerkOtpLogin`, `ClerkRegisterPanel`. Bottom alert `For Candidate Nomination -> /candidate/login` (`5ff1469` amber `Mic`).
- `auth/AuthLayout.tsx` + `AuthCard.tsx` + `AuthHeader.tsx`
- `candidate-dashboard/CandidateLayout.tsx`
- `layout/StudentLayout.tsx` + `AdminLayout.tsx` + `CadLayout.tsx`
- `ui/*` `CourseSelect`, `BatchSelect`, `Card`, `Button`, `Badge`.

## Env (frontend)
- `.env.local: NEXT_PUBLIC_API_URL=/api/v1`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_APP_URL=https://made-a.tech`, `BACKEND_API_ORIGIN=http://backend:3000`.
