-- Migration: 044_test_simulation_cleanup.sql
-- Deletes TEST_ELECTION_DELETE_ME and all TEST_COURSE test accounts after simulation.
-- Run after you confirm voting works: git add, commit, push -> Render auto-deletes.
-- Idempotent.

DELETE FROM vote_receipts WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM votes WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM voter_authorizations WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM candidates WHERE position_id IN (SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME')));
DELETE FROM candidate_applications WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME') OR department = 'TEST';
DELETE FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME'));
DELETE FROM constituencies WHERE election_id IN (SELECT id FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME');
DELETE FROM elections WHERE name = 'TEST_ELECTION_DELETE_ME';
DELETE FROM students WHERE email LIKE 'test-%@test.local' OR external_id LIKE 'TEST-%';
