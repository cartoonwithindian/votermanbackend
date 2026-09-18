-- Access requests no longer require Student ID or college email upfront.
-- They can be auto-detected from the whitelist (name + class) or resolved by
-- the admin at review time, so both columns are now nullable.
ALTER TABLE student_access_requests
  ALTER COLUMN student_id DROP NOT NULL,
  ALTER COLUMN college_email DROP NOT NULL;