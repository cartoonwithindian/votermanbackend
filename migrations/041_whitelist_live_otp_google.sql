-- Migration: 041_whitelist_live_otp_google.sql
-- Whitelist 15 live emails for OTP + Google (Clerk) login.
-- Idempotent via ON CONFLICT DO NOTHING on LOWER(email).
-- Render auto-deploys via preDeployCommand: npm run migrate.

-- Ensure extension for gen_random_uuid if needed (not used here, uses external_id pattern)
-- Insert each email as a whitelisted STUDENT, is_active=true, voting_eligible=true.

INSERT INTO students (external_id, student_id, name, email, official_email, current_login_email, department, year_or_semester, section, is_active, voting_eligible, role, email_verified)
VALUES
  ('WHITELIST-serwinbm-001', 'WHITELIST-serwinbm-001', 'Serwin BM', 'serwinbm@gmail.com', 'serwinbm@gmail.com', 'serwinbm@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-cartoonwithindian-001', 'WHITELIST-cartoonwithindian-001', 'Cartoon With Indian', 'cartoonwithindian@gmail.com', 'cartoonwithindian@gmail.com', 'cartoonwithindian@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-abastin443-001', 'WHITELIST-abastin443-001', 'Abastin', 'abastin443@gmail.com', 'abastin443@gmail.com', 'abastin443@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-backupwh196-001', 'WHITELIST-backupwh196-001', 'Backup WH', 'backupwh196@gmail.com', 'backupwh196@gmail.com', 'backupwh196@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-surahnw-001', 'WHITELIST-surahnw-001', 'Surah NW', 'surahnw@gmail.com', 'surahnw@gmail.com', 'surahnw@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-j46933223-001', 'WHITELIST-j46933223-001', 'J 46933223', 'j46933223@gmail.com', 'j46933223@gmail.com', 'j46933223@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-theshirutonft-001', 'WHITELIST-theshirutonft-001', 'Theshiru Tonft', 'theshirutonft@gmail.com', 'theshirutonft@gmail.com', 'theshirutonft@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-meryrajam-001', 'WHITELIST-meryrajam-001', 'Mery Rajam', 'meryrajam@gmail.com', 'meryrajam@gmail.com', 'meryrajam@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-jfjrihrje-001', 'WHITELIST-jfjrihrje-001', 'Jfjrihrje', 'jfjrihrje@gmail.com', 'jfjrihrje@gmail.com', 'jfjrihrje@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-who07512-001', 'WHITELIST-who07512-001', 'Who07512', 'who07512@gmail.com', 'who07512@gmail.com', 'who07512@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-ctrlplusz069-001', 'WHITELIST-ctrlplusz069-001', 'Ctrlplusz069', 'ctrlplusz069@gmail.com', 'ctrlplusz069@gmail.com', 'ctrlplusz069@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-ctrlpluss9-001', 'WHITELIST-ctrlpluss9-001', 'Ctrlpluss9', 'ctrlpluss9@gmail.com', 'ctrlpluss9@gmail.com', 'ctrlpluss9@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-draza108-001', 'WHITELIST-draza108-001', 'Draza108', 'draza108@gmail.com', 'draza108@gmail.com', 'draza108@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-madeaofficial1-001', 'WHITELIST-madeaofficial1-001', 'Madea Official', 'madea.official1@gmail.com', 'madea.official1@gmail.com', 'madea.official1@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE),
  ('WHITELIST-bmtashwin009-001', 'WHITELIST-bmtashwin009-001', 'Bmtashwin009', 'bmtashwin009@gmail.com', 'bmtashwin009@gmail.com', 'bmtashwin009@gmail.com', NULL, NULL, NULL, TRUE, TRUE, 'STUDENT', TRUE)
ON CONFLICT DO NOTHING;

-- Ensure is_active stays true for these (if row existed but was deactivated)
UPDATE students SET is_active = TRUE, voting_eligible = TRUE, email_verified = TRUE, updated_at = NOW()
WHERE LOWER(email) IN (
  'serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com','backupwh196@gmail.com',
  'surahnw@gmail.com','j46933223@gmail.com','theshirutonft@gmail.com','meryrajam@gmail.com',
  'jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com',
  'draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com'
);
