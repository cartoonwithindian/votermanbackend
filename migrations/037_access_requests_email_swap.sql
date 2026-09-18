-- Access requests now identify the student by their registered college email
-- (old mail -> new mail swap). The form no longer asks for the full name, and
-- it now captures the section and the student's phone number.
ALTER TABLE student_access_requests
  ALTER COLUMN full_name DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS section VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS phone VARCHAR(32) NULL;