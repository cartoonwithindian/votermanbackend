/**
 * Candidate Service
 * Business logic for candidate management.
 *
 * The public /api/v1/candidates endpoint uses candidate_applications with
 * status='approved'. The legacy `candidates` table backs the ballot rows for
 * constituency (Class Representative) positions.
 */

const db = require('../db');

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

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * Find a single approved candidate by ID for public view.
   */
  async findApprovedById(id) {
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
   * Create a ballot row in `candidates` for an approved applicant.
   * Used by approval/assign-ballot flows. Duplicate (position_id, name)
   * surfaces as 23505 for the caller to swallow; unknown position as 23503.
   */
  async create({ position_id, name, description = null, image_url = null }) {
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
