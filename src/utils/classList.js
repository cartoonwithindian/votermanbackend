/**
 * Canonical 22-class list for class-based elections.
 *
 * Each class is identified by (department, year, section). Year uses the
 * canonical "Xth Year" format (see yearNormalizer.js); sections are "" for
 * section-less courses (MBA, MCA, BCom). The semester references (1/3/5 Sem)
 * map to 1st/2nd/3rd Year and are only used for display.
 *
 * Excludes the internal TEST course.
 */

const { normalizeYear } = require('./yearNormalizer');

const CANONICAL_COURSES = ['MBA', 'MCA', 'BBA', 'BCom', 'BCA'];

const CLASSES = [
  // MBA - 2 batches (section-less)
  { department: 'MBA', year: '2nd Year', section: '' },
  { department: 'MBA', year: '1st Year', section: '' },
  // MCA - 2 batches (section-less)
  { department: 'MCA', year: '2nd Year', section: '' },
  { department: 'MCA', year: '1st Year', section: '' },
  // BBA - 9 batches (A1-A3 x 3 years)
  { department: 'BBA', year: '3rd Year', section: 'A1' },
  { department: 'BBA', year: '3rd Year', section: 'A2' },
  { department: 'BBA', year: '3rd Year', section: 'A3' },
  { department: 'BBA', year: '2nd Year', section: 'A1' },
  { department: 'BBA', year: '2nd Year', section: 'A2' },
  { department: 'BBA', year: '2nd Year', section: 'A3' },
  { department: 'BBA', year: '1st Year', section: 'A1' },
  { department: 'BBA', year: '1st Year', section: 'A2' },
  { department: 'BBA', year: '1st Year', section: 'A3' },
  // BCom - 3 batches (section-less)
  { department: 'BCom', year: '3rd Year', section: '' },
  { department: 'BCom', year: '2nd Year', section: '' },
  { department: 'BCom', year: '1st Year', section: '' },
  // BCA - 6 batches (A1-A2 x 3 years)
  { department: 'BCA', year: '3rd Year', section: 'A1' },
  { department: 'BCA', year: '3rd Year', section: 'A2' },
  { department: 'BCA', year: '2nd Year', section: 'A1' },
  { department: 'BCA', year: '2nd Year', section: 'A2' },
  { department: 'BCA', year: '1st Year', section: 'A1' },
  { department: 'BCA', year: '1st Year', section: 'A2' },
];

/**
 * Normalize a section value to "" for section-less courses.
 * Treats null, undefined, "", "-", "N/A" as no section.
 */
function normalizeSection(section) {
  const s = String(section ?? '').trim();
  if (s === '' || s === '-' || /^n\/?a$/i.test(s)) return '';
  return s;
}

/**
 * Normalize a department to its canonical spelling ("BCOM" -> "BCom").
 * Returns the trimmed original if it does not match a known course.
 */
function normalizeDepartment(department) {
  const d = String(department ?? '').trim();
  if (!d) return d;
  const found = CANONICAL_COURSES.find((c) => c.toLowerCase() === d.toLowerCase());
  return found || d;
}

/** Stable unique key for a class, safe for Set/Map usage. */
function classKey(cls) {
  return [
    normalizeDepartment(cls.department),
    normalizeYear(cls.year) || '',
    normalizeSection(cls.section),
  ].join('|');
}

/** Find a canonical class by (department, year, section), tolerating any year/section spelling. */
function findClass(cls) {
  if (!cls) return null;
  const dept = normalizeDepartment(cls.department);
  const year = normalizeYear(cls.year) || '';
  const section = normalizeSection(cls.section);
  return CLASSES.find(
    (c) =>
      normalizeDepartment(c.department) === dept &&
      normalizeYear(c.year) === year &&
      normalizeSection(c.section) === section
  ) || null;
}

module.exports = {
  CLASSES,
  CANONICAL_COURSES,
  normalizeSection,
  normalizeDepartment,
  classKey,
  findClass,
};