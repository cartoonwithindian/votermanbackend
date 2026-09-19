-- Migration: 042_test_simulation_seed.sql
-- Isolated test simulation: 4 girls + 3 boys candidates + 7 voters for TEST_COURSE batch.
-- All rows FK to TEST_ELECTION_DELETE_ME (id auto). Deletion via 043.
-- Idempotent: skips if TEST_ELECTION_DELETE_ME already exists.

DO $$
DECLARE
  test_election_id INT;
  test_constituency_id INT;
  boys_pos_id INT;
  girls_pos_id INT;
  cand_student_ids INT[] := '{}';
  voter_student_ids INT[] := '{}';
  tmp_id INT;
  i INT;
  cand_names TEXT[] := ARRAY['Test Girl 1','Test Girl 2','Test Girl 3','Test Girl 4','Test Boy 1','Test Boy 2','Test Boy 3'];
  cand_genders TEXT[] := ARRAY['Female','Female','Female','Female','Male','Male','Male'];
  cand_emails TEXT[] := ARRAY['test-girl1@test.local','test-girl2@test.local','test-girl3@test.local','test-girl4@test.local','test-boy1@test.local','test-boy2@test.local','test-boy3@test.local'];
  voter_emails TEXT[] := ARRAY['test-voter1@test.local','test-voter2@test.local','test-voter3@test.local','test-voter4@test.local','test-voter5@test.local','test-voter6@test.local','test-voter7@test.local'];
