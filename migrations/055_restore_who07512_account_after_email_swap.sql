-- Migration: 055_restore_who07512_account_after_email_swap.sql
-- The email-recovery test request (SAR-00003) was approved against the live
-- whitelisted test account Who07512 during simulation, which swapped its
-- login email and left the account unreachable:
--   who07512@gmail.com   -> ACCOUNT_NOT_FOUND (password_hash cleared)
--   whotestnew@gmail.com -> NOT_WHITELISTED  (no student row uses it)
--
-- Restore the account to its whitelisted identity with the known test
-- password (TestPassword123!, same scrypt value as 053: TestPassword123!).
-- Scoped to the Who07512 row by any of its identity keys; idempotent.
DO $$
DECLARE
  hashed TEXT := 'scrypt$16384$8$1$3IdyWdQ2WhysB355KO06CQ$Vz5tSBBJg8mB8AOnFNFLGrn7dTVIb2FIT6pJs15xVhgII5MD5BG7u6aHPlOrv155hsC3ldJHHvy8uAxLopsVDw';
BEGIN
  UPDATE students
     SET email = 'who07512@gmail.com',
         current_login_email = 'who07512@gmail.com',
         official_email = COALESCE(NULLIF(official_email, ''), 'who07512@gmail.com'),
         password_hash = hashed,
         password_change_required = FALSE,
         failed_login_attempts = 0,
         locked_until = NULL,
         email_verified = TRUE,
         is_active = TRUE,
         voting_eligible = TRUE,
         username = 'who07512',
         updated_at = NOW()
   WHERE LOWER(email) = 'who07512@gmail.com'
      OR LOWER(current_login_email) = 'who07512@gmail.com'
      OR LOWER(official_email) = 'who07512@gmail.com'
      OR LOWER(email) = 'whotestnew@gmail.com'
      OR LOWER(current_login_email) = 'whotestnew@gmail.com'
      OR LOWER(external_id) = 'WHITELIST-who07512-001'
      OR LOWER(student_id) = 'WHITELIST-who07512-001';

  RAISE NOTICE '055 restored Who07512 test account to who07512@gmail.com / TestPassword123!';
END $$;