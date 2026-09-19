-- Migration: 049_final_cleanup_after_15_test.sql
-- Final delete after you confirm 7 candidates (4G+3B) + 8 voters test works.
-- Push after test: git add migrations/049_final_cleanup_after_15_test.sql && git commit && git push
-- Render auto-deletes TEST_ELECTION_DELETE_ME and TEST rows, keeps 15 whitelisted + election #1.

DELETE FROM vote_receipts WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME');
DELETE FROM votes WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME');
DELETE FROM voter_authorizations WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME');
DELETE FROM candidates WHERE position_id IN (SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME')));
DELETE FROM candidate_applications WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME');
DELETE FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME'));
DELETE FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name='TEST_ELECTION_DELETE_ME');
DELETE FROM elections WHERE name='TEST_ELECTION_DELETE_ME';
-- Optional: keep 15 whitelisted as is (do not delete students), just ensure not TEST department
-- If you want to reset their TEST department after test, uncomment:
-- UPDATE students SET department=NULL, year_or_semester=NULL, section=NULL WHERE LOWER(email) IN ('serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com','backupwh196@gmail.com','surahnw@gmail.com','j46933223@gmail.com','theshirutonft@gmail.com','meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com','draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com') AND department='TEST';
