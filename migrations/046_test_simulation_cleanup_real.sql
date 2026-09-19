-- Migration: 046_test_simulation_cleanup_real.sql
-- Deletes live real-email test simulation after you confirm everything works.
-- Run: git add migrations/046_test_simulation_cleanup_real.sql && git commit -m "chore: delete real-email test" && git push
-- Render auto-deletes. Keeps 15 whitelisted emails (resets TEST department), keeps election #1.

-- Delete votes/receipts for test election
DELETE FROM vote_receipts WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM votes WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM voter_authorizations WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
-- Delete candidate ballot + applications for TEST (created live via candidate/apply)
DELETE FROM candidates WHERE position_id IN (SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME')));
DELETE FROM candidate_applications WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME'));
DELETE FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME';
-- Reset TEST voters department (optional, keep whitelist but clear TEST)
UPDATE students SET department=NULL, year_or_semester=NULL, section=NULL WHERE LOWER(email) IN ('meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com','draza108@gmail.com','madea.official1@gmail.com') AND department='TEST';
-- Note: candidate students (serwinbm etc) keep their TEST application history until they are also reset if needed
-- To fully reset candidates too, uncomment:
-- UPDATE students SET department=NULL, year_or_semester=NULL, section=NULL, role='STUDENT' WHERE LOWER(email) IN ('serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com','backupwh196@gmail.com','surahnw@gmail.com','j46933223@gmail.com','theshirutonft@gmail.com') AND department='TEST';
