-- Migration: 045_test_simulation_real_emails.sql
-- Real-email test simulation: uses your 15 whitelisted live mails for same-as-live OTP + Google + candidate form.
-- 7 candidates (4 girls + 3 boys) for TEST 1st Year T1, 7 voters for same test election.
-- All rows FK to TEST_ELECTION_DELETE_ME (recreated if 044 deleted it). Idempotent.
-- You will do live: OTP/Google -> candidate/apply -> admin approve -> vote -> delete via 046.

DO $$
DECLARE
  test_election_id INT;
  test_constituency_id INT;
  boys_pos_id INT;
  girls_pos_id INT;
  voter_ids INT[];
BEGIN
  -- 1. Ensure test election exists (044 may have deleted it)
  SELECT id INTO test_election_id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME' LIMIT 1;
  IF test_election_id IS NULL THEN
    INSERT INTO elections (name, description, status, start_time, end_time, category)
    VALUES ('TEST_ELECTION_DELETE_ME', 'Live simulation 4G 3B TEST - real emails - will be deleted via 046', 'OPEN', NOW(), NOW() + INTERVAL '7 days', 'CLASS_REPRESENTATIVE')
    RETURNING id INTO test_election_id;
    RAISE NOTICE 'Created TEST_ELECTION_DELETE_ME %', test_election_id;
  ELSE
    -- ensure OPEN for voting
    UPDATE elections SET status='OPEN', end_time = NOW() + INTERVAL '7 days' WHERE id=test_election_id;
    RAISE NOTICE 'Reusing test election %', test_election_id;
  END IF;

  -- 2. Constituency TEST / 1st Year / T1
  SELECT id INTO test_constituency_id FROM constituencies WHERE election_id=test_election_id AND department='TEST' AND year='1st Year' AND section='T1' LIMIT 1;
  IF test_constituency_id IS NULL THEN
    INSERT INTO constituencies (election_id, department, year, section, name, is_active)
    VALUES (test_election_id, 'TEST', '1st Year', 'T1', 'TEST 1st Year T1 - DELETE_ME', TRUE)
    RETURNING id INTO test_constituency_id;
  END IF;

  INSERT INTO positions (constituency_id, name, description, display_order, is_active)
  VALUES (test_constituency_id, 'Class Representative (Boys)', 'Test Boys CR', 1, TRUE) ON CONFLICT DO NOTHING;
  INSERT INTO positions (constituency_id, name, description, display_order, is_active)
  VALUES (test_constituency_id, 'Class Representative (Girls)', 'Test Girls CR', 2, TRUE) ON CONFLICT DO NOTHING;
  SELECT id INTO boys_pos_id FROM positions WHERE constituency_id=test_constituency_id AND LOWER(name)=LOWER('Class Representative (Boys)') LIMIT 1;
  SELECT id INTO girls_pos_id FROM positions WHERE constituency_id=test_constituency_id AND LOWER(name)=LOWER('Class Representative (Girls)') LIMIT 1;

  -- 3. Ensure 7 voter students are authorized for test election only (not main election 1)
  -- Voters: meryrajam, jfjrihrje, who07512, ctrlplusz069, ctrlpluss9, draza108, madea.official1
  WITH voter_emails(email) AS (
    VALUES ('meryrajam@gmail.com'),('jfjrihrje@gmail.com'),('who07512@gmail.com'),('ctrlplusz069@gmail.com'),('ctrlpluss9@gmail.com'),('draza108@gmail.com'),('madea.official1@gmail.com')
  )
  SELECT ARRAY_AGG(s.id) INTO voter_ids
  FROM students s JOIN voter_emails ve ON LOWER(s.email)=LOWER(ve.email);

  -- Insert authorizations for test election (leave election 1 untouched)
  INSERT INTO voter_authorizations (student_id, election_id, is_authorized, authorized_at)
  SELECT unnest(voter_ids), test_election_id, TRUE, NOW()
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Test setup complete: election % constituency % boys % girls % voters %', test_election_id, test_constituency_id, boys_pos_id, girls_pos_id, array_length(voter_ids,1);

  -- 4. Candidates: NOT pre-inserted. You will do live OTP/Google -> https://made-a.tech/candidate/login -> candidate/apply
  -- For 4 girls (serwinbm, cartoonwithindian, abastin443, backupwh196) and 3 boys (surahnw, j46933223, theshirutonft)
  -- Fill department=TEST, year=1st Year, section=T1, category=CR, then admin approves with electionId/test_constituency_id -> ballot appears.
  -- Leftover whitelist bmtashwin009@gmail.com remains spare.
END $$;

-- Ensure whitelist still active for all 15 (in case 041 not yet applied on Render)
UPDATE students SET is_active=TRUE, voting_eligible=TRUE, email_verified=TRUE
WHERE LOWER(email) IN ('serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com','backupwh196@gmail.com','surahnw@gmail.com','j46933223@gmail.com','theshirutonft@gmail.com','meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com','draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com');
