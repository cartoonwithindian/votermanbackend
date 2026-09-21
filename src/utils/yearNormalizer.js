/**
 * Year Normalizer
 *
 * Two year formats coexist in the system:
 *   - "X Sem"   (students.year_or_semester from whitelist_seed / student ID parsing)
 *   - "Xth Year" (class-data.ts BatchSelect used by candidate apply form & constituency creation)
 *
 * This utility converts "X Sem" → canonical "Xth Year" so comparisons in
 * candidate listing, constituency matching, and approval flows always match.
 */

const ORDINAL_SUFFIX = { 1: 'st', 2: 'nd', 3: 'rd' };

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

  // "X Sem" format → "Xth Year"
  const semMatch = trimmed.match(/^(\d+)\s*Sem$/i);
  if (semMatch) {
    const num = parseInt(semMatch[1], 10);
    const suffix = ORDINAL_SUFFIX[num] || 'th';
    return `${num}${suffix} Year`;
  }

  // Unknown format — return as-is so downstream can handle gracefully
  return trimmed;
}

module.exports = { normalizeYear };
