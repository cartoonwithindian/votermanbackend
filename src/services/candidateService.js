/**
 * Candidate Service
 * Business logic for candidate management.
 *
 * The public /api/v1/candidates endpoint uses candidate_applications with
 * status='approved'. The legacy `candidates` table backs the ballot rows for
 * constituency (Class Representative) positions.
 */

const db = require('../db');
const jsonStore = require('./jsonCandidateStore');
const mongoStore = require('./mongoCandidateStore');
const { normalizeYear } = require('../utils/yearNormalizer');
const { normalizeDepartment, normalizeSection } = require('../utils/classList');
const { getMongoDbName } = require('../utils/mongoDbName');
const { getDb: getSharedDb } = require('../db/mongoClient');
const redisCache = require('../utils/redisCache');
const { memoryCacheGet, memoryCacheSet, memoryCacheDelPrefix } = require('../utils/memoryCache');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

const CANDIDATES_CACHE_KEY_PREFIX = 'candidates:v1:';
const CANDIDATES_CACHE_TTL = 60;
const MEMORY_CACHE_TTL = 15000;

class CandidateService {
  /**
   * Attach position_name to ballot candidate docs by joining the `positions`
   * collection once. Ballot rows created via add-to-ballot store position_id
   * only; students and admin UIs render position_name.
   */
  async enrichPositionNames(rows, positions) {
    if (!rows || !rows.length) return rows;
    const missing = rows.some(r => !(r.position_name || r.position));
    const missingGender = rows.some(r => !(r.gender));
    if (!missing && !missingGender) return rows;
    const db = await getSharedDb();
    if (!db) return rows;
    try {
      if (!positions) positions = await db.collection('positions').find({}).toArray();
      const byId = new Map();
      for (const p of positions) {
        byId.set(String(p._id), p);
        if (p.postgresId != null) byId.set(String(p.postgresId), p);
      }
      return rows.map(r => {
        const pos = byId.get(String(r.position_id ?? r.positionId ?? ''));
        if (!pos) return r;
        return {
          ...r,
          position_id: r.position_id ?? pos._id ? String(pos._id) : r.position_id,
          position_name: pos.name,
          gender: r.gender || pos.gender || 'Other',
        };
      });
    } catch (e) {
      console.warn('[candidateService] enrichPositionNames failed:', e.message);
      return rows;
    }
  }

  /**
   * Restrict ballot rows to candidates tied to an OPEN/SCHEDULED election.
   * A row counts as open when its PRIMARY position OR any linked position
   * (linked_positions) resolves to an OPEN/SCHEDULED election — a canonical
   * candidate reused (linked) into a new election must appear there even when
   * its original primary seat sits in a stale election. Rows whose every
   * position chain is non-open (or orphaned) drop out of the public list.
   * Uses the same positions→constituencies→elections join as the admin list.
   */
  async filterOpenElectionRows(rows, preloaded) {
    if (!rows || !rows.length) return rows;
    try {
      const dbc = await getSharedDb();
      if (!dbc) return rows;
      let [positionDocs, constituentDocs, electionDocs] = preloaded && preloaded.positions && preloaded.constituencies && preloaded.elections
        ? [preloaded.positions, preloaded.constituencies, preloaded.elections]
        : await Promise.all([
            dbc.collection('positions').find({}).toArray(),
            dbc.collection('constituencies').find({}).toArray(),
            dbc.collection('elections').find({}).toArray(),
          ]);
        const positionById = new Map();
        for (const p of positionDocs) {
          positionById.set(String(p._id), p);
          if (p.postgresId != null) positionById.set(String(p.postgresId), p);
        }
        const constituentById = new Map();
        for (const ct of constituentDocs) {
          constituentById.set(String(ct._id), ct);
          if (ct.postgresId != null) constituentById.set(String(ct.postgresId), ct);
        }
        const electionStatus = new Map();
        for (const e of electionDocs) {
          electionStatus.set(String(e._id), String(e.status || '').toUpperCase());
          if (e.postgresId != null) electionStatus.set(String(e.postgresId), String(e.status || '').toUpperCase());
        }
        const statusOf = (positionId) => {
          const pos = positionById.get(String(positionId ?? ''));
          if (!pos) return '';
          const ct = constituentById.get(String(pos.constituency_id ?? pos.constituencyId ?? ''));
          if (!ct) return '';
          return electionStatus.get(String(ct.election_id ?? ct.electionId ?? '')) || '';
        };
        const open = ['OPEN', 'SCHEDULED'];
        return rows.filter(r => {
          const pids = [String(r.position_id ?? r.positionId ?? '')];
          const linked = Array.isArray(r.linked_positions) ? r.linked_positions : Array.isArray(r.linkedPositions) ? r.linkedPositions : [];
          for (const l of linked) pids.push(String(l));
          return pids.some(pid => open.includes(statusOf(pid)));
        });
    } catch (e) {
      console.warn('[candidateService] filterOpenElectionRows failed, keeping rows:', e.message);
      return rows;
    }
  }

  /**
   * Map raw Mongo ballot rows to the CandidateRow shape the frontend expects.
   * Ballot docs store `_id`, `name`, `position_name`, `description`,
   * `image_url`/`imageUrl`, `department`, `year`, `section`, `gender`.
   * The frontend CandidateRow needs `id`, `manifesto`, `election_id`,
   * `election_name` — supply safe defaults so cards/profile links work.
   */
  mapBallotRow(rows) {
    return (rows || []).map(r => ({
      id: r.id != null ? r.id : (r._id != null ? String(r._id) : r.postgresId),
      student_id: r.student_id != null ? r.student_id : null,
      name: r.name || '',
      gender: r.gender || 'Other',
      department: r.department || '',
      year: r.year || '',
      section: r.section != null && r.section !== '-' ? r.section : null,
      description: r.description || r.manifesto || r.bio || '',
      manifesto: r.manifesto || '',
      image_url: r.image_url ?? r.imageUrl ?? r.profilePhotoUrl ?? null,
      position_id: r.position_id != null ? r.position_id : (r.positionId != null ? r.positionId : null),
      position_name: r.position_name || r.position || 'Class Representative',
      election_id: r.election_id != null ? r.election_id : (r.electionId != null ? r.electionId : null),
      election_name: r.election_name || r.electionName || 'Student Council Election',
    }));
  }

