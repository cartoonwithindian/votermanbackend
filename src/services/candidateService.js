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

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

class CandidateService {
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
        const mongoRows = await mongoStore.readMongoCandidates();
        if (mongoRows && mongoRows.length) {
          // mongo docs already mapped to CandidateRow via jsonStore.mapJsonToRow on write
          const { rows } = mongoStore.filterMongoRows(mongoRows, { gender, department, year, section, limit, offset });
          return rows;
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
      query += ` AND ca.year = $${paramIndex}`;
      params.push(year);
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
   * Find a single approved candidate by ID for public view.
   */
  async findApprovedById(id) {
    // Priority: Atlas -> JSON -> DB
    try {
      if (await mongoStore.hasMongoCandidates()) {
        const mongoRows = await mongoStore.readMongoCandidates();
        if (mongoRows && mongoRows.length) {
          const found = mongoRows.find(r => String(r._id) === String(id) || String(r.id) === String(id));
          if (found) return found;
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
    // Priority: Atlas -> JSON -> DB
    try {
      if (await mongoStore.hasMongoCandidates()) {
        const mongoRows = await mongoStore.readMongoCandidates();
        if (mongoRows && mongoRows.length) {
          const { total } = mongoStore.filterMongoRows(mongoRows, { ...options, limit: 100000, offset: 0 });
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
      query += ` AND year = $${paramIndex}`;
      params.push(year);
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
    if (isMongoOnly) {
      // Mongo-only: attempt to read from Mongo candidates or return [] to avoid 500
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            // Check voteweb.candidates or mongoStore
            if (await mongoStore.hasMongoCandidates()) {
              const rows = await mongoStore.readMongoCandidates();
              if (rows && rows.length) {
                // Filter by positionId if available in row
                const filtered = rows.filter(r => String(r.position_id ?? r.positionId) === String(positionId));
                return filtered.slice(0, options.limit || 100);
              }
            }
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('candidates');
            const docs = await col.find({ $or: [{ position_id: positionId }, { positionId: String(positionId) }, { position_id: String(positionId) }] }).limit(options.limit || 100).skip(options.offset || 0).toArray();
            return docs.map(d => ({ id: d._id ? String(d._id) : d.id, position_id: d.position_id ?? d.positionId, name: d.name, description: d.description, image_url: d.image_url ?? d.imageUrl, display_order: d.display_order ?? d.displayOrder ?? 0, is_active: d.is_active ?? d.isActive ?? true }));
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[candidateService] findByPositionId mongo fallback to []:', e.message);
      }
      return [];
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
    return result.rows;
  }

  /**
   * Find candidate by ID (legacy)
   */
  async findByIdSimple(id) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient, ObjectId } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('candidates');
            let doc = null;
            try { if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) }); } catch (_) {}
            if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { _id: String(id) }] });
            if (!doc) return null;
            return { id: doc._id ? String(doc._id) : doc.id, position_id: doc.position_id ?? doc.positionId, name: doc.name, description: doc.description, image_url: doc.image_url ?? doc.imageUrl, display_order: doc.display_order ?? doc.displayOrder ?? 0, is_active: doc.is_active ?? doc.isActive ?? true };
          } finally {
            await client.close().catch(() => {});
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

  /**
   * Get election status by position ID
   */
  async getElectionStatusByPositionId(positionId) {
    if (isMongoOnly) return 'DRAFT';
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
    if (isMongoOnly) return true;
    const candidate = await this.findByIdSimple(candidateId);
    if (!candidate) return false;

    const status = await this.getElectionStatusByPositionId(candidate.position_id);
    return status === 'DRAFT' || status === 'SCHEDULED';
  }

  /**
   * Check if candidate can be created for a position based on election state
   */
  async canCreate(positionId) {
    if (isMongoOnly) return true;
    const status = await this.getElectionStatusByPositionId(positionId);
    return status === 'DRAFT' || status === 'SCHEDULED';
  }

  /**
   * Create a ballot row in `candidates` for an approved applicant.
   * Used by approval/assign-ballot flows. Duplicate (position_id, name)
   * surfaces as 23505 for the caller to swallow; unknown position as 23503.
   */
  async create({ position_id, name, description = null, image_url = null }) {
    if (isMongoOnly) {
      try {
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('candidates');
            const doc = { position_id, positionId: position_id, name, description, image_url: image_url, imageUrl: image_url, display_order: 1, displayOrder: 1, is_active: true, isActive: true, created_at: new Date(), createdAt: new Date() };
            const res = await col.insertOne(doc);
            return { id: String(res.insertedId), position_id, name, description, image_url, display_order: 1, is_active: true };
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[candidateService] create mongo fallback mock:', e.message);
      }
      // Mongo-only without URI: return mock to avoid 500
      return { id: `mock-${Date.now()}`, position_id, name, description, image_url, display_order: 1, is_active: true };
    }
    const result = await db.query(
      `INSERT INTO candidates (position_id, name, description, image_url, display_order)
       VALUES ($1, $2, $3, $4,
         COALESCE((SELECT MAX(display_order) + 1 FROM candidates WHERE position_id = $1), 1))
       RETURNING *`,
      [position_id, name, description, image_url]
    );
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
        const uri = process.env.MONGODB_URI || process.env.MONGODB_URL;
        if (uri) {
          const { MongoClient, ObjectId } = require('mongodb');
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const col = client.db(process.env.MONGODB_DB || 'voteweb').collection('candidates');
            const upd = {};
            if (data.name !== undefined) upd.name = data.name;
            if (data.description !== undefined) upd.description = data.description;
            if (data.image_url !== undefined) { upd.image_url = data.image_url; upd.imageUrl = data.image_url; }
            if (data.display_order !== undefined) { upd.display_order = data.display_order; upd.displayOrder = data.display_order; }
            upd.updated_at = new Date(); upd.updatedAt = new Date();
            let res = null;
            try { if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: upd }, { returnDocument: 'after' }); } catch (_) {}
            if (!res || !res.value) res = await col.findOneAndUpdate({ id: String(id) }, { $set: upd }, { returnDocument: 'after' });
            if (res && res.value) {
              const d = res.value;
              return { id: d._id ? String(d._id) : d.id, position_id: d.position_id ?? d.positionId, name: d.name, description: d.description, image_url: d.image_url ?? d.imageUrl, display_order: d.display_order ?? d.displayOrder ?? 0 };
            }
          } finally {
            await client.close().catch(() => {});
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

    return result.rows[0];
  }
}

module.exports = new CandidateService();
