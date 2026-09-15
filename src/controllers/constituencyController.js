/**
 * Constituency Controller
 * HTTP request handling for Class Representative (CR) constituencies.
 *
 * Security model mirrors clubs/positions:
 *  - Reads are public (ballot data).
 *  - Writes require an authenticated ADMIN session + CSRF, and the owning
 *    election must be DRAFT/SCHEDULED.
 */

const constituencyService = require('../services/constituencyService');
const electionService = require('../services/electionService');
const positionService = require('../services/positionService');

class ConstituencyController {
  /**
   * GET /api/v1/constituencies?election_id=&active_only=
   * Public read: constituencies for an election (active by default).
   */
  async list(req, res, next) {
    try {
      const { election_id, active_only } = req.query;

      if (!election_id || isNaN(parseInt(election_id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'election_id query parameter is required.',
        });
      }

      const election = await electionService.findById(parseInt(election_id));
      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${election_id} not found`,
        });
      }

      const constituencies = await constituencyService.findByElectionId(
        parseInt(election_id),
        { activeOnly: active_only !== 'false' }
      );

      res.json({
        data: constituencies,
        meta: { count: constituencies.length, electionId: parseInt(election_id) },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/constituencies/:id/positions
   * Public read: positions for a constituency (the locked CR position).
   */
  async listPositions(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      const constituency = await constituencyService.findById(parseInt(id));
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${id} not found`,
        });
      }

      const positions = await positionService.findByConstituencyId(parseInt(id), {
        activeOnly: req.query.active_only !== 'false',
      });

      res.json({
        data: positions,
        meta: { count: positions.length, constituencyId: parseInt(id) },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/constituencies
   * Create a constituency (auto-creates its Class Representative position).
   */
  async create(req, res, next) {
    try {
      const { election_id, department, year, section, name } = req.body;

      if (!election_id || isNaN(parseInt(election_id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'election_id is required.',
        });
      }
      for (const field of ['department', 'year']) {
        if (!req.body[field] || String(req.body[field]).trim() === '') {
          return res.status(400).json({
            error: 'Validation Error',
            message: `${field} is required.`,
          });
        }
      }
      // section may be "" for section-less courses (MCA, MBA, BCom) — it must
      // be present as a string, but empty is valid.
      if (req.body.section === undefined || req.body.section === null || typeof req.body.section !== 'string') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'section is required.',
        });
      }

      const election = await electionService.findById(parseInt(election_id));
      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${election_id} not found`,
        });
      }

      if (election.status !== 'DRAFT' && election.status !== 'SCHEDULED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot create constituencies when election is OPEN or CLOSED',
        });
      }

      const constituency = await constituencyService.create({
        electionId: parseInt(election_id),
        department,
        year,
        section,
        name,
      });

      res.status(201).json({ data: constituency });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A constituency with this department, year and section already exists in the election.',
        });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/constituencies/:id
   * Update name / is_active (identity fields are immutable).
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, is_active } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      const constituency = await constituencyService.findById(parseInt(id));
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${id} not found`,
        });
      }

      if (!(await constituencyService.canModify(parseInt(id)))) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify constituency when election is OPEN or CLOSED',
        });
      }

      if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name must be a non-empty string if provided',
        });
      }
      if (is_active !== undefined && typeof is_active !== 'boolean') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'is_active must be a boolean',
        });
      }

      const updated = await constituencyService.update(parseInt(id), { name, is_active });

      res.json({ data: updated });
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/admin/constituencies/:id
   * Deactivate a constituency (soft delete).
   */
  async remove(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid constituency ID',
        });
      }

      const constituency = await constituencyService.findById(parseInt(id));
      if (!constituency) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Constituency with ID ${id} not found`,
        });
      }

      if (!(await constituencyService.canModify(parseInt(id)))) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot deactivate constituency when election is OPEN or CLOSED',
        });
      }

      const updated = await constituencyService.deactivate(parseInt(id));

      res.json({
        data: updated,
        message: 'Constituency deactivated.',
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ConstituencyController();