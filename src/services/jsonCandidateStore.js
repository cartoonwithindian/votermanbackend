/**
 * JSON Candidate Store — Admin-uploaded JSON overrides DB
 * When admin uploads candidates.json, students see JSON candidates
 * filtered by their own department/year/section (cohort isolation).
 *
 * Storage: /home/hackersage/student/voteweb-backend/data/candidates.json
 *          also mirrored to /tmp/voteweb-candidates.json for ephemeral hosts.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const JSON_PATH = path.join(DATA_DIR, 'candidates.json');
const TMP_PATH = '/tmp/voteweb-candidates.json';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonCandidates() {
  // Prefer data/candidates.json, fallback to /tmp
  const p = fs.existsSync(JSON_PATH) ? JSON_PATH : fs.existsSync(TMP_PATH) ? TMP_PATH : null;
  if (!p) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    // Allow both {candidates:[...]} and direct array
    const arr = Array.isArray(data) ? data : Array.isArray(data.candidates) ? data.candidates : null;
    if (!arr) return null;
    return arr;
  } catch (e) {
    console.warn('[jsonCandidateStore] read failed:', e.message);
    return null;
  }
}

function hasJsonOverride() {
  return fs.existsSync(JSON_PATH) || fs.existsSync(TMP_PATH);
}

function writeJsonCandidates(candidates) {
  ensureDir();
  const json = JSON.stringify(candidates, null, 2);
  // Write to both locations for durability
  fs.writeFileSync(JSON_PATH, json, 'utf8');
  try { fs.writeFileSync(TMP_PATH, json, 'utf8'); } catch {}
  return { path: JSON_PATH, count: candidates.length };
}

function deleteJsonCandidates() {
  let deleted = 0;
  for (const p of [JSON_PATH, TMP_PATH]) {
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); deleted++; } catch {}
    }
  }
  return deleted;
}

function validateCandidates(arr) {
  if (!Array.isArray(arr)) return 'JSON must be an array or {candidates: [...]}';
  if (arr.length === 0) return 'At least one candidate required';
  if (arr.length > 500) return 'Too many candidates (max 500)';
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    // Minimal 8 fields: profilePhotoUrl, Full Name, Position, Department, Year, Section, Email, Manifesto
    const name = c.fullName || c.FullName || c.name;
    if (!name || typeof name !== 'string' || !name.trim()) return `Candidate ${i+1}: Full Name is required`;
    if (!c.department || typeof c.department !== 'string') return `Candidate ${i+1} (${name}): Department is required`;
    if (!c.year || typeof c.year !== 'string') return `Candidate ${i+1} (${name}): Year is required`;
    if (!c.email || typeof c.email !== 'string' || !c.email.includes('@')) return `Candidate ${i+1} (${name}): Email is required`;
    if (!c.manifesto || typeof c.manifesto !== 'string' || !c.manifesto.trim()) return `Candidate ${i+1} (${name}): Manifesto is required`;
    const pos = c.position || c.position_name || c.Position;
    if (!pos || typeof pos !== 'string' || !pos.trim()) return `Candidate ${i+1} (${name}): Position is required`;
    // profilePhotoUrl optional but recommended; section optional for MBA/MCA/BCom
    if (c.gender && !['Male','Female','Other'].includes(c.gender)) return `Candidate ${i+1} (${name}): gender must be Male/Female/Other`;
  }
  return null;
}

function filterJsonCandidates(rows, { gender, department, year, section, limit = 100, offset = 0 }) {
  const { normalizeYear } = require('../utils/yearNormalizer');
  let filtered = [...rows];
  if (gender && gender !== 'all') filtered = filtered.filter(r => r.gender === gender);
  if (department && department !== 'all') filtered = filtered.filter(r => r.department === department);
  if (year && year !== 'all') {
    const normYear = normalizeYear(year);
    filtered = filtered.filter(r => normalizeYear(r.year) === normYear);
  }
  if (section && section !== 'all') {
    const normSection = String(section).trim().toLowerCase();
    filtered = filtered.filter(r => String(r.section || '').trim().toLowerCase() === normSection);
  }
  const total = filtered.length;
  filtered = filtered.slice(offset, offset + limit);
  return { rows: filtered, total };
}

function mapJsonToRow(c, idx) {
  // Minimal 8-field JSON: profilePhotoUrl, Full Name, Position, Department, Year, Section, Email, Manifesto
  // Map to CandidateRow for Card: profilePhotoUrl(39), name/position(66), dept•year(72), bio(77) and Profile: photo(68), info(192), bio(132), manifestos(151)
  const fullName = c.fullName || c.FullName || c.name || `Candidate ${9000+idx}`;
  const position = c.position || c.position_name || c.Position || 'Class Representative';
  const email = c.email || c.Email || '';
  return {
    id: c.id != null ? c.id : 9000 + idx,
    student_id: c.student_id || null,
    name: fullName,
    gender: c.gender || 'Other',
    department: c.department || c.Department,
    year: c.year || c.Year,
    section: c.section || c.Section || null,
    description: c.bio || c.description || c.manifesto || '', // bio fallback to manifesto for Card line-clamp-2
    manifesto: c.manifesto || c.Manifesto || '',
    image_url: c.profilePhotoUrl || c.profile_photo_url || c.image_url || c.link || null,
    position_id: c.position_id || (String(position).toLowerCase().includes('girls') ? 2 : 1),
    position_name: position,
    election_id: c.election_id || 1,
    election_name: c.election_name || 'Student Council Election',
    email, // kept for admin view, not exposed to students via candidateService (filtered)
  };
}

module.exports = {
  JSON_PATH,
  TMP_PATH,
  DATA_DIR,
  readJsonCandidates,
  hasJsonOverride,
  writeJsonCandidates,
  deleteJsonCandidates,
  validateCandidates,
  filterJsonCandidates,
  mapJsonToRow,
};
