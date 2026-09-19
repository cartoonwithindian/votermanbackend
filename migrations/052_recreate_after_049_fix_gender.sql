-- Migration: 052_recreate_after_049_fix_gender.sql
-- 049 deleted TEST_ELECTION_DELETE_ME prematurely (applied before live verification of 051 gender fix).
-- Recreate it correctly with gendered positions and re-authorize 8 voters, and re-insert the 2 live candidates with correct positions.
-- Idempotent.

DO $$
DECLARE
  test_election_id INT;
  test_constituency_id INT;
  boys_pos_id INT;
  girls_pos_id INT;
  voter_ids INT[];
  voter_emails TEXT[] := ARRAY['meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com','draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com'];
  who_id INT;
  ctrl_id INT;
BEGIN
  SELECT id INTO test_election_id FROM elections WHERE name='TEST_ELECTION_DELETE_ME' LIMIT 1;
  IF test_election_id IS NULL THEN
    INSERT INTO elections (name, description, status, start_time, end_time, category)
    VALUES ('TEST_ELECTION_DELETE_ME','Live simulation 4G 3B TEST - real emails 15 total - recreated after 049', 'OPEN', NOW(), NOW()+INTERVAL '7 days', 'CLASS_REPRESENTATIVE')
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

  INSERT INTO positions (constituency_id, name, description, display_order, is_active, gender)
  VALUES (test_constituency_id,'Class Representative (Boys)','Test Boys CR',1,TRUE,'Male') ON CONFLICT DO NOTHING;
  INSERT INTO positions (constituency_id, name, description, display_order, is_active, gender)
  VALUES (test_constituency_id,'Class Representative (Girls)','Test Girls CR',2,TRUE,'Female') ON CONFLICT DO NOTHING;
  -- ensure gender correct if existing with NULL
  UPDATE positions SET gender='Male' WHERE constituency_id=test_constituency_id AND name='Class Representative (Boys)' AND (gender IS NULL OR gender != 'Male');
  UPDATE positions SET gender='Female' WHERE constituency_id=test_constituency_id AND name='Class Representative (Girls)' AND (gender IS NULL OR gender != 'Female');
  SELECT id INTO boys_pos_id FROM positions WHERE constituency_id=test_constituency_id AND name='Class Representative (Boys)' LIMIT 1;
  SELECT id INTO girls_pos_id FROM positions WHERE constituency_id=test_constituency_id AND name='Class Representative (Girls)' LIMIT 1;

  -- 8 voters
  SELECT ARRAY_AGG(s.id) INTO voter_ids FROM students s WHERE LOWER(s.email)=ANY(ARRAY(SELECT LOWER(x) FROM unnest(voter_emails) AS x));
  INSERT INTO voter_authorizations (student_id, election_id, is_authorized, authorized_at)
  SELECT unnest(voter_ids), test_election_id, TRUE, NOW() ON CONFLICT DO NOTHING;

  -- Re-insert the 2 live candidates with correct positions (if not already present)
  SELECT id INTO who_id FROM students WHERE LOWER(email)=LOWER('who07512@gmail.com') LIMIT 1;
  SELECT id INTO ctrl_id FROM students WHERE LOWER(email)=LOWER('ctrlplusz069@gmail.com') LIMIT 1;

  -- Who07512 Male -> Boys
  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, aadhar_number, category, election_id, status, submitted_at, created_at)
  VALUES (who_id, 'Who07512', 'TEST-ENROLL-WHO', 'TEST','1st Year','T1', boys_pos_id, 'Class Representative (Boys)', 'who07512@gmail.com','9000000011', 'https://fra.cloud.appwrite.io/v1/storage/buckets/candidate-photos/files/6aae5e07003d4f3626bf/view?project=6a961a3200335ef36ba8', 'first time first time','first time first time',20,'2005-01-01','Male','123456789012', 'CR', test_election_id, 'approved', NOW(), NOW())
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  VALUES (boys_pos_id, 'Who07512','first time first time',1,TRUE) ON CONFLICT DO NOTHING;

  -- Ctrlplusz069 Female -> Girls (was incorrectly Boys before 051)
  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, aadhar_number, category, election_id, status, submitted_at, created_at)
  VALUES (ctrl_id, 'Ctrlplusz069', 'TEST-ENROLL-CTRL', 'TEST','1st Year','T1', girls_pos_id, 'Class Representative (Girls)', 'ctrlplusz069@gmail.com','9000000022', 'https://fra.cloud.appwrite.io/v1/storage/buckets/candidate-photos/files/6aae5fa30023b875fb1a/view?project=6a961a3200335ef36ba8', 'HEUHEKUH','HEUHEKUH',20,'2005-01-01','Female','123456789013', 'CR', test_election_id, 'approved', NOW(), NOW())
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  VALUES (girls_pos_id, 'Ctrlplusz069','HEUHEKUH',2,TRUE) ON CONFLICT DO NOTHING;

  RAISE NOTICE '052 recreated test election % constituency % boys % girls % with 8 voters and 2 candidates corrected', test_election_id, test_constituency_id, boys_pos_id, girls_pos_id;
END $$;
