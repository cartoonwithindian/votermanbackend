-- Migration: 043_test_simulation_passwords.sql
-- Set password for TEST_COURSE simulation accounts to TestPassword123! so they can login via password on live OTP/Google fallback.
-- Hash for TestPassword123! (scrypt)
-- Idempotent

UPDATE students SET password_hash = 'scrypt$16384$8$1$3IdyWdQ2WhysB355KO06CQ$Vz5tSBBJg8mB8AOnFNFLGrn7dTVIb2FIT6pJs15xVhgII5MD5BG7u6aHPlOrv155hsC3ldJHHvy8uAxLopsVDw', password_change_required = FALSE, updated_at = NOW()
WHERE email LIKE 'test-%@test.local' AND (password_hash IS NULL OR password_hash NOT LIKE 'scrypt%');
