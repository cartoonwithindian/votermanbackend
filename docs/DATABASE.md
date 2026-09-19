# Database — Postgres 16 `voteweb` `127.0.0.1:5434` / `Render` internal

## Connection
- `voteweb-backend/.env: DATABASE_URL=postgres://voteweb:voteweb@127.0.0.1:5434/voteweb` `DB_SSL=false` local, `true` on `Render`.
- `src/config/database.js` pool `min2 max10`. Migrations track `migrations` table `id, name, executed_at`.

## Core Tables

### `elections: migrations/001_elections.sql:1`
- `id SERIAL PK`, `name VARCHAR(255)`, `description TEXT`, `status VARCHAR(50) CHECK (draft/scheduled/open/closed/published)`, `start_time TIMESTAMPTZ`, `end_time TIMESTAMPTZ`, `category VARCHAR(50) DEFAULT CLASS_REPRESENTATIVE` (`038` set default), `results_published_at`, `created_at`.
- Index `idx_elections_status`.

### `students: migrations/002_students.sql:1` + `022_add_username_mobile.sql` + `024_...` + `026_cad_role`
- `id SERIAL PK`, `external_id VARCHAR(100) UNIQUE`, `name`, `email VARCHAR(255) UNIQUE`, `role ENUM (STUDENT/CANDIDATE/ADMIN/CAD)`, `password_hash`, `roll_number`, `mobile_number`, `department`, `year_or_semester`, `section`, `voting_eligible BOOLEAN`, `is_active BOOLEAN`, `totp_secret_encrypted`, `failed_login_attempts`, `locked_until`.
- `CLERK` users have `external_id=clerk_xxx`.

### `constituencies: migrations/030_class_representative.sql:1`
- `id SERIAL PK`, `election_id FK elections.id CASCADE`, `department`, `year`, `section`, `name` (`seatLabel`), `is_active`, `created_at`. Unique `(election_id, department, year, section)`.
- Auto-creates 2 `positions` per constituency `031_gendered_cr_positions.sql`.

### `positions: migrations/004_positions.sql:1` + `029_positions_max_selections.sql` + `038`
- `id SERIAL PK`, `constituency_id FK constituencies.id CASCADE NOT NULL` (`038` dropped `club_id`, set `constituency_id NOT NULL`), `name` (`Class Representative (Boys/Girls)`), `description`, `display_order`, `max_selections`, `is_active`. Unique `idx_positions_constituency_name (constituency_id, LOWER(name)) WHERE is_active`.
- `038` dropped `positions_club_id_fkey`, `idx_positions_club_id`.

### `candidates: migrations/005_candidates.sql:1` + `032_candidates_image_url_text.sql`
- `id SERIAL PK`, `position_id FK positions.id`, `name`, `description`, `image_url TEXT`, `display_order`, `is_active`, `created_at`. Partial unique `(position_id, name) WHERE is_active`.

### `candidate_applications: migrations/021_candidate_applications.sql:1` + `023` + `027` + `030` + `038` + `039`/`040` cleanup
- `id`, `student_id FK students.id CASCADE`, `full_name`, `enrollment_number`, `department`, `year`, `semester`, `section`, `position_id FK positions.id NULL` (`027` `DROP NOT NULL`), `contesting_position VARCHAR(255)` (`027`), `email`, `phone`, `profile_photo_url TEXT`, `bio`, `manifesto`, `age`, `date_of_birth DATE`, `gender CHECK (Male/Female/Other)`, `aadhar_number`, `category VARCHAR(30) DEFAULT CR` (`030` added `category/election_id`), `election_id FK elections.id`, `status CHECK (draft/submitted/under_review/changes_requested/approved/rejected)`, `rejection_reason`, `changes_requested_reason`, `reviewed_by FK students.id`, `reviewed_at`, `submitted_at`, `created_at`, `updated_at`.
- `027` added `nomination_club` + `contesting_position` + made `position_id` nullable. `038:74` `DROP COLUMN IF EXISTS nomination_club`, deleted `club`-scoped rows. `039/040` cleanup test rows.
- Indexes: `idx_candidate_applications_enrollment UNIQUE (enrollment_number) WHERE status != rejected`, `idx_candidate_applications_student_position UNIQUE (student_id, position_id) WHERE status IN (under_review,changes_requested,approved)`.

### `voter_authorizations: migrations/006_voter_authorizations.sql:1` + `038`
- `id`, `student_id FK`, `election_id FK`, `is_authorized BOOLEAN DEFAULT true`, `authorized_at`, `authorized_by`. Unique `voter_auth_unique (student_id, election_id)` (`038` dropped `club_id`, added unique, deleted `club_id IS NOT NULL` rows).

### `votes: migrations/007_votes.sql:1` + `038`
- `id`, `student_id FK`, `election_id FK`, `constituency_id FK NOT NULL` (`038` dropped `club_id`, set `constituency_id NOT NULL`), `position_id FK`, `candidate_id FK`, `created_at`. Unique `idx_votes_student_position UNIQUE (student_id, position_id)` prevents double vote.

### `vote_receipts: migrations/013_create_vote_receipts.sql:1`
- `id`, `vote_id FK votes.id`, `student_id FK`, `election_id FK`, `receipt_hash VARCHAR(255) UNIQUE`, `created_at`. Public verify `GET /api/v1/receipts/:hash`.

### `otp_challenges: migrations/021_otp_challenges.sql:1`
- `id`, `email`, `otp_hash`, `purpose (LOGIN_OTP/PASSWORD_RESET/REGISTER)`, `target_role`, `attempts`, `used BOOLEAN`, `rate_key`, `created_at`, `expires_at (5m)`, `consumed_at`.

### `sessions: migrations/020_authentication.sql:1`
- `id`, `student_id FK`, `binding_token_hash`, `expires_at`, `created_at`. Cookie `cv_sid`.

### Others
- `announcements: 014`, `support_requests: 015`, `notifications: 016` (user_id, title, message, read), `auth_audit_logs: 008` (`auth_audit_logs` `admin_audit_logs` for `admin/activity`), `mfa_challenges`, `students` `access_requests` `025/036/037`.

## Migration Order (critical)
`001` elections -> `002` students -> `004` positions -> `005` candidates -> `006` voter_authorizations -> `007` votes -> `013` receipts -> `021` candidate_applications + otp_challenges -> `023` extra_fields -> `027` nomination_club -> `030` CR constituencies -> `031` gendered positions -> `038` remove clubs (DROP club_id + nomination_club, DROP clubs table) -> `039`/`040` test cleanup.

Run: `cd voteweb-backend && node migrate.js up` (`status`, `down <name>`).
