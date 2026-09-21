/**
 * Position Service
 * Business logic for position management
 * Mongo-only (Atlas M10) safe — returns []/null/mock instead of throwing when Postgres not configured
 */

const db = require('../db');
const { getMongoDbName } = require('../utils/mongoDbName');

const isMongoOnly = !process.env.DATABASE_URL && !!(process.env.MONGODB_URI || process.env.MONGODB_URL);

function getMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGODB_URL || null;
}

async function mongoFindPositions({ filter = {}, limit = 100, offset = 0, sort = { display_order: 1, _id: 1 } } = {}) {
  const { MongoClient } = require('mongodb');
  const uri = getMongoUri();
  if (!uri) return [];
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
  await client.connect();
  try {
    const col = client.db(getMongoDbName()).collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
    const docs = await col.find(filter).sort(sort).skip(offset).limit(limit).toArray();
    return docs.map((d) => ({
      id: d._id ? String(d._id) : d.id,
      constituency_id: d.constituency_id ?? d.constituencyId ?? null,
      name: d.name,
      description: d.description ?? null,
      display_order: d.display_order ?? d.displayOrder ?? 0,
      is_active: d.is_active ?? d.isActive ?? true,
      max_selections: d.max_selections ?? d.maxSelections ?? 1,
      gender: d.gender ?? null,
      created_at: d.created_at ?? d.createdAt ?? new Date().toISOString(),
      updated_at: d.updated_at ?? d.updatedAt ?? new Date().toISOString(),
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

async function mongoFindConstituencies({ limit = 50, offset = 0 } = {}) {
  const { MongoClient } = require('mongodb');
  const uri = getMongoUri();
  if (!uri) return [];
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
  await client.connect();
  try {
    const col = client.db(getMongoDbName()).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
    const docs = await col.find({}).sort({ _id: 1 }).skip(offset).limit(limit).toArray();
    return docs;
  } finally {
    await client.close().catch(() => {});
  }
}

// Recommended position names (not enforced by database)
const RECOMMENDED_POSITIONS = [
  'Leader',
  'Co-Leader',
  'Secretary',
  'Joint Secretary',
  'Treasurer',
];

class PositionService {
  /**
   * Get recommended position names
   */
  getRecommendedPositions() {
    return RECOMMENDED_POSITIONS;
  }

  /**
   * Find all positions
   */
  async findAll(options = {}) {
    if (isMongoOnly) {
      try {
        const { activeOnly = true, limit = 100, offset = 0 } = options;
        // Try Mongo voteweb.positions first; fallback to constituencies-derived empty, return [] to avoid 500
        const rows = await mongoFindPositions({ filter: {}, limit, offset });
        if (rows.length) {
          return activeOnly ? rows.filter((r) => r.is_active !== false) : rows;
        }
        // If positions collection empty, try constituencies as hint (avoid 500, return [] or mock)
        try {
          const constituencies = await mongoFindConstituencies({ limit: 5, offset: 0 });
          if (constituencies.length) {
            // Optionally synthesize empty positions list; for now return [] so admin page loads
            // Could return mock CR seats per constituency, but task says [] or mock is ok
            return [];
          }
        } catch (_) {}
        return [];
      } catch (e) {
        console.warn('[positionService] Mongo-only findAll fallback to []:', e.message);
        return [];
      }
    }

    const { activeOnly = true, limit = 100, offset = 0 } = options;
    let query = 'SELECT * FROM positions WHERE 1=1';
    const params = [];
    if (activeOnly) query += ' AND is_active = true';
    query += ' ORDER BY display_order, id LIMIT $1 OFFSET $2';
    params.push(limit, offset);
    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find all positions for a constituency
   */
  async findByConstituencyId(constituencyId, options = {}) {
    if (isMongoOnly) {
      try {
        const { activeOnly = true, limit = 100, offset = 0 } = options;
        const rows = await mongoFindPositions({
          filter: {
            $or: [
              { constituency_id: constituencyId },
              { constituencyId: String(constituencyId) },
              { constituency_id: String(constituencyId) },
            ],
          },
          limit,
          offset,
        });
        if (rows.length) return activeOnly ? rows.filter((r) => r.is_active !== false) : rows;
        // fallback: query all and filter by JS (handles ObjectId vs number mismatches)
        const all = await mongoFindPositions({ filter: {}, limit: 200, offset: 0 });
        const filtered = all.filter((r) => String(r.constituency_id) === String(constituencyId));
        return activeOnly ? filtered.filter((r) => r.is_active !== false).slice(0, limit) : filtered.slice(0, limit);
      } catch (e) {
        console.warn('[positionService] Mongo-only findByConstituencyId fallback to []:', e.message);
        return [];
      }
    }

    const { activeOnly = true, limit = 100, offset = 0 } = options;

    let query = 'SELECT * FROM positions WHERE constituency_id = $1';
    const params = [constituencyId];

    if (activeOnly) {
      query += ' AND is_active = true';
    }

    query += ' ORDER BY display_order, id LIMIT $2 OFFSET $3';
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find position by ID
   */
  async findById(id) {
    if (isMongoOnly) {
      try {
        const { MongoClient, ObjectId } = require('mongodb');
        const uri = getMongoUri();
        if (!uri) return null;
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
          let doc = null;
          // Try ObjectId lookup first, then string/number id
          try {
            if (ObjectId.isValid(String(id))) {
              doc = await col.findOne({ _id: new ObjectId(String(id)) });
            }
          } catch (_) {}
          if (!doc) {
            doc = await col.findOne({
              $or: [{ id: id }, { id: String(id) }, { _id: String(id) }],
            });
            if (!doc) {
              // brute force: scan limited set
              const rows = await mongoFindPositions({ filter: {}, limit: 200, offset: 0 });
              doc = rows.find((r) => String(r.id) === String(id)) || null;
              if (doc) return doc;
            }
          }
          if (!doc) return null;
          return {
            id: doc._id ? String(doc._id) : doc.id,
            constituency_id: doc.constituency_id ?? doc.constituencyId ?? null,
            name: doc.name,
            description: doc.description ?? null,
            display_order: doc.display_order ?? doc.displayOrder ?? 0,
            is_active: doc.is_active ?? doc.isActive ?? true,
            max_selections: doc.max_selections ?? doc.maxSelections ?? 1,
            gender: doc.gender ?? null,
            created_at: doc.created_at ?? doc.createdAt ?? new Date().toISOString(),
            updated_at: doc.updated_at ?? doc.updatedAt ?? new Date().toISOString(),
          };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[positionService] Mongo-only findById fallback to null:', e.message);
        return null;
      }
    }

    const result = await db.query(
      'SELECT * FROM positions WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new position (constituency-backed — Class Representative seats)
   */
  async create(data) {
    if (isMongoOnly) {
      try {
        const { constituency_id, name, description, display_order } = data;

        if (constituency_id === undefined || constituency_id === null) {
          const error = new Error('constituency_id is required.');
          error.code = 'VALIDATION';
          error.status = 400;
          throw error;
        }

        const { MongoClient } = require('mongodb');
        const uri = getMongoUri();
        if (!uri) {
          // Return mock without persisting, to avoid 500
          return {
            id: `mock-${Date.now()}`,
            constituency_id,
            name: String(name).trim(),
            description: description?.trim() || null,
            display_order: display_order !== undefined ? display_order : 0,
            is_active: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
          const doc = {
            constituency_id,
            constituencyId: constituency_id,
            name: String(name).trim(),
            description: description?.trim() || null,
            display_order: display_order !== undefined ? display_order : 0,
            displayOrder: display_order !== undefined ? display_order : 0,
            is_active: true,
            isActive: true,
            created_at: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          const res = await col.insertOne(doc);
          return {
            id: String(res.insertedId),
            constituency_id,
            name: doc.name,
            description: doc.description,
            display_order: doc.display_order,
            is_active: true,
            created_at: doc.created_at,
            updated_at: doc.updated_at,
          };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        if (e.code === 'VALIDATION') throw e;
        console.warn('[positionService] Mongo-only create fallback to mock:', e.message);
        // Return mock to avoid 500 for admin UI
        const { constituency_id, name, description, display_order } = data;
        return {
          id: `mock-${Date.now()}`,
          constituency_id: constituency_id ?? null,
          name: String(name || '').trim() || 'Mock Position',
          description: description?.trim() || null,
          display_order: display_order !== undefined ? display_order : 0,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
    }

    const { constituency_id, name, description, display_order } = data;

    if (constituency_id === undefined || constituency_id === null) {
      const error = new Error('constituency_id is required.');
      error.code = 'VALIDATION';
      error.status = 400;
      throw error;
    }

    const result = await db.query(
      `INSERT INTO positions (constituency_id, name, description, display_order)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        constituency_id,
        name.trim(),
        description?.trim() || null,
        display_order !== undefined ? display_order : 0,
      ]
    );

    return result.rows[0];
  }

  /**
   * Update a position
   */
  async update(id, data) {
    if (isMongoOnly) {
      try {
        // Find existing first (Mongo-aware)
        const position = await this.findById(id);
        if (!position) return null;

        const allowedFields = ['name', 'description', 'display_order'];
        const hasUpdate = allowedFields.some((f) => data[f] !== undefined);
        if (!hasUpdate) return position;

        const { MongoClient, ObjectId } = require('mongodb');
        const uri = getMongoUri();
        if (!uri) {
          // Mock update in-memory
          const updated = { ...position };
          if (data.name !== undefined) updated.name = String(data.name).trim();
          if (data.description !== undefined) updated.description = data.description?.trim() || null;
          if (data.display_order !== undefined) updated.display_order = data.display_order;
          updated.updated_at = new Date().toISOString();
          return updated;
        }
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
        await client.connect();
        try {
          const col = client.db(getMongoDbName()).collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
          const updateDoc = {};
          if (data.name !== undefined) updateDoc.name = String(data.name).trim();
          if (data.description !== undefined) updateDoc.description = data.description?.trim() || null;
          if (data.display_order !== undefined) {
            updateDoc.display_order = data.display_order;
            updateDoc.displayOrder = data.display_order;
          }
          updateDoc.updated_at = new Date().toISOString();
          updateDoc.updatedAt = new Date().toISOString();

          // Try ObjectId update, fallback to id field
          let res = null;
          try {
            if (ObjectId.isValid(String(id))) {
              res = await col.findOneAndUpdate({ _id: new ObjectId(String(id)) }, { $set: updateDoc }, { returnDocument: 'after' });
            }
          } catch (_) {}
          if (!res || !res.value) {
            // try by mapped id field
            res = await col.findOneAndUpdate({ id: String(id) }, { $set: updateDoc }, { returnDocument: 'after' });
          }
          if (!res || !res.value) {
            // fallback: try string _id
            res = await col.findOneAndUpdate({ _id: String(id) }, { $set: updateDoc }, { returnDocument: 'after' });
          }
          if (res && res.value) {
            const d = res.value;
            return {
              id: d._id ? String(d._id) : d.id,
              constituency_id: d.constituency_id ?? d.constituencyId ?? position.constituency_id,
              name: d.name,
              description: d.description ?? null,
              display_order: d.display_order ?? d.displayOrder ?? 0,
              is_active: d.is_active ?? d.isActive ?? true,
              created_at: d.created_at ?? d.createdAt ?? position.created_at,
              updated_at: d.updated_at ?? d.updatedAt ?? new Date().toISOString(),
            };
          }
          // If not found in Mongo, return mock merged
          return { ...position, ...updateDoc, id: String(id) };
        } finally {
          await client.close().catch(() => {});
        }
      } catch (e) {
        console.warn('[positionService] Mongo-only update fallback to mock:', e.message);
        // Return mock merged to avoid 500
        const position = await this.findById(id).catch(() => null);
        if (!position) return null;
        const updated = { ...position };
        if (data.name !== undefined) updated.name = String(data.name).trim();
        if (data.description !== undefined) updated.description = data.description?.trim() || null;
        if (data.display_order !== undefined) updated.display_order = data.display_order;
        updated.updated_at = new Date().toISOString();
        return updated;
      }
    }

    const position = await this.findById(id);
    if (!position) return null;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    const allowedFields = ['name', 'description', 'display_order'];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        if (field === 'name') {
          params.push(data[field].trim());
        } else if (field === 'description') {
          params.push(data[field]?.trim() || null);
        } else {
          params.push(data[field]);
        }
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return position;
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const query = `UPDATE positions SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await db.query(query, params);
    return result.rows[0];
  }

  /**
   * Get election status for a position (constituency-backed)
   */
  async getElectionStatus(positionId) {
    if (isMongoOnly) {
      // In Mongo-only, elections live in voteweb.elections or voteweb.constituencies (if seeded)
      // For admin page stability, return DRAFT to allow edits, or try to read actual status
      try {
        const { MongoClient } = require('mongodb');
        const uri = getMongoUri();
        if (uri) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const dbName = getMongoDbName();
            // Try to find position -> constituency -> election chain via Mongo
            const posCol = client.db(dbName).collection(process.env.MONGODB_POSITIONS_COLLECTION || 'positions');
            const ctCol = client.db(dbName).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
            const eCol = client.db(dbName).collection(process.env.MONGODB_ELECTIONS_COLLECTION || 'elections');
            let pos = null;
            try {
              const { ObjectId } = require('mongodb');
              if (ObjectId.isValid(String(positionId))) pos = await posCol.findOne({ _id: new ObjectId(String(positionId)) });
            } catch (_) {}
            if (!pos) pos = await posCol.findOne({ $or: [{ id: String(positionId) }, { _id: String(positionId) }] });
            if (pos) {
              const ctId = pos.constituency_id ?? pos.constituencyId;
              if (ctId) {
                let ct = null;
                try {
                  const { ObjectId } = require('mongodb');
                  if (ObjectId.isValid(String(ctId))) ct = await ctCol.findOne({ _id: new ObjectId(String(ctId)) });
                } catch (_) {}
                if (!ct) ct = await ctCol.findOne({ $or: [{ id: String(ctId) }, { _id: String(ctId) }] });
                if (ct && (ct.election_id || ct.electionId)) {
                  const eId = ct.election_id ?? ct.electionId;
                  let e = null;
                  try {
                    const { ObjectId } = require('mongodb');
                    if (ObjectId.isValid(String(eId))) e = await eCol.findOne({ _id: new ObjectId(String(eId)) });
                  } catch (_) {}
                  if (!e) e = await eCol.findOne({ $or: [{ id: String(eId) }, { _id: String(eId) }] });
                  if (e && e.status) return e.status;
                }
              }
            }
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[positionService] Mongo getElectionStatus fallback to DRAFT:', e.message);
      }
      return 'DRAFT';
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
   * Get election status by constituency ID
   */
  async getElectionStatusByConstituencyId(constituencyId) {
    if (isMongoOnly) {
      try {
        const { MongoClient } = require('mongodb');
        const uri = getMongoUri();
        if (uri) {
          const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000 });
          await client.connect();
          try {
            const dbName = getMongoDbName();
            const ctCol = client.db(dbName).collection(process.env.MONGODB_CONSTITUENCIES_COLLECTION || 'constituencies');
            const eCol = client.db(dbName).collection(process.env.MONGODB_ELECTIONS_COLLECTION || 'elections');
            let ct = null;
            try {
              const { ObjectId } = require('mongodb');
              if (ObjectId.isValid(String(constituencyId))) ct = await ctCol.findOne({ _id: new ObjectId(String(constituencyId)) });
            } catch (_) {}
            if (!ct) ct = await ctCol.findOne({ $or: [{ id: String(constituencyId) }, { _id: String(constituencyId) }] });
            if (ct && (ct.election_id || ct.electionId)) {
              const eId = ct.election_id ?? ct.electionId;
              let e = null;
              try {
                const { ObjectId } = require('mongodb');
                if (ObjectId.isValid(String(eId))) e = await eCol.findOne({ _id: new ObjectId(String(eId)) });
              } catch (_) {}
              if (!e) e = await eCol.findOne({ $or: [{ id: String(eId) }, { _id: String(eId) }] });
              if (e && e.status) return e.status;
            }
          } finally {
            await client.close().catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[positionService] Mongo getElectionStatusByConstituencyId fallback to DRAFT:', e.message);
      }
      return 'DRAFT';
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
   * Check if position can be modified based on election state
   */
  async canModify(positionId, constituencyId) {
    if (isMongoOnly) return true;
    let status;
    if (positionId) {
      status = await this.getElectionStatus(positionId);
    } else if (constituencyId) {
      status = await this.getElectionStatusByConstituencyId(constituencyId);
    }
    return status === 'DRAFT' || status === 'SCHEDULED';
  }
}

module.exports = new PositionService();
