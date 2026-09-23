-- Migration: 058_add_constituency_voting_open.sql
-- Adds a per-class "voting open" master switch on constituencies.
--
-- Model: a class's CR voting is open only when BOTH the election is OPEN and
-- this flag is true. Admin starts/stops voting per class via the existing
-- admin PATCH endpoint (voting_open is a runtime switch, not a structural
-- change, so it is allowed even when the election is OPEN).
--
-- Default FALSE: a freshly created / existing constituency is closed until
-- admin explicitly starts voting for it.
ALTER TABLE constituencies ADD COLUMN IF NOT EXISTS voting_open BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN constituencies.voting_open IS
    'Per-class voting switch. CR votes are accepted only if the election is OPEN AND this flag is true. Default false (closed until admin starts the class).';