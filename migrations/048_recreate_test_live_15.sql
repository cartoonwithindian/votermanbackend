-- Migration: 048_recreate_test_live_15.sql
-- Recreate TEST_ELECTION_DELETE_ME after 046 cleanup (which was applied prematurely locally).
-- Ensures 7 candidates (4G+3B) to be created live via OTP, and 8 voters authorized for the 15 total.
-- Idempotent.

DO $$
DECLARE
  test_election_id INT;
  test_constituency_id INT;
  voter_ids INT[];
  voter_emails TEXT[] := ARRAY['meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com','draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com'];
BEGIN
  SELECT id INTO test_election_id FROM elections WHERE name='TEST_ELECTION_DELETE_ME' LIMIT 1;
  IF test_election_id IS NULL THEN
    INSERT INTO elections (name, description, status, start_time, end_time, category)
    VALUES ('TEST_ELECTION_DELETE_ME','Live simulation 4G 3B TEST - real emails 15 total - will be deleted via 049', 'OPEN', NOW(), NOW()+INTERVAL '7 days', 'CLASS_REPRESENTATIVE')
    RETURNING id INTO test_election_id;
  ELSE
    UPDATE elections SET status='OPEN', end_time=NOW()+INTERVAL '7 days' WHERE id=test_election_id;
  END IF;

  SELECT id INTO test_constituency_id FROM constituencies WHERE election_id=test_election_id AND department='TEST' AND year='1st Year' AND section='T1' LIMIT 1;
  IF test_constituency_id IS NULL THEN
    INSERT INTO constituencies (election_id, department, year, section, name, is_active)
    VALUES (test_election_id, 'TEST','1st Year','T1','TEST 1st Year T1 - DELETE_ME', TRUE)
    RETURNING id INTO test_constituency_id;
  END IF;

  INSERT INTO positions (constituency_id, name, description, display_order, is_active) VALUES (test_constituency_id,'Class Representative (Boys)','Test Boys CR',1,TRUE) ON CONFLICT DO NOTHING;
  INSERT INTO positions (constituency_id, name, description, display_order, is_active) VALUES (test_constituency_id,'Class Representative (Girls)','Test Girls CR',2,TRUE) ON CONFLICT DO NOTHING;

  -- 8 voters
  SELECT ARRAY_AGG(s.id) INTO voter_ids FROM students s WHERE LOWER(s.email)=ANY(ARRAY(SELECT LOWER(x) FROM unnest(voter_emails) AS x));
  INSERT INTO voter_authorizations (student_id, election_id, is_authorized, authorized_at)
  SELECT unnest(voter_ids), test_election_id, TRUE, NOW() ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Recreated test election % with 8 voters', test_election_id;
END $$;

-- Ensure 15 whitelisted stay active
UPDATE students SET is_active=TRUE, voting_eligible=TRUE WHERE LOWER(email) IN ('serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com','backupwh196@gmail.com','surahnw@gmail.com','j46933223@gmail.com','theshirutonft@gmail.com','meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com','draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com');