BEGIN
  -- 1. Election (skip if exists)
  SELECT id INTO test_election_id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME' LIMIT 1;
  IF test_election_id IS NULL THEN
    INSERT INTO elections (name, description, status, start_time, end_time, category)
    VALUES ('TEST_ELECTION_DELETE_ME', 'Simulation - 4 girls 3 boys TEST_COURSE - will be deleted', 'OPEN', NOW(), NOW() + INTERVAL '7 days', 'CLASS_REPRESENTATIVE')
    RETURNING id INTO test_election_id;
    RAISE NOTICE 'Created test election id %', test_election_id;
  ELSE
    RAISE NOTICE 'Test election already exists id %', test_election_id;
  END IF;

  -- 2. Constituency TEST_COURSE / Test Year 1 / T1
  SELECT id INTO test_constituency_id FROM constituencies WHERE election_id = test_election_id AND department = 'TEST' AND year = '1st Year' AND section = 'T1' LIMIT 1;
  IF test_constituency_id IS NULL THEN
    INSERT INTO constituencies (election_id, department, year, section, name, is_active)
    VALUES (test_election_id, 'TEST', '1st Year', 'T1', 'TEST 1st Year T1 - DELETE_ME', TRUE)
    RETURNING id INTO test_constituency_id;
    RAISE NOTICE 'Created constituency %', test_constituency_id;
  END IF;

  -- 3. Positions (Boys/Girls) - idempotent via unique (constituency_id, LOWER(name))
  INSERT INTO positions (constituency_id, name, description, display_order, is_active)
  VALUES (test_constituency_id, 'Class Representative (Boys)', 'Test Boys CR', 1, TRUE)
  ON CONFLICT DO NOTHING;
  INSERT INTO positions (constituency_id, name, description, display_order, is_active)
  VALUES (test_constituency_id, 'Class Representative (Girls)', 'Test Girls CR', 2, TRUE)
  ON CONFLICT DO NOTHING;

  SELECT id INTO boys_pos_id FROM positions WHERE constituency_id = test_constituency_id AND LOWER(name) = LOWER('Class Representative (Boys)') AND is_active = TRUE LIMIT 1;
  SELECT id INTO girls_pos_id FROM positions WHERE constituency_id = test_constituency_id AND LOWER(name) = LOWER('Class Representative (Girls)') AND is_active = TRUE LIMIT 1;

  -- 4. 7 Candidate students + approved applications + ballot rows
  FOR i IN 1..7 LOOP
    tmp_id := NULL;
    INSERT INTO students (external_id, student_id, name, email, official_email, current_login_email, department, year_or_semester, section, is_active, voting_eligible, role, email_verified)
    VALUES (
      'TEST-CAND-' || LPAD(i::text,3,'0'),
      'TEST-CAND-' || LPAD(i::text,3,'0'),
      cand_names[i],
      cand_emails[i],
      cand_emails[i],
      cand_emails[i],
      'TEST', '1st Year', 'T1',
      TRUE, TRUE, 'CANDIDATE', TRUE
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO tmp_id;
    IF tmp_id IS NOT NULL THEN
      cand_student_ids[i] := tmp_id;
    ELSE
      SELECT id INTO tmp_id FROM students WHERE LOWER(email) = LOWER(cand_emails[i]) LIMIT 1;
      cand_student_ids[i] := tmp_id;
    END IF;

    -- candidate application approved
    INSERT INTO candidate_applications (student_id, full_name, enrollment_number, department, year, section, position_id, contesting_position, email, phone, profile_photo_url, bio, manifesto, age, date_of_birth, gender, aadhar_number, category, election_id, status, submitted_at, created_at)
    VALUES (
      cand_student_ids[i],
      cand_names[i],
      'TEST-ENROLL-CAND-' || LPAD(i::text,3,'0'),
      'TEST', '1st Year', 'T1',
      CASE WHEN cand_genders[i] = 'Female' THEN girls_pos_id ELSE boys_pos_id END,
      CASE WHEN cand_genders[i] = 'Female' THEN 'Class Representative (Girls)' ELSE 'Class Representative (Boys)' END,
      cand_emails[i],
      '900000000' || i,
      NULL,
      'Bio for ' || cand_names[i],
      'Manifesto for ' || cand_names[i] || ' - TEST',
      20, '2005-01-01', cand_genders[i], '12345678901' || i,
      'CR', test_election_id, 'approved', NOW(), NOW()
    )
    ON CONFLICT DO NOTHING;

    -- ballot row in candidates
    INSERT INTO candidates (position_id, name, description, display_order, is_active)
    VALUES (
      CASE WHEN cand_genders[i] = 'Female' THEN girls_pos_id ELSE boys_pos_id END,
      cand_names[i],
      'Test candidate ' || cand_names[i],
      i, TRUE
    )
    ON CONFLICT DO NOTHING;

  END LOOP;

  -- 5. 7 Voter students + authorizations for test election only (not election 1)
  FOR i IN 1..7 LOOP
    tmp_id := NULL;
    INSERT INTO students (external_id, student_id, name, email, official_email, current_login_email, department, year_or_semester, section, is_active, voting_eligible, role, email_verified)
    VALUES (
      'TEST-VOTER-' || LPAD(i::text,3,'0'),
      'TEST-VOTER-' || LPAD(i::text,3,'0'),
      'Test Voter ' || i,
      voter_emails[i],
      voter_emails[i],
      voter_emails[i],
      'TEST', '1st Year', 'T1',
      TRUE, TRUE, 'STUDENT', TRUE
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO tmp_id;
    IF tmp_id IS NOT NULL THEN
      voter_student_ids[i] := tmp_id;
    ELSE
      SELECT id INTO tmp_id FROM students WHERE LOWER(email) = LOWER(voter_emails[i]) LIMIT 1;
      voter_student_ids[i] := tmp_id;
    END IF;

    INSERT INTO voter_authorizations (student_id, election_id, is_authorized, authorized_at)
    VALUES (voter_student_ids[i], test_election_id, TRUE, NOW())
    ON CONFLICT DO NOTHING;
  END LOOP;

  RAISE NOTICE 'Test simulation seed complete: election %, constituency %, boys %, girls %', test_election_id, test_constituency_id, boys_pos_id, girls_pos_id;
END $$;
