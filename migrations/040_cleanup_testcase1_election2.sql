-- Migration: 040_cleanup_testcase1_election2.sql
-- Remove testcase1 Election #2 via Render auto-deploy (idempotent)

DELETE FROM vote_receipts WHERE election_id = 2;
DELETE FROM votes WHERE election_id = 2;
DELETE FROM voter_authorizations WHERE election_id = 2;
DELETE FROM candidates WHERE position_id IN (
  SELECT id FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 2)
);
DELETE FROM positions WHERE constituency_id IN (SELECT id FROM constituencies WHERE election_id = 2);
DELETE FROM constituencies WHERE election_id = 2;
DELETE FROM elections WHERE id = 2 AND name = 'testcase1';
-- Fallback: if name differs but id=2 is test, delete by id only if not the real election
-- DELETE FROM elections WHERE id = 2 AND name ILIKE 'testcase%';
