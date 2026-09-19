-- Migration: 053_set_passwords_for_15_live_test_accounts.sql
-- The 15 whitelisted live test accounts (7 candidates + 8 voters) have no
-- password_hash, so email+password login always returns "Invalid username or
-- password." Set the verified TestPassword123! scrypt hash (same as 043) and
-- a username (email local-part) for each, and clear password_change_required
-- so the test flows don't hit a forced password reset. Idempotent.

DO $$
DECLARE
  hashed TEXT := 'scrypt$16384$8$1$3IdyWdQ2WhysB355KO06CQ$Vz5tSBBJg8mB8AOnFNFLGrn7dTVIb2FIT6pJs15xVhgII5MD5BG7u6aHPlOrv155hsC3ldJHHvy8uAxLopsVDw';
  emails TEXT[] := ARRAY[
    'serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com',
    'backupwh196@gmail.com','surahnw@gmail.com','j46933223@gmail.com',
    'theshirutonft@gmail.com','meryrajam@gmail.com','jfjrihrje@gmail.com',
    'who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com',
    'draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com'
  ];
  e TEXT;
  uname TEXT;
BEGIN
  FOREACH e IN ARRAY emails LOOP
    -- Ensure the username is unique even if the local-part collides.
    uname := split_part(e, '@', 1);
    IF EXISTS (SELECT 1 FROM students WHERE LOWER(username) = LOWER(uname) AND LOWER(email) <> LOWER(e)) THEN
      uname := uname || '.2';
    END IF;

    UPDATE students
       SET password_hash = hashed,
           username = COALESCE(NULLIF(username, ''), uname),
           password_change_required = FALSE,
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = NOW()
     WHERE LOWER(email) = LOWER(e)
        OR LOWER(current_login_email) = LOWER(e)
        OR LOWER(official_email) = LOWER(e);
  END LOOP;

  RAISE NOTICE '053 set TestPassword123! for 15 live test accounts';
END $$;