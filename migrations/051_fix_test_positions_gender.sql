-- Migration: 051_fix_test_positions_gender.sql
-- Fixes TEST_ELECTION_DELETE_ME positions gender NULL and reassigns Ctrlplusz069 (Female) from Boys to Girls.
-- Idempotent.

-- Fix positions gender for TEST election (and any other with NULL)
UPDATE positions SET gender='Male', updated_at=NOW()
WHERE name='Class Representative (Boys)' AND (gender IS NULL OR gender != 'Male')
  AND constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME'));

UPDATE positions SET gender='Female', updated_at=NOW()
WHERE name='Class Representative (Girls)' AND (gender IS NULL OR gender != 'Female')
  AND constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME'));

-- Reassign misassigned Female candidates from Boys to Girls
WITH test_const AS (
  SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME') LIMIT 1
), boys AS (
  SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM test_const) AND name='Class Representative (Boys)' LIMIT 1
), girls AS (
  SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM test_const) AND name='Class Representative (Girls)' LIMIT 1
)
UPDATE candidate_applications ca
SET position_id = (SELECT id FROM girls), updated_at=NOW()
WHERE ca.election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME')
  AND ca.gender='Female'
  AND ca.position_id = (SELECT id FROM boys);

-- Same for ballot candidates table (if used)
WITH test_const AS (
  SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME') LIMIT 1
), boys AS (
  SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM test_const) AND name='Class Representative (Boys)' LIMIT 1
), girls AS (
  SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM test_const) AND name='Class Representative (Girls)' LIMIT 1
)
UPDATE candidates c
SET position_id = (SELECT id FROM girls)
FROM candidate_applications ca
WHERE c.position_id = (SELECT id FROM boys)
  AND c.name = ca.full_name
  AND ca.gender='Female'
  AND ca.election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME');
