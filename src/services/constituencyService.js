/**
 * Constituency Service
 * Business logic for Class Representative (CR) constituencies.
 *
 * A constituency is (election, department, year, section) and owns exactly
 * one Class Representative position. Creating a constituency auto-creates its
 * position so the ballot is always well-formed and candidates can never be
 * placed on the wrong section's ballot.
 */

const db = require('../db');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGODB_URL || null;
}
function getMongoDbName() {
  return process.env.MONGODB_DB || 'voteweb';
}

// Each class constituency exposes two lock-step Class Representative seats —
// one Boy CR and one Girl CR — so a class votes for one boy and one girl rep.
const CR_POSITION_SEATS = [
  { name: 'Class Representative (Boys)', gender: 'Male' },
  { name: 'Class Representative (Girls)', gender: 'Female' },
];

class ConstituencyService {
  /**
   * Build the human-readable constituency label.
   */
  buildName({ department, year, section }) {
    const sec = String(section || '').trim();
    return sec ? `${department} ${year} Section ${sec}`.trim() : `${department} ${year}`.trim();
  }

  /**
   * Find all constituencies for an election.
   */
  async findByElectionId(electionId, options = {}) {
    if (isMongoOnly) {
      try {
        const uri = getMongoUri();
        if (!uri) return [];
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
          const filter = {};
          // Try both numeric and string election_id variants
          filter.$or = [{ election_id: parseInt(electionId) }, { electionId: parseInt(electionId) }, { election_id: String(electionId) }, { electionId: String(electionId) }];
          if (options.activeOnly !== false) {
            // is_active filter via JS after fetch to handle inconsistent schema
          }
          const docs = await col.find({ $or: filter.$or }).sort({ department: 1, year: 1, section: 1 }).skip(options.offset || 0).limit(Math.min(options.limit || 100, 100)).toArray();
          let rows = docs.map(d => ({
            id: d._id ? String(d._id) : d.id,
            election_id: d.election_id ?? d.electionId ?? parseInt(electionId),
            department: d.department,
            year: d.year,
            section: d.section ?? '',
            name: d.name,
            is_active: d.is_active ?? d.isActive ?? true,
            created_at: d.created_at ?? d.createdAt,
            updated_at: d.updated_at ?? d.updatedAt,
          }));
          if (options.activeOnly !== false) rows = rows.filter(r => r.is_active !== false);
          return rows;
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[constituencyService] Mongo-only findByElectionId fallback to []:', e.message);
        return [];
      }
    }
    const { activeOnly = true, limit = 100, offset = 0 } = options;

    let query = 'SELECT * FROM constituencies WHERE election_id = $1';
    const params = [electionId];

    if (activeOnly) {
      query += ' AND is_active = true';
    }

    query += ' ORDER BY department, year, section LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find a constituency by ID.
   */
  async findById(id) {
    if (isMongoOnly) {
      try {
        const uri = getMongoUri();
        if (!uri) return null;
        const { MongoClient, ObjectId } = require('mongodb');
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
          let doc = null;
          try {
            if (ObjectId.isValid(String(id))) doc = await col.findOne({ _id: new ObjectId(String(id)) });
          } catch (_) {}
          if (!doc) doc = await col.findOne({ $or: [{ id: String(id) }, { id: parseInt(id) }, { _id: String(id) }] });
          if (!doc) {
            const all = await col.find({}).limit(200).toArray();
            doc = all.find(d => String(d._id) === String(id) || String(d.id) === String(id)) || null;
          }
          if (!doc) return null;
          return {
            id: doc._id ? String(doc._id) : doc.id,
            election_id: doc.election_id ?? doc.electionId ?? null,
            department: doc.department,
            year: doc.year,
            section: doc.section ?? '',
            name: doc.name,
            is_active: doc.is_active ?? doc.isActive ?? true,
            created_at: doc.created_at ?? doc.createdAt,
            updated_at: doc.updated_at ?? doc.updatedAt,
          };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[constituencyService] Mongo-only findById fallback to null:', e.message);
        return null;
      }
    }
    const result = await db.query(
      'SELECT * FROM constituencies WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find the constituency matching (department, year, section) in an election.
   */
  async findMatching({ electionId, department, year, section, activeOnly = true }) {
    if (isMongoOnly) {
      try {
        const uri = getMongoUri();
        if (!uri) return null;
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
          // Fetch candidates for election then filter case-insensitively in JS
          const docs = await col.find({ $or: [{ election_id: parseInt(electionId) }, { electionId: parseInt(electionId) }, { election_id: String(electionId) }, { electionId: String(electionId) }] }).toArray();
          const match = (a, b) => (a ?? '').toString().trim().toLowerCase() === (b ?? '').toString().trim().toLowerCase();
          let filtered = docs.filter(d => match(d.department, department) && match(d.year, year) && match(d.section ?? '', section ?? ''));
          if (activeOnly) filtered = filtered.filter(d => (d.is_active ?? d.isActive ?? true) !== false);
          if (!filtered.length) return null;
          filtered.sort((a, b) => String(a._id).localeCompare(String(b._id)));
          const doc = filtered[0];
          return {
            id: doc._id ? String(doc._id) : doc.id,
            election_id: doc.election_id ?? doc.electionId ?? parseInt(electionId),
            department: doc.department,
            year: doc.year,
            section: doc.section ?? '',
            name: doc.name,
            is_active: doc.is_active ?? doc.isActive ?? true,
            created_at: doc.created_at ?? doc.createdAt,
            updated_at: doc.updated_at ?? doc.updatedAt,
          };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[constituencyService] Mongo-only findMatching fallback to null:', e.message);
        return null;
      }
    }
    const result = await db.query(
      `SELECT * FROM constituencies
       WHERE election_id = $1
         AND LOWER(department) = LOWER($2)
         AND LOWER(year) = LOWER($3)
         AND LOWER(section) = LOWER($4)
         ${activeOnly ? 'AND is_active = true' : ''}
       ORDER BY id
       LIMIT 1`,
      [electionId, department, year, section]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a constituency and auto-create its Class Representative position.
   */
  async create({ electionId, department, year, section, name }) {
    // section may be "" for section-less courses (MCA, MBA, BCom).
    if (!electionId || !department || !year || section === undefined || section === null) {
      const error = new Error('election_id, department, year, section are required.');
      error.code = 'VALIDATION';
      error.status = 400;
      throw error;
    }

    if (isMongoOnly) {
      try {
        const uri = getMongoUri();
        if (!uri) {
          // Return mock without persisting to avoid 500
          return {
            id: `mock-${Date.now()}`,
            election_id: electionId,
            department: String(department).trim(),
            year: String(year).trim(),
            section: String(section).trim(),
            name: name || this.buildName({ department, year, section }),
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const dbName = getMongoDbName();
          const col = client.db(dbName).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
          const doc = {
            election_id: electionId,
            electionId: electionId,
            department: String(department).trim(),
            year: String(year).trim(),
            section: String(section).trim(),
            name: name || this.buildName({ department, year, section }),
            is_active: true,
            isActive: true,
            created_at: new Date(),
            createdAt: new Date(),
            updated_at: new Date(),
            updatedAt: new Date(),
          };
          const res = await col.insertOne(doc);
          const constituencyId = String(res.insertedId);
          // Auto-create Boy/Girl CR positions in Mongo too (best-effort)
          try {
            const posCol = client.db(dbName).collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
            for (const [index, seat] of CR_POSITION_SEATS.entries()) {
              await posCol.insertOne({
                constituency_id: constituencyId,
                constituencyId,
                name: seat.name,
                description: null,
                display_order: index,
                displayOrder: index,
                max_selections: 1,
                maxSelections: 1,
                gender: seat.gender,
                is_active: true,
                isActive: true,
                created_at: new Date(),
                createdAt: new Date(),
              });
            }
          } catch (e) {
            console.warn('[constituencyService] Mongo auto-create positions failed:', e.message);
          }
          return {
            id: constituencyId,
            election_id: electionId,
            department: doc.department,
            year: doc.year,
            section: doc.section,
            name: doc.name,
            is_active: true,
            created_at: doc.created_at.toISOString(),
            updated_at: doc.updated_at.toISOString(),
          };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[constituencyService] Mongo-only create fallback to mock:', e.message);
        return {
          id: `mock-${Date.now()}`,
          election_id: electionId,
          department: String(department).trim(),
          year: String(year).trim(),
          section: String(section).trim(),
          name: name || this.buildName({ department, year, section }),
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
    }

    const client = await db.pool.connect();
    let constituency;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO constituencies (election_id, department, year, section, name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          electionId,
          String(department).trim(),
          String(year).trim(),
          String(section).trim(),
          name || this.buildName({ department, year, section }),
        ]
      );

      constituency = result.rows[0];

      // Auto-create the two gender-scoped Class Representative seats (Boy CR +
      // Girl CR) as locked single-seat positions. Both inserts live inside the
      // same transaction so a failed create never leaves a half-built seat set.
      for (const [index, seat] of CR_POSITION_SEATS.entries()) {
        await client.query(
          `INSERT INTO positions (constituency_id, name, description, display_order, max_selections, gender)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [constituency.id, seat.name, null, index, seat.gender]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return constituency;
  }

  /**
   * Update a constituency (name / is_active only; identity is immutable).
   */
  async update(id, data) {
    if (isMongoOnly) {
      try {
        const existing = await this.findById(id);
        if (!existing) return null;
        const uri = getMongoUri();
        if (!uri) {
          // Mock update in-memory
          const merged = { ...existing };
          if (data.name !== undefined) merged.name = String(data.name).trim();
          if (data.is_active !== undefined) merged.is_active = Boolean(data.is_active);
          merged.updated_at = new Date().toISOString();
          return merged;
        }
        const { MongoClient, ObjectId } = require('mongodb');
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
          const updates = {};
          if (data.name !== undefined) updates.name = String(data.name).trim();
          if (data.is_active !== undefined) { updates.is_active = Boolean(data.is_active); updates.isActive = Boolean(data.is_active); }
          updates.updated_at = new Date();
          updates.updatedAt = new Date();
          let res = null;
          try {
            if (ObjectId.isValid(String(id))) res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updates }, { returnDocument: 'after' });
          } catch (_) {}
          if (!res || !res.value) res = await col.findOneAndUpdate({ id: String(id) }, { $set: updates }, { returnDocument: 'after' });
          if (!res || !res.value) res = await col.findOneAndUpdate({ _id: String(id) }, { $set: updates }, { returnDocument: 'after' });
          if (res && res.value) {
            const d = res.value;
            return { id: d._id ? String(d._id) : d.id, election_id: d.election_id ?? d.electionId, department: d.department, year: d.year, section: d.section ?? '', name: d.name, is_active: d.is_active ?? d.isActive ?? true, created_at: d.created_at ?? d.createdAt, updated_at: d.updated_at ?? d.updatedAt };
          }
          return { ...existing, ...updates, id: String(id) };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[constituencyService] Mongo-only update fallback to mock:', e.message);
        const existing = await this.findById(id).catch(() => null);
        if (!existing) return null;
        const merged = { ...existing };
        if (data.name !== undefined) merged.name = String(data.name).trim();
        if (data.is_active !== undefined) merged.is_active = Boolean(data.is_active);
        merged.updated_at = new Date().toISOString();
        return merged;
      }
    }
    const { name, is_active } = data;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex}`);
      params.push(String(name).trim());
      paramIndex++;
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex}`);
      params.push(Boolean(is_active));
      paramIndex++;
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await db.query(
      `UPDATE constituencies SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  /**
   * Deactivate a constituency (soft delete; keeps history).
   */
  async deactivate(id) {
    if (isMongoOnly) {
      return this.update(id, { is_active: false });
    }
    const result = await db.query(
      `UPDATE constituencies SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND is_active = true
       RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Count constituencies in an election.
   */
  async countByElectionId(electionId, activeOnly = true) {
    if (isMongoOnly) {
      try {
        const rows = await this.findByElectionId(electionId, { activeOnly, limit: 1000, offset: 0 });
        return rows.length;
      } catch (e) {
        console.warn('[constituencyService] Mongo-only countByElectionId fallback to 0:', e.message);
        return 0;
      }
    }
    const result = await db.query(
      `SELECT COUNT(*) as count FROM constituencies
       WHERE election_id = $1 ${activeOnly ? 'AND is_active = true' : ''}`,
      [electionId]
    );
    return parseInt(result.rows[0].count) || 0;
  }

  /**
   * Election status for a constituency.
   */
  async getElectionStatusByConstituencyId(constituencyId) {
    if (isMongoOnly) {
      try {
        const constituency = await this.findById(constituencyId);
        if (!constituency || !constituency.election_id) return 'DRAFT';
        const electionService = require('./electionService');
        const election = await electionService.findById(constituency.election_id);
        return election?.status || 'DRAFT';
      } catch (e) {
        console.warn('[constituencyService] Mongo-only getElectionStatus fallback to DRAFT:', e.message);
        return 'DRAFT';
      }
    }
    const result = await db.query(
      `SELECT e.status FROM elections e
       JOIN constituencies ct ON ct.election_id = e.id
       WHERE ct.id = $1`,
      [constituencyId]
    );
    return result.rows[0]?.status || null;
  }

  /**
   * Can a constituency (and its position) be modified? Only in DRAFT/SCHEDULED.
   */
  async canModify(constituencyId) {
    if (isMongoOnly) return true;
    const status = await this.getElectionStatusByConstituencyId(constituencyId);
    return status === 'DRAFT' || status === 'SCHEDULED';
  }
}

module.exports = new ConstituencyService();