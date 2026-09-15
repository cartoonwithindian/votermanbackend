-- 032: ballot photo storage
--
-- Ballot rows copy the applicant's uploaded photo (base64 data URL, typically
-- 10-70KB) into candidates.image_url. VARCHAR(500) cannot hold that — every
-- photo-carrying placement failed with "value too long for type character
-- varying(500)". TEXT removes the practical limit, matching 028 which did the
-- same for candidate_applications.profile_photo_url.

ALTER TABLE candidates ALTER COLUMN image_url TYPE TEXT;
