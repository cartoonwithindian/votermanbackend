-- Migration: 057_test_sim_7_candidates_seed.sql
-- Isolated TEST simulation election for TEST / 1st Year / T1.
-- 7 candidates seeded directly (4 girls CR + 3 boys CR). All 16 TEST/T1
-- students receive voting rights on this election only. Main elections are
-- left untouched. Idempotent.

DO $$
DECLARE
  test_election_id INT;
  test_constituency_id INT;
  boys_pos_id INT;
  girls_pos_id INT;
  voter_count INT;
BEGIN
  -- 1. Isolated sim election
  SELECT id INTO test_election_id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME' LIMIT 1;
  IF test_election_id IS NULL THEN
    INSERT INTO elections (name, description, status, start_time, end_time, category)
    VALUES ('TEST_ELECTION_DELETE_ME', 'TEST simulation 4G 3B - seeded candidates, isolated, will be deleted', 'OPEN', NOW(), NOW() + INTERVAL '7 days', 'CLASS_REPRESENTATIVE')
    RETURNING id INTO test_election_id;
  ELSE
    UPDATE elections SET status='OPEN', end_time = NOW() + INTERVAL '7 days' WHERE id = test_election_id;
  END IF;

  -- 2. Constituency TEST / 1st Year / T1
  SELECT id INTO test_constituency_id FROM constituencies
  WHERE election_id = test_election_id AND department='TEST' AND year='1st Year' AND section='T1' LIMIT 1;
  IF test_constituency_id IS NULL THEN
    INSERT INTO constituencies (election_id, department, year, section, name, is_active)
    VALUES (test_election_id, 'TEST', '1st Year', 'T1', 'TEST 1st Year T1 - DELETE_ME', TRUE)
    RETURNING id INTO test_constituency_id;
  END IF;

  -- 3. Gendered positions
  INSERT INTO positions (constituency_id, name, description, display_order, is_active, gender)
  VALUES (test_constituency_id, 'Class Representative (Boys)', 'Test Boys CR', 1, TRUE, 'Male') ON CONFLICT DO NOTHING;
  INSERT INTO positions (constituency_id, name, description, display_order, is_active, gender)
  VALUES (test_constituency_id, 'Class Representative (Girls)', 'Test Girls CR', 2, TRUE, 'Female') ON CONFLICT DO NOTHING;
  UPDATE positions SET gender='Male' WHERE constituency_id=test_constituency_id AND name='Class Representative (Boys)' AND (gender IS NULL OR gender != 'Male');
  UPDATE positions SET gender='Female' WHERE constituency_id=test_constituency_id AND name='Class Representative (Girls)' AND (gender IS NULL OR gender != 'Female');
  SELECT id INTO boys_pos_id FROM positions WHERE constituency_id=test_constituency_id AND name='Class Representative (Boys)' LIMIT 1;
  SELECT id INTO girls_pos_id FROM positions WHERE constituency_id=test_constituency_id AND name='Class Representative (Girls)' LIMIT 1;

  -- 4. Seed 7 candidates (directly, bypassing live apply flow)
  -- Boys CR
  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Cartoon With Indian', 'SIM-ENROLL-9011', 'TEST', '1st Year', 'T1', boys_pos_id, 'Class Representative (Boys)', s.email, '9100000011', NULL, 'Cartoon boy candidate', 'Vote Cartoon', 20, '2005-01-01', 'Male', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1760
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT boys_pos_id, 'Cartoon With Indian', 'Cartoon boy candidate', 1, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=boys_pos_id AND c.name='Cartoon With Indian');

  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Ctrlplusz069', 'SIM-ENROLL-9012', 'TEST', '1st Year', 'T1', boys_pos_id, 'Class Representative (Boys)', s.email, '9100000012', NULL, 'Ctrlplusz boy candidate', 'Vote Ctrlplusz', 20, '2005-01-01', 'Male', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1769
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT boys_pos_id, 'Ctrlplusz069', 'Ctrlplusz boy candidate', 2, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=boys_pos_id AND c.name='Ctrlplusz069');

  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Theshiru Tonft', 'SIM-ENROLL-9013', 'TEST', '1st Year', 'T1', boys_pos_id, 'Class Representative (Boys)', s.email, '9100000013', NULL, 'Theshiru boy candidate', 'Vote Theshiru', 20, '2005-01-01', 'Male', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1765
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT boys_pos_id, 'Theshiru Tonft', 'Theshiru boy candidate', 3, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=boys_pos_id AND c.name='Theshiru Tonft');

  -- Girls CR
  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Abastin', 'SIM-ENROLL-9021', 'TEST', '1st Year', 'T1', girls_pos_id, 'Class Representative (Girls)', s.email, '9100000021', NULL, 'Abastin girl candidate', 'Vote Abastin', 20, '2005-01-01', 'Female', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1761
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT girls_pos_id, 'Abastin', 'Abastin girl candidate', 1, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=girls_pos_id AND c.name='Abastin');

  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Draza108', 'SIM-ENROLL-9022', 'TEST', '1st Year', 'T1', girls_pos_id, 'Class Representative (Girls)', s.email, '9100000022', NULL, 'Draza girl candidate', 'Vote Draza', 20, '2005-01-01', 'Female', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1771
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT girls_pos_id, 'Draza108', 'Draza girl candidate', 2, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=girls_pos_id AND c.name='Draza108');

  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Jfjrihrje', 'SIM-ENROLL-9023', 'TEST', '1st Year', 'T1', girls_pos_id, 'Class Representative (Girls)', s.email, '9100000023', NULL, 'Jfjrihrje girl candidate', 'Vote Jfjrihrje', 20, '2005-01-01', 'Female', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1767
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT girls_pos_id, 'Jfjrihrje', 'Jfjrihrje girl candidate', 3, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=girls_pos_id AND c.name='Jfjrihrje');

  INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, category, election_id, status, submitted_at, created_at)
  SELECT s.id, 'Surah NW', 'SIM-ENROLL-9024', 'TEST', '1st Year', 'T1', girls_pos_id, 'Class Representative (Girls)', s.email, '9100000024', NULL, 'Surah girl candidate', 'Vote Surah', 20, '2005-01-01', 'Female', 'CR', test_election_id, 'approved', NOW(), NOW()
  FROM students s WHERE s.id = 1763
  ON CONFLICT DO NOTHING;
  INSERT INTO candidates (position_id, name, description, display_order, is_active)
  SELECT girls_pos_id, 'Surah NW', 'Surah girl candidate', 4, TRUE WHERE NOT EXISTS (SELECT 1 FROM candidates c WHERE c.position_id=girls_pos_id AND c.name='Surah NW');

  -- 5. Voting rights for all 16 TEST / 1 Sem / T1 students (incl. the 7 candidates)
  INSERT INTO voter_authorizations (student_id, election_id, is_authorized, authorized_at)
  SELECT s.id, test_election_id, TRUE, NOW()
  FROM students s
  WHERE s.department='TEST' AND s.year_or_semester='1 Sem' AND s.section='T1'
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO voter_count
  FROM voter_authorizations WHERE election_id = test_election_id AND is_authorized;

  RAISE NOTICE '057 sim: election % constituency % boys % girls % voters %', test_election_id, test_constituency_id, boys_pos_id, girls_pos_id, voter_count;
END $$;