  /**
   * Find all APPROVED candidates for public/student view.
   * Uses candidate_applications with status='approved'.
   *
   * @param {Object} options
   * @param {number} options.limit - Result limit
   * @param {number} options.offset - Result offset
   * @param {string} options.gender - Filter by gender (Male, Female, Other)
   * @param {string} options.department - Filter by department
   * @param {string} options.year - Filter by year
   * @param {string} options.section - Filter by section
   */
  async findApproved(options = {}) {
    const memoryKey = `${CANDIDATES_CACHE_KEY_PREFIX}mem:${this.buildCandidateCacheKey(options)}`;
    const mem = memoryCacheGet(memoryKey);
    if (mem !== undefined) return mem;
    const cacheKey = redisCache.isEnabled() ? this.buildCandidateCacheKey(options) : null;
    if (cacheKey) {
      const cached = await redisCache.getKey(cacheKey);
      if (cached !== null) {
        const rows = Array.isArray(cached) ? cached : [];
        memoryCacheSet(memoryKey, rows, MEMORY_CACHE_TTL);
        return rows;
      }
    }
    const rows = await this._loadApprovedRows(options);
    memoryCacheSet(memoryKey, rows, MEMORY_CACHE_TTL);
    if (cacheKey) {
      await redisCache.setKey(cacheKey, rows, CANDIDATES_CACHE_TTL);
    }
    return rows;
  }

  buildCandidateCacheKey(options = {}) {
    const version = process.env.CANDIDATES_CACHE_VERSION || '1';
    const safe = (v) => String(v ?? '').trim().toLowerCase() !== '' ? String(v).trim().toLowerCase() : 'all';
    return `${CANDIDATES_CACHE_KEY_PREFIX}${version}:${safe(options.gender)}:${safe(options.department)}:${safe(options.year)}:${safe(options.section)}:${options.limit ?? 100}:${options.offset ?? 0}`;
  }

  async invalidateCandidates() {
    memoryCacheDelPrefix(`${CANDIDATES_CACHE_KEY_PREFIX}mem:`);
    await redisCache.deleteKeysWithPrefix(CANDIDATES_CACHE_KEY_PREFIX);
  }

