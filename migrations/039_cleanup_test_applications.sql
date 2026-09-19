-- Migration: 039_cleanup_test_applications.sql
-- Remove test candidate application: Test Student 1st Year BBA 1st Year Section A1 CR Approved 2026-09-19
-- Runs via Render preDeployCommand: npm run migrate (idempotent)

-- Delete ballot row if approved created one (candidates table)
DELETE FROM candidates
WHERE name = 'Test Student 1st Year'
  AND position_id IN (
    SELECT p.id FROM positions p
    JOIN constituencies c ON c.id = p.constituency_id
    WHERE c.department = 'BBA' AND c.year = '1st Year' AND c.section = 'A1'
  );

-- Delete the application itself
DELETE FROM candidate_applications
WHERE full_name = 'Test Student 1st Year'
  AND department = 'BBA'
  AND year = '1st Year'
  AND section = 'A1'
  AND category = 'CR';

-- Optional: also clean legacy test students if they exist on Render (same as local seed)
DELETE FROM voter_authorizations WHERE student_id IN (SELECT id FROM students WHERE name = 'Test Student 1st Year' AND external_id = 'TEST-1SEM-001');
DELETE FROM votes WHERE student_id IN (SELECT id FROM students WHERE name = 'Test Student 1st Year' AND external_id = 'TEST-1SEM-001');
DELETE FROM students WHERE name = 'Test Student 1st Year' AND external_id = 'TEST-1SEM-001' AND department = 'BBA';
