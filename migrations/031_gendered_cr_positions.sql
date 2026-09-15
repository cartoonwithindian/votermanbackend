-- Migration: 031_gendered_cr_positions.sql
-- Adds a gender discriminator to positions so a class constituency can expose
-- two lock-step Class Representative seats (one Boy CR + one Girl CR).
-- NULL = unisex/club position (legacy Class Representative seats remain ungendered).

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS gender VARCHAR(10) CHECK (gender IN ('Male', 'Female'));

COMMENT ON COLUMN positions.gender IS
  'Gender scoping for Class Representative seats: Male | Female | NULL (unisex/club). Used to route an approved CR applicant onto the seat matching their gender.';