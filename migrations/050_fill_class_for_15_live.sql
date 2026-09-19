-- Migration: 050_fill_class_for_15_live.sql
-- Fix "Class is not filled" for who07512@gmail.com and other 14 live whitelisted.
-- Sets department/year/section for the 15 so profile is complete and test election TEST 1st Year T1 matches.
-- Idempotent.

UPDATE students SET department='TEST', year_or_semester='1st Year', section='T1', updated_at=NOW()
WHERE LOWER(email) IN (
  'serwinbm@gmail.com','cartoonwithindian@gmail.com','abastin443@gmail.com','backupwh196@gmail.com',
  'surahnw@gmail.com','j46933223@gmail.com','theshirutonft@gmail.com',
  'meryrajam@gmail.com','jfjrihrje@gmail.com','who07512@gmail.com','ctrlplusz069@gmail.com','ctrlpluss9@gmail.com',
  'draza108@gmail.com','madea.official1@gmail.com','bmtashwin009@gmail.com'
) AND (department IS NULL OR year_or_semester IS NULL OR section IS NULL);
