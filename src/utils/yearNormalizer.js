/**
 * Year Normalizer
 *
 * Semester vs Year formats coexist in the system:
 *   - "X Sem"   (students.year_or_semester from whitelist_seed / student ID parsing)
 *   - "Xth Year" (class-data.ts BatchSelect used by candidate apply form & constituency creation)
 *
 * Indian programs are semester-based: 2 semesters per academic year.
 *   - 1st Year = Semesters 1–2
 *   - 2nd Year = Semesters 3–4
 *   - 3rd Year = Semesters 5–6
 *
 * This utility converts "X Sem" → the canonical "Xth Year" it belongs to
 * (year = ceil(semester / 2)) so cohort matching, constituency matching, and
 * approval flows always compare the same value.
 */

const ORDINAL_SUFFIX = { 1: 'st', 2: 'nd', 3: 'rd' };

function ordinalYear(yearNumber) {
  const suffix = ORDINAL_SUFFIX[yearNumber] || 'th';
  return `${yearNumber}${suffix} Year`;
}

/**
 * Normalize a year string to the canonical "Xth Year" format.
 *
 * @param {string|null|undefined} year
 * @returns {string|null|undefined} normalized year, or original if already canonical / falsy
 */
function normalizeYear(year) {
  if (!year) return year;
  const trimmed = String(year).trim();
  if (!trimmed) return trimmed;

  // Already in canonical "Xth Year" format
  if (/^\d+(st|nd|rd|th)\s+Year$/i.test(trimmed)) return trimmed;

  // "X Sem" format → academic year it belongs to (ceil(X/2))
  const semMatch = trimmed.match(/^(\d+)\s*Sem$/i);
  if (semMatch) {
    const sem = parseInt(semMatch[1], 10);
    const yearNumber = Math.max(1, Math.ceil(sem / 2));
    return ordinalYear(yearNumber);
  }

  // Unknown format — return as-is so downstream can handle gracefully
  return trimmed;
}

module.exports = { normalizeYear };