  async _loadApprovedRows(options = {}) {
    const {
      limit = 100,
      offset = 0,
      gender,
      department,
      year,
      section,
    } = options;

    // Priority: Atlas -> JSON -> DB
    // 1) Atlas (MONGODB_URI) — preferred when configured
    try {
      if (await mongoStore.hasMongoCandidates()) {
        const dbc = await getSharedDb();
        if (dbc) {
          const [mongoRows, posDocs, ctDocs, elecDocs] = await Promise.all([
            dbc.collection('candidates').find({}).toArray(),
            dbc.collection('positions').find({}).toArray(),
            dbc.collection('constituencies').find({}).toArray(),
            dbc.collection('elections').find({}).toArray(),
          ]);
          if (mongoRows && mongoRows.length) {
            const preloaded = { positions: posDocs, constituencies: ctDocs, elections: elecDocs };
            const enriched = await this.enrichPositionNames(mongoRows, posDocs);
            const inOpen = await this.filterOpenElectionRows(enriched, preloaded);
            // Ballot rows in Mongo store raw candidate fields (_id, name,
            // position_name, image_url/description). Map to the same
            // CandidateRow shape the Postgres/JSON paths return so the
            // frontend always sees `id`, `manifesto`, `election_*`.
            const mapped = this.mapBallotRow(inOpen);
            const { rows } = mongoStore.filterMongoRows(mapped, { gender, department, year, section, limit, offset });
            return rows;
          }
        }
      }
    } catch (e) {
      console.warn('[candidateService] Atlas read failed, falling back:', e.message);
    }

    // 2) JSON override: if admin uploaded candidates.json, students see JSON
    // filtered by their own department/year/section (cohort isolation).
    // Card: profilePhotoUrl(39), name/position(66), department•year(72), bio(77)
    // Profile: photo header(68), info(192), bio(132), manifestos(151)
    if (jsonStore.hasJsonOverride()) {
      const raw = jsonStore.readJsonCandidates();
      if (raw && Array.isArray(raw)) {
        const mapped = raw.map((c, idx) => jsonStore.mapJsonToRow(c, idx));
        const { rows } = jsonStore.filterJsonCandidates(mapped, { gender, department, year, section, limit, offset });
        return rows;
      }
    }

    // Query approved applications with position information
    let query = `
      SELECT
        ca.id,
        ca.student_id,
        ca.full_name AS name,
        ca.gender,
        ca.department,
        ca.year,
        ca.section,
        ca.bio AS description,
        ca.manifesto AS manifesto,
        ca.profile_photo_url AS image_url,
        p.id AS position_id,
        p.name AS position_name,
        e.id AS election_id,
        e.name AS election_name
      FROM candidate_applications ca
      JOIN positions p ON ca.position_id = p.id
      JOIN elections e ON ca.election_id = e.id
      WHERE ca.status = 'approved'
    `;

    const params = [];
    let paramIndex = 1;

    // Add filters
    if (gender && gender !== 'all') {
      query += ` AND ca.gender = $${paramIndex}`;
      params.push(gender);
      paramIndex++;
    }

    if (department && department !== 'all') {
      query += ` AND ca.department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }

    if (year && year !== 'all') {
      const normalizedYear = normalizeYear(year);
      query += ` AND ca.year = $${paramIndex}`;
      params.push(normalizedYear);
      paramIndex++;
    }

    if (section && section !== 'all') {
      query += ` AND ca.section = $${paramIndex}`;
      params.push(section);
      paramIndex++;
    }

    query += ` ORDER BY ca.id LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    if (isMongoOnly) {
      try {
        const result = await db.query(query, params);
        return result.rows;
      } catch (e) {
        console.warn('[candidateService] findApproved mongo-only fallback to []:', e.message);
        return [];
      }
    }
    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Admin-only: list all ballot/master candidate docs (including unplaced
   * canonical masters with position_id null). Filters are optional and cohort
   * fields are normalized before comparing. Invoked by the admin candidates
   * gallery via GET /candidates?scope=all (ADMIN role only).
   */
  async listAllCandidates({ limit = 1000, offset = 0, gender, department, year, section } = {}) {
    if (isMongoOnly) {
      try {
        const dbc = await getSharedDb();
        if (!dbc) return [];
        const col = dbc.collection('candidates');
        const docs = await col.find({}).sort({ department: 1, year: 1, section: 1, name: 1 }).toArray();
        const rows = docs.map(d => ({
          id: d._id ? String(d._id) : (d.id != null ? String(d.id) : ''),
          name: d.name || '',
          gender: d.gender || null,
          department: d.department ?? null,
          year: d.year ?? null,
          section: d.section ?? null,
          description: d.description ?? d.manifesto ?? '',
          manifesto: d.manifesto ?? d.description ?? '',
          image_url: d.image_url ?? d.imageUrl ?? null,
          profilePhotoUrl: d.image_url ?? d.imageUrl ?? null,
          email: d.email ?? null,
          position_id: d.position_id ?? d.positionId ?? null,
          linked_positions: Array.isArray(d.linked_positions) ? d.linked_positions : Array.isArray(d.linkedPositions) ? d.linkedPositions : [],
          is_active: d.is_active ?? d.isActive ?? true,
          position_name: d.position_name ?? 'Class Representative',
        }));
        const normEq = (a, b) => {
          const A = String(a ?? '').trim().toLowerCase();
          const B = String(b ?? '').trim().toLowerCase();
          if (!A || !B) return false;
          return A === B;
        };
        let filtered = rows;
        if (gender && gender !== 'all') filtered = filtered.filter(r => normEq(r.gender, gender));
        if (department && department !== 'all') filtered = filtered.filter(r => normalizeDepartment(r.department) === normalizeDepartment(department));
        if (year && year !== 'all') {
          const ny = normalizeYear(year);
          filtered = filtered.filter(r => normalizeYear(r.year) === ny);
        }
        if (section && section !== 'all') filtered = filtered.filter(r => normalizeSection(r.section ?? '') === normalizeSection(section));
        return filtered.slice(offset, offset + limit);
      } catch (e) {
        console.warn('[candidateService] listAllCandidates failed:', e.message);
        return [];
      }
    }
    return [];
  }

  /**
   * Find a single approved candidate by ID for public view.
   */
  async findApprovedById(id) {
    // Priority: Atlas -> JSON -> DB
    try {
      if (await mongoStore.hasMongoCandidates()) {
        const dbc = await getSharedDb();
        if (dbc) {
          const [mongoRows, posDocs, ctDocs, elecDocs] = await Promise.all([
            dbc.collection('candidates').find({}).toArray(),
            dbc.collection('positions').find({}).toArray(),
            dbc.collection('constituencies').find({}).toArray(),
            dbc.collection('elections').find({}).toArray(),
          ]);
          if (mongoRows && mongoRows.length) {
            const preloaded = { positions: posDocs, constituencies: ctDocs, elections: elecDocs };
            const enriched = await this.enrichPositionNames(mongoRows, posDocs);
            const inOpen = await this.filterOpenElectionRows(enriched, preloaded);
            const mapped = this.mapBallotRow(inOpen);
            const found = mapped.find(r => String(r.id) === String(id));
            if (found) return found;
          }
        }
      }
    } catch (e) {
      console.warn('[candidateService] Atlas findById failed, falling back:', e.message);
    }
    if (jsonStore.hasJsonOverride()) {
      const raw = jsonStore.readJsonCandidates();
      if (raw && Array.isArray(raw)) {
        const mapped = raw.map((c, idx) => jsonStore.mapJsonToRow(c, idx));
        const found = mapped.find(r => String(r.id) === String(id));
        if (found) return found;
      }
    }
    if (isMongoOnly) {
      try {
        const result = await db.query(`
      SELECT
        ca.id,
        ca.student_id,
        ca.full_name AS name,
        ca.gender,
        ca.department,
        ca.year,
        ca.section,
        ca.bio AS description,
        ca.manifesto AS manifesto,
        ca.profile_photo_url AS image_url,
        p.id AS position_id,
        p.name AS position_name,
        e.id AS election_id,
        e.name AS election_name
      FROM candidate_applications ca
      JOIN positions p ON ca.position_id = p.id
      JOIN elections e ON ca.election_id = e.id
      WHERE ca.id = $1 AND ca.status = 'approved'
    `, [id]);
        return result.rows[0] || null;
      } catch (e) {
        console.warn('[candidateService] findApprovedById mongo-only fallback to null:', e.message);
        return null;
      }
    }
    const result = await db.query(`
      SELECT
        ca.id,
        ca.student_id,
        ca.full_name AS name,
        ca.gender,
        ca.department,
        ca.year,
        ca.section,
        ca.bio AS description,
        ca.manifesto AS manifesto,
        ca.profile_photo_url AS image_url,
        p.id AS position_id,
        p.name AS position_name,
        e.id AS election_id,
        e.name AS election_name
      FROM candidate_applications ca
      JOIN positions p ON ca.position_id = p.id
      JOIN elections e ON ca.election_id = e.id
      WHERE ca.id = $1 AND ca.status = 'approved'
    `, [id]);

    return result.rows[0] || null;
  }

  /**
   * Count approved candidates with optional filters.
   */
  async countApproved(options = {}) {
    const memoryKey = `${CANDIDATES_CACHE_KEY_PREFIX}mem:count:${options.department ?? 'all'}:${options.year ?? 'all'}:${options.section ?? 'all'}:${options.gender ?? 'all'}`;
    const mem = memoryCacheGet(memoryKey);
    if (mem !== undefined) return mem;
    // Priority: Atlas -> JSON -> DB
    try {
      if (await mongoStore.hasMongoCandidates()) {
        const dbc = await getSharedDb();
        if (dbc) {
          const mongoRows = await dbc.collection('candidates').find({}).toArray();
          const { total } = mongoStore.filterMongoRows(mongoRows, { ...options, limit: 100000, offset: 0 });
          memoryCacheSet(memoryKey, total, MEMORY_CACHE_TTL);
          return total;
        }
      }
    } catch (e) {
      console.warn('[candidateService] Atlas count failed, falling back:', e.message);
    }
    if (jsonStore.hasJsonOverride()) {
      const raw = jsonStore.readJsonCandidates();
      if (raw && Array.isArray(raw)) {
        const mapped = raw.map((c, idx) => jsonStore.mapJsonToRow(c, idx));
        const { total } = jsonStore.filterJsonCandidates(mapped, { ...options, limit: 100000, offset: 0 });
        memoryCacheSet(memoryKey, total, MEMORY_CACHE_TTL);
        return total;
      }
    }
    const { gender, department, year, section } = options;

    let query = `
      SELECT COUNT(*) as count
      FROM candidate_applications
      WHERE status = 'approved'
    `;

    const params = [];
    let paramIndex = 1;

    if (gender && gender !== 'all') {
      query += ` AND gender = $${paramIndex}`;
      params.push(gender);
      paramIndex++;
    }

    if (department && department !== 'all') {
      query += ` AND department = $${paramIndex}`;
      params.push(department);
      paramIndex++;
    }

    if (year && year !== 'all') {
      const normalizedYear = normalizeYear(year);
      query += ` AND year = $${paramIndex}`;
      params.push(normalizedYear);
      paramIndex++;
    }

    if (section && section !== 'all') {
      query += ` AND section = $${paramIndex}`;
      params.push(section);
      paramIndex++;
    }

    if (isMongoOnly) {
      try {
        const result = await db.query(query, params);
        return parseInt(result.rows[0].count) || 0;
      } catch (e) {
        console.warn('[candidateService] countApproved mongo-only fallback to 0:', e.message);
        return 0;
      }
    }
    const result = await db.query(query, params);
    return parseInt(result.rows[0].count) || 0;
  }

  // =============================================
  // LEGACY METHODS (for the candidates ballot table)
  // =============================================

  /**
   * Find all candidates for a position
   */
  async findByPositionId(positionId, options = {}) {
    // Fallback: serve uploaded JSON routed to the matching seat (gender + cohort).
    // JSON candidates carry no real position_id, so route them via the position's
    // gender + constituency cohort rather than raw position_id comparison.
    const jsonFallback = async () => {
      if (!jsonStore.hasJsonOverride()) return null;
      const raw = jsonStore.readJsonCandidates();
      if (!raw || !Array.isArray(raw)) return null;
      const mapped = raw.map((c, idx) => jsonStore.mapJsonToRow(c, idx));
      const { limit = 100, offset = 0 } = options;
      let isGirlSeat = false;
      let cohort = null;
      try {
        const positionService = require('./positionService');
        const constituencyService = require('./constituencyService');
        const position = await positionService.findById(positionId);
        const posName = String(position?.name || '');
        isGirlSeat = /girls|female/i.test(posName) || String(position?.gender).toLowerCase() === 'female';
        if (position && position.constituency_id) {
          const ct = await constituencyService.findById(position.constituency_id);
          if (ct) cohort = { department: ct.department, year: ct.year, section: ct.section || '' };
        }
      } catch (_) {}
      if (!cohort) return null;
      const norm = (v) => {
        const s = String(v ?? '').trim().toLowerCase();
        return (s === '-' || s === '') ? '' : s;
      };
      const cohortYear = normalizeYear(cohort.year);
      let filtered = mapped.filter(r =>
        norm(r.department) === norm(cohort.department) &&
        norm(normalizeYear(r.year)) === norm(cohortYear) &&
        norm(r.section || '') === norm(cohort.section || '')
      );
      filtered = filtered.filter(r => {
        const rGirl = /girls|female/i.test(String(r.position_name || '')) || String(r.gender).toLowerCase() === 'female';
        return rGirl === isGirlSeat;
      });
      return filtered.slice(offset, offset + limit);
    };

    if (isMongoOnly) {
      // Mongo-only: read from Mongo candidates (real voteable rows take precedence)
      try {
        const dbc = await getSharedDb();
        if (dbc) {
          try {
            let docs = null;
            if (await mongoStore.hasMongoCandidates()) {
              const rows = await mongoStore.readMongoCandidates();
              if (rows && rows.length) {
                const target = String(positionId);
                docs = rows.filter(r => this._belongsToPosition(r, target));
              }
            }
            if (!docs || !docs.length) {
              const col = dbc.collection('candidates');
              docs = await col.find({ $or: [{ position_id: positionId }, { positionId: String(positionId) }, { position_id: String(positionId) }, { linked_positions: String(positionId) }, { linkedPositions: String(positionId) }] }).limit(options.limit || 100).skip(options.offset || 0).toArray();
            }
            if (docs && docs.length) {
              return docs.map(d => ({ id: d._id ? String(d._id) : d.id, position_id: d.position_id ?? d.positionId, name: d.name, description: d.description, image_url: d.image_url ?? d.imageUrl, display_order: d.display_order ?? d.displayOrder ?? 0, is_active: d.is_active ?? d.isActive ?? true, gender: d.gender ?? null, department: d.department ?? null, year: d.year ?? null, section: d.section ?? null, email: d.email ?? null }));
            }
          } catch (e) {
            console.warn('[candidateService] findByPositionId mongo fallback to []:', e.message);
          }
        }
      } catch (e) {
        console.warn('[candidateService] findByPositionId mongo fallback to []:', e.message);
      }
      const fb = await jsonFallback();
      return fb || [];
    }

    const { activeOnly = true, limit = 100, offset = 0 } = options;

    let query = 'SELECT * FROM candidates WHERE position_id = $1';
    const params = [positionId];

    if (activeOnly) {
      query += ' AND is_active = true';
    }

    query += ' ORDER BY display_order, id LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await db.query(query, params);
    if (result.rows.length) return result.rows;
    return (await jsonFallback()) || [];
  }

  /**
   * Find candidate by ID (legacy)
   */
  async findByIdSimple(id) {
    if (isMongoOnly) {
      try {
        const dbc = await getSharedDb();
        if (dbc) {
          try {
            const { ObjectId } = require('mongodb');
            const col = dbc.collection('candidates');
            let doc = null;
            try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (!doc) return null;
            return { id: doc._id ? String(doc._id) : doc.id, position_id: doc.position_id ?? doc.positionId, name: doc.name, description: doc.description, image_url: doc.image_url ?? doc.imageUrl, display_order: doc.display_order ?? doc.displayOrder ?? 0, is_active: doc.is_active ?? doc.isActive ?? true, gender: doc.gender ?? null, department: doc.department ?? null, year: doc.year ?? null, section: doc.section ?? null, email: doc.email ?? null };
          } catch (e) {
            console.warn('[candidateService] findByIdSimple mongo fallback to null:', e.message);
          }
        }
      } catch (e) {
        console.warn('[candidateService] findByIdSimple mongo fallback to null:', e.message);
      }
      return null;
    }
    const result = await db.query(
      'SELECT * FROM candidates WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async deleteById(id) {
    if (isMongoOnly) {
      try {
        const dbc = await getSharedDb();
        if (dbc) {
          try {
            const { ObjectId } = require('mongodb');
            const col = dbc.collection('candidates');
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndDelete({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!res) res = await col.findOneAndDelete({ $or: [{ id: String(id) }, { _id: String(id) }] });
            const d = res && typeof res === 'object' ? (Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res) : null;
            if (!d) return null;
            await this.invalidateCandidates();
            return { id: d._id ? String(d._id) : d.id, position_id: d.position_id ?? d.positionId, name: d.name, description: d.description, image_url: d.image_url ?? d.imageUrl, department: d.department ?? null, year: d.year ?? null, section: d.section ?? null, gender: d.gender ?? null, display_order: d.display_order ?? d.displayOrder ?? 0, is_active: d.is_active ?? d.isActive ?? true };
          } catch (e) {
            console.warn('[candidateService] deleteById mongo fallback null:', e.message);
          }
        }
      } catch (e) {
        console.warn('[candidateService] deleteById mongo fallback null:', e.message);
      }
      return null;
    }
    const result = await db.query(
      'DELETE FROM candidates WHERE id = $1 RETURNING *',
      [id]
    );
    await this.invalidateCandidates();
    return result.rows[0] || null;
  }

  /**
   * Get election status by position ID
   */
  async getElectionStatusByPositionId(positionId) {
    if (isMongoOnly) {
      try {
        const dbc = await getSharedDb();
        if (dbc) {
          const { ObjectId } = require('mongodb');
          const positionsCol = dbc.collection('positions');
          let pos = null;
          try { if (ObjectId.isValid(String(positionId))) pos = await positionsCol.findOne({ _id: new ObjectId(String(positionId)) }); } catch (_) {}
          if (!pos) pos = await positionsCol.findOne({ $or: [{ _id: String(positionId) }, { id: String(positionId) }, { postgresId: Number(positionId) }] });
          if (!pos) return null;
          const constituencyId = pos.constituency_id ?? pos.constituencyId;
          const constituenciesCol = dbc.collection('constituencies');
          let ct = null;
          try { if (ObjectId.isValid(String(constituencyId))) ct = await constituenciesCol.findOne({ _id: new ObjectId(String(constituencyId)) }); } catch (_) {}
          if (!ct) ct = await constituenciesCol.findOne({ $or: [{ _id: String(constituencyId) }, { id: String(constituencyId) }, { postgresId: Number(constituencyId) }] });
          if (!ct) return null;
          const electionId = ct.election_id ?? ct.electionId;
          const electionService = require('./electionService');
          const election = await electionService.findById(electionId);
          return election?.status || null;
        }
      } catch (e) {
        console.warn('[candidateService] getElectionStatusByPositionId Mongo lookup failed:', e.message);
        return null;
      }
      return null;
    }
    const result = await db.query(
      `SELECT e.status FROM elections e
       JOIN constituencies ct ON ct.election_id = e.id
       JOIN positions p ON p.constituency_id = ct.id
       WHERE p.id = $1`,
      [positionId]
    );
    return result.rows[0]?.status || null;
  }

  /**
   * Check if candidate can be modified based on election state
   */
  async canModify(candidateId) {
    const candidate = await this.findByIdSimple(candidateId);
    if (!candidate) return false;

    const status = await this.getElectionStatusByPositionId(candidate.position_id);
    return status === 'DRAFT' || status === 'SCHEDULED';
  }

  /**
   * Check if candidate can be created for a position based on election state
   */
  async canCreate(positionId) {
    const status = await this.getElectionStatusByPositionId(positionId);
    return status === 'DRAFT' || status === 'SCHEDULED';
  }

  /**
   * Check whether a candidate with the same name already exists on a position.
   * Used by the Add-to-Ballot flow to keep inserts idempotent across re-runs.
   */
  async candidateExists(positionId, name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return false;
    if (isMongoOnly) {
      try {
        const dbc = await getSharedDb();
        if (dbc) {
          try {
            const col = dbc.collection('candidates');
            const docs = await col.find({ $or: [{ position_id: positionId }, { positionId: String(positionId) }, { position_id: String(positionId) }, { linked_positions: String(positionId) }, { linkedPositions: String(positionId) }] }).toArray();
            return docs.some(d => String(d.name || '').trim().toLowerCase() === target);
          } catch (e) {
            console.warn('[candidateService] candidateExists mongo fallback false:', e.message);
          }
        }
      } catch (e) {
        console.warn('[candidateService] candidateExists mongo fallback false:', e.message);
      }
      return false;
    }
    const result = await db.query(
      'SELECT 1 FROM candidates WHERE position_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
      [positionId, name]
    );
    return result.rows.length > 0;
  }

  /**
   * True when a doc's primary position OR any linked position matches a target.
   * Position references on ballot docs are piecemeal strings/numbers/ids, so
   * all sides are stringified before comparing.
   */
  _belongsToPosition(doc, positionId) {
    const target = String(positionId);
    if (String(doc.position_id ?? doc.positionId) === target) return true;
    const linked = Array.isArray(doc.linked_positions) ? doc.linked_positions : Array.isArray(doc.linkedPositions) ? doc.linkedPositions : [];
    return linked.some(x => String(x) === target);
  }

  /**
   * Find the ONE canonical ballot candidate for an identity
   * (name + department + year + section), regardless of how many copies the
   * matcher created across elections. Among duplicates, prefer the copy tied
   * to the most active election (OPEN > SCHEDULED > DRAFT > unknown >
   * CLOSED/PUBLISHED), oldest created_at first — so reuse always picks the
   * live-cohort copy over stale test copies.
   */
  async findCanonicalCandidate({ name, department, year, section } = {}, opts = {}) {
    if (isMongoOnly) {
      try {
        const col = await this._getCollection();
        if (!col) return null;
        const all = await col.find({}).toArray();
        if (!all.length) return null;
        const targetName = String(name ?? '').trim().toLowerCase();
        const targetDept = String(normalizeDepartment(department) || department || '').trim().toLowerCase();
        const targetYear = normalizeYear(year) || '';
        const targetSec = normalizeSection(section);
        const matches = all.filter(d => {
          const dYear = normalizeYear(d.year) || '';
          const dSec = String(d.section ?? '').trim();
          const dSecNorm = (dSec === '' || dSec === '-') ? '' : dSec;
          if (targetName && String(d.name ?? '').trim().toLowerCase() !== targetName) return false;
          if (targetDept && String(normalizeDepartment(d.department) || d.department || '').trim().toLowerCase() !== targetDept) return false;
          if (targetYear && dYear !== targetYear) return false;
          if (targetSec !== undefined && dSecNorm !== String(targetSec).trim()) return false;
          return true;
        });
        if (!matches.length) return null;
        const ranked = await this._electionActivityRank(matches);
        return ranked[0] || null;
      } catch (e) {
        console.warn('[candidateService] findCanonicalCandidate failed:', e.message);
        return null;
      }
    }
    return null;
  }

  /**
   * Deterministically order ballot docs by the activity of the election they
   * sit on (derived via position -> constituency -> election). Ties break on
   * created_at, oldest first.
   */
  async _electionActivityRank(docs) {
    try {
      const dbc = await getSharedDb();
      if (!dbc) return docs;
      const [posDocs, ctDocs, elecDocs] = await Promise.all([
        dbc.collection('positions').find({}).toArray(),
        dbc.collection('constituencies').find({}).toArray(),
        dbc.collection('elections').find({}).toArray(),
      ]);
      const posById = new Map();
      for (const p of posDocs) { posById.set(String(p._id), p); if (p.postgresId != null) posById.set(String(p.postgresId), p); }
      const ctById = new Map();
      for (const c of ctDocs) { ctById.set(String(c._id), c); if (c.postgresId != null) ctById.set(String(c.postgresId), c); }
      const elecStatus = new Map();
      for (const e of elecDocs) { elecStatus.set(String(e._id), String(e.status || '').toUpperCase()); if (e.postgresId != null) elecStatus.set(String(e.postgresId), String(e.status || '').toUpperCase()); }
      const RANK = { OPEN: 0, SCHEDULED: 1, DRAFT: 2, CLOSED: 4, PUBLISHED: 5 };
      const rows = docs.map(d => {
        const pids = [String(d.position_id ?? d.positionId ?? '')];
        const linked = Array.isArray(d.linked_positions) ? d.linked_positions : Array.isArray(d.linkedPositions) ? d.linkedPositions : [];
        for (const l of linked) pids.push(String(l));
        let best = Infinity;
        for (const pid of pids) {
          const pos = posById.get(pid);
          if (!pos) continue;
          const ct = ctById.get(String(pos.constituency_id ?? pos.constituencyId ?? ''));
          if (!ct) continue;
          const status = elecStatus.get(String(ct.election_id ?? ct.electionId ?? ''));
          if (status !== undefined) best = Math.min(best, RANK[status] ?? 3);
        }
        return { doc: d, rank: best === Infinity ? 3 : best, created: d.created_at ?? d.createdAt ?? d._id };
      });
      rows.sort((a, b) => a.rank - b.rank || (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
      return rows.map(r => r.doc);
    } catch (e) {
      return docs;
    }
  }

  /**
   * Link an existing candidate doc to an additional ballot position without
   * cloning the doc or disturbing its primary position. Idempotent ($addToSet).
   * Returns the linked doc or null.
   */
  async linkToPosition(candidateId, positionId) {
    if (isMongoOnly) {
      try {
        const col = await this._getCollection();
        if (!col) return null;
        const pid = String(positionId);
        const upd = { $addToSet: { linked_positions: pid, linkedPositions: pid } };
        const { ObjectId } = require('mongodb');
        let res = null;
        try {
          if (ObjectId.isValid(String(candidateId))) {
            res = await col.findOneAndUpdate({ _id: new ObjectId(String(candidateId)) }, upd, { returnDocument: 'after' });
          }
        } catch (_) {}
        if (!res || !res.value) {
          res = await col.findOneAndUpdate({ $or: [{ id: String(candidateId) }, { id: Number(candidateId) }, { _id: String(candidateId) }, { postgresId: Number(candidateId) }] }, upd, { returnDocument: 'after' });
        }
        if (!res) return null;
        // Some mongodb driver versions return the doc directly instead of
        // wrapping it in { value }.
        const d = res.value || res;
        if (!d) return null;
        await this.invalidateCandidates();
        return {
          id: d._id ? String(d._id) : d.id,
          position_id: d.position_id ?? d.positionId ?? null,
          linked_positions: Array.isArray(d.linked_positions) ? d.linked_positions : Array.isArray(d.linkedPositions) ? d.linkedPositions : [],
        };
      } catch (e) {
        console.warn('[candidateService] linkToPosition failed:', e.message);
        return null;
      }
    }
    return null;
  }

  async _getCollection() {
    const dbc = await getSharedDb();
    if (!dbc) return null;
    return dbc.collection('candidates');
  }

  /**
   * Create a ballot row in `candidates` for an approved applicant.
   * Used by approval/assign-ballot flows. Duplicate (position_id, name)
   * surfaces as 23505 for the caller to swallow; unknown position as 23503.
   */
  async create({ position_id, name, description = null, image_url = null, department = null, year = null, section = null, gender = null, manifest = null }) {
    if (isMongoOnly) {
      try {
        const dbc = await getSharedDb();
        if (dbc) {
          try {
            const col = dbc.collection('candidates');
            const doc = { position_id, positionId: position_id, linked_positions: [String(position_id)], linkedPositions: [String(position_id)], name, description: description ?? manifest, image_url: image_url, imageUrl: image_url, department: department ?? null, year: year ?? null, section: section ?? null, gender: gender ?? null, display_order: 1, displayOrder: 1, is_active: true, isActive: true, created_at: new Date(), createdAt: new Date() };
            const res = await col.insertOne(doc);
            await this.invalidateCandidates();
            return { id: String(res.insertedId), position_id, name, description: description ?? manifest, image_url, department, year, section, gender, display_order: 1, is_active: true };
          } catch (e) {
            console.warn('[candidateService] create mongo fallback mock:', e.message);
          }
        }
      } catch (e) {
        console.warn('[candidateService] create mongo fallback mock:', e.message);
      }
      // Mongo-only without URI: return mock to avoid 500
      return { id: `mock-${Date.now()}`, position_id, name, description: description ?? manifest, image_url, department, year, section, gender, display_order: 1, is_active: true };
    }
    const result = await db.query(
      `INSERT INTO candidates (position_id, name, description, image_url, display_order)
       VALUES ($1, $2, $3, $4,
         COALESCE((SELECT MAX(display_order) + 1 FROM candidates WHERE position_id = $1), 1))
       RETURNING *`,
      [position_id, name, description, image_url]
    );
    await this.invalidateCandidates();
    return result.rows[0];
  }

  /**
   * Update candidate (legacy)
   */
  async update(id, data) {
    if (isMongoOnly) {
      try {
        const existing = await this.findByIdSimple(id);
        if (!existing) return null;
        const merged = { ...existing };
        if (data.name !== undefined) merged.name = data.name;
        if (data.description !== undefined) merged.description = data.description;
        if (data.image_url !== undefined) merged.image_url = data.image_url;
        if (data.display_order !== undefined) merged.display_order = data.display_order;
        merged.updated_at = new Date().toISOString();
        // Try Mongo update if available
        const dbc = await getSharedDb();
        if (dbc) {
          try {
            const { ObjectId } = require('mongodb');
            const col = dbc.collection('candidates');
            const upd = {};
            if (data.name !== undefined) upd.name = data.name;
            if (data.description !== undefined) upd.description = data.description;
if (data.image_url !== undefined) { upd.image_url = data.image_url; upd.imageUrl = data.image_url; }
        if (data.display_order !== undefined) { upd.display_order = data.display_order; upd.displayOrder = data.display_order; }
        if (data.department !== undefined) upd.department = data.department;
        if (data.year !== undefined) upd.year = data.year;
        if (data.section !== undefined) upd.section = data.section;
        if (data.gender !== undefined) upd.gender = data.gender;
            upd.updated_at = new Date(); upd.updatedAt = new Date();
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: upd }, { returnDocument: 'after' }); } catch (_) {}
            if (!res) res = await col.findOneAndUpdate({ id: String(id) }, { $set: upd }, { returnDocument: 'after' });
            const d = res && typeof res === 'object' ? (Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res) : null;
            if (d) {
              await this.invalidateCandidates();
              return { id: d._id ? String(d._id) : d.id, position_id: d.position_id ?? d.positionId, name: d.name, description: d.description, image_url: d.image_url ?? d.imageUrl, display_order: d.display_order ?? d.displayOrder ?? 0, is_active: d.is_active ?? d.isActive ?? true, gender: d.gender ?? null, department: d.department ?? null, year: d.year ?? null, section: d.section ?? null, email: d.email ?? null };
            }
          } catch (e) {
            console.warn('[candidateService] update mongo fallback:', e.message);
          }
        }
        return merged;
      } catch (e) {
        console.warn('[candidateService] update mongo fallback:', e.message);
        return null;
      }
    }
    const { name, description, image_url, display_order } = data;

    const result = await db.query(`
      UPDATE candidates
      SET name = COALESCE($2, name),
          description = COALESCE($3, description),
          image_url = COALESCE($4, image_url),
          display_order = COALESCE($5, display_order),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, name, description, image_url, display_order]);

    await this.invalidateCandidates();
    return result.rows[0];
  }

  /**
   * Find the ballot row belonging to the logged-in student. Candidates are
   * matched by name + cohort (department/year/section) since ballot rows are
   * not linked to a student account. Returns null when the student is not
   * standing. Only supports the Mongo-only deployment.
   */
  async findOwnCandidacy(student) {
    if (!student) return null;
    if (!isMongoOnly) {
      const studentId = student.studentId || student.id;
      if (!studentId) return null;
      try {
        const result = await db.query(
          `SELECT ca.*, p.name AS position_name
           FROM candidate_applications ca
           LEFT JOIN positions p ON ca.position_id = p.id
           WHERE ca.student_id = $1 AND ca.status = 'approved'
           ORDER BY ca.created_at DESC
           LIMIT 1`,
          [studentId]
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        return {
          id: String(row.id),
          name: row.full_name || '',
          position_id: row.position_id ?? null,
          position_name: row.position_name || null,
          department: row.department || null,
          year: row.year || null,
          section: row.section || null,
          gender: row.gender || null,
          image_url: row.profile_photo_url || null,
          manifesto: row.manifesto || '',
          bio: row.bio || '',
        };
      } catch (e) {
        console.warn('[candidateService] findOwnCandidacy pg failed:', e.message);
        return null;
      }
    }
    const dbc = await getSharedDb();
    if (!dbc || !student || !student.name) return null;
    try {
      const canonical = await this.findCanonicalCandidate({
        name: student.name,
        department: student.department,
        year: student.year,
        section: student.section,
      });
      const doc = canonical || null;
      if (!doc) return null;
      return {
        id: String(doc._id),
        name: doc.name || '',
        position_id: doc.position_id ?? doc.positionId ?? null,
        position_name: doc.position_name || null,
        department: doc.department || null,
        year: doc.year || null,
        section: doc.section || null,
        gender: doc.gender || null,
        image_url: doc.image_url ?? doc.imageUrl ?? null,
        manifesto: doc.description || doc.manifesto || '',
        bio: doc.bio || '',
      };
    } catch (e) {
      console.warn('[candidateService] findOwnCandidacy failed:', e.message);
      return null;
    }
  }

  /**
   * Update the standing candidate's manifesto (description). Belongs to the
   * logged-in student (matched by the same name + cohort query). Returns the
   * updated row or null. Invalidate the candidates cache so the change shows
   * immediately on the student list.
   */
  async updateOwnManifesto(student, manifesto, bio) {
    if (!student) return null;
    if (!isMongoOnly) {
      const studentId = student.studentId || student.id;
      if (!studentId) return null;
      try {
        const result = await db.query(
          `UPDATE candidate_applications
           SET manifesto = COALESCE($2, manifesto),
               bio = COALESCE($3, bio),
               updated_at = NOW()
           WHERE student_id = $1 AND status = 'approved'
           RETURNING *`,
          [studentId, manifesto, bio]
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        await this.invalidateCandidates().catch(() => {});
        return {
          id: String(row.id),
          name: row.full_name || '',
          position_id: row.position_id ?? null,
          position_name: null,
          department: row.department || null,
          year: row.year || null,
          section: row.section || null,
          gender: row.gender || null,
          image_url: row.profile_photo_url || null,
          manifesto: row.manifesto || '',
          bio: row.bio || '',
        };
      } catch (e) {
        console.warn('[candidateService] updateOwnManifesto pg failed:', e.message);
        return null;
      }
    }
    const dbc = await getSharedDb();
    if (!dbc || !student || !student.name) return null;
    try {
      const col = dbc.collection('candidates');
      const cohort = {
        name: student.name,
        department: student.department || undefined,
        year: student.year ? normalizeYear(student.year) : undefined,
        section: student.section || undefined,
      };
      const query = {};
      for (const [k, v] of Object.entries(cohort)) {
        if (v !== undefined) query[k] = v;
      }
      const existing = await col.findOne(query);
      if (!existing) return null;
      const upd = { updated_at: new Date(), updatedAt: new Date() };
      if (manifesto !== undefined) upd.description = manifesto;
      if (bio !== undefined) upd.bio = bio;
      await col.updateOne({ _id: existing._id }, { $set: upd });
      await this.invalidateCandidates().catch(() => {});
      return {
        id: String(existing._id),
        name: existing.name || '',
        position_id: existing.position_id ?? existing.positionId ?? null,
        position_name: existing.position_name || null,
        department: existing.department || null,
        year: existing.year || null,
        section: existing.section || null,
        gender: existing.gender || null,
        image_url: existing.image_url ?? existing.imageUrl ?? null,
        manifesto: manifesto || existing.description || existing.manifesto || '',
        bio: bio || existing.bio || '',
      };
    } catch (e) {
      console.warn('[candidateService] updateOwnManifesto failed:', e.message);
      return null;
    }
  }
}

module.exports = new CandidateService();
