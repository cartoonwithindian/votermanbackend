-- Migration: 056_remove_all_elections.sql
-- Removes ALL elections and their dependent data (constituencies, positions,
-- candidates, candidate applications, votes, receipts, authorizations,
-- announcements, clubs [if still present]). Student accounts, sessions,
-- access requests and identity rows are left untouched so a fresh election
-- can be created from the admin UI.
-- Idempotent and tolerant: each DELETE only runs when its table exists.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vote_receipts',
    'votes',
    'candidate_applications',
    'candidates',
    'positions',
    'constituencies',
    'voter_authorizations',
    'announcements',
    'clubs',
    'elections'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I', t);
    END IF;
  END LOOP;
END $$;