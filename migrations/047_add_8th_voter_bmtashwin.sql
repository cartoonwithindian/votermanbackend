-- Migration: 047_add_8th_voter_bmtashwin.sql
-- Add 8th voter to reach 7 candidates + 8 voters = 15 total as requested (4 girls + 3 boys CR).
-- Idempotent. Render auto-deploy via npm run migrate.

DO $$
DECLARE
  test_election_id INT;
  voter_id INT;
BEGIN
  SELECT id INTO test_election_id FROM elections WHERE name='TEST_ELECTION_DELETE_ME' LIMIT 1;
  IF test_election_id IS NULL THEN
    RAISE NOTICE 'TEST_ELECTION_DELETE_ME not found, skipping 8th voter';
    RETURN;
  END IF;
  SELECT id INTO voter_id FROM students WHERE LOWER(email)=LOWER('bmtashwin009@gmail.com') LIMIT 1;
  IF voter_id IS NULL THEN
    RAISE NOTICE 'bmtashwin009 not found';
    RETURN;
  END IF;
  INSERT INTO voter_authorizations (student_id, election_id, is_authorized, authorized_at)
  VALUES (voter_id, test_election_id, TRUE, NOW())
  ON CONFLICT DO NOTHING;
  RAISE NOTICE 'Added 8th voter bmtashwin009 for election %', test_election_id;
END $$;
