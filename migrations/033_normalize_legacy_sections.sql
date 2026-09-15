-- 033: normalize legacy section letters on candidate applications
--
-- Applications submitted before canonical batches existed carry bare section
-- letters ("A"/"B"/"C") which match no batch (A1/A2/A3), so CR seat matching,
-- ballot placement and the constituency modal silently skip them. Map them to
-- the canonical codes for the sectioned courses (BBA, BCA):
--   A -> A1, B -> A2, C -> A3 (C only meaningful for BBA).
-- Section-less courses (MCA, MBA, BCom) are untouched.

UPDATE candidate_applications
SET section = CASE UPPER(section)
                WHEN 'A' THEN 'A1'
                WHEN 'B' THEN 'A2'
                WHEN 'C' THEN 'A3'
              END,
    updated_at = NOW()
WHERE department IN ('BBA', 'BCA')
  AND (UPPER(section) IN ('A', 'B')
       OR (department = 'BBA' AND UPPER(section) = 'C'));
