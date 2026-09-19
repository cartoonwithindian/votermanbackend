/**
 * Position Service
 * Business logic for position management
 */

const db = require('../db');

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
    const { activeOnly = true, limit = 100, offset = 0 } = options;

    let query = 'SELECT * FROM positions WHERE 1=1';
    const params = [];

    if (activeOnly) {
      query += ' AND is_active = true';
    }

    query += ' ORDER BY display_order, id LIMIT $1 OFFSET $2';
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find all positions for a constituency
   */
  async findByConstituencyId(constituencyId, options = {}) {
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
