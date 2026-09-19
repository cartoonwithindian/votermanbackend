/**
 * Authorization Controller
 * HTTP request handling for voter authorization management
 */

const authService = require('../services/authorizationService');

class AuthorizationController {
  /**
   * GET /api/v1/elections/:electionId/authorizations
   */
  async list(req, res, next) {
    try {
      const { electionId } = req.params;
      const { active_only, limit, offset } = req.query;

      if (!electionId || isNaN(parseInt(electionId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      // Verify election exists
      const election = await authService.getElectionById(parseInt(electionId));
      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${electionId} not found`,
        });
      }

      const authorizations = await authService.findByElectionId(parseInt(electionId), {
        activeOnly: active_only !== 'false',
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });

      res.json({
        data: authorizations,
        meta: {
          count: authorizations.length,
          electionId: parseInt(electionId),
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/authorizations/:id
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid authorization ID',
        });
      }

      const authorization = await authService.findById(parseInt(id));

      if (!authorization) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Authorization with ID ${id} not found`,
        });
      }

      res.json({ data: authorization });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/elections/:electionId/authorizations
   */
  async create(req, res, next) {
    try {
      const { electionId } = req.params;
      const { student_id, is_authorized = true, expires_at } = req.body;

      // Validate election ID
      if (!electionId || isNaN(parseInt(electionId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      // Validate student_id
      if (student_id === undefined || student_id === null) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'student_id is required',
        });
      }

      if (isNaN(parseInt(student_id))) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'student_id must be a valid integer',
        });
      }

      // Validate expires_at if provided
      if (expires_at !== undefined && expires_at !== null) {
        const date = new Date(expires_at);
        if (isNaN(date.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'expires_at must be a valid date',
          });
        }
      }

      // Check election exists
      const election = await authService.getElectionById(parseInt(electionId));
      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${electionId} not found`,
        });
      }

      // Check student exists and is active
      const student = await authService.getStudentById(parseInt(student_id));
      if (!student) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Student with ID ${student_id} not found`,
        });
      }

      if (!student.is_active) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot authorize inactive student',
        });
      }

      // Check election state allows authorization
      const canCreate = await authService.canCreate(parseInt(electionId));
      if (!canCreate.canCreate) {
        return res.status(403).json({
          error: 'Forbidden',
          message: canCreate.reason || 'Cannot add authorizations when election is OPEN or CLOSED',
        });
      }

      // Check for existing authorization
      const existing = await authService.exists(
        parseInt(student_id),
        parseInt(electionId)
      );
      if (existing) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Authorization already exists for this student/election',
        });
      }

      // Create authorization
      const authorization = await authService.create({
        student_id: parseInt(student_id),
        election_id: parseInt(electionId),
        is_authorized: is_authorized !== false,
        expires_at: expires_at || null,
      });

      res.status(201).json({ data: authorization });
    } catch (err) {
      // Handle duplicate constraint
      if (err.code === '23505') {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Authorization already exists for this student/election',
        });
      }
      // Handle foreign key violations
      if (err.code === '23503') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid student or election reference',
        });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/authorizations/:id
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { is_authorized, expires_at } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid authorization ID',
        });
      }

      // Validate expires_at if provided
      if (expires_at !== undefined && expires_at !== null) {
        const date = new Date(expires_at);
        if (isNaN(date.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'expires_at must be a valid date',
          });
        }
      }

      // Check authorization exists
      const existing = await authService.findByIdSimple(parseInt(id));
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Authorization with ID ${id} not found`,
        });
      }

      // Check election state allows modification
      const canModify = await authService.canModify(parseInt(id));
      if (!canModify) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Cannot modify authorization when election is OPEN or CLOSED',
        });
      }

      // Only allow updating is_authorized and expires_at
      const updateData = {};
      if (is_authorized !== undefined) {
        updateData.is_authorized = Boolean(is_authorized);
      }
      if (expires_at !== undefined) {
        updateData.expires_at = expires_at;
      }

      const authorization = await authService.update(parseInt(id), updateData);

      res.json({ data: authorization });
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/v1/authorizations/:id
   */
  async delete(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid authorization ID',
        });
      }

      // Check authorization exists
      const existing = await authService.findByIdSimple(parseInt(id));
      if (!existing) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Authorization with ID ${id} not found`,
        });
      }

      // Check election state allows deletion
      const canDelete = await authService.canDelete(parseInt(id));
      if (!canDelete.canDelete) {
        return res.status(403).json({
          error: 'Forbidden',
          message: canDelete.reason,
        });
      }

      await authService.delete(parseInt(id));

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:electionId/eligibility/:studentId
   */
  async checkEligibility(req, res, next) {
    try {
      const { electionId, studentId } = req.params;

      if (!electionId || isNaN(parseInt(electionId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      if (!studentId || isNaN(parseInt(studentId))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid student ID',
        });
      }

      const eligibility = await authService.checkEligibility(
        parseInt(studentId),
        parseInt(electionId)
      );

      // Return minimal response for privacy
      res.json({
        eligible: eligibility.eligible,
        reason: eligibility.reason,
        election_status: eligibility.election_status,
        authorized_clubs: eligibility.authorized_clubs,
        full_access: eligibility.full_access,
      });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new AuthorizationController();
