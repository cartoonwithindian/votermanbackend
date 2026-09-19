-- Migration: 038_remove_clubs.sql
-- Removes the club concept entirely. The app now handles only Class
-- Representative (constituency-backed) elections:
--   * positions / votes become constituency-only (club_id dropped)
--   * voter_authorizations become election-wide only (club_id dropped)
--   * candidate_applications.nomination_club dropped
--   * the clubs table itself is dropped

BEGIN;

-- ---- 1. Delete club-backed vote data (children before parents) ----
DELETE FROM vote_receipts
 USING votes
 WHERE votes.id = vote_receipts.vote_id AND votes.club_id IS NOT NULL;

DELETE FROM votes WHERE club_id IS NOT NULL;

-- ---- 2. Delete club-scoped authorizations (election-wide grants remain) ----
-- Dedupe any leftover election-wide duplicates before re-adding the unique
-- constraint, then drop the now-unused club_id column.
DELETE FROM voter_authorizations WHERE club_id IS NOT NULL;

DELETE FROM voter_authorizations a
 USING voter_authorizations b
 WHERE a.id > b.id
   AND a.student_id = b.student_id
   AND a.election_id = b.election_id;

-- ---- 3. Delete club-backed candidates / applications / positions ----
DELETE FROM candidates
 WHERE position_id IN (SELECT id FROM positions WHERE club_id IS NOT NULL);

DELETE FROM candidate_applications
 WHERE position_id IN (SELECT id FROM positions WHERE club_id IS NOT NULL);

DELETE FROM positions WHERE club_id IS NOT NULL;

-- ---- 4. Drop club_id columns and their constraints/indexes ----
ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_club_id_fkey,
  DROP COLUMN IF EXISTS club_id;
ALTER TABLE positions ALTER COLUMN constituency_id SET NOT NULL;
DROP INDEX IF EXISTS idx_positions_club_id;
DROP INDEX IF EXISTS idx_positions_club_name;

-- Replace the old per-club position name uniqueness with per-constituency
-- name uniqueness (matching the service-level lower() duplicate check).
-- Deactivate older active duplicates first so the index can be created.
UPDATE positions p SET is_active = FALSE
 FROM positions q
 WHERE p.id > q.id
   AND p.constituency_id = q.constituency_id
   AND LOWER(p.name) = LOWER(q.name)
   AND p.is_active = TRUE AND q.is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_constituency_name
  ON positions (constituency_id, LOWER(name)) WHERE is_active = TRUE;

ALTER TABLE votes
  DROP CONSTRAINT IF EXISTS votes_club_id_fkey,
  DROP COLUMN IF EXISTS club_id;
ALTER TABLE votes ALTER COLUMN constituency_id SET NOT NULL;
DROP INDEX IF EXISTS idx_votes_club_id;

ALTER TABLE voter_authorizations
  DROP CONSTRAINT IF EXISTS voter_authorizations_club_id_fkey,
  DROP CONSTRAINT IF EXISTS voter_auth_unique,
  DROP COLUMN IF EXISTS club_id;
ALTER TABLE voter_authorizations
  ADD CONSTRAINT voter_auth_unique UNIQUE (student_id, election_id);
DROP INDEX IF EXISTS idx_voter_auth_club_id;

-- Nomination "for which club" field is obsolete — only CR positions exist now.
ALTER TABLE candidate_applications DROP COLUMN IF EXISTS nomination_club;

-- Update the display hint: elections are Class Representative elections.
ALTER TABLE elections ALTER COLUMN category SET DEFAULT 'CLASS_REPRESENTATIVE';

-- ---- 5. Drop the clubs table (drops its dependent indexes too) ----
DROP TABLE IF EXISTS clubs;

COMMIT;