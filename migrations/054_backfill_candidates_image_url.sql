-- Backfill ballot `candidates.image_url` from approved candidate applications.
--
-- The approve flow copies profile_photo_url into the ballot row, but the
-- TEST election ballot rows were inserted via raw SQL in 052 (image_url NULL),
-- so /positions/:id/candidates returned no photo for Who07512 / Ctrlplusz069.
--
-- Generic and idempotent: for every ballot candidate whose image_url is empty,
-- copy the photo from its approved application matched on (position_id, name).
UPDATE candidates c
SET image_url = ca.profile_photo_url
FROM candidate_applications ca
WHERE ca.status = 'approved'
  AND c.position_id = ca.position_id
  AND LOWER(TRIM(c.name)) = LOWER(TRIM(ca.full_name))
  AND (c.image_url IS NULL OR c.image_url = '');

-- Verify: ballot candidates for the TEST election should now carry a photo.
SELECT c.position_id, c.name,
       (c.image_url IS NOT NULL AND c.image_url <> '') AS has_image
FROM candidates c
JOIN positions p ON p.id = c.position_id
JOIN constituencies ct ON ct.id = p.constituency_id
JOIN elections e ON e.id = ct.election_id
WHERE e.name LIKE 'TEST %'
ORDER BY c.position_id, c.name;