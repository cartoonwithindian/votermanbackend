-- 034: student profile image URL
--
-- Profile images are stored in Appwrite Storage bucket
-- `candidate-photos` (renamed "Profile Images & Candidate Photos" for education pack)
-- with folder "profiles/" for user avatars vs "candidates/" for ballot photos.
-- Postgres keeps only the public view URL — no blobs in DB.
-- Education pack bucket config: 5MB max, zstd, antivirus, transformations.

ALTER TABLE students ADD COLUMN IF NOT EXISTS profile_image_url TEXT;

COMMENT ON COLUMN students.profile_image_url IS 'Public Appwrite Storage URL for user profile avatar (bucket: candidate-photos, folder: profiles/)';
