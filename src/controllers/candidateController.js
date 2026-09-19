/**
 * Candidate Controller
 * HTTP request handling for candidate management.
 *
 * PUBLIC ENDPOINTS:
 * - GET /candidates         : List approved candidates for student view
 * - GET /candidates/:id     : Get single candidate (public)
 *
 * These endpoints return candidates from candidate_applications with status='approved'.
 */

const candidateService = require('../services/candidateService');

class CandidateController {
  /**
   * GET /api/v1/candidates - List approved candidates for public/student view
   *
   * Returns candidates from candidate_applications with status='approved'.
   * Supports filtering by gender, department, year, and section.
   */
  async listAll(req, res, next) {
    try {
      const {
        active_only,
        limit,
        offset,
        gender,      // 'Male', 'Female', 'Other'
        department,
        year,
        section,
      } = req.query;

      const candidates = await candidateService.findApproved({
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
        gender,
        department,
        year,
        section,
      });

      res.json({
        data: candidates,
        meta: {
          count: candidates.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/candidates/:id - Get single candidate (public)
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid candidate ID',
        });
      }

      const candidate = await candidateService.findApprovedById(parseInt(id));

      if (!candidate) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Candidate not found',
        });
      }

      res.json({
        data: candidate,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/positions/:positionId/candidates
   */
  async list(req, res, next) {
    try {
      const { positionId } = req.params;
      const { active_only, limit, offset } = req.query;

      if (!positionId || isNaN(parseInt(positionId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid position ID',
        });
      }

      const candidates = await candidateService.findByPositionId(parseInt(positionId), {
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });

      res.json({
        data: candidates,
        meta: {
          count: candidates.length,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/candidates/:id - Update candidate (admin only)
   *
   * Admin-only endpoint for managing ballot candidates.
   * Public reads stay open; writes require an authenticated ADMIN session, a
   * valid CSRF token, and the election must be DRAFT/SCHEDULED.
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, description, image_url, display_order } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid candidate ID',
        });
      }

      // Check election state - only allow modification in DRAFT/SCHEDULED
      const canModify = await candidateService.canModify(parseInt(id));
      if (!canModify) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify candidate when election is OPEN or CLOSED',
        });
      }

      const candidate = await candidateService.update(parseInt(id), {
        name,
        description,
        image_url,
        display_order,
      });

      res.json({ data: candidate });
    } catch (err) {
      // Handle duplicate name constraint
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: `A candidate with name '${req.body.name}' already exists in this position`,
        });
      }
      next(err);
    }
  }
}

module.exports = new CandidateController();
