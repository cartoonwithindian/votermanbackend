/**
 * Election Controller
 * HTTP request handling for election management
 */

const electionService = require('../services/electionService');
const candidateAppService = require('../services/candidateApplicationService');
const { auditLog } = require('../db');

const VALID_STATUSES = ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'PUBLISHED'];

class ElectionController {
  /**
   * GET /api/v1/elections
   */
  async list(req, res, next) {
    try {
      const { status, limit, offset } = req.query;

      // Validate status if provided
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }

      const MAX_LIMIT = 100;
      const parsedLimit = Math.min(parseInt(limit) || 100, MAX_LIMIT);

      // Non-admin viewers must NEVER see DRAFT elections (drafts are internal
      // working state; exposing them leaks upcoming/abandoned ballots). The
      // role is read from the server-side session, never the client.
      const viewerRole = (req.user?.role || '').toUpperCase();
      const isStaff = viewerRole === 'ADMIN' || viewerRole === 'CAD';
      const effectiveStatus = status
        ? status
        : null;

      const elections = await electionService.findAll({
        status: status || null,
        limit: parsedLimit,
        offset: parseInt(offset) || 0,
        excludeDraft: !isStaff,
      });

      res.json({
        data: elections,
        meta: {
          count: elections.length,
          limit: parsedLimit,
          offset: parseInt(offset) || 0,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:id
   */
  async get(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const election = await electionService.findById(parseInt(id));

      if (!election) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      res.json({ data: election });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/elections
   */
  async create(req, res, next) {
    try {
      const { name, description, start_time, end_time } = req.body;

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name is required and must be a non-empty string',
        });
      }

      // Validate name length
      if (name.length > 255) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'name must be 255 characters or less',
        });
      }

      // Validate timestamps if provided
      if (start_time) {
        const startDate = new Date(start_time);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'start_time must be a valid timestamp',
          });
        }
      }

      if (end_time) {
        const endDate = new Date(end_time);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be a valid timestamp',
          });
        }
      }

      // Validate end_time > start_time if both provided
      if (start_time && end_time) {
        const startDate = new Date(start_time);
        const endDate = new Date(end_time);
        if (endDate <= startDate) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be after start_time',
          });
        }
      }

      const election = await electionService.create({
        name: name.trim(),
        description: description?.trim() || null,
        start_time: start_time ? new Date(start_time).toISOString() : null,
        end_time: end_time ? new Date(end_time).toISOString() : null,
      });

      // Audit log: election created
      await auditLog('ELECTION_CREATED', {
        electionId: election.id,
        name: election.name,
        status: election.status,
        adminUserId: req.adminUser?.id,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.status(201).json({ data: election });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/elections/:id
   */
  async update(req, res, next) {
    try {
      const { id } = req.params;
      const { name, description, start_time, end_time } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      // Validate name length if provided
      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim() === '') {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'name must be a non-empty string if provided',
          });
        }
        if (name.length > 255) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'name must be 255 characters or less',
          });
        }
      }

      // Validate timestamps if provided
      if (start_time) {
        const startDate = new Date(start_time);
        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'start_time must be a valid timestamp',
          });
        }
      }

      if (end_time) {
        const endDate = new Date(end_time);
        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be a valid timestamp',
          });
        }
      }

      // Validate end_time > start_time if both provided
      if (start_time && end_time) {
        const startDate = new Date(start_time);
        const endDate = new Date(end_time);
        if (endDate <= startDate) {
          return res.status(400).json({
            error: 'Validation Error',
            message: 'end_time must be after start_time',
          });
        }
      }

      const result = await electionService.update(parseInt(id), {
        name: name?.trim(),
        description: description !== undefined ? (description?.trim() || null) : undefined,
        start_time: start_time ? new Date(start_time).toISOString() : undefined,
        end_time: end_time ? new Date(end_time).toISOString() : undefined,
      });

      if (result === null) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error) {
        return res.status(result.status || 400).json({
          error: result.error,
          message: result.message,
        });
      }

      res.json({ data: result });
    } catch (err) {
      // Handle protected field error
      if (err.code === 'PROTECTED_FIELD' || err.code === 'ELECTION_CLOSED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: err.message,
          protectedFields: err.fields,
        });
      }
      next(err);
    }
  }

  /**
   * PATCH /api/v1/elections/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      // Validate status value
      if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          error: 'Validation Error',
          message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }

      const result = await electionService.updateStatus(parseInt(id), status);

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error === 'INVALID_TRANSITION') {
        return res.status(409).json({
          error: 'Conflict',
          message: result.message,
          currentStatus: result.currentStatus,
          allowedTransitions: result.allowedTransitions,
        });
      }

      if (result.error === 'PROTECTED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: result.message,
        });
      }

      // Audit log: election status changed
      await auditLog('ELECTION_STATUS_CHANGED', {
        electionId: parseInt(id),
        previousStatus: result.previousStatus,
        newStatus: status,
        adminUserId: req.adminUser?.id,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      // Opening the election makes every approved CR candidate ballot-ready:
      // auto-place any approved-but-unplaced applications onto this
      // election's constituencies. Best-effort — never fails the status change.
      let autoPlaced = [];
      if (status === 'OPEN') {
        try {
          const outcome = await candidateAppService.placeUnplacedForElection(parseInt(id));
          autoPlaced = outcome.placed;
        } catch (err) {
          console.warn('updateStatus: auto ballot placement failed', { electionId: id, code: err.code || err.message });
        }
      }

      res.json({ data: result.election, meta: { autoPlaced } });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/elections/:id/readiness
   * Check if election is ready to be opened
   */
  async getReadiness(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const result = await electionService.getReadiness(parseInt(id));

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/elections/:id/results
   * Get aggregated election results
   * Only returns results if election status is RESULTS_PUBLISHED or if admin requests
   */
  async getResults(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const result = await electionService.getResults(parseInt(id));

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error === 'NOT_PUBLISHED') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Results have not been published for this election',
        });
      }

      // Return aggregated results without individual vote data
      res.json({
        data: {
          electionId: result.electionId,
          electionName: result.electionName,
          publishedAt: result.publishedAt,
          status: result.status,
          totalEligible: result.totalEligible,
          totalVotes: result.totalVotes,
          participation: result.participation,
          clubs: result.clubs,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/elections/:id/publish
   * Publish election results - sets results_published_at timestamp
   */
  async publishResults(req, res, next) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid election ID',
        });
      }

      const adminUserId = req.adminUser?.id || 1;
      const result = await electionService.publishResults(parseInt(id), adminUserId);

      if (result.error === 'NOT_FOUND') {
        return res.status(404).json({
          error: 'Not Found',
          message: `Election with ID ${id} not found`,
        });
      }

      if (result.error === 'INVALID_STATE') {
        return res.status(409).json({
          error: 'Conflict',
          message: result.message,
        });
      }

      // Audit log
      await auditLog('RESULTS_PUBLISHED', {
        electionId: parseInt(id),
        adminUserId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({ data: result.election });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ElectionController();
